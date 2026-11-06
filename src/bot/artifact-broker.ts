import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { LarkChannel } from '@larksuite/channel';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';
import { ArtifactRelayReader, claimArtifactRelayRequest, verifiedArtifactRelayRequests, type ArtifactRelaySource } from '../agent/artifact-relay';

export interface ArtifactDeliveryGrant {
  statePath?: string;
  scope: string;
  socketPath: string;
  token: string;
}

export interface ArtifactBrokerIssueInput {
  scope: string;
  chatId: string;
  replyTo: string;
  replyInThread?: boolean;
  allowedRoots: readonly string[];
  maxFileBytes: number;
  /**
   * A live terminal process outlives individual turns, so its environment can
   * only carry one token. Keep that opaque token stable for the scope while
   * refreshing its reply target and allowed roots on each accepted run.
   */
  persistent?: boolean;
}

interface ActiveGrant extends ArtifactBrokerIssueInput {
  token: string;
  updatedAt?: number;
}

interface PersistentGrantsFile {
  version: 1;
  grants: ActiveGrant[];
}

interface ArtifactRequest {
  token?: unknown;
  cwd?: unknown;
  path?: unknown;
  caption?: unknown;
}

interface ArtifactResponse {
  ok: boolean;
  message: string;
}

/**
 * The only process allowed to upload an agent-produced file.  Agents receive
 * an opaque profile-scope token; they cannot select a chat, reply target or
 * bypass the workspace/media policy.
 */
export class ArtifactBroker {
  private readonly grants = new Map<string, ActiveGrant>();
  private readonly persistentTokensByScope = new Map<string, string>();
  private server: Server | undefined;
  private saving: Promise<void> = Promise.resolve();
  private relayTimer?: NodeJS.Timeout;
  private relaying: Promise<void> | undefined;
  private readonly relayReader = new ArtifactRelayReader();

  private readonly socketPath: string;

  constructor(
    socketPath: string,
    private readonly channel: LarkChannel,
    private readonly allowLocalFileRoot: (root: string) => Promise<boolean>,
    /**
     * A managed tmux agent inherits its environment only once. Persisting its
     * opaque capability is therefore necessary for a restarted bridge to
     * continue serving that same terminal. This is intentionally profile-local
     * and written 0600. Every chat scope now uses this stable capability so
     * tmux, structured main sessions and reusable side workers can recover.
     */
    private readonly persistentStatePath?: string,
    private readonly relaySources?: (socketPath: string, scopes: ReadonlySet<string>) => Promise<ArtifactRelaySource[]>,
  ) {
    this.socketPath = artifactBrokerSocketPath(socketPath);
  }

