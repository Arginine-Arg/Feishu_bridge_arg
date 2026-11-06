import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ArtifactBroker } from '../../src/bot/artifact-broker';
import { bindThreadArtifactDelivery, readThreadArtifactDelivery } from '../../src/agent/artifact-context';
import { StructuredAdapter } from '../../src/agent/structured/adapter';
import { PreferredStructuredAdapter } from '../../src/agent/structured/preferred';
import { runAgentSendFile } from '../../src/cli/commands/agent-sendfile';
import type { AgentAdapter } from '../../src/agent/types';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ab-artifact-'));
  cleanups.push(() => rm(root, { force: true, recursive: true }));
  const workspace = join(root, 'workspace');
  const profileDir = join(root, 'profile');
  const directory = join(profileDir, 'structured');
  const contexts = join(root, 'contexts');
  await mkdir(workspace);
  await mkdir(directory, { recursive: true });
  await writeFile(join(workspace, 'prompt.md'), 'ready');
  vi.stubEnv('ARG_BRIDGE_ARTIFACT_CONTEXT_DIR', contexts);
  for (const key of ['ARG_BRIDGE_ARTIFACT_SCOPE', 'ARG_BRIDGE_ARTIFACT_SOCKET', 'ARG_BRIDGE_ARTIFACT_TOKEN', 'CODEX_THREAD_ID', 'TMUX', 'TMUX_PANE']) vi.stubEnv(key, '');
  vi.spyOn(process, 'cwd').mockReturnValue(workspace);
  const send = vi.fn(async (_chatId: string, _content: unknown, _options: unknown) => ({ messageId: 'file-response' }));
  const broker = new ArtifactBroker(join(profileDir, 'artifact-broker.sock'), { send } as never,
    async () => true, join(profileDir, 'artifact-grants.json'));
  await broker.start();
  cleanups.push(() => broker.close());
  const grant = broker.issue({ scope: 'chat-a', chatId: 'oc-a', replyTo: 'om-a',
    allowedRoots: [workspace], maxFileBytes: 4096, persistent: true });
  await broker.flush();
  return { root, workspace, profileDir, directory, contexts, send, broker, grant };
}

it('restores pre-upgrade main, side and worker processes after only a bot restart', async () => {
  const h = await setup();
  const state = { id: 'main-old', scope: 'chat-a', cwd: h.workspace, kind: 'codex', endpoint: 'unix:///not-restarted.sock' };
  await writeFile(join(h.directory, `${createHash('sha256').update('state').digest('hex')}.json`), JSON.stringify(state));
  const workerStateFile = join(h.directory, `broker-workers-${createHash('sha256').update(state.id).digest('hex').slice(0, 24)}.json`);
  await writeFile(workerStateFile, JSON.stringify({
    version: 1, workers: [{ agent: { agentId: 'broker:old-runtime:worker-old' }, workspace: h.workspace }],
  }), { mode: 0o600 });
  await writeFile(join(h.directory, 'subagent-sides.json'), JSON.stringify({ version: 1, sides: {
    side: { scope: 'chat-a', cwd: h.workspace,
      route: { id: 'side-route', provider: 'test', model: 'test', maxAccess: 'read-only', available: true, missingEnvironment: [], tags: [] },
      agent: { agentId: 'broker:side-runtime:side-old' } },
  } }));
  await h.broker.close();
  const restarted = new ArtifactBroker(h.grant.socketPath, { send: h.send } as never,
    async () => true, join(h.profileDir, 'artifact-grants.json'));
  await restarted.start();
  cleanups.push(() => restarted.close());
  const structured = new StructuredAdapter({ kind: 'codex', binary: '/must-not-start-codex', profileDir: h.profileDir });
  const restoreLive = vi.fn(async () => false);
  const preferred = new PreferredStructuredAdapter(structured, { tmux: { restoreArtifactDelivery: restoreLive } } as unknown as AgentAdapter, h.profileDir);
  for (const grant of restarted.persistentDeliveries()) {
    await expect(preferred.tmux.restoreArtifactDelivery!(grant.scope, grant)).resolves.toBe(true);
  }
  expect(restoreLive).toHaveBeenCalledOnce();
  for (const threadId of ['main-old', 'side-old', 'worker-old']) {
    vi.stubEnv('CODEX_THREAD_ID', threadId);
    expect(await readThreadArtifactDelivery(), threadId).toMatchObject(h.grant);
    await expect(runAgentSendFile('prompt.md')).resolves.toBeUndefined();
  }
  expect(h.send).toHaveBeenCalledTimes(3);
  expect(h.send.mock.calls.every(call => call[0] === 'oc-a')).toBe(true);
  // The old native controller can create more workers after the bot upgrade.
  // Its environment and loaded code remain unchanged; its state supplies the
  // authoritative new child ID to the updated sendfile CLI.
  await writeFile(workerStateFile, JSON.stringify({ version: 1, workers: [
    { agent: { agentId: 'broker:old-runtime:worker-born-after-restart' }, workspace: h.workspace },
  ] }));
  vi.stubEnv('CODEX_THREAD_ID', 'worker-born-after-restart');
  await expect(runAgentSendFile('prompt.md')).resolves.toBeUndefined();
  expect(h.send).toHaveBeenCalledTimes(4);
  // A different thread in the same directory must not acquire this chat.
  vi.stubEnv('CODEX_THREAD_ID', 'unrelated-thread');
  await expect(runAgentSendFile('prompt.md')).rejects.toThrow('没有 bridge 文件发送能力');
  expect(h.send).toHaveBeenCalledTimes(4);
});

