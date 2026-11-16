import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import { withConfigFileLock } from '../../config/profile-store';
import { writeFileAtomic } from '../../platform/atomic-write';
import { codexHostRuntimeDirectory, processAlive } from './host-registry';
import { log } from '../../core/logger';

interface NativeLease {
  pid: number;
  processStart?: string;
  profile: string;
  token: string;
  preparing: boolean;
}

async function processStart(pid: number): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/u)[19];
  } catch { return undefined; }
}

async function isLive(entry: { pid: number; processStart?: string }): Promise<boolean> {
  return processAlive(entry.pid) &&
    (!entry.processStart || entry.processStart === await processStart(entry.pid));
}

async function threadDirectory(codexHome: string, threadId: string): Promise<string> {
  const home = await realpath(codexHome);
  const key = createHash('sha256').update(threadId).digest('hex');
  const directory = join(home, 'arg-bridge', 'thread-clients', key);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

async function readOptional<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

/** This is Bridge bookkeeping, never Codex's writer-lock file. */
export async function acquireNativeThreadLease(codexHome: string, threadId: string, profile: string): Promise<{
  attached(): Promise<void>;
  release(): Promise<void>;
}> {
  const file = join(await threadDirectory(codexHome, threadId), 'native.json');
  const lease: NativeLease = { pid: process.pid, processStart: await processStart(process.pid), profile, token: randomUUID(), preparing: true };
  await withConfigFileLock(file, async () => {
    const previous = await readOptional<NativeLease>(file);
    if (previous && await isLive(previous)) {
      throw new Error(`thread ${threadId} 已有 native 控制连接（PID ${previous.pid}, profile=${previous.profile}）；未启动竞争 writer。`);
    }
    await writeFileAtomic(file, JSON.stringify(lease), { mode: 0o600 });
  });
  const update = async (remove: boolean): Promise<void> => withConfigFileLock(file, async () => {
    if ((await readOptional<NativeLease>(file))?.token !== lease.token) return;
    if (remove) await rm(file, { force: true });
    else await writeFileAtomic(file, JSON.stringify({ ...lease, preparing: false }), { mode: 0o600 });
  });
  return { attached: () => update(false), release: () => update(true) };
}

/** Block new Bot input while another process is transferring this thread. */
export async function assertThreadNotHandingOff(codexHome: string, threadId: string): Promise<void> {
  // Do not create coordination files on the ordinary prompt path. Older or
  // test servers can report a home that is not mounted on this client.
  let home: string;
  try { home = await realpath(codexHome); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const key = createHash('sha256').update(threadId).digest('hex');
  const file = join(home, 'arg-bridge', 'thread-clients', key, 'native.json');
  const lease = await readOptional<NativeLease>(file);
  if (lease?.preparing && lease.pid !== process.pid && await isLive(lease)) {
    throw new Error(`thread ${threadId} 正在交接 provider（PID ${lease.pid}, profile=${lease.profile}）；未发送新任务，请稍后重试。`);
  }
}

/** Serialize connection establishment with the final idle-host reclaim check. */
export async function withHostConnectionLock<T>(socketPath: string, action: () => Promise<T>): Promise<T> {
  const canonical = await realpath(socketPath);
  const gate = codexHostRuntimeDirectory(canonical, 'connection-gate', canonical);
  await mkdir(gate, { recursive: true, mode: 0o700 });
  return withConfigFileLock(join(gate, 'connect'), action);
}

interface ThreadClient {
  pid: number;
  processStart?: string;
  profile: string;
  endpoint: string;
  socket: string;
  token: string;
}

async function canonicalEndpoint(endpoint: string): Promise<string> {
  if (!endpoint.startsWith('unix://')) return endpoint;
  try { return `unix://${await realpath(endpoint.slice('unix://'.length))}`; }
  catch { return endpoint; }
}

/**
 * A separate control socket addresses the *real* subscriber's RPC connection.
 * A diagnostic connection cannot unsubscribe another connection in Codex.
 */
export async function registerThreadHandoffClient(input: {
  codexHome: string;
  threadId: string;
  endpoint: string;
  profile: string;
  inspect(): Promise<void>;
  release(): Promise<void>;
}): Promise<() => Promise<void>> {
  if (process.platform === 'win32') return async () => {};
  const token = randomUUID();
  const directory = codexHostRuntimeDirectory(input.codexHome, `handoff:${token}`, input.threadId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const socket = join(directory, 'server.sock');
  const record = join(await threadDirectory(input.codexHome, input.threadId), `${token}.json`);
  const server = createServer(client => {
    client.setTimeout(12_000, () => client.destroy());
    let buffer = '';
    let handled = false;
    client.on('error', () => {});
    client.on('data', data => {
      if (handled) return;
      buffer += data.toString();
      if (buffer.length > 4096) { client.destroy(); return; }
      if (!buffer.includes('\n')) return;
      handled = true;
      void (async () => {
        try {
          const request = JSON.parse(buffer.split('\n')[0]!);
          if (request.token !== token || !['inspect', 'release'].includes(request.action)) throw new Error('Invalid handoff request');
          await input.inspect();
          if (request.action === 'release') await input.release();
          client.end(JSON.stringify({ ok: true }) + '\n');
        } catch (error) {
          client.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) + '\n');
        }
      })();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, () => { server.off('error', reject); resolve(); });
    });
    server.unref();
    const entry: ThreadClient = { pid: process.pid, processStart: await processStart(process.pid), profile: input.profile, endpoint: await canonicalEndpoint(input.endpoint), socket, token };
    await writeFileAtomic(record, JSON.stringify(entry), { mode: 0o600 });
  } catch (error) {
    server.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return async () => {
    // Do not await server.close: this may be called from its own release RPC.
    server.close();
    await rm(record, { force: true });
    await rm(directory, { recursive: true, force: true });
  };
}

function askClient(client: ThreadClient, action: 'inspect' | 'release'): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(client.socket);
    let data = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('订阅者交接超时；结果未知，未终止旧 Server')); }, 12_000);
    const finish = (error?: Error) => { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(); };
    socket.once('error', finish);
    socket.once('connect', () => socket.write(JSON.stringify({ token: client.token, action }) + '\n'));
    socket.on('data', chunk => {
      data += chunk.toString();
      if (data.length > 16_384) { finish(new Error('Invalid subscriber response')); return; }
      if (!data.includes('\n')) return;
      try {
        const result = JSON.parse(data.split('\n')[0]!);
        finish(result.ok === true ? undefined : new Error(result.error ?? '订阅者拒绝交接'));
      } catch (error) { finish(error as Error); }
    });
    socket.once('end', () => { if (!data.includes('\n')) finish(new Error('订阅者未确认交接')); });
  });
}

export async function releaseThreadHandoffClients(codexHome: string, threadId: string, endpoint: string): Promise<void> {
  const directory = await threadDirectory(codexHome, threadId);
  const clients: ThreadClient[] = [];
  const target = await canonicalEndpoint(endpoint);
  for (const name of await readdir(directory)) {
    if (name === 'native.json' || !name.endsWith('.json')) continue;
    const file = join(directory, name);
    const entry = await readOptional<ThreadClient>(file);
    if (!entry) continue;
    if (!await isLive(entry)) { await rm(file, { force: true }); continue; }
    if (await canonicalEndpoint(entry.endpoint) === target) clients.push(entry);
  }
  // Inspect everyone before releasing any subscriber. Each release also
  // rechecks activity, since a user can send input during the preflight.
  for (const action of ['inspect', 'release'] as const) {
    for (const client of clients) {
      try { await askClient(client, action); }
      catch (error) {
        throw new Error(`thread ${threadId} 的订阅者未能交接（PID ${client.pid}, profile=${client.profile}）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (clients.length) log.info('agent', 'provider-thread-subscribers-released', { threadId, pids: clients.map(client => client.pid) });
}