  async start(): Promise<void> {
    await this.loadPersistentGrants();
    if (process.platform !== 'win32') {
      await mkdir(dirname(this.socketPath), { recursive: true });
      await rm(this.socketPath, { force: true }).catch(() => {});
    }
    this.server = createServer((socket) => {
      void this.handle(socket);
    });
    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      server.once('error', reject);
      server.listen(this.socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    if (this.relaySources) {
      this.relayTimer = setInterval(() => { void this.pollRelay(); }, 1000);
      this.relayTimer.unref();
    }
  }

  issue(input: ArtifactBrokerIssueInput): ArtifactDeliveryGrant {
    if (input.persistent) {
      const existingToken = this.persistentTokensByScope.get(input.scope);
      const existing = existingToken ? this.grants.get(existingToken) : undefined;
      if (existing) {
        // Do not revoke or replace a token already exported into the live CLI
        // environment. The policy-approved roots are updated separately by
        // activate() after this run's workspace checks succeed.
        existing.chatId = input.chatId;
        existing.replyTo = input.replyTo;
        existing.replyInThread = input.replyInThread;
        existing.maxFileBytes = input.maxFileBytes;
        existing.updatedAt = Date.now();
        existing.allowedRoots = [
          ...new Set([...existing.allowedRoots, ...input.allowedRoots]),
        ];
        this.schedulePersist();
        return this.delivery(existing.scope, existing.token);
      }
      this.persistentTokensByScope.delete(input.scope);
    }
    const token = randomBytes(32).toString('base64url');
    this.grants.set(token, { ...input, token, updatedAt: Date.now() });
    if (input.persistent) {
      this.persistentTokensByScope.set(input.scope, token);
      this.schedulePersist();
    }
    return this.delivery(input.scope, token);
  }

  private delivery(scope: string, token: string): ArtifactDeliveryGrant {
    return { scope, socketPath: this.socketPath, token,
      ...(this.persistentStatePath ? { statePath: this.persistentStatePath } : {}) };
  }

  revoke(token: string | undefined): void {
    if (!token) return;
    const grant = this.grants.get(token);
    this.grants.delete(token);
    if (grant?.persistent) {
      if (this.persistentTokensByScope.get(grant.scope) === token) {
        this.persistentTokensByScope.delete(grant.scope);
      }
      this.schedulePersist();
    }
  }

  activate(token: string, allowedRoots: readonly string[]): boolean {
    const grant = this.grants.get(token);
    if (!grant) return false;
    grant.allowedRoots = [
      ...new Set([...grant.allowedRoots, ...allowedRoots]),
    ];
    grant.updatedAt = Date.now();
    if (grant.persistent) this.schedulePersist();
    return true;
  }

  /** Persistent grants are restored only into their matching managed tmux scope. */
  persistentDeliveries(): ArtifactDeliveryGrant[] {
    return [...this.persistentTokensByScope.entries()].flatMap(([scope, token]) => {
      const grant = this.grants.get(token);
      return grant?.persistent ? [this.delivery(scope, token)] : [];
    });
  }

  async close(): Promise<void> {
    if (this.relayTimer) clearInterval(this.relayTimer);
    await this.relaying;
    await this.flush();
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (process.platform !== 'win32') await rm(this.socketPath, { force: true }).catch(() => {});
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  /** Signed tool-output relay keeps read-only/offline sandboxes intact. */
  async pollRelay(): Promise<void> {
    if (!this.relaySources || this.relaying) return;
    this.relaying = (async () => {
      const tokens = new Map([...this.grants.values()].map(grant => [grant.scope, grant]));
      if (!tokens.size) return;
      for (const source of await this.relaySources!(this.socketPath, new Set(tokens.keys()))) {
        const output = await this.relayReader.read(source).catch(() => '');
        for (const request of verifiedArtifactRelayRequests(output, source.threadId, tokens)) {
          if (!(await claimArtifactRelayRequest(request.nonce))) continue;
          const grant = tokens.get(request.scope)!;
          try {
            await this.deliver({ token: grant.token, cwd: request.cwd, path: request.path, caption: request.caption });
          } catch (err) {
            const message = err instanceof Error ? err.message : '文件发送失败';
            await this.channel.send(grant.chatId, { markdown: `飞书附件未发送成功：${message}` },
              { replyTo: grant.replyTo, ...(grant.replyInThread ? { replyInThread: true } : {}) });
          }
        }
      }
    })().catch(err => {
      log.warn('artifact', 'sandbox-relay-failed', { message: err instanceof Error ? err.message : String(err) });
    });
    try { await this.relaying; } finally { this.relaying = undefined; }
  }

  private async handle(socket: Socket): Promise<void> {
    let input = '';
    socket.setEncoding('utf8');
    socket.setTimeout(15_000, () => socket.destroy());
    socket.on('data', (chunk: string) => {
      input += chunk;
      if (input.length > 16_384) socket.destroy();
      if (input.includes('\n')) {
        socket.pause();
        void this.dispatch(socket, input.slice(0, input.indexOf('\n')));
      }
    });
  }

  private async dispatch(socket: Socket, line: string): Promise<void> {
    let response: ArtifactResponse;
    try {
      const request = JSON.parse(line) as ArtifactRequest;
      response = await this.deliver(request);
    } catch (err) {
      response = {
        ok: false,
        message: err instanceof Error ? err.message : '文件发送请求无效',
      };
    }
    socket.end(`${JSON.stringify(response)}\n`);
  }

  private async deliver(request: ArtifactRequest): Promise<ArtifactResponse> {
    if (typeof request.token !== 'string') throw new Error('无效的 bridge 文件能力令牌');
    const grant = this.grants.get(request.token);
    if (!grant) throw new Error('文件能力令牌已失效；客户端会尝试从当前 profile 的最新授权恢复');
    if (typeof request.path !== 'string' || !request.path.trim()) {
      throw new Error('请提供要发送的文件路径');
    }
    if (isAbsolute(request.path)) throw new Error('文件路径必须相对当前工作目录');
    if (request.path.split(/[\\/]+/u).some((part) => part === '..')) {
      throw new Error('文件路径不能包含 ..');
    }
    if (grant.allowedRoots.length === 0) {
      throw new Error('当前任务尚未授权文件目录；请在当前任务中重新请求发送');
    }
    let roots = grant.allowedRoots;
    if (request.cwd !== undefined) {
      if (typeof request.cwd !== 'string' || !isAbsolute(request.cwd)) throw new Error('无效的文件发送工作目录');
      const cwd = await realpath(request.cwd);
      if (!(await findCanonicalAllowedRoot(cwd, grant.allowedRoots))) throw new Error('文件发送工作目录不在当前任务允许的目录内');
      roots = [cwd];
    }
    let requested: string | undefined;
    let entry: Awaited<ReturnType<typeof lstat>> | undefined;
    for (const root of roots) {
      const candidate = resolve(root, request.path);
      const candidateEntry = await lstat(candidate).catch(() => undefined);
      if (!candidateEntry) continue;
      requested = candidate;
      entry = candidateEntry;
      break;
    }
    if (!entry) throw new Error('文件不存在或不可访问');
    if (entry.isSymbolicLink()) throw new Error('不允许发送符号链接');
    if (!entry.isFile()) throw new Error('只能发送普通文件');
    if (entry.size > grant.maxFileBytes) throw new Error(`文件超过发送上限（${grant.maxFileBytes} B）`);
    const resolved = await realpath(requested!);
    const root = await findCanonicalAllowedRoot(resolved, grant.allowedRoots);
    if (!root) throw new Error('文件不在当前任务允许的目录内');
    if (!(await this.allowLocalFileRoot(root))) throw new Error('bridge 未允许该文件目录');

    const caption = normalizeCaption(request.caption);
    await this.channel.send(
      grant.chatId,
      { file: { source: resolved, fileName: basename(resolved) } },
      { replyTo: grant.replyTo, ...(grant.replyInThread ? { replyInThread: true } : {}) },
    );
    if (caption) {
      await this.channel.send(
        grant.chatId,
        { markdown: caption },
        { replyTo: grant.replyTo, ...(grant.replyInThread ? { replyInThread: true } : {}) },
      );
    }
    log.info('artifact', 'delivered', {
      scope: grant.scope,
      name: basename(resolved),
      size: entry.size,
    });
    return { ok: true, message: `已发送 ${basename(resolved)}` };
  }

  private async loadPersistentGrants(): Promise<void> {
    if (!this.persistentStatePath) return;
    try {
      const raw = JSON.parse(await readFile(this.persistentStatePath, 'utf8')) as Partial<PersistentGrantsFile>;
      if (raw.version !== 1 || !Array.isArray(raw.grants)) return;
      for (const item of raw.grants) {
        if (!isPersistentGrant(item)) continue;
        this.grants.set(item.token, item);
        this.persistentTokensByScope.set(item.scope, item.token);
      }
      log.info('artifact', 'persistent-grants-restored', { count: this.persistentTokensByScope.size });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('artifact', 'persistent-grants-load-failed', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private schedulePersist(): void {
    if (!this.persistentStatePath) return;
    this.saving = this.saving
      .then(async () => {
        const content: PersistentGrantsFile = {
          version: 1,
          grants: [...this.grants.values()].filter((grant) => grant.persistent),
        };
        await writeFileAtomic(this.persistentStatePath!, `${JSON.stringify(content, null, 2)}\n`, {
          mode: 0o600,
        });
      })
      .catch((err: unknown) => {
        log.warn('artifact', 'persistent-grants-save-failed', {
          message: err instanceof Error ? err.message : String(err),
        });
      });
  }
}

export function isPathWithinRoot(path: string, root: string): boolean {
  const pathRelative = relative(root, path);
  return pathRelative === '' ||
    (pathRelative !== '..' && !pathRelative.startsWith(`..${sep}`) && !isAbsolute(pathRelative));
}

/**
 * Node only supports IPC sockets through named pipes on Windows. Derive a
 * stable, opaque pipe name from the profile-local socket path so a persisted
 * live terminal capability still works after the bridge restarts.
 */
export function artifactBrokerSocketPath(socketPath: string): string {
  if (process.platform !== 'win32') return socketPath;
  if (socketPath.startsWith('\\\\.\\pipe\\arg-bridge-artifact-')) return socketPath;
  const digest = createHash('sha256').update(resolve(socketPath)).digest('hex').slice(0, 32);
  return `\\\\.\\pipe\\arg-bridge-artifact-${digest}`;
}

async function findCanonicalAllowedRoot(path: string, roots: readonly string[]): Promise<string | undefined> {
  for (const root of roots) {
    const canonicalRoot = await realpath(root).catch(() => undefined);
    if (canonicalRoot && isPathWithinRoot(path, canonicalRoot)) return root;
  }
  return undefined;
}

function isPersistentGrant(value: unknown): value is ActiveGrant {
  if (!value || typeof value !== 'object') return false;
  const grant = value as Partial<ActiveGrant>;
  return grant.persistent === true &&
    typeof grant.token === 'string' && /^[A-Za-z0-9_-]{16,200}$/u.test(grant.token) &&
    typeof grant.scope === 'string' && grant.scope.length > 0 &&
    typeof grant.chatId === 'string' && grant.chatId.length > 0 &&
    typeof grant.replyTo === 'string' && grant.replyTo.length > 0 &&
    Array.isArray(grant.allowedRoots) && grant.allowedRoots.every((root) => typeof root === 'string' && isAbsolute(root)) &&
    typeof grant.maxFileBytes === 'number' && Number.isSafeInteger(grant.maxFileBytes) && grant.maxFileBytes > 0;
}

function normalizeCaption(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('文件说明必须是文本');
  const caption = value.trim();
  if (!caption) return undefined;
  if (caption.length > 1_000) throw new Error('文件说明不能超过 1000 个字符');
  return caption;
}
