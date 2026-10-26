import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { findLoadedThreadHost } from '../../../src/agent/structured/native-bridge';
import { recordHost } from '../../../src/agent/structured/host-registry';

const require = createRequire(import.meta.url);
const children: ChildProcess[] = [];
const cleanups: Array<() => Promise<void>> = [];
const linuxIt = process.platform === 'linux' && spawnSync('flock', ['--version']).status === 0
  ? it
  : it.skip;

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (!child.pid) continue;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
    try { process.kill(child.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
});

linuxIt('follows the writer-lock owner instead of a different host that can read history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arg-bridge-thread-owner-'));
  const codexHome = join(root, 'codex-home');
  const profileDir = join(root, 'profile');
  const ownerDirectory = join(root, 'owner');
  const decoyDirectory = join(root, 'decoy');
  const ownerCalls = join(root, 'owner-calls.json');
  const decoyCalls = join(root, 'decoy-calls.json');
  const script = join(root, 'fake-codex.mjs');
  const threadId = '01a179c2-b81c-7e70-b385-eb4b84f41eb1';
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(join(codexHome, 'thread-writer-locks'), { recursive: true }),
    mkdir(profileDir, { recursive: true }),
    mkdir(ownerDirectory, { recursive: true }),
    mkdir(decoyDirectory, { recursive: true }),
  ]);
  await writeFile(script, fakeServerSource(), 'utf8');
  await chmod(script, 0o755);

  const ownerSocket = join(ownerDirectory, 'server.sock');
  const decoySocket = join(decoyDirectory, 'server.sock');
  const lockPath = join(codexHome, 'thread-writer-locks', `${threadId}.lock`);
  const owner = spawn('flock', [
    '-x', lockPath,
    process.execPath, script,
    'app-server', '--listen', `unix://${ownerSocket}`,
  ], {
    env: {
      ...process.env,
      FAKE_CODEX_CALLS: ownerCalls,
      FAKE_LOADED_THREADS: threadId,
      FAKE_READABLE_THREADS: threadId,
    },
    detached: true,
    stdio: 'ignore',
  });
  const decoy = spawn(process.execPath, [
    script, 'app-server', '--listen', `unix://${decoySocket}`,
  ], {
    env: {
      ...process.env,
      FAKE_CODEX_CALLS: decoyCalls,
      FAKE_LOADED_THREADS: '',
      // This reproduces the old false positive: history is readable here even
      // though another process owns the live thread.
      FAKE_READABLE_THREADS: threadId,
    },
    detached: true,
    stdio: 'ignore',
  });
  children.push(owner, decoy);
  await Promise.all([waitForSocket(ownerSocket), waitForSocket(decoySocket)]);
  await recordHost(profileDir, {
    directory: decoyDirectory,
    pid: decoy.pid!,
    startedAt: Date.now(),
    binary: 'codex',
    fingerprint: {
      credentials: {},
      networkMode: 'inherit',
    },
  });

  const host = await findLoadedThreadHost(profileDir, threadId, { CODEX_HOME: codexHome });
  expect(host?.endpoint).toBe(`unix://${ownerSocket}`);
  const resumed = await host!.rpc.request('thread/resume', { threadId });
  expect(resumed.thread.id).toBe(threadId);
  host!.rpc.close();

  const ownerMethods = await readCalls(ownerCalls);
  expect(ownerMethods).toEqual(expect.arrayContaining(['initialize', 'thread/loaded/list', 'thread/resume']));
  expect(ownerMethods).not.toContain('thread/read');
  await expect(readCalls(decoyCalls)).rejects.toMatchObject({ code: 'ENOENT' });
});

function fakeServerSource(): string {
  const wrapper = new URL('wrapper.mjs', pathToFileURL(require.resolve('ws'))).href;
  return `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { WebSocketServer } from ${JSON.stringify(wrapper)};

const args = process.argv.slice(2);
const endpoint = args[args.indexOf('--listen') + 1];
const socketPath = endpoint.slice('unix://'.length);
const callsFile = process.env.FAKE_CODEX_CALLS;
const loaded = (process.env.FAKE_LOADED_THREADS || '').split(',').filter(Boolean);
const readable = (process.env.FAKE_READABLE_THREADS || '').split(',').filter(Boolean);
const calls = [];
const server = createServer();
const wss = new WebSocketServer({ server, path: '/' });
wss.on('connection', socket => socket.on('message', raw => {
  const message = JSON.parse(raw.toString());
  if (message.id === undefined) return;
  calls.push(message.method);
  writeFileSync(callsFile, JSON.stringify(calls));
  if (message.method === 'initialize') {
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
      codexHome: process.env.CODEX_HOME,
      userAgent: 'fake-codex/0',
      platformFamily: 'unix',
      platformOs: 'linux',
    } }));
    return;
  }
  if (message.method === 'thread/loaded/list') {
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { data: loaded, nextCursor: null } }));
    return;
  }
  if (message.method === 'thread/read') {
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: readable.includes(message.params.threadId)
      ? { thread: { id: message.params.threadId, status: { type: 'idle' }, turns: [] } }
      : { thread: null } }));
    return;
  }
  if (message.method === 'thread/resume') {
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
      thread: { id: message.params.threadId },
      approvalPolicy: 'never',
      sandbox: { type: 'dangerFullAccess' },
    } }));
    return;
  }
  socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
}));
server.listen(socketPath);
`;
}

async function waitForSocket(path: string, timeoutMs = 5_000): Promise<void> {
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

async function readCalls(path: string): Promise<string[]> {
  return JSON.parse(await readFile(path, 'utf8')) as string[];
}
