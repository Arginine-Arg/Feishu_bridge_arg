import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { RpcClient } from '../../src/agent/structured/rpc.js';
import { resumeCodexThread } from '../../src/agent/structured/permissions.js';

const require = createRequire(import.meta.url);
const cleanups: Array<() => Promise<void>> = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    try { process.kill(-(child.pid!), 'SIGTERM'); } catch { /* gone */ }
    try { process.kill(child.pid!, 'SIGTERM'); } catch { /* gone */ }
  }
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('provider-aware Codex resume', () => {
  it('rebinds only after a missing historical provider and then resumes', async () => {
    const fixture = await startFakeServer('provider-missing');
    const calls = await fixture.resume();

    expect(calls).toEqual([
      { threadId: 'thread-old', cwd: '/repo' },
      { threadId: 'thread-old', cwd: '/repo', modelProvider: 'custom', model: 'model-new' },
    ]);
  }, 30_000);

  it('does not touch the thread provider/model on a normal resume', async () => {
    const fixture = await startFakeServer('normal');
    const calls = await fixture.resume();

    expect(calls).toEqual([{ threadId: 'thread-old', cwd: '/repo' }]);
  }, 30_000);

  it('retries permission overrides first and keeps provider defaults out of it', async () => {
    const fixture = await startFakeServer('permission-then-normal');
    const calls = await fixture.resume({
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    });

    expect(calls).toEqual([
      {
        threadId: 'thread-old',
        cwd: '/repo',
        sandbox: 'danger-full-access',
        approvalPolicy: 'never',
      },
      { threadId: 'thread-old', cwd: '/repo' },
    ]);
  }, 30_000);

  it('combines permission and provider retries in the correct order', async () => {
    const fixture = await startFakeServer('permission-then-provider');
    const calls = await fixture.resume({
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    });

    expect(calls).toEqual([
      {
        threadId: 'thread-old',
        cwd: '/repo',
        sandbox: 'danger-full-access',
        approvalPolicy: 'never',
      },
      { threadId: 'thread-old', cwd: '/repo' },
      { threadId: 'thread-old', cwd: '/repo', modelProvider: 'custom', model: 'model-new' },
    ]);
  }, 30_000);
});

async function startFakeServer(mode: string): Promise<{
  resume(overrides?: Record<string, unknown>): Promise<unknown[]>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'provider-resume-process-'));
  const home = join(dir, 'codex-home');
  const socket = join(dir, 'server.sock');
  const callsFile = join(dir, 'calls.json');
  const binary = join(dir, 'codex');
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'config-placeholder'), '');
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'config.toml'), 'model = "model-new"\nmodel_provider = "custom"\n');
  await writeFile(binary, fakeSource(callsFile), 'utf8');
  await chmod(binary, 0o755);

  const child = spawn(binary, ['app-server', '--listen', `unix://${socket}`], {
    env: { ...process.env, CODEX_HOME: home, FAKE_MODE: mode },
    detached: true,
    stdio: 'ignore',
  });
  children.push(child);
  await waitForSocket(socket, 5_000);

  const client = await RpcClient.connect(`ws+unix://${socket}:/`, { codexHome: home });
  cleanups.push(async () => client.close());
  await client.initialize();

  return {
    async resume(overrides: Record<string, unknown> = {}) {
      const result = await resumeCodexThread(
        client,
        { threadId: 'thread-old', cwd: '/repo' },
        overrides,
      );
      expect(result.thread?.id).toBe('thread-old');
      return JSON.parse(await readFile(callsFile, 'utf8')) as unknown[];
    },
  };
}

function fakeSource(callsFile: string): string {
  return `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { WebSocketServer } from ${JSON.stringify(new URL('wrapper.mjs', pathToFileURL(require.resolve('ws'))).href)};

const mode = process.env.FAKE_MODE || 'normal';
const calls = [];
const args = process.argv.slice(2);
const socketPath = args[args.indexOf('--listen') + 1].slice('unix://'.length);
const httpServer = createServer();
const wss = new WebSocketServer({ server: httpServer, path: '/' });
wss.on('connection', (socket) => {
  socket.on('message', (data) => {
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    if (message.method === 'initialized' || message.id === undefined) return;
    if (message.method === 'initialize') {
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { codexHome: process.env.CODEX_HOME } }));
      return;
    }
    if (message.method === 'thread/resume') {
      calls.push(message.params);
      writeFileSync(${JSON.stringify(callsFile)}, JSON.stringify(calls));
      const index = calls.length;
      const hasPermission = message.params.sandbox !== undefined || message.params.approvalPolicy !== undefined;
      if (mode === 'permission-then-normal' && index === 1 && hasPermission) {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Permission overrides are not supported when resuming a remote task.' } }));
        return;
      }
      if (mode === 'permission-then-provider' && index === 1 && hasPermission) {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Permission overrides are not supported when resuming a remote task.' } }));
        return;
      }
      if (mode === 'permission-then-provider' && index === 2) {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'failed to load configuration: Model provider \`deepseek\` not found' } }));
        return;
      }
      if (mode === 'provider-missing' && message.params.modelProvider === undefined) {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'failed to load configuration: Model provider \`deepseek\` not found' } }));
        return;
      }
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { thread: { id: message.params.threadId } } }));
      return;
    }
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
  });
});
httpServer.listen(socketPath);
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
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  throw new Error(`fake server socket did not appear: ${path}`);
}
