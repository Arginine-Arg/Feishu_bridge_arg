import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StructuredAdapter } from '../../../src/agent/structured/adapter';
import { CodexStructuredSession } from '../../../src/agent/structured/codex';
import { StructuredView } from '../../../src/agent/structured/view';
import type { RpcClient } from '../../../src/agent/structured/rpc';
import {
  SubagentAgentNotFoundError,
  type SideAgent,
  type SideAgentInput,
  type SideAgentResult,
  type SubagentBackend,
  type SubagentRoute,
} from '../../../src/agent/subagents/types';
import type { ResolvedSubagents } from '../../../src/agent/subagents/registry';
import type { SubagentConfig } from '../../../src/config/profile-schema';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import {
  createRootConfig,
  saveRootConfig,
} from '../../../src/config/profile-store';
import type { AgentEvent, AgentRun } from '../../../src/agent/types';
import type { StructuredSession } from '../../../src/agent/structured/contracts';

afterEach(() => vi.restoreAllMocks());

const subagents: SubagentConfig = {
  enabled: true,
  mode: 'broker',
  routeMode: 'manual',
  readRoute: 'route-a',
  writeRoute: null,
  modelTools: true,
  nativeToolPolicy: 'shadow',
  toolNamespace: 'arg_bridge',
  maxConcurrentWorkers: 4,
  workerTimeoutMs: 15 * 60_000,
  allowWriteWorkers: false,
  includeProgressSnapshot: true,
  reuse: 'scope-cwd',
  allowForkFallback: false,
};

const routeA: SubagentRoute = {
  id: 'route-a',
  provider: 'provider-a',
  model: 'model-a',
  maxAccess: 'read-only',
  available: true,
  missingEnvironment: [],
  tags: ['review'],
};

const routeB: SubagentRoute = {
  id: 'route-b',
  provider: 'provider-b',
  model: 'model-b',
  maxAccess: 'read-only',
  available: true,
  missingEnvironment: [],
  tags: ['review'],
};

class FakeBackend implements SubagentBackend {
  readonly id = 'mixagents' as const;
  readonly spawns: SideAgentInput[] = [];
  readonly sends: Array<{ agent: SideAgent; message: string; signal?: AbortSignal }> = [];
  readonly waitTimeouts: Array<number | undefined> = [];
  readonly sendTimeouts: Array<number | undefined> = [];
  readonly interruptions: string[] = [];
  readonly closes: string[] = [];
  backendCloses = 0;
  sendNotFoundOnce = false;
  hangWaits = false;
  waitResult?: SideAgentResult;

  constructor(private readonly route: () => SubagentRoute) {}

  async listRoutes(_signal: AbortSignal): Promise<SubagentRoute[]> {
    return [routeA, routeB];
  }

  async createOrReuse(input: SideAgentInput): Promise<SideAgent> {
    this.spawns.push(input);
    return {
      agentId: `agent-${this.spawns.length}`,
      route: input.route.id,
      provider: input.route.provider,
      model: input.route.model,
      access: input.access,
      cwd: input.cwd,
      scope: input.scope,
      backendId: 'mixagents',
      status: 'running',
      createdAt: Date.now(),
    };
  }

  async wait(
    agent: SideAgent,
    signal: AbortSignal,
    timeoutMs?: number,
  ): Promise<SideAgentResult> {
    this.waitTimeouts.push(timeoutMs);
    if (this.waitResult) return this.waitResult;
    if (this.hangWaits) {
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      });
    }
    return { status: 'completed', text: `completed:${agent.agentId}` };
  }

  async send(
    agent: SideAgent,
    message: string,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<SideAgentResult> {
    this.sendTimeouts.push(timeoutMs);
    if (this.sendNotFoundOnce) {
      this.sendNotFoundOnce = false;
      throw new SubagentAgentNotFoundError(agent.agentId);
    }
    this.sends.push({ agent, message, signal });
    return { status: 'completed', text: `followup:${agent.agentId}` };
  }

  async interrupt(agent: SideAgent): Promise<void> {
    this.interruptions.push(agent.agentId);
  }

  async close(agent: SideAgent): Promise<void> {
    this.closes.push(agent.agentId);
  }

  async closeBackend(): Promise<void> {
    this.backendCloses += 1;
  }
}

