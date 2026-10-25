import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  readonly interruptions: string[] = [];
  readonly closes: string[] = [];
  sendNotFoundOnce = false;
  hangWaits = false;

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

  async wait(agent: SideAgent, signal: AbortSignal): Promise<SideAgentResult> {
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

  async send(agent: SideAgent, message: string, signal?: AbortSignal): Promise<SideAgentResult> {
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
    const main: StructuredSession & {
      submitCalls: number;
    } = {
      id: 'main-thread',
      submitCalls: 0,
      async submit(_options, emit) {
        this.submitCalls += 1;
        emit({
          type: 'tool_use',
          id: 'tool-1',
          name: 'fileChange',
          input: { path: 'src/app.ts' },
        });
        emit({ type: 'done', terminationReason: 'normal' });
      },
      async command() { return []; },
      async answer() {},
      hasRequest() { return false; },
      freeTextRequest() { return undefined; },
      async interrupt() { return false; },
      diagnostics() {
        return { phase: 'idle', inputState: 'empty', retryCount: 0 };
      },
      async close() {},
    };
    const adapter = new StructuredAdapter({
      kind: 'codex',
      binary: 'not-spawned',
      profileDir,
      rsi: {
        mode: 'auto',
        projectRoot,
        reviewerRouteMode: 'follow-cc-switch',
        reviewerRoute: null,
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
    expect(events.filter(event => event.type === 'tool_use')).toHaveLength(1);
    expect(events.filter(event => event.type === 'done')).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      message: expect.stringContaining('fresh validator receipt'),
    }));
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
