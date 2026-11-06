import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { artifactContextDirectory, artifactRelayThreadIds } from './artifact-context';
import type { ArtifactDeliveryEnv } from './lark-channel-env';

const PREFIX = 'ARG_BRIDGE_FILE_REQUEST_V1:';
const MAX_AGE_MS = 5 * 60_000;

export interface ArtifactRelayRequest {
  scope: string;
  threadId: string;
  cwd: string;
  path: string;
  caption?: string;
  nonce: string;
  createdAt: number;
}

/** No raw capability is put in tool output or sent to the model. */
export function artifactRelayRequest(artifact: ArtifactDeliveryEnv, path: string, caption?: string): string {
  if (!artifact.scope || !process.env.CODEX_THREAD_ID) throw new Error('当前沙箱无法连接 Bridge，且缺少精确 thread/scope，不能提交文件请求');
  const request: ArtifactRelayRequest = {
    scope: artifact.scope, threadId: process.env.CODEX_THREAD_ID, cwd: process.cwd(), path,
    ...(caption ? { caption } : {}), nonce: randomBytes(24).toString('hex'), createdAt: Date.now(),
  };
  const payload = Buffer.from(JSON.stringify(request)).toString('base64url');
  return `${PREFIX}${payload}.${signature(payload, artifact.token)}`;
}

export function verifiedArtifactRelayRequests(text: string, threadId: string,
  tokens: ReadonlyMap<string, { scope: string; token: string }>): ArtifactRelayRequest[] {
  const requests: ArtifactRelayRequest[] = [];
  for (const match of text.matchAll(/ARG_BRIDGE_FILE_REQUEST_V1:([A-Za-z0-9_-]{1,22000})\.([a-f0-9]{64})/gu)) {
    try {
      const payload = match[1]!;
      const request = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ArtifactRelayRequest;
      if (request.threadId !== threadId || typeof request.scope !== 'string' ||
          typeof request.path !== 'string' || typeof request.cwd !== 'string' ||
          (request.caption !== undefined && typeof request.caption !== 'string') ||
          !/^[a-f0-9]{48}$/u.test(request.nonce) || !Number.isFinite(request.createdAt) ||
          Date.now() - request.createdAt > MAX_AGE_MS || request.createdAt - Date.now() > 10_000) continue;
      const grant = tokens.get(request.scope);
      if (!grant || !timingSafeEqual(Buffer.from(match[2]!, 'hex'), Buffer.from(signature(payload, grant.token), 'hex'))) continue;
      requests.push(request);
    } catch { /* Untrusted model/tool text cannot authorize delivery. */ }
  }
  return requests;
}

function signature(payload: string, token: string): string {
  return createHmac('sha256', token).update(`arg-bridge-file-v1\0${payload}`).digest('hex');
}

export interface ArtifactRelaySource { threadId: string; path: string }

/** Incremental reads only; a large rollout is never loaded in full. */
export class ArtifactRelayReader {
  private offsets = new Map<string, { offset: number; tail: string }>();
  async read(source: ArtifactRelaySource): Promise<string> {
    const info = await lstat(source.path);
    if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) return '';
    const previous = this.offsets.get(source.path);
    const offset = previous && previous.offset <= info.size ? previous.offset : Math.max(0, info.size - 256 * 1024);
    if (offset === info.size) return '';
    const file = await open(source.path, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(512 * 1024, info.size - offset));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      const text = (previous?.tail ?? '') + buffer.subarray(0, bytesRead).toString('utf8');
      const end = text.lastIndexOf('\n');
      this.offsets.set(source.path, { offset: offset + bytesRead, tail: end >= 0 ? text.slice(end + 1) : text.slice(-65_536) });
      if (end < 0) return '';
      return text.slice(0, end).split('\n').flatMap(line => {
        try {
          const entry = JSON.parse(line);
          // Only actual tool output can carry a request. User prompts and
          // model reasoning/messages are never treated as delivery commands.
          return entry.type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(entry.payload?.type) && typeof entry.payload.output === 'string'
            ? [entry.payload.output] : [];
        } catch { return []; }
      }).join('\n');
    } finally { await file.close(); }
  }
}

export async function claimArtifactRelayRequest(nonce: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const directory = join(artifactContextDirectory(env), 'relay-receipts');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) return false;
  try {
    const file = await open(join(directory, `${nonce}.json`), 'wx', 0o600);
    await file.close();
    return true;
  } catch (err) { if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false; throw err; }
}

/** UUIDv7 thread IDs locate their rollout day without scanning old history. */
export async function findArtifactRelaySources(homes: readonly string[], threadIds: readonly string[]): Promise<ArtifactRelaySource[]> {
  const sources: ArtifactRelaySource[] = [];
  for (const threadId of new Set(threadIds)) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(threadId)) continue;
    const timestamp = Number.parseInt(threadId.replaceAll('-', '').slice(0, 12), 16);
    for (const home of homes) for (const offset of [-86_400_000, 0, 86_400_000]) {
      const day = new Date(timestamp + offset).toISOString().slice(0, 10).split('-');
      const directory = join(home, 'sessions', ...day);
      for (const name of await readdir(directory).catch(() => [] as string[])) {
        if (name.endsWith(`-${threadId}.jsonl`)) sources.push({ threadId, path: join(directory, name) });
      }
    }
  }
  return sources;
}

export function createArtifactRelaySourceResolver(profileDir: string, codexHome?: string,
  env: NodeJS.ProcessEnv = process.env): (socketPath: string, scopes: ReadonlySet<string>) => Promise<ArtifactRelaySource[]> {
  let cached: ArtifactRelaySource[] = [];
  let refreshedAt = 0;
  return async (socketPath, scopes) => {
    if (Date.now() - refreshedAt < 3000) return cached;
    const homes = new Set([codexHome ?? env.CODEX_HOME ?? join(homedir(), '.codex')]);
    try {
      const bindings = JSON.parse(await readFile(join(profileDir, 'structured', 'tmux-bindings.json'), 'utf8'));
      for (const binding of Object.values(bindings.bindings ?? {}) as Array<{ target?: { structured?: { codexHome?: string } } }>) {
        const home = binding.target?.structured?.codexHome;
        if (home) homes.add(home);
      }
    } catch { /* No external native bindings. */ }
    const dataDirs = new Set<string>();
    const generated = join(profileDir, 'structured', 'cc-switch', 'mixagents-data');
    for (const name of await readdir(generated).catch(() => [] as string[])) {
      if (/^[a-f0-9]{16}$/u.test(name)) dataDirs.add(join(generated, name));
    }
    try {
      const path = env.MIXAGENTS_BROKER_CONFIG || join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'mixagents', 'broker.json');
      const config = JSON.parse(await readFile(path, 'utf8'));
      if (typeof config.dataDir === 'string') dataDirs.add(config.dataDir);
    } catch { /* No manually configured Broker. */ }
    for (const dataDir of dataDirs) {
      const runtimes = join(dataDir, 'runtimes');
      for (const name of await readdir(runtimes).catch(() => [] as string[])) {
        if (/^[A-Za-z0-9._-]+$/u.test(name)) homes.add(join(runtimes, name));
      }
    }
    cached = await findArtifactRelaySources([...homes], await artifactRelayThreadIds(socketPath, scopes, env));
    refreshedAt = Date.now();
    return cached;
  };
}
