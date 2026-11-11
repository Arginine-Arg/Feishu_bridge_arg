import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { connectCodexHost, shutdownProfileHosts } from '../../src/agent/structured/host';
import { CodexStructuredSession } from '../../src/agent/structured/codex';
import { normalizeProviderRecovery } from '../../src/config/provider-recovery';
import type { AgentEvent } from '../../src/agent/types';
import { initialState, reduce } from '../../src/card/run-state';

const native = process.env.ARG_BRIDGE_RECOVERY_E2E === '1' && process.platform !== 'win32' ? it : it.skip;
native('real Codex interrupts a retrying provider and continues the same thread with complete text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-recovery-e2e-'));
  const home = join(root, 'codex-home');
  const profile = join(root, 'profile');
  await mkdir(home); await mkdir(profile);
  let healthy = false;
  let calls = 0;
  const requests: any[] = [];
  const finalText = 'RECOVERY_OK — 这是完整的正文，必须保留末尾 🧬 END';
  const provider = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      if (!req.url?.includes('/responses')) { res.writeHead(404); res.end(); return; }
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      const id = `response-${++calls}`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (event: object) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      send({ type: 'response.created', response: { id } });
      if (!healthy) { res.end(); return; }
      send({ type: 'response.output_item.added', output_index: 0, item: { id: 'answer', type: 'message', role: 'assistant', content: [] } });
      for (const delta of ['REC', 'OVERY', '_OK']) send({ type: 'response.output_text.delta', item_id: 'answer', output_index: 0, content_index: 0, delta });
      send({ type: 'response.output_item.done', output_index: 0, item: { id: 'answer', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: finalText }] } });
      send({ type: 'response.completed', response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } });
      res.end();
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const port = (provider.address() as { port: number }).port;
  await writeFile(join(home, 'config.toml'), [
    'model = "recovery-local"', 'model_provider = "recovery-local"',
    'approval_policy = "never"', 'sandbox_mode = "read-only"',
    '[model_providers.recovery-local]', 'name = "Local test"',
    `base_url = "http://127.0.0.1:${port}/v1"`, 'wire_api = "responses"',
    'requires_openai_auth = false', 'stream_max_retries = 100', 'request_max_retries = 0',
  ].join('\n'));
  const env = { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: 'local-test-only',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '127.0.0.1' };
  const host = await connectCodexHost({ binary: 'codex', profileDir: profile, scope: 'test', cwd: root, env });
  let session: CodexStructuredSession | undefined;
  const wire: any[] = [];
  host.rpc.on('message', message => { if (['error', 'turn/started', 'turn/completed'].includes(message.method)) wire.push(message); });
  try {
    const started = await host.rpc.request('thread/start', { cwd: root, approvalPolicy: 'never', sandbox: 'read-only' });
    session = new CodexStructuredSession(started.thread.id, host.endpoint, host.rpc, undefined, {
      policy: normalizeProviderRecovery({ retryStallSeconds: 15 }), providerIds: ['recovery-local'],
    });
    const events: AgentEvent[] = [];
    const stop = new AbortController();
    const timeout = setTimeout(() => stop.abort(), 75_000);
    try {
      await session.submit({ runId: 'e2e', prompt: 'Return the test answer.', cwd: root, sandbox: 'read-only' }, event => {
        events.push(event);
        if (event.type === 'text' && event.delta.includes('正在中断本轮')) healthy = true;
      }, stop.signal);
    } finally { clearTimeout(timeout); }
    expect(events.filter(e => e.type === 'error')).toEqual([]);
    expect(wire.some(m => m.method === 'error' && m.params.willRetry === true)).toBe(true);
    expect(wire.filter(m => m.method === 'turn/completed').map(m => m.params.turn.status)).toEqual(['interrupted', 'completed']);
    const text = events.reduce(reduce, initialState).blocks.filter(b => b.kind === 'text').map(b => b.content).join('');
    expect(text).toContain(finalText);
    expect(requests.some(r => JSON.stringify(r.input).includes('do not repeat completed actions'))).toBe(true);
    expect(new Set(wire.map(m => m.params.threadId))).toEqual(new Set([started.thread.id]));
  } finally {
    await session?.close(); host.rpc.close();
    await shutdownProfileHosts(profile);
    provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 100_000);
