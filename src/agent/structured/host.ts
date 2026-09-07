import { createHash } from 'node:crypto';
import { mkdir, lstat, chmod, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnProcess } from '../../platform/spawn';
import { RpcClient } from './rpc';

export async function connectCodexHost(options: {
  binary: string; profileDir: string; scope: string; cwd: string; env: NodeJS.ProcessEnv;
}): Promise<{ rpc: RpcClient; endpoint: string }> {
  if (process.platform === 'win32') throw new Error('Codex structured shared-terminal backend currently requires Unix sockets; keep terminal transport on Windows');
  const hash = createHash('sha256').update(options.profileDir).update('\0').update(options.scope).update('\0').update(options.cwd).digest('hex').slice(0, 20);
  const directory = join(tmpdir(), `argbridge-rpc-${process.getuid?.() ?? 'user'}-${hash}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe structured runtime directory');
  await chmod(directory, 0o700);
  const path = join(directory, 'server.sock');
  const endpoint = `unix://${path}`;
  const url = `ws+unix://${path}:/`;
  let rpc: RpcClient;
  try { rpc = await RpcClient.connect(url); }
  catch {
    const log = await open(join(directory, 'server.log'), 'a', 0o600);
    const child = spawnProcess(options.binary, ['app-server', '--listen', endpoint], {
      cwd: options.cwd, env: options.env, detached: true,
      stdio: ['ignore', log.fd, log.fd],
    });
    let failure: Error | undefined;
    child.once('error', error => { failure = error; });
    child.unref(); await log.close();
    const deadline = Date.now() + 20000;
    let connected: RpcClient | undefined;
    while (Date.now() < deadline && !failure) {
      try { connected = await RpcClient.connect(url); break; } catch { await new Promise(resolve => setTimeout(resolve, 150)); }
    }
    if (!connected) { child.kill('SIGTERM'); throw failure ?? new Error(`Codex App Server did not become ready; inspect ${join(directory, 'server.log')}`); }
    rpc = connected;
  }
  try { await rpc.initialize(); } catch (error) { rpc.close(); throw error; }
  return { rpc, endpoint };
}
