import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnProcessSync } from '../../src/platform/spawn';
import { DshStructuredSession } from '../../src/agent/dsh/session';
import { StructuredAdapter } from '../../src/agent/structured/adapter';
import type { AgentEvent } from '../../src/agent/types';
import { resolveDshProvider, dshProfilePatch } from '../../src/agent/dsh/provider';
import { brokerToolSpecs, type BrokerToolHost } from '../../src/agent/subagents/broker-tools';
import { resolveSubagents } from '../../src/agent/subagents/registry';
import { DEFAULT_SUBAGENT_CONFIG } from '../../src/config/profile-schema';

const enabled = process.env.ARG_BRIDGE_TEST_DSH === '1';
const binary = process.env.ARG_BRIDGE_DSH_BIN ?? 'dsh';
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'arg-bridge-dsh-test-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const requests: Array<{ model: string; body: string }> = [];
  const attemptedWrites = new Set<string>();
  let held = false;
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer test-dsh-credential') {
      res.writeHead(401).end();
      return;
    }
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }));
      return;
    }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    const { model, tools } = JSON.parse(body);
    requests.push({ model, body });
    const messages = JSON.parse(body).messages as Array<{ role: string; content: unknown }>;
    const userInputs = messages.filter(message => message.role === 'user').map(message => JSON.stringify(message.content));
    if (!held && userInputs.some(input => input.includes('hold the active prompt'))) {
      held = true;
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const brokerRequest = body.includes('call the Bridge route tool');
    const escalationRequest = body.includes('request sandbox escalation');
    const fileWrite = userInputs.reverse().map(input => /fixture write ([a-z]+(?:\/[a-z]+)?\.txt)/u.exec(input)?.[1])
      .find(file => file && !attemptedWrites.has(file));
    const shellWrite = userInputs.some(input => input.includes('fixture shell writes')) && !attemptedWrites.has('shell');
    if (fileWrite || shellWrite || (requests.length === 1 && (brokerRequest || escalationRequest))) {
      const toolName = tools?.find((tool: { function: { name: string } }) =>
        brokerRequest ? tool.function.name.endsWith('list_routes') : tool.function.name === (fileWrite ? 'write' : 'bash'))?.function.name;
      if (toolName) {
        if (fileWrite) attemptedWrites.add(fileWrite);
        if (shellWrite) attemptedWrites.add('shell');
        const args = brokerRequest ? {} : fileWrite ? { file_path: fileWrite, content: 'worker fixture\n' }
          : shellWrite ? {
            description: 'Check workspace write permissions with fixture files',
            command: "printf 'shell inside\\n' > inside.txt && touch escape/shelloutside.txt",
          } : {
          description: 'Request elevated sandbox access for this fixture',
          command: 'touch should-not-exist',
          sandbox_permissions: 'danger-full-access',
          justification: 'Fixture checks that Bridge denies this request.',
        };
        for (const [delta, finish_reason] of [[{
          tool_calls: [{ index: 0, id: 'fixture-tool-call', type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }],
        }, null], [{}, 'tool_calls']]) {
          res.write(`data: ${JSON.stringify({
            id: 'test-completion', object: 'chat.completion.chunk', created: 1, model,
            choices: [{ index: 0, delta, finish_reason }],
          })}\n\n`);
        }
        res.end('data: [DONE]\n\n');
        return;
      }
    }
    for (const [content, finish_reason] of [['完整', null], ['回复。', null], ['', 'stop']]) {
      res.write(`data: ${JSON.stringify({
        id: 'test-completion', object: 'chat.completion.chunk', created: 1, model,
        choices: [{ index: 0, delta: { content }, finish_reason }],
      })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  await listen(server);
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  const { port } = address;
  const ccHome = join(root, 'cc-switch');
  const home = join(root, 'dsh');
  await mkdir(ccHome);
  const env = { ...process.env, CC_SWITCH_HOME: ccHome };
  async function switchTo(id: string) {
    const providers = Object.fromEntries(['model-a', 'model-b'].map(name => [name, {
      id: name, name, appType: 'codex',
      settingsConfig: {
        auth: { OPENAI_API_KEY: 'test-dsh-credential' },
        config: [
          `model = "${name}"`, 'model_provider = "local"',
          '[model_providers.local]', 'name = "Local"',
          `base_url = "http://127.0.0.1:${port}/v1"`,
          'wire_api = "responses"',
          'requires_openai_auth = true',
        ].join('\n'),
      },
    }]));
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const database = new DatabaseSync(join(ccHome, 'cc-switch.db'));
    try {
      database.exec(`
        CREATE TABLE IF NOT EXISTS providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT,
          is_current BOOLEAN, provider_type TEXT, category TEXT, sort_index INTEGER, meta TEXT, PRIMARY KEY (id, app_type));
        CREATE TABLE IF NOT EXISTS provider_endpoints (id INTEGER PRIMARY KEY, provider_id TEXT, app_type TEXT, url TEXT, added_at INTEGER);
      `);
      const update = database.prepare('INSERT OR REPLACE INTO providers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const provider of Object.values(providers)) {
        update.run(provider.id, 'codex', provider.name, JSON.stringify(provider.settingsConfig),
          provider.id === id ? 1 : 0, 'custom', null, 0, '{}');
      }
    } finally { database.close(); }
    await writeFile(join(ccHome, 'settings.json'), JSON.stringify({ currentProviderCodex: id, codexProviders: providers }));
  }
  await switchTo('model-a');
  const config = { binaryPath: binary, api: 'openai-completions' as const };
  const models = new Map<string, string>();
  const session = (sessionId?: string, controller?: BrokerToolHost) => {
    const result = new DshStructuredSession({
      config, cwd: root, home, env, sessionId,
      onSessionId: async () => {},
      loadModel: async id => models.get(id),
      saveModel: async (id, model) => { if (model) models.set(id, model); else models.delete(id); },
      sandbox: 'read-only',
      ...(controller ? { broker: async () => ({
        namespace: 'arg_bridge', controller: async () => controller,
      }) } : {}),
    });
    cleanups.push(() => result.close());
    return result;
  };
  return { root, config, env, home, requests, switchTo, session };
}

function listen(server: Server): Promise<void> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
}

describe.runIf(enabled)('official DeepSeek Harness ACP', () => {
  it('runs MixAgents workers without Codex and restores the result and session across Broker reconnects', async () => {
    const f = await fixture();
    const signal = AbortSignal.timeout(75_000);
    const runtime = await resolveSubagents({
      cwd: f.root, env: f.env, stateDir: join(f.root, 'broker'),
      codexBin: join(f.root, 'missing-codex'), dsh: f.config, allowCodexFork: false,
      subagents: {
        ...DEFAULT_SUBAGENT_CONFIG, mode: 'broker',
        providerPriority: [{ providerId: 'model-b', models: ['model-b'] }],
      },
      signal,
    });
    const { backend, route } = runtime;
    expect(route).toMatchObject({ backend: 'dsh_acp', ccSwitchProviderId: 'model-b', model: 'model-b' });
    if (!backend || !route) throw new Error('Missing DSH worker route');
    cleanups.push(async () => { await backend.closeBackend?.(); });
    const agent = await backend.createOrReuse({
      route, task: 'remember this worker task', scope: 'dsh-worker',
      cwd: f.root, access: 'read-only', signal,
    });
    const first = await backend.wait(agent, signal, 25_000);
    expect(first).toMatchObject({ status: 'completed', text: '完整回复。' });
    const tools = JSON.parse(f.requests[0]!.body).tools as Array<{ function: { name: string } }>;
    expect(tools.some(tool => /subagent|plugin_manager|workflow/iu.test(tool.function.name))).toBe(false);
    await backend.closeBackend?.();
    expect(await backend.wait(agent, signal, 25_000)).toMatchObject({ status: 'completed', text: '完整回复。' });
    const resumed = await backend.send(agent, 'remember that worker follow-up', signal, 25_000);
    expect(resumed).toMatchObject({ status: 'completed', text: '完整回复。' });
    expect(f.requests.map(request => request.model)).toEqual(['model-b', 'model-b']);
    expect(f.requests[1]?.body).toContain('remember this worker task');
    expect(f.requests[1]?.body).toContain('remember that worker follow-up');
    await expect(backend.createOrReuse({
      route, task: 'write without approval', scope: 'dsh-worker',
      cwd: f.root, access: 'workspace-write', signal,
    })).rejects.toThrow(/明确授权/u);
  }, 90_000);

  it.runIf(process.platform === 'linux')('enforces the DSH worker workspace and cancels an active worker without replay', async () => {
    const f = await fixture();
    const cwd = join(f.root, 'workspace');
    const outside = join(f.root, 'outside');
    await mkdir(cwd);
    await mkdir(outside);
    await symlink(outside, join(cwd, 'escape'));
    const signal = AbortSignal.timeout(75_000);
    const { backend, route } = await resolveSubagents({
      cwd, env: f.env, stateDir: join(f.root, 'broker'), dsh: f.config, signal,
      subagents: { ...DEFAULT_SUBAGENT_CONFIG, mode: 'broker' },
    });
    if (!backend || !route) throw new Error('Missing DSH worker route');
    cleanups.push(async () => { await backend.closeBackend?.(); });
    const launch = (task: string, access: 'read-only' | 'workspace-write') => backend.createOrReuse({
      route, task, scope: 'dsh-worker-boundary', cwd, access, signal,
      ...(access === 'workspace-write' ? { writeAuthorization: { workspace: cwd, task } } : {}),
    });
    await backend.wait(await launch('fixture write readonly.txt', 'read-only'), signal, 20_000);
    await expect(readFile(join(cwd, 'readonly.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    const writer = await launch('fixture write allowed.txt', 'workspace-write');
    await backend.wait(writer, signal, 20_000);
    await expect(readFile(join(cwd, 'allowed.txt'), 'utf8')).resolves.toBe('worker fixture\n');
    await backend.send(writer, 'fixture write escape/denied.txt', signal, 20_000);
    await expect(readFile(join(outside, 'denied.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await backend.send(writer, 'fixture shell writes', signal, 20_000);
    const shellResult = JSON.parse(f.requests.at(-1)!.body).messages
      .filter((message: { role: string }) => message.role === 'tool').at(-1);
    expect(String(shellResult?.content)).toContain('Read-only file system');
    await expect(readFile(join(cwd, 'inside.txt'), 'utf8')).resolves.toBe('shell inside\n');
    await expect(readFile(join(outside, 'shelloutside.txt'))).rejects.toMatchObject({ code: 'ENOENT' });

    const active = await launch('hold the active prompt', 'read-only');
    await expect.poll(() => f.requests.at(-1)?.body.includes('hold the active prompt'), { timeout: 20_000 }).toBe(true);
    await backend.interrupt(active, signal);
    expect(await backend.wait(active, signal, 20_000)).toMatchObject({ status: 'interrupted' });
    const requests = f.requests.length;
    expect(await backend.send(active, 'explicit follow-up after cancellation', signal, 20_000))
      .toMatchObject({ status: 'completed', text: '完整回复。' });
    expect(f.requests).toHaveLength(requests + 1);
  }, 90_000);

  it('delivers a real DSH worker result through the structured /btw entry point', async () => {
    const f = await fixture();
    const adapter = new StructuredAdapter({
      kind: 'dsh', binary, profileDir: f.root, env: f.env,
      dsh: { ...f.config, home: f.home }, sandbox: 'read-only',
    });
    cleanups.push(() => adapter.shutdown());
    const run = adapter.runSide({
      runId: 'dsh-side', cwd: f.root, scopeId: 'side-chat', sessionMode: 'live',
      liveInputMode: 'side', prompt: '/btw --read-only check the fixture',
    });
    const events: AgentEvent[] = [];
    for await (const event of run.events) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
    expect(events.filter(event => event.type === 'text').map(event => event.delta).join('')).toContain('完整回复。');
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.body).toContain('check the fixture');
  }, 60_000);

  it('forwards complete text, releases the writer, and follows cc-switch on the same session', async () => {
    expect(spawnProcessSync(binary, ['--version']).status).toBe(0);
    const f = await fixture();
    const provider = await resolveDshProvider(f.config, f.env, true);
    expect(provider.models).toEqual(['model-a', 'model-b']);
    expect(dshProfilePatch(provider, 'model-a')).not.toContain('test-dsh-credential');
    const first = f.session();
    const events: AgentEvent[] = [];
    await first.submit({ runId: '1', prompt: 'remember the first prompt' }, event => events.push(event), new AbortController().signal);
    expect(events.filter(event => event.type === 'text').map(event => event.delta).join('')).toBe('完整回复。');
    expect(first.id).toBeTruthy();
    expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
    await f.switchTo('model-b');
    const resumed = f.session(first.id);
    await resumed.submit({ runId: '2', prompt: 'the second prompt' }, () => {}, new AbortController().signal);
    expect(resumed.id).toBe(first.id);
    expect(f.requests.map(request => request.model)).toEqual(['model-a', 'model-b']);
    expect(f.requests[1]?.body).toContain('remember the first prompt');
  }, 80_000);

  it('cancels an active turn, protects the single writer, and releases it for the next owner', async () => {
    const f = await fixture();
    const primary = f.session();
    const events: AgentEvent[] = [];
    const active = primary.submit({ runId: '1', prompt: 'hold the active prompt' }, event => events.push(event), new AbortController().signal);
    void active.catch(() => {});
    await Promise.race([
      expect.poll(() => f.requests.length, { timeout: 20_000 }).toBe(1),
      active.then(() => { throw new Error('The active prompt ended before reaching the fixture'); }),
    ]);
    const concurrent = f.session(primary.id);
    await expect(concurrent.submit({ runId: '2', prompt: 'a concurrent writer' }, () => {}, new AbortController().signal))
      .rejects.toThrow(/写入客户端|already owned/u);
    expect(f.requests).toHaveLength(1);
    await primary.interrupt();
    await active;
    expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'interrupted' });
    await concurrent.submit({ runId: '3', prompt: 'a new owner' }, () => {}, new AbortController().signal);
    expect(f.requests).toHaveLength(2);
  }, 80_000);

  it('exposes the existing Bridge broker tools to a real DSH model turn through MCP', async () => {
    const f = await fixture();
    const calls: string[] = [];
    const session = f.session(undefined, {
      specs: brokerToolSpecs(),
      call: async tool => { calls.push(tool); return { success: true, text: 'Bridge fixture route result' }; },
      close: async () => {},
    });
    await session.submit({ runId: '1', prompt: 'call the Bridge route tool' }, () => {}, new AbortController().signal);
    expect(calls).toEqual(['list_routes']);
    expect(f.requests[1]?.body).toContain('Bridge fixture route result');
  }, 60_000);

  it.runIf(process.platform === 'linux')('rejects tool requests that would widen the sandbox', async () => {
    const f = await fixture();
    const events: AgentEvent[] = [];
    const allowedWallTime = AbortSignal.timeout(20_000);
    await f.session().submit({ runId: '1', prompt: 'request sandbox escalation' }, event => events.push(event), allowedWallTime);
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_use', name: 'bash' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_result', isError: true }));
    expect(events.find(event => event.type === 'tool_result')).not.toMatchObject({
      output: expect.stringContaining('invalid arguments'),
    });
    expect(events.some(event => event.type === 'interactive')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
    await expect(readFile(join(f.root, 'should-not-exist'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 40_000);

  it.runIf(process.platform === 'linux')('resumes after the dedicated ACP process is killed without replaying the interrupted prompt', async () => {
    const f = await fixture();
    const first = f.session();
    const active = first.submit({ runId: '1', prompt: 'hold the active prompt' }, () => {}, new AbortController().signal);
    const failed = active.catch((error: unknown) => error);
    await expect.poll(() => f.requests.length, { timeout: 20_000 }).toBe(1);
    const entries = (await readdir('/proc')).filter(name => /^\d+$/u.test(name));
    const owners = (await Promise.all(entries.map(async pid => {
      const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => '');
      if (cwd !== f.root) return undefined;
      const args = (await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')).split('\0');
      return args.includes('acp') && args.includes('--patch') ? Number(pid) : undefined;
    }))).filter((pid): pid is number => pid !== undefined);
    expect(owners).toHaveLength(1);
    process.kill(owners[0]!, 'SIGKILL');
    expect(await failed).toEqual(expect.objectContaining({ message: expect.stringMatching(/已退出|ACP connection closed/u) }));
    const recovery = f.session(first.id);
    await recovery.submit({ runId: '2', prompt: 'resume the original session' }, () => {}, new AbortController().signal);
    expect(recovery.id).toBe(first.id);
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]?.body).toContain('resume the original session');
  }, 60_000);

  it('keeps separate Feishu conversation history and restores its selected DSH session', async () => {
    const f = await fixture();
    const adapter = new StructuredAdapter({
      kind: 'dsh', binary, profileDir: f.root, env: f.env,
      dsh: { ...f.config, home: f.home },
      sandbox: 'read-only', subagents: undefined,
    });
    cleanups.push(() => adapter.shutdown());
    const turn = async (prompt: string) => {
      const run = adapter.run({ runId: prompt, prompt, cwd: f.root, scopeId: 'feishu:chat' });
      const events: AgentEvent[] = [];
      for await (const event of run.events) events.push(event);
      expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
      const system = events.find(event => event.type === 'system' && event.sessionId);
      if (system?.type !== 'system' || !system.sessionId) throw new Error('Missing DSH session ID');
      return system.sessionId;
    };
    const first = await turn('first Feishu task');
    await adapter.selectStructuredSession('feishu:chat', f.root);
    const second = await turn('different Feishu session');
    expect(second).not.toBe(first);
    expect(await adapter.structuredHistory('feishu:other', f.root)).toEqual([]);
    await adapter.selectStructuredSession('feishu:chat', f.root, first);
    expect(await turn('third Feishu task')).toBe(first);
    expect(f.requests[2]?.body).toContain('first Feishu task');
    expect(f.requests[2]?.body).not.toContain('different Feishu session');
  }, 80_000);
});
