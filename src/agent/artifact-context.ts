import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { writeFileAtomic } from '../platform/atomic-write';
import type { ArtifactDeliveryEnv } from './lark-channel-env';
import { subagentThreadId } from './subagents/types';

interface ThreadArtifactContext {
  version: 1;
  threadId: string;
  delivery: ArtifactDeliveryEnv & { scope: string };
  allowedRoots: string[];
}

/** A private, exact-thread handoff for App Servers whose environment is immutable. */
export function artifactContextDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.ARG_BRIDGE_ARTIFACT_CONTEXT_DIR || join(homedir(), '.lark-channel', 'artifact-contexts');
}

export async function bindThreadArtifactDelivery(
  threadId: string,
  delivery: ArtifactDeliveryEnv | undefined,
  allowedRoots: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!threadId || !delivery?.scope || !delivery.socketPath || !delivery.token) return;
  const directory = join(artifactContextDirectory(env), digest(threadId));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const path of [artifactContextDirectory(env), directory]) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || !ownedByCurrentUser(info.uid)) {
      throw new Error('Unsafe Bridge artifact context directory');
    }
    await chmod(path, 0o700);
  }
  const context: ThreadArtifactContext = {
    version: 1,
    threadId,
    delivery: { ...delivery, scope: delivery.scope },
    allowedRoots: [...new Set(allowedRoots)],
  };
  // One file per broker/scope prevents concurrent profiles from overwriting
  // another chat's binding. Ambiguous bindings are rejected by the reader.
  await writeFileAtomic(
    join(directory, `${digest(`${delivery.socketPath}\0${delivery.scope}`)}.json`),
    `${JSON.stringify(context)}\n`,
    { mode: 0o600 },
  );
}

export async function readThreadArtifactDelivery(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): Promise<ArtifactDeliveryEnv | undefined> {
  const threadId = env.CODEX_THREAD_ID;
  if (!threadId) return undefined;
  const directory = join(artifactContextDirectory(env), digest(threadId));
  if (!(await privateDirectory(artifactContextDirectory(env)))) return undefined;
  const current = await realpath(cwd).catch(() => undefined);
  if (!current) return undefined;
  const candidates: ArtifactDeliveryEnv[] = [];
  const names = await privateDirectory(directory) ? await readdir(directory) : [];
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
    try {
      const path = join(directory, name);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || !ownedByCurrentUser(info.uid) || !privateMode(info.mode) || info.size > 65_536) continue;
      const context = JSON.parse(await readFile(path, 'utf8')) as ThreadArtifactContext;
      const delivery = context.delivery;
      if (context.version !== 1 || context.threadId !== threadId ||
          !delivery || typeof delivery.scope !== 'string' || !delivery.scope ||
          typeof delivery.socketPath !== 'string' || !delivery.socketPath ||
          typeof delivery.token !== 'string' || !delivery.token ||
          !Array.isArray(context.allowedRoots)) continue;
      if (env.ARG_BRIDGE_ARTIFACT_SCOPE && delivery.scope !== env.ARG_BRIDGE_ARTIFACT_SCOPE) continue;
      if (env.ARG_BRIDGE_ARTIFACT_SOCKET && delivery.socketPath !== env.ARG_BRIDGE_ARTIFACT_SOCKET) continue;
      for (const root of context.allowedRoots) {
        if (typeof root !== 'string' || !isAbsolute(root)) continue;
        const canonical = await realpath(root).catch(() => undefined);
        if (canonical && within(current, canonical)) { candidates.push(delivery); break; }
      }
    } catch { /* A partial or stale entry is not a capability. */ }
  }
  if (candidates.length === 0) candidates.push(...await readWorkerArtifactDeliveries(threadId, env, current));
  if (candidates.length > 1) {
    throw new Error('当前 thread 绑定了多个 Bridge 文件发送会话，无法确定收件聊天；请在目标飞书会话中重新请求发送');
  }
  return candidates[0];
}

/** Old native controllers remain alive across bot upgrades. Their new workers
 * still persist exact native IDs, even though they cannot inherit new env. */
export async function bindArtifactWorkerState(
  stateFile: string,
  delivery: ArtifactDeliveryEnv,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!delivery.scope) return;
  const directory = join(artifactContextDirectory(env), 'workers');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const path of [artifactContextDirectory(env), directory]) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || !ownedByCurrentUser(info.uid)) throw new Error('Unsafe Bridge worker context directory');
    await chmod(path, 0o700);
  }
  await writeFileAtomic(join(directory, `${digest(`${stateFile}\0${delivery.socketPath}\0${delivery.scope}`)}.json`),
    `${JSON.stringify({ version: 1, stateFile, delivery })}\n`, { mode: 0o600 });
}

