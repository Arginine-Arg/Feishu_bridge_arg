import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from '../../src/agent/codex/adapter.js';
import { connectCodexHost } from '../../src/agent/structured/host.js';
import { fileStamp, fingerprintCredentialEnv } from '../../src/agent/structured/host-registry.js';

const require = createRequire(import.meta.url);
const cleanups: Array<() => Promise<void>> = [];
const savedEnv = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  HTTP_PROXY: process.env.HTTP_PROXY,
  ALL_PROXY: process.env.ALL_PROXY,
};

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('cc-switch acceptance path', () => {
  it('runs a third-party provider directly with the configured token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cc-switch-acceptance-'));
    const codexHome = join(dir, 'codex-home');
    const serverLog = join(dir, 'servers.json');
    const record = join(dir, 'codex-record.json');
    await mkdir(codexHome, { recursive: true });
    cleanups.push(() => rm(dir, { recursive: true, force: true }));

    // What cc-switch leaves behind: a third-party provider with a token in the
    // config, an API key file, an empty OPENAI_API_KEY from the shell wrapper,
    // and a local clash proxy that this provider cannot use.
    await writeFile(join(codexHome, 'config.toml'), [
      'model = "deepseek-flash"',
      'model_provider = "deepseek"',
      'preferred_auth_method = "apikey"',
      '',
      '[model_providers.deepseek]',
      'name = "deepseek"',
      'base_url = "https://api.xinlab-ioz.cn/v1"',
      'wire_api = "responses"',
      'requires_openai_auth = false',
      'experimental_bearer_token = "sk-config-token"',
      'env_key = "OPENAI_API_KEY"',
      '',
    ].join('\n'));
    await writeFile(join(codexHome, 'auth.json'), '{"OPENAI_API_KEY":"sk-auth-token"}\n');
    process.env.OPENAI_API_KEY = '';
    process.env.HTTPS_PROXY = 'http://127.0.0.1:17897';
    process.env.HTTP_PROXY = 'http://127.0.0.1:17897';
    process.env.ALL_PROXY = 'socks5h://127.0.0.1:17897';

    const binary = await writeFakeCodex(dir, { record, serverLog });

    // 1. Turn path: the child receives the configured token and no local proxy.
    const adapter = new CodexAdapter({
      binary,
      profileStateDir: dir,
      codexHome,
      network: { mode: 'inherit' },
    });
    await adapter.prepareRun();
    const run = adapter.run({ runId: 'acceptance', prompt: 'hi', cwd: dir });
    for await (const _event of run.events) { /* drain */ }
    const child = JSON.parse(await readFile(record, 'utf8')) as {
      argv: string[];
      key: string | null;
      proxy: string | null;
    };
    expect(child.key).toBe('sk-config-token');
    expect(child.proxy).toBeNull();
    expect(child.argv).toContain('exec');
    expect(child.argv).toContain('--json');

    // 2. Structured path: the App Server gets the same environment, and the
    // registry records a credential digest instead of the token.
    const host = await connectCodexHost({
      binary,
      profileDir: dir,
      scope: 'acceptance-scope',
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        CODEX_HOME: codexHome,
        OPENAI_API_KEY: 'sk-config-token',
      },
      fingerprint: {
        credentials: fingerprintCredentialEnv({ OPENAI_API_KEY: 'sk-config-token' }),
        networkMode: 'inherit:third-party-direct',
        configStamp: fileStamp(join(codexHome, 'config.toml')),
        authStamp: fileStamp(join(codexHome, 'auth.json')),
      },
    });
    await host.rpc.request('thread/loaded/list', {});
    host.rpc.close();

    const registry = await readFile(join(dir, 'structured', 'app-server-registry.json'), 'utf8');
    expect(registry).not.toContain('sk-config-token');
    expect(registry).not.toContain('sk-auth-token');
    expect(registry).toContain('sha256:');
  }, 60_000);
});

async function writeFakeCodex(
  dir: string,
  paths: { record: string; serverLog: string },
): Promise<string> {
  const binary = join(dir, 'codex');
  await writeFile(
    binary,
    `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { WebSocketServer } from ${JSON.stringify(wsWrapper())};

const args = process.argv.slice(2);
if (args[0] !== 'app-server') {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', () => {});
  process.stdin.on('end', () => {
    writeFileSync(${JSON.stringify(paths.record)}, JSON.stringify({
      argv: args,
      key: process.env.OPENAI_API_KEY ?? null,
      proxy: process.env.HTTPS_PROXY ?? process.env.ALL_PROXY ?? null,
    }));
    console.log(JSON.stringify({ type: 'turn.completed' }));
    process.exit(0);
  });
} else {
  const endpoint = args[args.indexOf('--listen') + 1];
  appendFileSync(${JSON.stringify(paths.serverLog)}, process.pid + '\\n');
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer, path: '/' });
  wss.on('connection', (socket) => {
    socket.on('message', (data) => {
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (message.method === 'initialized' || message.id === undefined) return;
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
    });
  });
  httpServer.listen(endpoint.slice('unix://'.length));
}
`,
    'utf8',
  );
  await chmod(binary, 0o755);
  return binary;
}

function wsWrapper(): string {
  return new URL('wrapper.mjs', pathToFileURL(require.resolve('ws'))).href;
}
