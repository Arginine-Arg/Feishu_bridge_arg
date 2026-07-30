import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';

interface BrokerResponse {
  ok?: unknown;
  message?: unknown;
}

type TmuxEnvironmentReader = (name: string, env: NodeJS.ProcessEnv) => string | undefined;

export function resolveAgentArtifactDelivery(
  env: NodeJS.ProcessEnv = process.env,
  readTmuxEnvironment: TmuxEnvironmentReader = readTmuxSessionEnvironment,
): { socketPath: string; token: string } | undefined {
  const socketPath = env.ARG_BRIDGE_ARTIFACT_SOCKET;
  const token = env.ARG_BRIDGE_ARTIFACT_TOKEN;
  if (socketPath && token) return { socketPath, token };

  // A bridge-managed tmux session is one scope. Existing Codex processes
  // cannot have their environment mutated after codex --resume, but their
  // sendfile subprocess can safely read this session-local handoff. External
  // tmux sessions never receive these variables.
  const resumedSocketPath = readTmuxEnvironment('ARG_BRIDGE_ARTIFACT_SOCKET', env);
  const resumedToken = readTmuxEnvironment('ARG_BRIDGE_ARTIFACT_TOKEN', env);
  return resumedSocketPath && resumedToken
    ? { socketPath: resumedSocketPath, token: resumedToken }
    : undefined;
}

/** Client half of the run-scoped artifact capability exposed to agents. */
export async function runAgentSendFile(path: string, caption?: string): Promise<void> {
  const artifact = resolveAgentArtifactDelivery();
  if (!artifact) {
    throw new Error('当前进程没有 bridge 文件发送能力；请从 bridge agent 任务内调用，或在托管 tmux session 中重启 bridge 后重试');
  }
  const response = await new Promise<BrokerResponse>((resolve, reject) => {
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
      socket.write(`${JSON.stringify({ token: artifact.token, path, ...(caption ? { caption } : {}) })}\n`);
    });
  });
  if (response.ok !== true) throw new Error(typeof response.message === 'string' ? response.message : 'bridge 文件发送失败');
  process.stdout.write(`${typeof response.message === 'string' ? response.message : '文件已发送'}\n`);
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