async function readWorkerArtifactDeliveries(threadId: string, env: NodeJS.ProcessEnv, cwd: string): Promise<ArtifactDeliveryEnv[]> {
  const directory = join(artifactContextDirectory(env), 'workers');
  const candidates: ArtifactDeliveryEnv[] = [];
  if (!(await privateDirectory(directory))) return candidates;
  const names = await readdir(directory).catch(() => [] as string[]);
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
    try {
      const entry = JSON.parse(await readPrivateFile(join(directory, name), 65_536));
      const delivery = entry.delivery as ArtifactDeliveryEnv;
      if (entry.version !== 1 || typeof entry.stateFile !== 'string' || !isAbsolute(entry.stateFile) ||
          typeof delivery?.scope !== 'string' || !delivery.scope ||
          typeof delivery.socketPath !== 'string' || !delivery.socketPath ||
          typeof delivery.token !== 'string' || !delivery.token) continue;
      if (env.ARG_BRIDGE_ARTIFACT_SCOPE && delivery.scope !== env.ARG_BRIDGE_ARTIFACT_SCOPE) continue;
      if (env.ARG_BRIDGE_ARTIFACT_SOCKET && delivery.socketPath !== env.ARG_BRIDGE_ARTIFACT_SOCKET) continue;
      const state = JSON.parse(await readPrivateFile(entry.stateFile, 32 * 1024 * 1024));
      if (state.version !== 1 || !Array.isArray(state.workers)) continue;
      for (const worker of state.workers) {
        if (!worker?.agent || typeof worker.agent.agentId !== 'string' || subagentThreadId(worker.agent) !== threadId || typeof worker.workspace !== 'string') continue;
        const root = await realpath(worker.workspace).catch(() => undefined);
        if (root && within(cwd, root)) candidates.push(delivery);
      }
    } catch { /* No matching live controller state. */ }
  }
  return [...new Map(candidates.map(delivery => [`${delivery.socketPath}\0${delivery.scope}`, delivery])).values()];
}

async function readPrivateFile(path: string, maxBytes: number): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || !ownedByCurrentUser(info.uid) || !privateMode(info.mode) || info.size > maxBytes) throw new Error('Unsafe Bridge artifact context file');
  return readFile(path, 'utf8');
}

async function privateDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink() && ownedByCurrentUser(info.uid) && privateMode(info.mode);
  } catch { return false; }
}

/** Metadata only: used by the trusted broker to watch authorized tool output. */
export async function artifactRelayThreadIds(socketPath: string, scopes: ReadonlySet<string>, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const directory = artifactContextDirectory(env);
  if (!(await privateDirectory(directory))) return [];
  const ids = new Set<string>();
  const matches = (delivery: ArtifactDeliveryEnv | undefined) => delivery?.socketPath === socketPath && Boolean(delivery.scope && scopes.has(delivery.scope));
  for (const name of await readdir(directory)) {
    if (!/^[a-f0-9]{64}$/u.test(name)) continue;
    const child = join(directory, name);
    if (!(await privateDirectory(child))) continue;
    for (const file of await readdir(child)) {
      if (!/^[a-f0-9]{64}\.json$/u.test(file)) continue;
      try {
        const context = JSON.parse(await readPrivateFile(join(child, file), 65_536));
        if (context.version === 1 && typeof context.threadId === 'string' && matches(context.delivery)) ids.add(context.threadId);
      } catch { /* No authorized context. */ }
    }
  }
  const workers = join(directory, 'workers');
  if (await privateDirectory(workers)) for (const file of await readdir(workers)) {
    if (!/^[a-f0-9]{64}\.json$/u.test(file)) continue;
    try {
      const entry = JSON.parse(await readPrivateFile(join(workers, file), 65_536));
      if (entry.version !== 1 || !matches(entry.delivery) || typeof entry.stateFile !== 'string' || !isAbsolute(entry.stateFile)) continue;
      const state = JSON.parse(await readPrivateFile(entry.stateFile, 32 * 1024 * 1024));
      if (state.version !== 1 || !Array.isArray(state.workers)) continue;
      for (const worker of state.workers) {
        if (!worker?.agent || typeof worker.agent.agentId !== 'string') continue;
        const id = subagentThreadId(worker.agent);
        if (id) ids.add(id);
      }
    } catch { /* An old controller may be between atomic snapshots. */ }
  }
  return [...ids];
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function ownedByCurrentUser(uid: number): boolean {
  return !process.getuid || uid === process.getuid();
}

function privateMode(mode: number): boolean {
  return process.platform === 'win32' || (mode & 0o077) === 0;
}

function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
