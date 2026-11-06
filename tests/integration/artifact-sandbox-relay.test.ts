import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ArtifactBroker } from '../../src/bot/artifact-broker';
import { bindThreadArtifactDelivery } from '../../src/agent/artifact-context';
import { artifactRelayRequest, createArtifactRelaySourceResolver, verifiedArtifactRelayRequests } from '../../src/agent/artifact-relay';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ab-relay-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  await writeFile(join(workspace, 'report.md'), 'verified');
  vi.stubEnv('ARG_BRIDGE_ARTIFACT_CONTEXT_DIR', join(root, 'contexts'));
  vi.stubEnv('CODEX_THREAD_ID', 'sandbox-thread');
  vi.spyOn(process, 'cwd').mockReturnValue(workspace);
  const transcript = join(root, 'rollout.jsonl');
  await writeFile(transcript, '');
  const send = vi.fn(async (_chat: string, _content: unknown, _options: unknown) => ({ messageId: 'sent' }));
  const make = () => new ArtifactBroker(join(root, 'artifact-broker.sock'), { send } as never, async () => true,
    join(root, 'artifact-grants.json'), async () => [{ threadId: 'sandbox-thread', path: transcript }]);
  const broker = make(); await broker.start(); cleanups.push(() => broker.close());
  const grant = broker.issue({ scope: 'chat-sandbox', chatId: 'oc-sandbox', replyTo: 'om-sandbox', allowedRoots: [workspace], maxFileBytes: 4096, persistent: true });
  const line = (output: string, type = 'function_call_output') => JSON.stringify({ type: 'response_item', payload: { type, output } }) + '\n';
  return { root, workspace, transcript, send, make, broker, grant, line };
}

it('delivers a signed sandbox tool request once, including across broker restart', async () => {
  const h = await setup();
  const marker = artifactRelayRequest(h.grant, 'report.md');
  expect(marker).not.toContain(h.grant.token);
  await writeFile(h.transcript, h.line(marker));
  await h.broker.pollRelay(); await h.broker.pollRelay();
  expect(h.send).toHaveBeenCalledOnce();
  expect(h.send).toHaveBeenCalledWith('oc-sandbox', expect.objectContaining({ file: expect.anything() }), { replyTo: 'om-sandbox' });
  await h.broker.close();
  const restarted = h.make(); await restarted.start(); cleanups.push(() => restarted.close());
  await restarted.pollRelay();
  expect(h.send).toHaveBeenCalledOnce();
});

it('rejects forged signatures, mismatched threads and requests in user/model messages', async () => {
  const h = await setup();
  const forged = artifactRelayRequest({ ...h.grant, token: 'untrusted-token' }, 'report.md');
  const marker = artifactRelayRequest(h.grant, 'report.md');
  vi.stubEnv('CODEX_THREAD_ID', 'other-thread');
  const other = artifactRelayRequest(h.grant, 'report.md');
  await writeFile(h.transcript, h.line(forged) + h.line(other) + h.line(marker, 'message'));
  await h.broker.pollRelay();
  expect(h.send).not.toHaveBeenCalled();
});

it('keeps workspace checks and reports a rejected relay to the correct chat', async () => {
  const h = await setup();
  await writeFile(h.transcript, h.line(artifactRelayRequest(h.grant, '../outside.md')));
  await h.broker.pollRelay();
  expect(h.send).toHaveBeenCalledOnce();
  expect(h.send).toHaveBeenCalledWith('oc-sandbox', { markdown: expect.stringContaining('文件路径不能包含 ..') }, { replyTo: 'om-sandbox' });
});

it('does not replay expired signed requests', async () => {
  const h = await setup();
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now - 6 * 60_000);
  const marker = artifactRelayRequest(h.grant, 'report.md'); clock.mockRestore();
  expect(verifiedArtifactRelayRequests(marker, 'sandbox-thread', new Map([[h.grant.scope, h.grant]]))).toEqual([]);
});

it('locates authorized native and generated Broker rollouts by exact UUIDv7 thread IDs', async () => {
  const h = await setup();
  const nativeId = '01a1b24d-a955-7f61-b13f-ed534d5c97a3';
  const workerId = '01a1b24d-a956-7f61-b13f-ed534d5c97a3';
  const mainHome = join(h.root, 'codex-home');
  const profileDir = join(h.root, 'profile');
  const workerHome = join(profileDir, 'structured', 'cc-switch', 'mixagents-data', '0123456789abcdef', 'runtimes', 'runtime-a');
  for (const [home, thread] of [[mainHome, nativeId], [workerHome, workerId]]) {
    const day = join(home!, 'sessions', '2026', '11', '07'); await mkdir(day, { recursive: true });
    await writeFile(join(day, `rollout-2026-11-07T03-19-56-${thread}.jsonl`), '');
    await bindThreadArtifactDelivery(thread!, h.grant, [h.workspace]);
  }
  const sources = await createArtifactRelaySourceResolver(profileDir, mainHome)(h.grant.socketPath, new Set([h.grant.scope]));
  expect(sources.map(source => source.threadId).sort()).toEqual([nativeId, workerId].sort());
});
