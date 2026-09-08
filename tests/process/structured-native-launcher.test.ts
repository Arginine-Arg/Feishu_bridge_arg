import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { listStructuredTmuxPanes } from '../../src/agent/structured/tmux-discovery';
import { RpcClient } from '../../src/agent/structured/rpc';

const native = process.env.ARG_BRIDGE_NATIVE_PROTOCOL === '1' ? it : it.skip;
native('native launcher shares a YOLO thread and leaves the original shell usable', async () => {
  const dir = await mkdtemp('/tmp/ab-launch-');
  const socket = join(dir, 'tmux.sock');
  const tmux = (...args: string[]) => spawnSync('tmux', ['-S', socket, ...args], { encoding: 'utf8' });
  await writeFile(join(dir, 'config.json'), JSON.stringify({ schemaVersion: 2, activeProfile: 'codex', profiles: {
    codex: { schemaVersion: 2, agentKind: 'codex', accounts: { app: { id: 'test', secret: 'not-used', tenant: 'feishu' } },
      codex: { binaryPath: 'codex', inheritCodexHome: true }, permissions: { defaultAccess: 'full', maxAccess: 'full' } },
  } }));
  let rpc: RpcClient | undefined;
  try {
    const seed = spawnSync('codex', ['exec', '--json', '--skip-git-repo-check', 'Reply exactly LAUNCHER_FIXTURE_OK. Do not use tools.'], { cwd: dir, encoding: 'utf8', timeout: 60000 });
    expect(seed.status, seed.stderr).toBe(0);
    const started = seed.stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).find(item => item.type === 'thread.started');
    expect(started?.thread_id).toBeTruthy();
    expect(tmux('new-session', '-d', '-s', 'test', '-c', dir, '-e', `LARK_CHANNEL_HOME=${dir}`,
      'bash', '--noprofile', '--norc', '-i').status).toBe(0);
    const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const command = `${quote(process.execPath)} ${quote(join(process.cwd(), 'dist/cli.js'))} native ${quote(started.thread_id)} --profile codex`;
    tmux('send-keys', '-t', 'test', '-l', command);
    tmux('send-keys', '-t', 'test', 'Enter');
    await expect.poll(() => listStructuredTmuxPanes(socket).find(pane => pane.structured.endpoint)?.structured.threadId, { timeout: 30000 }).toBeTruthy();
    const identity = listStructuredTmuxPanes(socket)[0]!.structured;
    rpc = await RpcClient.connect(`ws+unix://${identity.endpoint!.slice('unix://'.length)}:/`);
    await rpc.initialize();
    const loaded = await rpc.request('thread/loaded/list', {});
    expect(loaded.data).toContain(identity.threadId);
    const resumed = await rpc.request('thread/resume', { threadId: identity.threadId, cwd: dir, excludeTurns: true }).catch(error => {
      throw new Error(`${error.message}\n${tmux('capture-pane', '-p', '-t', 'test').stdout}`);
    });
    expect(resumed.approvalPolicy).toBe('never');
    expect(resumed.sandbox.type).toBe('dangerFullAccess');
    await expect.poll(() => tmux('capture-pane', '-p', '-t', 'test').stdout, { timeout: 10000 }).toContain('OpenAI Codex');
    // Exit through the native UI; the original shell must remain alive.
    tmux('send-keys', '-t', 'test', 'C-c');
    await new Promise(resolve => setTimeout(resolve, 200));
    tmux('send-keys', '-t', 'test', 'C-c');
    await expect.poll(() => listStructuredTmuxPanes(socket).length, { timeout: 10000 }).toBe(0);
    tmux('send-keys', '-t', 'test', '-l', "printf 'ORIGINAL_%s\\n' SHELL");
    tmux('send-keys', '-t', 'test', 'Enter');
    await expect.poll(() => tmux('capture-pane', '-p', '-t', 'test').stdout, { timeout: 5000 }).toContain('ORIGINAL_SHELL');
    expect(tmux('display-message', '-p', '-t', 'test', '#{pane_dead}').stdout.trim()).toBe('0');
    tmux('send-keys', '-t', 'test', '-l', command);
    tmux('send-keys', '-t', 'test', 'Enter');
    await expect.poll(() => listStructuredTmuxPanes(socket)[0]?.structured, { timeout: 30000 }).toMatchObject({
      endpoint: identity.endpoint, threadId: identity.threadId,
    });
  } finally { rpc?.close(); tmux('kill-session', '-t', 'test'); }
}, 120000);