const drain = async (run: AgentRun): Promise<AgentEvent[]> => {
  const events: AgentEvent[] = [];
  for await (const event of run.events) events.push(event);
  return events;
};

function session() {
  const rpc = new EventEmitter() as EventEmitter & { request: ReturnType<typeof vi.fn> };
  rpc.request = vi.fn(async () => ({}));
  return new CodexStructuredSession('main-thread', '', rpc as unknown as RpcClient);
}

function resolved(
  route: SubagentRoute,
  backend: FakeBackend,
  config: SubagentConfig = subagents,
): ResolvedSubagents {
  return {
    kind: 'mixagents',
    config,
    backend,
    route,
    routes: [routeA, routeB],
    ccSwitch: {
      currentProviderCodex: 'provider-a',
      providers: [],
      settingsPath: '/not-used/settings.json',
    },
  };
}

describe('structured MixAgents /btw', () => {
  it('queues next-turn input for third-party structured providers instead of using turn/steer', async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'arg-bridge-third-party-steer-'));
    const main = session();
    const submit = vi.spyOn(main, 'submit').mockImplementation(async (_options, _emit, signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      });
    });
    const adapter = new StructuredAdapter({
      kind: 'codex',
      binary: 'not-spawned',
      profileDir,
    });
    Reflect.set(adapter, 'providerIsThirdParty', true);
    Reflect.get(adapter, 'sessions').set('scope', {
      main,
      cwd: '/workspace',
      view: new StructuredView(profileDir, 'main'),
    });

    const run = adapter.run({
      runId: 'third-party-steer',
      scopeId: 'scope',
      cwd: '/workspace',
      prompt: 'long provider task',
    });
    await vi.waitFor(() => expect(submit).toHaveBeenCalled());
    await expect(run.steer?.({ text: 'next-turn input' })).resolves.toMatchObject({
      status: 'unavailable',
      reason: expect.stringContaining('next-turn queueing'),
    });
    await run.stop({ force: true });
    await drain(run);
    await main.close();
    await rm(profileDir, { recursive: true, force: true });
  });

  it('reloads a Broker marker written after the daemon started', async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'arg-bridge-marker-hot-reload-'));
    const adapter = new StructuredAdapter({
      kind: 'codex',
      binary: 'not-spawned',
      profileDir,
    });
    await mkdir(join(profileDir, 'structured'), { recursive: true });
    await writeFile(join(profileDir, 'structured', 'broker-threads.json'), JSON.stringify({
      version: 1,
      threads: {
        'adopted-after-start': {
          version: 1,
          namespace: 'arg_bridge',
          createdAt: Date.now(),
          adoptedFrom: 'legacy-thread',
        },
      },
    }));

    const hasBrokerTools = Reflect.get(adapter, 'hasBrokerTools') as
      (threadId: string, namespace: string) => boolean;
    expect(hasBrokerTools.call(adapter, 'adopted-after-start', 'arg_bridge')).toBe(true);
    expect(hasBrokerTools.call(adapter, 'not-adopted', 'arg_bridge')).toBe(false);
    await rm(profileDir, { recursive: true, force: true });
  });

  it('uses the main Codex provider through thread/fork when the resolver falls back', async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'arg-bridge-side-main-fallback-'));
    const rpc = new EventEmitter() as EventEmitter & { request: ReturnType<typeof vi.fn> };
    rpc.request = vi.fn(async () => ({}));
    const main = new CodexStructuredSession('main-thread', '', rpc as unknown as RpcClient);
    const side = new CodexStructuredSession(
      'side-thread',
      'unix:///tmp/main-provider-side.sock',
      rpc as unknown as RpcClient,
    );
    vi.spyOn(main, 'forkSide').mockResolvedValue(side);
    const submitted: Array<{ prompt: string; sandbox?: string }> = [];
    vi.spyOn(side, 'submit').mockImplementation(async (options, emit) => {
      submitted.push({ prompt: options.prompt, sandbox: options.sandbox });
      emit({ type: 'text', delta: 'MAIN_PROVIDER_SIDE_OK' });
      emit({ type: 'done', terminationReason: 'normal' });
    });
    vi.spyOn(StructuredView.prototype, 'start').mockResolvedValue();
    const resolver = vi.fn(async (): Promise<ResolvedSubagents> => ({
      kind: 'fork',
      config: { ...subagents, mode: 'auto', routeMode: 'follow-cc-switch', allowForkFallback: true },
      routes: [],
      notice: '子代理 provider 不可用，已回退到主 Codex session。',
      ccSwitch: {
        currentProviderCodex: 'provider-a',
        providers: [],
        settingsPath: '/not-used/settings.json',
      },
    }));
    const adapter = new StructuredAdapter({
      kind: 'codex',
      binary: 'not-spawned',
      profileDir,
      subagents: { ...subagents, mode: 'auto', routeMode: 'follow-cc-switch', allowForkFallback: true },
      subagentResolver: resolver,
    });
    Reflect.get(adapter, 'sessions').set('scope', {
      main,
      cwd: '/workspace',
      view: new StructuredView(profileDir, 'main'),
    });

    const events = await drain(adapter.runSide({
      runId: 'main-fallback',
      scopeId: 'scope',
      cwd: '/workspace',
      prompt: '/btw 现在什么进度了？',
      liveInputMode: 'side',
    }));
    expect(events.filter(event => event.type === 'error')).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'text',
      delta: expect.stringContaining('MAIN_PROVIDER_SIDE_OK'),
    }));
    expect(main.forkSide).toHaveBeenCalledWith('/workspace');
    expect(submitted).toEqual([{
      prompt: '现在什么进度了？',
      sandbox: 'read-only',
    }]);
    await side.close();
    await main.close();
    await rm(profileDir, { recursive: true, force: true });
  });

  it('binds a user-issued write directive outside the parent prompt and clears it', async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'arg-bridge-write-auth-'));
    const workspace = await mkdtemp(join(tmpdir(), 'arg-bridge-write-workspace-'));
    const rpc = new EventEmitter() as EventEmitter & { request: ReturnType<typeof vi.fn> };
    rpc.request = vi.fn(async () => ({}));
    const main = new CodexStructuredSession(
      'main-thread',
      'unix:///tmp/write-auth.sock',
      rpc as unknown as RpcClient,
    );
    const authorization = vi.spyOn(main, 'setBrokerWriteAuthorization');
    const prompts: string[] = [];
    vi.spyOn(main, 'submit').mockImplementation(async options => {
      prompts.push(options.prompt);
    });
    const adapter = new StructuredAdapter({
      kind: 'codex',
      binary: 'not-spawned',
      profileDir,
    });
    Reflect.get(adapter, 'sessions').set('scope', {
      main,
      cwd: workspace,
      view: new StructuredView(profileDir, 'main'),
    });
    const events = await drain(adapter.run({
      runId: 'write-auth',
      scopeId: 'scope',
      cwd: workspace,
      prompt: `arg-bridge-write --workspace "${workspace}" --task Fix the parser`,
    }));
    expect(events.filter(event => event.type === 'error')).toEqual([]);
    expect(prompts).toEqual(['Fix the parser']);
    expect(authorization).toHaveBeenNthCalledWith(1, {
      workspace,
      task: 'Fix the parser',
    });
    expect(authorization).toHaveBeenLastCalledWith(undefined);
    await main.close();
    await rm(profileDir, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  it('spawns read-only, reuses the same agent, and replaces it on route change', async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'arg-bridge-side-'));
    let activeRoute = routeA;
    const backend = new FakeBackend(() => activeRoute);
    const resolver = vi.fn(async () => resolved(activeRoute, backend));
    const main = session();
    Reflect.set(main, 'lastUserText', 'Review sk-super-secret-value and do not share it');
    Reflect.set(main, 'lastAssistantText', 'I will inspect the patch');
    const adapter = new StructuredAdapter({
      kind: 'codex',
      binary: 'not-spawned',
      profileDir,
      subagents,
      subagentResolver: resolver,
    });
    Reflect.get(adapter, 'sessions').set('scope', {
      main,
      cwd: '/workspace',
      view: new StructuredView(profileDir, 'main'),
    });

    const first = await drain(adapter.runSide({
      runId: 'side-1',
      scopeId: 'scope',
      cwd: '/workspace',
      prompt: '/btw Review the implementation',
      liveInputMode: 'side',
    }));
    expect(first.filter(event => event.type === 'error')).toEqual([]);
    expect(backend.spawns).toHaveLength(1);
    expect(backend.spawns[0]).toMatchObject({
      route: routeA,
      cwd: '/workspace',
      access: 'read-only',
    });
    expect(backend.spawns[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(backend.spawns[0]!.task).not.toContain('sk-super-secret-value');
    expect(backend.spawns[0]!.task).toContain('[REDACTED]');
    expect(backend.waitTimeouts[0]).toBe(subagents.workerTimeoutMs);

    const second = await drain(adapter.runSide({
      runId: 'side-2',
      scopeId: 'scope',
      cwd: '/workspace',
      prompt: '/btw Check the tests',
      liveInputMode: 'side',
    }));
    expect(second.filter(event => event.type === 'error')).toEqual([]);
    expect(backend.sends).toHaveLength(1);
    expect(backend.sends[0]!.agent.agentId).toBe('agent-1');
    expect(backend.sends[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(backend.sendTimeouts[0]).toBe(subagents.workerTimeoutMs);

    activeRoute = routeB;
    resolver.mockImplementation(async () => resolved(activeRoute, backend));
    const switched = await drain(adapter.runSide({
      runId: 'side-3',
      scopeId: 'scope',
      cwd: '/workspace',
      prompt: '/btw Re-review with the new provider',
      liveInputMode: 'side',
    }));
    expect(switched.filter(event => event.type === 'error')).toEqual([]);
    expect(backend.interruptions).toContain('agent-1');
    expect(backend.closes).toContain('agent-1');
    expect(backend.spawns).toHaveLength(2);
    expect(backend.spawns[1]).toMatchObject({ route: routeB, access: 'read-only' });
    expect((await adapter.tmux.diagnostics!('scope')).sideConversation).toBe(true);

    const exited = await drain(adapter.runSide({
      runId: 'out',
      scopeId: 'scope',
      cwd: '/workspace',
      prompt: '/btw out',
      liveInputMode: 'side-exit',
    }));
    expect(exited).toContainEqual(expect.objectContaining({
      type: 'system',
      sideConversation: 'exited',
    }));
    expect((await adapter.tmux.diagnostics!('scope')).sideConversation).toBe(false);
    await main.close();
    await rm(profileDir, { recursive: true, force: true });
  });

  it('creates a new agent when send reports not_found', async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'arg-bridge-side-'));
    const backend = new FakeBackend(() => routeA);
    const resolver = vi.fn(async () => resolved(routeA, backend));
    const main = session();
    const adapter = new StructuredAdapter({
      kind: 'codex',
      binary: 'not-spawned',
      profileDir,
      subagents,
      subagentResolver: resolver,
    });
    Reflect.get(adapter, 'sessions').set('scope', {
      main,
      cwd: '/workspace',
      view: new StructuredView(profileDir, 'main'),
    });
    await drain(adapter.runSide({
      runId: 'first',
      scopeId: 'scope',
      cwd: '/workspace',
      prompt: '/btw First task',
      liveInputMode: 'side',
    }));
    backend.sendNotFoundOnce = true;
    const events = await drain(adapter.runSide({
      runId: 'second',
      scopeId: 'scope',
      cwd: '/workspace',
      prompt: '/btw Retry after not_found',
      liveInputMode: 'side',
    }));
    expect(events.filter(event => event.type === 'error')).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'text',
      delta: expect.stringContaining('已不存在'),
    }));
    expect(backend.spawns).toHaveLength(2);
    await main.close();
    await rm(profileDir, { recursive: true, force: true });
  });

  it('reuses the backend that owns an existing side and closes only the verification backend', async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'arg-bridge-side-backend-reuse-'));
    const owner = new FakeBackend(() => routeA);
    const verification = new FakeBackend(() => routeA);
    const resolver = vi.fn()
      .mockResolvedValueOnce(resolved(routeA, owner))
      .mockResolvedValueOnce(resolved(routeA, verification));
    const main = session();
    const adapter = new StructuredAdapter({
      kind: 'codex',
      binary: 'not-spawned',
      profileDir,
      subagents,
      subagentResolver: resolver,
    });
    Reflect.get(adapter, 'sessions').set('scope', {
      main,
      cwd: '/workspace',
      view: new StructuredView(profileDir, 'main'),
    });

    await drain(adapter.runSide({
      runId: 'owner',
      scopeId: 'scope',
      cwd: '/workspace',
      prompt: '/btw First task',
      liveInputMode: 'side',
    }));
    const followup = await drain(adapter.runSide({
      runId: 'verification',
      scopeId: 'scope',
      cwd: '/workspace',
      prompt: '/btw Follow up',
      liveInputMode: 'side',
    }));

    expect(followup.filter(event => event.type === 'error')).toEqual([]);
    expect(owner.spawns).toHaveLength(1);
    expect(owner.sends).toHaveLength(1);
    expect(owner.sends[0]?.agent.agentId).toBe('agent-1');
    expect(verification.spawns).toHaveLength(0);
    expect(verification.sends).toHaveLength(0);
    expect(verification.backendCloses).toBe(1);
    await main.close();
    await rm(profileDir, { recursive: true, force: true });
  });

  it('keeps the newly resolved backend alive to recreate a missing agent', async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'arg-bridge-side-backend-recreate-'));
    const owner = new FakeBackend(() => routeA);
    const replacement = new FakeBackend(() => routeA);
    const resolver = vi.fn()
      .mockResolvedValueOnce(resolved(routeA, owner))
      .mockResolvedValueOnce(resolved(routeA, replacement));
    const main = session();
    const adapter = new StructuredAdapter({
      kind: 'codex',
      binary: 'not-spawned',
      profileDir,
      subagents,
      subagentResolver: resolver,
    });
    Reflect.get(adapter, 'sessions').set('scope', {
      main,
      cwd: '/workspace',
      view: new StructuredView(profileDir, 'main'),
    });

    await drain(adapter.runSide({
      runId: 'owner',
      scopeId: 'scope',
      cwd: '/workspace',
      prompt: '/btw First task',
      liveInputMode: 'side',
    }));
    owner.sendNotFoundOnce = true;
    const events = await drain(adapter.runSide({
      runId: 'replacement',
      scopeId: 'scope',
      cwd: '/workspace',
      prompt: '/btw Recreate after not_found',
      liveInputMode: 'side',
    }));

    expect(events.filter(event => event.type === 'error')).toEqual([]);
    expect(owner.backendCloses).toBe(1);
    expect(replacement.backendCloses).toBe(0);
    expect(replacement.spawns).toHaveLength(1);
    expect(replacement.spawns[0]?.task).toContain('Recreate after not_found');
    await main.close();
    await rm(profileDir, { recursive: true, force: true });
  });

  it('uses profile changes from an already-running old session', async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'arg-bridge-side-reload-'));
    const configFile = join(profileDir, 'config.json');
    const profile = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
      codex: { binaryPath: 'codex' },
    });
    profile.subagents = { ...subagents, readRoute: 'route-a' };
    await saveRootConfig(createRootConfig('codex', profile), configFile);

    const backend = new FakeBackend(() => routeA);
    const resolver = vi.fn(async input => resolved(
      input.subagents?.readRoute === 'route-b' ? routeB : routeA,
      backend,
      input.subagents,
    ));
    const main = session();
    const adapter = new StructuredAdapter({
      kind: 'codex',
      binary: 'not-spawned',
      profileDir,
      configFile,
      profile: 'codex',
      // This stale startup value must not win over the profile file.
      subagents: { ...subagents, readRoute: 'route-a' },
      subagentResolver: resolver,
    });
    Reflect.get(adapter, 'sessions').set('scope', {
      main,
      cwd: '/workspace',
      view: new StructuredView(profileDir, 'main'),
    });
    await drain(adapter.runSide({
      runId: 'before',
      scopeId: 'scope',
      cwd: '/workspace',
      prompt: '/btw Before reload',
      liveInputMode: 'side',
    }));
    expect(backend.spawns[0]?.route).toBe(routeA);

    profile.subagents = { ...subagents, readRoute: 'route-b' };
    await saveRootConfig(createRootConfig('codex', profile), configFile);
    const events = await drain(adapter.runSide({
      runId: 'after',
      scopeId: 'scope',
      cwd: '/workspace',
      prompt: '/btw After reload',
      liveInputMode: 'side',
    }));
    expect(events.filter(event => event.type === 'error')).toEqual([]);
    expect(backend.spawns[1]?.route).toBe(routeB);
    expect(backend.interruptions).toContain('agent-1');
    await main.close();
    await rm(profileDir, { recursive: true, force: true });
  });

  it('replaces a side when the same route id changes provider/model/revision', async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'arg-bridge-side-revision-'));
    let active: SubagentRoute = { ...routeA, model: 'model-a1', revision: 'rev-1' };
    const backend = new FakeBackend(() => active);
    const resolver = vi.fn(async () => resolved(active, backend));
    const main = session();
    const adapter = new StructuredAdapter({
      kind: 'codex',
      binary: 'not-spawned',
      profileDir,
      subagents,
      subagentResolver: resolver,
    });
    Reflect.get(adapter, 'sessions').set('scope', {
      main,
      cwd: '/workspace',
      view: new StructuredView(profileDir, 'main'),
    });
    await drain(adapter.runSide({
      runId: 'revision-1',
      scopeId: 'scope',
      cwd: '/workspace',
      prompt: '/btw First revision',
      liveInputMode: 'side',
    }));
    active = { ...routeA, model: 'model-a2', revision: 'rev-2' };
    resolver.mockImplementation(async () => resolved(active, backend));
    await drain(adapter.runSide({
      runId: 'revision-2',
      scopeId: 'scope',
      cwd: '/workspace',
      prompt: '/btw Second revision',
      liveInputMode: 'side',
    }));
    expect(backend.interruptions).toContain('agent-1');
    expect(backend.spawns).toHaveLength(2);
    expect(backend.spawns[1]?.route.revision).toBe('rev-2');
    await main.close();
    await rm(profileDir, { recursive: true, force: true });
  });

  it('blocks a persistent main turn without fresh Project RSI evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arg-bridge-rsi-gate-'));
    const projectRoot = join(root, 'project');
    const profileDir = join(root, 'state');
    await mkdir(join(projectRoot, '.project-rsi'), { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await writeFile(join(projectRoot, '.project-rsi', 'config.json'), JSON.stringify({
      version: 1,
    }));
    const rpc = new EventEmitter() as EventEmitter & { request: ReturnType<typeof vi.fn> };
    rpc.request = vi.fn(async () => ({}));
    const main = new CodexStructuredSession(
      'main-thread',
      'unix:///tmp/rsi-main.sock',
      rpc as unknown as RpcClient,
    );
    const submittedPrompts: string[] = [];
    vi.spyOn(main, 'submit').mockImplementation(async (options, emit) => {
      submittedPrompts.push(options.prompt);
      emit({
        type: 'tool_use',
        id: `tool-${submittedPrompts.length}`,
        name: 'fileChange',
        input: { path: 'src/app.ts' },
      });
      emit({ type: 'done', terminationReason: 'normal' });
    });
    const adapter = new StructuredAdapter({
      kind: 'codex',
      binary: 'not-spawned',
      profileDir,
      rsi: {
        mode: 'auto',
        projectRoot,
        reviewerRouteMode: 'follow-cc-switch',
        reviewerRoute: null,
        maxRepairRounds: 2,
        repairTimeoutMs: 10 * 60_000,
      },
    });
    Reflect.get(adapter, 'sessions').set('scope', {
      main,
      cwd: projectRoot,
      view: new StructuredView(profileDir, 'main'),
    });

    const events = await drain(adapter.run({
      runId: 'persistent-turn',
      scopeId: 'scope',
      cwd: projectRoot,
      prompt: 'Modify the project and report completion',
    }));
    expect(events.filter(event => event.type === 'tool_use')).toHaveLength(3);
    expect(submittedPrompts).toHaveLength(3);
    expect(submittedPrompts.slice(1)).toEqual([
      expect.stringContaining('<validator-findings>'),
      expect.stringContaining('<validator-findings>'),
    ]);
    expect(events.filter(event => event.type === 'done')).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      message: expect.stringContaining('fresh validator receipt'),
    }));
    await main.close();
    await rm(root, { recursive: true, force: true });
  });

  it('feeds validator findings back, repairs in the same thread, and reruns the gate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arg-bridge-rsi-repair-'));
    const projectRoot = join(root, 'project');
    const profileDir = join(root, 'state');
    await mkdir(join(projectRoot, '.project-rsi'), { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await writeFile(join(projectRoot, '.project-rsi', 'config.json'), JSON.stringify({
      version: 1,
      validator: { path: '.project-rsi/project_rsi.py' },
    }), { mode: 0o600 });
    await writeFile(join(projectRoot, '.project-rsi', 'project_rsi.py'), '#!/usr/bin/env python3\n', {
      mode: 0o700,
    });
    const rpc = new EventEmitter() as EventEmitter & { request: ReturnType<typeof vi.fn> };
    rpc.request = vi.fn(async () => ({}));
    const main = new CodexStructuredSession(
      'main-thread',
      'unix:///tmp/rsi-repair.sock',
      rpc as unknown as RpcClient,
    );
    const submittedPrompts: string[] = [];
    vi.spyOn(main, 'submit').mockImplementation(async (options, emit) => {
      submittedPrompts.push(options.prompt);
      emit({
        type: 'tool_use',
        id: `tool-${submittedPrompts.length}`,
        name: 'fileChange',
        input: { path: 'src/app.ts' },
      });
      if (submittedPrompts.length > 1) {
        const runId = 'repair-run-001';
        const runDir = join(projectRoot, '.agent', 'rsi', 'runs', runId);
        await mkdir(runDir, { recursive: true });
        const manifest = `${JSON.stringify({
          runId,
          projectRoot,
          threadId: 'main-thread',
          taskHash: createHash('sha256')
            .update('Modify the project and report completion')
            .digest('hex'),
          outcome: 'success',
        }, null, 2)}\n`;
        await writeFile(join(runDir, 'manifest.json'), manifest, { mode: 0o600 });
        await writeFile(join(runDir, 'validator.json'), JSON.stringify({
          runId,
          manifestSha256: createHash('sha256').update(manifest).digest('hex'),
          passed: true,
          exitCode: 0,
        }), { mode: 0o600 });
        const freshTime = new Date(Date.now() + 100);
        await Promise.all([
          utimes(join(runDir, 'manifest.json'), freshTime, freshTime),
          utimes(join(runDir, 'validator.json'), freshTime, freshTime),
        ]);
      }
      emit({ type: 'done', terminationReason: 'normal' });
    });
    const backend = new FakeBackend(() => routeA);
    const resolver = vi.fn(async () => resolved(routeA, backend));
    const adapter = new StructuredAdapter({
      kind: 'codex',
      binary: 'not-spawned',
      profileDir,
      subagents: { ...subagents, enabled: true, mode: 'broker' },
      subagentResolver: resolver,
      rsi: {
        mode: 'auto',
        projectRoot,
        reviewerRouteMode: 'manual',
        reviewerRoute: routeA.id,
        maxRepairRounds: 2,
        repairTimeoutMs: 10 * 60_000,
      },
    });
    Reflect.get(adapter, 'sessions').set('scope', {
      main,
      cwd: projectRoot,
      view: new StructuredView(profileDir, 'main'),
    });
    const events = await drain(adapter.run({
      runId: 'rsi-repair',
      scopeId: 'scope',
      cwd: projectRoot,
      prompt: 'Modify the project and report completion',
    }));
    expect(submittedPrompts).toHaveLength(2);
    expect(submittedPrompts[1]).toContain('<validator-findings>');
    expect(events).toContainEqual(expect.objectContaining({
      type: 'done',
      terminationReason: 'normal',
    }));
    expect(events.filter(event => event.type === 'error')).toEqual([]);
    const evidence = JSON.parse(await readFile(
      join(projectRoot, '.agent', 'rsi', 'runs', 'repair-run-001', 'repair-loop.json'),
      'utf8',
    ));
    expect(evidence).toMatchObject({
      finalVerdict: 'passed',
      rounds: [expect.objectContaining({ round: 1 })],
    });
    expect(backend.spawns[0]).toMatchObject({ access: 'read-only' });
    await main.close();
    await rm(root, { recursive: true, force: true });
  });

  it('does not pass Project RSI when the reviewer is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arg-bridge-rsi-reviewer-'));
    const projectRoot = join(root, 'project');
    const profileDir = join(root, 'state');
    await mkdir(join(projectRoot, '.project-rsi'), { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await writeFile(join(projectRoot, '.project-rsi', 'config.json'), JSON.stringify({
      version: 1,
      validator: { path: '.project-rsi/project_rsi.py' },
    }), { mode: 0o600 });
    await writeFile(join(projectRoot, '.project-rsi', 'project_rsi.py'), '#!/usr/bin/env python3\n', {
      mode: 0o700,
    });
    const rpc = new EventEmitter() as EventEmitter & { request: ReturnType<typeof vi.fn> };
    rpc.request = vi.fn(async () => ({}));
    const main = new CodexStructuredSession(
      'main-thread',
      'unix:///tmp/rsi-reviewer.sock',
      rpc as unknown as RpcClient,
    );
    vi.spyOn(main, 'submit').mockImplementation(async (_options, emit) => {
      emit({
        type: 'tool_use',
        id: 'tool-reviewer',
        name: 'fileChange',
        input: { path: 'src/app.ts' },
      });
      const runId = 'reviewer-run-001';
      const runDir = join(projectRoot, '.agent', 'rsi', 'runs', runId);
      await mkdir(runDir, { recursive: true });
      const manifest = `${JSON.stringify({
        runId,
        projectRoot,
        threadId: 'main-thread',
        taskHash: createHash('sha256')
          .update('Modify and require review')
          .digest('hex'),
        outcome: 'success',
      }, null, 2)}\n`;
      await writeFile(join(runDir, 'manifest.json'), manifest, { mode: 0o600 });
      await writeFile(join(runDir, 'validator.json'), JSON.stringify({
        runId,
        manifestSha256: createHash('sha256').update(manifest).digest('hex'),
        passed: true,
        exitCode: 0,
      }), { mode: 0o600 });
      emit({ type: 'done', terminationReason: 'normal' });
    });
    const backend = new FakeBackend(() => routeA);
    backend.waitResult = { status: 'failed', error: 'reviewer unavailable' };
    const adapter = new StructuredAdapter({
      kind: 'codex',
      binary: 'not-spawned',
      profileDir,
      subagents: { ...subagents, enabled: true, mode: 'broker' },
      subagentResolver: vi.fn(async () => resolved(routeA, backend)),
      rsi: {
        mode: 'auto',
        projectRoot,
        reviewerRouteMode: 'manual',
        reviewerRoute: routeA.id,
        maxRepairRounds: 0,
        repairTimeoutMs: 10 * 60_000,
      },
    });
    Reflect.get(adapter, 'sessions').set('scope', {
      main,
      cwd: projectRoot,
      view: new StructuredView(profileDir, 'main'),
    });
    const events = await drain(adapter.run({
      runId: 'rsi-reviewer-failure',
      scopeId: 'scope',
      cwd: projectRoot,
      prompt: 'Modify and require review',
    }));
    expect(events.filter(event => event.type === 'done')).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      message: expect.stringContaining('reviewer'),
    }));
    await main.close();
    await rm(root, { recursive: true, force: true });
  });

  it('interrupts a spawned side when its AbortSignal is cancelled', async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'arg-bridge-side-abort-'));
    const backend = new FakeBackend(() => routeA);
    backend.hangWaits = true;
    const resolver = vi.fn(async () => resolved(routeA, backend));
    const main = session();
    const adapter = new StructuredAdapter({
      kind: 'codex',
      binary: 'not-spawned',
      profileDir,
      subagents,
      subagentResolver: resolver,
    });
    Reflect.get(adapter, 'sessions').set('scope', {
      main,
      cwd: '/workspace',
      view: new StructuredView(profileDir, 'main'),
    });
    const run = adapter.runSide({
      runId: 'cancel-side',
      scopeId: 'scope',
      cwd: '/workspace',
      prompt: '/btw Cancel this side',
      liveInputMode: 'side',
    });
    await vi.waitFor(() => expect(backend.spawns).toHaveLength(1));
    await run.stop();
    const events = await drain(run);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      terminationReason: 'interrupted',
    }));
    expect(backend.interruptions).toContain('agent-1');
    await main.close();
    await rm(profileDir, { recursive: true, force: true });
  });
});
