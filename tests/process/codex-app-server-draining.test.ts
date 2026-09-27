import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { connectCodexHost } from '../../src/agent/structured/host.js';
import { codexHostRuntimeDirectory, processAlive } from '../../src/agent/structured/host-registry.js';

const require = createRequire(import.meta.url);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('draining App Server recovery', () => {
  it('reclaims a draining orphan whose wrapper process already died', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'draining-app-server-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const binary = join(dir, 'codex');
    const pidsFile = join(dir, 'pids.txt');
    await writeFile(binary, fakeAppServerSource(pidsFile), 'utf8');
    await chmod(binary, 0o755);

    const profileDir = join(dir, 'profile');
    const cwd = join(dir, 'workspace');
    await mkdir(profileDir, { recursive: true });
    await mkdir(cwd, { recursive: true });

    // Pre-start the broken server exactly where the bridge will look: the
    // socket answers connections but rejects every request as "draining".
    const directory = codexHostRuntimeDirectory(profileDir, 'scope-draining', cwd);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const broken = require('node:child_process').spawn(
      binary,
      ['app-server', '--listen', `unix://${join(directory, 'server.sock')}`],
      { env: { ...process.env, DRAIN: '1' }, detached: true, stdio: 'ignore' },
    ) as import('node:child_process').ChildProcess;
    cleanups.push(async () => {
      try { process.kill(-broken.pid!, 'SIGKILL'); } catch { /* gone */ }
    });
    await waitForSocket(join(directory, 'server.sock'), 5_000);

    const host = await connectCodexHost({
      binary,
      profileDir,
      scope: 'scope-draining',
      cwd,
      env: { PATH: process.env.PATH },
      fingerprint: { credentials: {}, networkMode: 'inherit' },
    });

    // The draining orphan was replaced by a healthy server that answers.
    await expect(host.rpc.request('thread/loaded/list', {})).resolves.toBeDefined();
    expect(processAlive(broken.pid!)).toBe(false);
    host.rpc.close();
  }, 60_000);
});

function fakeAppServerSource(pidsFile: string): string {
  return `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { WebSocketServer } from ${JSON.stringify(new URL('wrapper.mjs', pathToFileURL(require.resolve('ws'))).href)};

appendFileSync(${JSON.stringify(pidsFile)}, process.pid + '\\n');
const args = process.argv.slice(2);
const endpoint = args[args.indexOf('--listen') + 1];
const draining = process.env.DRAIN === '1';
const httpServer = createServer();
const wss = new WebSocketServer({ server: httpServer, path: '/' });
wss.on('connection', (socket) => {
  socket.on('message', (data) => {
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    if (message.method === 'initialized' || message.id === undefined) return;
    if (draining) {
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Server is draining; retry after reconnecting' } }));
      return;
    }
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
  });
});
httpServer.listen(endpoint.slice('unix://'.length));
`;
}

async function waitForSocket(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { lstat } = await import('node:fs/promises');
      await lstat(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`socket did not appear: ${path}`);
}
