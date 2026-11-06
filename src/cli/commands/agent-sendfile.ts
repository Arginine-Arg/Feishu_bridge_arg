import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readThreadArtifactDelivery } from '../../agent/artifact-context';
import { artifactRelayRequest } from '../../agent/artifact-relay';

interface BrokerResponse {
  ok?: unknown;
  message?: unknown;
}

type TmuxEnvironmentReader = (name: string, env: NodeJS.ProcessEnv) => string | undefined;

export function resolveAgentArtifactDelivery(
  env: NodeJS.ProcessEnv = process.env,
  readTmuxEnvironment: TmuxEnvironmentReader = readTmuxSessionEnvironment,
): { scope?: string; statePath?: string; socketPath: string; token: string } | undefined {
  const scope = env.ARG_BRIDGE_ARTIFACT_SCOPE;
  const socketPath = env.ARG_BRIDGE_ARTIFACT_SOCKET;
  const token = env.ARG_BRIDGE_ARTIFACT_TOKEN;
  const statePath = env.ARG_BRIDGE_ARTIFACT_STATE;

  // A bridge-managed tmux session is one scope. Existing Codex processes
  // cannot have their environment mutated after codex --resume, but their
  // sendfile subprocess can safely read this session-local handoff. External
  // tmux sessions never receive these variables.
  if (env.TMUX && env.TMUX_PANE && /^%\d+$/u.test(env.TMUX_PANE)) {
    const resumedScope = readTmuxEnvironment('ARG_BRIDGE_ARTIFACT_SCOPE', env);
    const resumedSocketPath = readTmuxEnvironment('ARG_BRIDGE_ARTIFACT_SOCKET', env);
    const resumedToken = readTmuxEnvironment('ARG_BRIDGE_ARTIFACT_TOKEN', env);
    if (resumedSocketPath && resumedToken) {
      return {
        ...(resumedScope ? { scope: resumedScope } : {}),
        socketPath: resumedSocketPath,
        token: resumedToken,
        ...(statePath && socketPath === resumedSocketPath ? { statePath } : {}),
      };
    }
  }
  return socketPath && token ? { ...(scope ? { scope } : {}), ...(statePath ? { statePath } : {}), socketPath, token } : undefined;
}

/** Client half of the run-scoped artifact capability exposed to agents. */
export async function runAgentSendFile(path: string, caption?: string): Promise<void> {
  // Native/adopted App Servers can predate the bot and never inherit its
  // capability. CODEX_THREAD_ID identifies an exact persisted chat binding;
  // workspace alone is deliberately insufficient to select a recipient.
  let artifact = await readThreadArtifactDelivery() ?? resolveAgentArtifactDelivery();
  if (!artifact && process.env.ARG_BRIDGE_ARTIFACT_SCOPE && process.env.ARG_BRIDGE_ARTIFACT_SOCKET) {
    artifact = await recoverArtifactDelivery({
      scope: process.env.ARG_BRIDGE_ARTIFACT_SCOPE,
      socketPath: process.env.ARG_BRIDGE_ARTIFACT_SOCKET,
      statePath: process.env.ARG_BRIDGE_ARTIFACT_STATE,
      token: '',
    });
  }
  if (!artifact) {
    throw new Error('当前进程没有 bridge 文件发送能力；请从 bridge agent 任务内调用，或在托管 tmux session 中重启 bridge 后重试');
  }
  let response: BrokerResponse;
  try {
    response = await requestArtifactDelivery(artifact, path, caption);
  } catch (err) {
    if (!['EPERM', 'EACCES'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
    const renewed = await recoverArtifactDelivery(artifact) ?? artifact;
    process.stdout.write(`${artifactRelayRequest(renewed, path, caption)}\n文件发送请求已提交到 Bridge；以飞书附件或失败回执为准。\n`);
    return;
  }
  const message = typeof response.message === 'string' ? response.message : '';
  if (response.ok !== true && /令牌已失效|capability.*expired/iu.test(message)) {
    const renewed = await recoverArtifactDelivery(artifact);
    if (renewed && renewed.token !== artifact.token) {
      response = await requestArtifactDelivery(renewed, path, caption);
    }
  }
  if (response.ok !== true) throw new Error(typeof response.message === 'string' ? response.message : 'bridge 文件发送失败');
  process.stdout.write(`${typeof response.message === 'string' ? response.message : '文件已发送'}\n`);
}

function requestArtifactDelivery(
  artifact: { socketPath: string; token: string },
  path: string,
  caption?: string,
): Promise<BrokerResponse> {
  return new Promise<BrokerResponse>((resolve, reject) => {
    const socket = connect(artifact.socketPath);
    let data = '';
    socket.setEncoding('utf8');
    socket.setTimeout(20_000, () => socket.destroy(new Error('等待 bridge 文件发送超时')));
    socket.once('error', reject);
    socket.on('data', (chunk: string) => {
      data += chunk;
      if (!data.includes('\n')) return;
      try {
        resolve(JSON.parse(data.slice(0, data.indexOf('\n'))) as BrokerResponse);
      } catch (err) {
        reject(err);
      }
      socket.end();
    });
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ token: artifact.token, cwd: process.cwd(), path, ...(caption ? { caption } : {}) })}\n`);
    });
  });
}

export async function recoverArtifactDelivery(
  stale: { scope?: string; statePath?: string; socketPath: string; token: string },
  cwd = process.cwd(),
): Promise<{ scope: string; statePath?: string; socketPath: string; token: string } | undefined> {
  if (!stale.scope) return undefined;
  const statePath = stale.statePath ?? join(dirname(stale.socketPath), 'artifact-grants.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(statePath, 'utf8'));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const root = parsed as { version?: unknown; grants?: unknown };
  if (root.version !== 1 || !Array.isArray(root.grants)) return undefined;
  const currentCwd = resolve(cwd);
  const candidates = root.grants.flatMap((entry): Array<{
    token: string;
    updatedAt: number;
  }> => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const grant = entry as Record<string, unknown>;
    if (
      grant.persistent !== true ||
      grant.scope !== stale.scope ||
      typeof grant.token !== 'string' ||
      !/^[A-Za-z0-9_-]{16,200}$/u.test(grant.token) ||
      !Array.isArray(grant.allowedRoots)
    ) return [];
    const allowed = grant.allowedRoots.some(value =>
      typeof value === 'string' &&
      isAbsolute(value) &&
      isWithin(currentCwd, resolve(value)),
    );
    return allowed
      ? [{
          token: grant.token,
          updatedAt: typeof grant.updatedAt === 'number' && Number.isFinite(grant.updatedAt)
            ? grant.updatedAt
            : 0,
        }]
      : [];
  }).sort((left, right) => right.updatedAt - left.updatedAt);
  const token = candidates[0]?.token;
  return token ? { scope: stale.scope, ...(stale.statePath ? { statePath: stale.statePath } : {}), socketPath: stale.socketPath, token } : undefined;
}

function readTmuxSessionEnvironment(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const pane = env.TMUX_PANE;
  if (!pane || !/^%\d+$/u.test(pane) || !env.TMUX) return undefined;
  const result = spawnSync('tmux', ['show-environment', '-t', pane, name], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return undefined;
  const prefix = `${name}=`;
  const line = result.stdout.trim();
  return line.startsWith(prefix) ? line.slice(prefix.length) || undefined : undefined;
}

function isWithin(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