it('recovers a token filtered from the shell while keeping scope and socket exact', async () => {
  const h = await setup();
  vi.stubEnv('ARG_BRIDGE_ARTIFACT_SCOPE', h.grant.scope);
  vi.stubEnv('ARG_BRIDGE_ARTIFACT_SOCKET', h.grant.socketPath);
  await expect(runAgentSendFile('prompt.md')).resolves.toBeUndefined();
  expect(h.send).toHaveBeenCalledOnce();
});

it('renews an old exact-thread token without selecting another chat in the same cwd', async () => {
  const h = await setup();
  await bindThreadArtifactDelivery('thread-a', h.grant, [h.workspace]);
  h.broker.revoke(h.grant.token);
  h.broker.issue({ scope: 'chat-a', chatId: 'oc-a', replyTo: 'om-new', allowedRoots: [h.workspace], maxFileBytes: 4096, persistent: true });
  h.broker.issue({ scope: 'chat-b', chatId: 'oc-b', replyTo: 'om-b', allowedRoots: [h.workspace], maxFileBytes: 4096, persistent: true });
  await h.broker.flush();
  vi.stubEnv('CODEX_THREAD_ID', 'thread-a');
  await expect(runAgentSendFile('prompt.md')).resolves.toBeUndefined();
  expect(h.send).toHaveBeenCalledWith('oc-a', expect.anything(), { replyTo: 'om-new' });
  expect(h.send).toHaveBeenCalledOnce();
});

it('rejects ambiguous thread recipients and cwd outside the authorized workspace', async () => {
  const h = await setup();
  const other = h.broker.issue({ scope: 'chat-b', chatId: 'oc-b', replyTo: 'om-b', allowedRoots: [h.workspace], maxFileBytes: 4096, persistent: true });
  await bindThreadArtifactDelivery('shared-thread', h.grant, [h.workspace]);
  await bindThreadArtifactDelivery('shared-thread', other, [h.workspace]);
  vi.stubEnv('CODEX_THREAD_ID', 'shared-thread');
  await expect(runAgentSendFile('prompt.md')).rejects.toThrow('多个 Bridge');
  expect(h.send).not.toHaveBeenCalled();
  await expect(readThreadArtifactDelivery({ ...process.env, ARG_BRIDGE_ARTIFACT_SCOPE: h.grant.scope }, h.root)).resolves.toBeUndefined();
  vi.stubEnv('ARG_BRIDGE_ARTIFACT_SCOPE', h.grant.scope);
  await expect(runAgentSendFile('prompt.md')).resolves.toBeUndefined();
  expect(h.send).toHaveBeenCalledWith('oc-a', expect.anything(), expect.anything());
});

it('resolves relative files from the actual caller cwd among multiple allowed roots', async () => {
  const h = await setup();
  const sub = join(h.workspace, 'nested');
  await mkdir(sub);
  await writeFile(join(sub, 'prompt.md'), 'nested');
  await bindThreadArtifactDelivery('nested-thread', h.grant, [h.workspace]);
  vi.stubEnv('CODEX_THREAD_ID', 'nested-thread');
  vi.mocked(process.cwd).mockReturnValue(sub);
  await expect(runAgentSendFile('prompt.md')).resolves.toBeUndefined();
  expect(h.send).toHaveBeenCalledWith('oc-a', { file: { source: expect.stringContaining(`${join('nested', 'prompt.md')}`), fileName: 'prompt.md' } }, expect.anything());
  await expect(runAgentSendFile('../prompt.md')).rejects.toThrow('..');
});

it.skipIf(process.platform === 'win32')('does not trust a world-readable thread capability file', async () => {
  const h = await setup();
  await bindThreadArtifactDelivery('private-thread', h.grant, [h.workspace]);
  const dir = join(h.contexts, createHash('sha256').update('private-thread').digest('hex'));
  const [file] = await readdir(dir);
  await chmod(join(dir, file!), 0o644);
  await expect(readThreadArtifactDelivery({ ...process.env, CODEX_THREAD_ID: 'private-thread' }, h.workspace)).resolves.toBeUndefined();
});
