import { connect } from 'node:net';

interface BrokerResponse {
  ok?: unknown;
  message?: unknown;
}

/** Client half of the run-scoped artifact capability exposed to agents. */
export async function runAgentSendFile(path: string, caption?: string): Promise<void> {
  const socketPath = process.env.ARG_BRIDGE_ARTIFACT_SOCKET;
  const token = process.env.ARG_BRIDGE_ARTIFACT_TOKEN;
  if (!socketPath || !token) {
    throw new Error('当前进程没有 bridge 文件发送能力；请从 bridge agent 任务内调用');
  }
  const response = await new Promise<BrokerResponse>((resolve, reject) => {
    const socket = connect(socketPath);
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
      socket.write(`${JSON.stringify({ token, path, ...(caption ? { caption } : {}) })}\n`);
    });
  });
  if (response.ok !== true) throw new Error(typeof response.message === 'string' ? response.message : 'bridge 文件发送失败');
  process.stdout.write(`${typeof response.message === 'string' ? response.message : '文件已发送'}\n`);
}
