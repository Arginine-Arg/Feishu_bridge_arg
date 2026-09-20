import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { connectCodexHost, shutdownProfileHosts } from '../../src/agent/structured/host.js';
import {
  codexHostRuntimeDirectory,
  dropOwner,
  fileStamp,
  fingerprintCredentialEnv,
  processAlive,
  readHostRegistry,
  recordOwner,
  type CodexHostEnvironmentFingerprint,
} from '../../src/agent/structured/host-registry.js';

const require = createRequire(import.meta.url);

/** Absolute ESM wrapper path; `ws` does not export it through `exports`. */
function wsWrapperPath(): string {
  return new URL('wrapper.mjs', pathToFileURL(require.resolve('ws'))).href;
}

const cleanups: Array<() => Promise<void>> = [];
const oldKey = process.env.OPENAI_API_KEY;
let otherOwnerPid = 0;

beforeAll(() => {
  // A stand-in for a paused native TUI: a live process that owns the profile.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  otherOwnerPid = child.pid ?? 0;
});

afterAll(() => {
  if (otherOwnerPid > 0) {
    try {
      process.kill(otherOwnerPid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
});

afterEach(async () => {
  if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = oldKey;
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('Codex App Server lifecycle', () => {
  it('reuses a server whose environment still matches and replaces it after a provider switch', async () => {
    const fixture = await createAppServerFixture();
    const cwd = fixture.dir;
    const env = {
      PATH: process.env.PATH,
      CODEX_HOME: fixture.codexHome,
      OPENAI_API_KEY: 'sk-first',
    };
    const fingerprint = (): CodexHostEnvironmentFingerprint => ({
      credentials: fingerprintCredentialEnv({ OPENAI_API_KEY: env.OPENAI_API_KEY }),
      networkMode: 'inherit:third-party-direct',
      configStamp: fileStamp(join(fixture.codexHome, 'config.toml')),
      authStamp: fileStamp(join(fixture.codexHome, 'auth.json')),
    });

    const first = await connectCodexHost({
      binary: fixture.binary,
      profileDir: fixture.dir,
      scope: 'scope-reuse',
      cwd,
      env,
      fingerprint: fingerprint(),
    }).catch(async (error) => {
      const directory = codexHostRuntimeDirectory(fixture.dir, 'scope-reuse', cwd);
      const log = await readFile(join(directory, 'server.log'), 'utf8').catch(() => '(no log)');
      throw new Error(`${(error as Error).message}\n--- server.log ---\n${log}`);
    });
    const firstPid = fixture.startedPids()[0]!;
    expect(firstPid).toBeGreaterThan(0);
    await first.rpc.request('thread/loaded/list', {});
    first.rpc.close();

    // Same environment: the running server is reused, not respawned.
    const reused = await connectCodexHost({
      binary: fixture.binary,
      profileDir: fixture.dir,
      scope: 'scope-reuse',
      cwd,
      env,
      fingerprint: fingerprint(),
    });
    expect(fixture.startedPids()).toEqual([firstPid]);
    reused.rpc.close();

    // cc-switch rewrites config.toml and the token: the stale server must go.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(
      join(fixture.codexHome, 'config.toml'),
      'model_provider = "other"\nmodel = "other-model"\n',
    );
    env.OPENAI_API_KEY = 'sk-second';
    const replaced = await connectCodexHost({
      binary: fixture.binary,
      profileDir: fixture.dir,
      scope: 'scope-reuse',
      cwd,
      env,
      fingerprint: fingerprint(),
    });
    const pids = fixture.startedPids();
    expect(pids).toHaveLength(2);
    expect(pids[1]).not.toBe(firstPid);
    // The registry points at the runtime directory; the endpoint adds /server.sock.
    const registry = await readHostRegistry(fixture.dir);
    expect(replaced.endpoint).toBe(`unix://${codexHostRuntimeDirectory(fixture.dir, 'scope-reuse', cwd)}/server.sock`);
    expect(registry.filter((host) => processAlive(host.pid)).map((host) => host.pid)).toEqual([pids[1]]);
    replaced.rpc.close();

    await shutdownProfileHosts(fixture.dir);
    expect(processAlive(pids[1]!)).toBe(false);
    expect(await readHostRegistry(fixture.dir)).toEqual([]);
  }, 60_000);

  it('keeps a detached server while another owner is alive', async () => {
    const fixture = await createAppServerFixture();
    const directory = codexHostRuntimeDirectory(fixture.dir, 'scope-shared', fixture.dir);
    await recordOwner(fixture.dir, otherOwnerPid);
    const host = await connectCodexHost({
      binary: fixture.binary,
      profileDir: fixture.dir,
      scope: 'scope-shared',
      cwd: fixture.dir,
      env: { PATH: process.env.PATH, CODEX_HOME: fixture.codexHome },
      fingerprint: {
        credentials: {},
        networkMode: 'inherit',
        configStamp: fileStamp(join(fixture.codexHome, 'config.toml')),
        authStamp: fileStamp(join(fixture.codexHome, 'auth.json')),
      },
    });
    const pid = fixture.startedPids()[0]!;
    host.rpc.close();

    // A paused native TUI (another live owner) keeps the server reusable.
    await shutdownProfileHosts(fixture.dir);
    expect(processAlive(pid)).toBe(true);
    expect((await readHostRegistry(fixture.dir)).some((item) => item.directory === directory)).toBe(true);

    // Once the last owner is gone the next shutdown reclaims it.
    await dropOwner(fixture.dir, otherOwnerPid);
    await shutdownProfileHosts(fixture.dir);
    expect(processAlive(pid)).toBe(false);
    expect(await readHostRegistry(fixture.dir)).toEqual([]);
  }, 60_000);
});

async function createAppServerFixture(): Promise<{
  dir: string;
  codexHome: string;
  binary: string;
  startedPids: () => number[];
}> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-app-server-lifecycle-'));
  const codexHome = join(dir, 'codex-home');
  const logFile = join(dir, 'servers.json');
  const binary = join(dir, 'codex');
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(codexHome, 'config.toml'), 'model_provider = "deepseek"\nmodel = "deepseek-chat"\n');
  await writeFile(join(codexHome, 'auth.json'), '{"OPENAI_API_KEY":"sk-first"}\n');
  await writeFile(
    binary,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { WebSocketServer } from ${JSON.stringify(wsWrapperPath())};

const args = process.argv.slice(2);
const listenIndex = args.indexOf('--listen');
const endpoint = args[listenIndex + 1];
if (!endpoint || !endpoint.startsWith('unix://')) {
  process.stderr.write('missing --listen unix:// endpoint\\n');
  process.exit(2);
}
appendFileSync(${JSON.stringify(logFile)}, process.pid + '\\n');
const path = endpoint.slice('unix://'.length);
const httpServer = createServer();
const wss = new WebSocketServer({ server: httpServer, path: '/' });
wss.on('connection', (socket) => {
  socket.on('message', (data) => {
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    if (message.method === 'initialized') return;
    if (message.id === undefined) return;
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
  });
});
httpServer.on('error', (error) => {
  process.stderr.write('listen failed: ' + error.message + '\\n');
  process.exit(1);
});
httpServer.listen(path, () => process.stderr.write('listening ' + path + '\\n'));
`,
    'utf8',
  );
  await chmod(binary, 0o755);
  const startedPids = (): number[] => {
    try {
      const raw = require('node:fs').readFileSync(logFile, 'utf8') as string;
      return raw.split('\n').filter(Boolean).map((line) => Number.parseInt(line, 10));
    } catch {
      return [];
    }
  };
  cleanups.push(async () => {
    for (const pid of startedPids()) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, codexHome, binary, startedPids };
}
