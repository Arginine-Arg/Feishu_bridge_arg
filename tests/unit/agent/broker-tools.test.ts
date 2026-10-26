import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrokerToolController,
  brokerCodexThreadConfig,
} from '../../../src/agent/subagents/broker-tools';
import {
  SubagentAgentNotFoundError,
  type SideAgent,
  type SideAgentInput,
  type SideAgentResult,
  type SubagentBackend,
  type SubagentRoute,
} from '../../../src/agent/subagents/types';
import { CodexStructuredSession } from '../../../src/agent/structured/codex';
import { parseWriteAuthorizationPrompt } from '../../../src/agent/structured/adapter';
import type { RpcClient } from '../../../src/agent/structured/rpc';
import {
  DEFAULT_SUBAGENT_CONFIG,
  type SubagentConfig,
} from '../../../src/config/profile-schema';

const routeRead: SubagentRoute = {
  id: 'read-a',
  provider: 'provider-a',
  model: 'model-a',
  maxAccess: 'read-only',
  available: true,
  missingEnvironment: [],
  tags: ['review'],
  revision: 'r1',
};

const routeReadB: SubagentRoute = {
  ...routeRead,
  id: 'read-b',
  provider: 'provider-b',
  model: 'model-b',
  revision: 'r2',
};

const routeReadC: SubagentRoute = {
  ...routeRead,
  id: 'read-c',
  provider: 'provider-c',
  model: 'model-c',
  revision: 'r3',
};

const routeWrite: SubagentRoute = {
  id: 'write-a',
  provider: 'provider-w',
  model: 'model-w',
  maxAccess: 'workspace-write',
  available: true,
  missingEnvironment: [],
  tags: ['coding'],
  revision: 'w1',
};

class FakeBrokerBackend implements SubagentBackend {
  readonly id = 'mixagents' as const;
  readonly spawns: SideAgentInput[] = [];
  readonly sends: Array<{ agent: SideAgent; message: string }> = [];
  readonly interrupts: string[] = [];
  readonly closes: string[] = [];
  notFound = false;
  sendNotFoundOnce = false;

  async listRoutes(): Promise<SubagentRoute[]> {
    return [routeRead, routeReadB, routeReadC, routeWrite];
  }

  async createOrReuse(input: SideAgentInput): Promise<SideAgent> {
    this.spawns.push(input);
    return {
      agentId: `agent-${this.spawns.length}`,
      threadId: `worker-thread-${this.spawns.length}`,
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

  async wait(agent: SideAgent): Promise<SideAgentResult> {
    if (this.notFound) throw new SubagentAgentNotFoundError(agent.agentId);
    return { status: 'completed', text: `result:${agent.agentId}` };
  }

  async send(agent: SideAgent, message: string): Promise<SideAgentResult> {
    if (this.sendNotFoundOnce) {
      this.sendNotFoundOnce = false;
      throw new SubagentAgentNotFoundError(agent.agentId);
    }
    this.sends.push({ agent, message });
    return { status: 'completed', text: `followup:${message}` };
  }

  async interrupt(agent: SideAgent): Promise<void> {
    this.interrupts.push(agent.agentId);
  }

  async close(agent: SideAgent): Promise<void> {
    this.closes.push(agent.agentId);
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map(path =>
    rm(path, { recursive: true, force: true })
  ));
});

async function controller(options: {
  workspace?: string;
  config?: Partial<SubagentConfig>;
  backend?: FakeBrokerBackend;
  activeRoute?: () => SubagentRoute;
  stateFile?: string;
  namespace?: string;
} = {}) {
  const root = options.workspace ?? await mkdtemp(join(tmpdir(), 'arg-bridge-broker-tools-'));
  if (!options.workspace) temporaryDirectories.push(root);
  const backend = options.backend ?? new FakeBrokerBackend();
  const activeRoute = options.activeRoute ?? (() => routeRead);
  const config: SubagentConfig = {
    ...DEFAULT_SUBAGENT_CONFIG,
    mode: 'broker',
    routeMode: 'manual',
    readRoute: 'read-a',
    writeRoute: 'write-a',
    allowForkFallback: false,
    ...options.config,
  };
  const stateFile = options.stateFile ?? join(root, 'broker-workers.json');
  const tool = new BrokerToolController({
    threadId: 'parent-thread',
    cwd: root,
    scope: 'scope',
    stateFile,
    ...(options.namespace ? { namespace: options.namespace } : {}),
    getConfig: async () => config,
    routeResolver: async input => {
      const routes = [routeRead, routeReadB, routeReadC, routeWrite];
      const route = input.requestedRoute
        ? routes.find(item => item.id === input.requestedRoute)
        : activeRoute();
      if (!route) throw new Error(`route not found: ${input.requestedRoute}`);
      if (input.access === 'workspace-write' && route.maxAccess !== 'workspace-write') {
        throw new Error('write route unavailable');
      }
      return { backend, route, routes };
    },
  });
  return { root, backend, config, stateFile, tool };
}

describe('Bridge Broker dynamic tools', () => {
  it('binds user-issued write authorization outside model-controlled tool arguments', () => {
    expect(parseWriteAuthorizationPrompt(
      'arg-bridge-write --workspace "/workspace with spaces" --task Fix the parser',
    )).toEqual({
      prompt: 'Fix the parser',
      authorization: {
        workspace: '/workspace with spaces',
        task: 'Fix the parser',
      },
    });
    expect(parseWriteAuthorizationPrompt('arg-bridge-write --bad')).toMatchObject({
      error: expect.stringContaining('arg-bridge-write'),
    });
  });

  it('uses the configured dynamic-tool namespace', async () => {
    const { tool } = await controller({ namespace: 'bridge_agents' });
    expect(tool.specs[0]?.name).toBe('bridge_agents');
    await tool.close();
  });

  it('configures native collaboration shadowing for Bridge-managed threads', () => {
    expect(brokerCodexThreadConfig({
      ...DEFAULT_SUBAGENT_CONFIG,
      mode: 'broker',
      toolNamespace: 'arg_bridge',
    })).toMatchObject({
      features: {
        multi_agent_v2: {
          enabled: true,
          disable_native_tools: true,
          root_agent_usage_hint_text: expect.stringContaining('arg_bridge.spawn_agent'),
        },
      },
    });
    expect(brokerCodexThreadConfig({
      ...DEFAULT_SUBAGENT_CONFIG,
      mode: 'broker',
      nativeToolPolicy: 'preserve',
    })).toMatchObject({
      features: {
        multi_agent_v2: {
          enabled: true,
          root_agent_usage_hint_text: expect.any(String),
        },
      },
    });
  });

  it('spawns with ordinary task input and returns a worker mailbox', async () => {
    const { backend, tool } = await controller();
    const spawned = await tool.call('spawn_agent', {
      name: 'reviewer',
      task: 'Inspect the parser and report bugs',
    });
    expect(spawned.success).toBe(true);
    expect(JSON.parse(spawned.text)).toMatchObject({
      logical_path: '/root/reviewer',
      agent_id: 'agent-1',
      thread_id: 'worker-thread-1',
      access: 'read-only',
    });
    expect(backend.spawns[0]?.task).toBe('Inspect the parser and report bugs');
    expect(backend.spawns[0]?.task).not.toContain('agent_message');
    expect(backend.spawns[0]?.task).not.toContain('encrypted_content');

    const waited = await tool.call('wait_agent', {
      logical_names: ['reviewer'],
      timeout_ms: 1000,
    });
    expect(waited.success).toBe(true);
    expect(JSON.parse(waited.text)).toMatchObject({
      agents: [{
        logical_path: '/root/reviewer',
        agent_id: 'agent-1',
        status: 'completed',
        text: 'result:agent-1',
      }],
    });
    await tool.close();
  });

  it('fans out three concurrent routes and preserves plaintext followup', async () => {
    const { backend, tool } = await controller({ config: { maxConcurrentWorkers: 3 } });
    for (const [name, task, route] of [
      ['one', 'review module one', 'read-a'],
      ['two', 'review module two', 'read-b'],
      ['three', 'review module three', 'read-c'],
    ]) {
      await expect(tool.call('spawn_agent', { name, task, route })).resolves.toMatchObject({ success: true });
    }
    const listed = await tool.call('list_agents', {});
    expect(JSON.parse(listed.text).agents).toHaveLength(3);

    const waited = await Promise.all([
      tool.call('wait_agent', { logical_names: ['one'], timeout_ms: 1000 }),
      tool.call('wait_agent', { logical_names: ['two'], timeout_ms: 1000 }),
      tool.call('wait_agent', { logical_names: ['three'], timeout_ms: 1000 }),
    ]);
    expect(waited.every(result => result.success)).toBe(true);
    const followup = await tool.call('followup_task', {
      logical_name: 'two',
      task: 'Now verify the failing test',
      route: 'read-b',
    });
    expect(followup.success).toBe(true);
    expect(backend.sends.at(-1)?.message).toBe('Now verify the failing test');
    await tool.close();
  });

  it('replaces an agent when route identity changes', async () => {
    let activeRoute = routeRead;
    const { backend, tool } = await controller({ activeRoute: () => activeRoute });
    await tool.call('spawn_agent', { name: 'reviewer', task: 'first task' });
    activeRoute = routeReadB;
    const result = await tool.call('followup_task', {
      logical_name: 'reviewer',
      task: 'second task',
    });
    expect(result.success).toBe(true);
    expect(JSON.parse(result.text)).toMatchObject({
      recreated: true,
      route: 'read-b',
    });
    expect(backend.interrupts).toContain('agent-1');
    expect(backend.closes).toContain('agent-1');
    expect(backend.spawns.at(-1)?.task).toBe('second task');
    await tool.close();
  });

  it('recreates a missing worker during followup without reusing its identity', async () => {
    const { backend, tool } = await controller();
    await tool.call('spawn_agent', { name: 'reviewer', task: 'first task' });
    backend.sendNotFoundOnce = true;
    const result = await tool.call('followup_task', {
      logical_name: 'reviewer',
      task: 'replacement task',
    });
    expect(result.success).toBe(true);
    expect(JSON.parse(result.text)).toMatchObject({
      recreated: true,
      reason: expect.stringContaining('agent_not_found'),
      agent_id: 'agent-2',
    });
    expect(backend.spawns).toHaveLength(2);
    expect(backend.spawns[1]?.task).toBe('replacement task');
    await tool.close();
  });

  it('fails closed on write without exact task/workspace authorization', async () => {
    const { root, backend, tool } = await controller({
      config: { allowWriteWorkers: true },
      activeRoute: () => routeWrite,
    });
    const denied = await tool.call('spawn_agent', {
      name: 'writer',
      task: 'change a file',
      access: 'workspace-write',
      write_authorization: { workspace: root, task: 'change a file' },
    });
    expect(denied.success).toBe(false);
    expect(denied.text).toContain('arg-bridge-write');
    expect(backend.spawns).toHaveLength(0);

    tool.setWriteAuthorization({ workspace: root, task: 'change a file' });
    const allowed = await tool.call('spawn_agent', {
      name: 'writer',
      task: 'change a file',
      access: 'workspace-write',
      workspace: root,
    });
    expect(allowed.success).toBe(true);
    expect(backend.spawns[0]).toMatchObject({
      access: 'workspace-write',
      task: 'change a file',
      writeAuthorization: {
        workspace: root,
        task: 'change a file',
      },
    });
    await tool.close();
  });

  it('does not let a read-only worker expand outside the parent workspace', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'arg-bridge-broker-outside-'));
    temporaryDirectories.push(outside);
    const { backend, tool } = await controller();
    const result = await tool.call('spawn_agent', {
      name: 'outside-reader',
      task: 'read another directory',
      workspace: outside,
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain('parent workspace');
    expect(backend.spawns).toHaveLength(0);
    await tool.close();
  });

  it('deduplicates idempotent calls and queues send_message text for the next followup', async () => {
    const { backend, tool } = await controller();
    const args = {
      name: 'reviewer',
      task: 'same task',
      idempotency_key: 'spawn-1',
    };
    const [first, second] = await Promise.all([
      tool.call('spawn_agent', args),
      tool.call('spawn_agent', args),
    ]);
    expect(first).toEqual(second);
    expect(backend.spawns).toHaveLength(1);

    const followupArgs = {
      logical_name: 'reviewer',
      task: 'run once',
      idempotency_key: 'followup-1',
    };
    const followupFirst = await tool.call('followup_task', followupArgs);
    const followupSecond = await tool.call('followup_task', followupArgs);
    expect(followupSecond).toEqual(followupFirst);
    expect(backend.sends).toHaveLength(1);

    const send = await tool.call('send_message', {
      logical_name: 'reviewer',
      message: 'queue only',
    });
    expect(send).toMatchObject({ success: true });
    expect(JSON.parse(send.text)).toMatchObject({
      status: 'queued',
      queued_messages: 1,
    });
    expect(backend.sends).toHaveLength(1);

    const queuedFollowup = await tool.call('followup_task', {
      logical_name: 'reviewer',
      task: 'wake and answer',
    });
    expect(queuedFollowup).toMatchObject({ success: true });
    expect(backend.sends).toHaveLength(2);
    expect(backend.sends.at(-1)?.message).toBe('queue only\n\nwake and answer');
    await tool.close();
  });

  it('interrupts and times out workers explicitly', async () => {
    const first = await controller();
    await first.tool.call('spawn_agent', { name: 'interrupt-me', task: 'long task' });
    const interrupted = await first.tool.call('interrupt_agent', {
      logical_name: 'interrupt-me',
    });
    expect(interrupted.success).toBe(true);
    expect(first.backend.interrupts).toContain('agent-1');
    await first.tool.close();

    const second = await controller({
      config: { workerTimeoutMs: 20 },
    });
    await second.tool.call('spawn_agent', { name: 'timeout-me', task: 'slow task' });
    await new Promise(resolve => setTimeout(resolve, 40));
    const listed = await second.tool.call('list_agents', {});
    expect(JSON.parse(listed.text).agents[0]).toMatchObject({
      logical_name: 'timeout-me',
      status: 'timeout',
    });
    await second.tool.close();
  });

  it('persists mappings across a Bridge restart without persisting credentials', async () => {
    const first = await controller();
    await first.tool.call('spawn_agent', {
      name: 'reviewer',
      task: 'persistent mapping',
    });
    await first.tool.close();
    const persisted = await readFile(first.stateFile, 'utf8');
    expect(persisted).toContain('agent-1');
    expect(persisted).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/u);

    const second = await controller({ workspace: first.root, stateFile: first.stateFile });
    const listed = await second.tool.call('list_agents', {});
    expect(JSON.parse(listed.text).agents[0]).toMatchObject({
      logical_path: '/root/reviewer',
      agent_id: 'agent-1',
      thread_id: 'worker-thread-1',
    });
    await second.tool.close();
  });

  it('persists send_message queues across a Bridge restart and clears them after delivery', async () => {
    const first = await controller();
    await first.tool.call('spawn_agent', { name: 'reviewer', task: 'first' });
    expect((await first.tool.call('send_message', {
      logical_name: 'reviewer',
      message: 'queued before restart',
    })).success).toBe(true);
    await first.tool.close();

    const second = await controller({ workspace: first.root, stateFile: first.stateFile });
    const followup = await second.tool.call('followup_task', {
      logical_name: 'reviewer',
      task: 'wake after restart',
    });
    expect(followup.success).toBe(true);
    expect(second.backend.sends.at(-1)?.message).toBe('queued before restart\n\nwake after restart');
    const persisted = JSON.parse(await readFile(second.stateFile, 'utf8'));
    expect(persisted.workers[0].queuedMessages).toEqual([]);
    await second.tool.close();
  });

  it('answers App Server item/tool/call with a standard dynamic tool result', async () => {
    const rpc = new EventEmitter() as EventEmitter & {
      request: ReturnType<typeof vi.fn>;
      respond: ReturnType<typeof vi.fn>;
      rejectRequest: ReturnType<typeof vi.fn>;
      closed: boolean;
    };
    rpc.request = vi.fn(async () => ({}));
    rpc.respond = vi.fn();
    rpc.rejectRequest = vi.fn();
    rpc.closed = false;
    const host = {
      specs: [{
        type: 'namespace' as const,
        name: 'arg_bridge',
        description: 'test',
        tools: [],
      }],
      call: vi.fn(async () => ({ success: true, text: 'worker result' })),
      close: vi.fn(async () => {}),
    };
    const session = new CodexStructuredSession(
      'parent-thread',
      'unix:///tmp/test.sock',
      rpc as unknown as RpcClient,
      host,
    );
    rpc.emit('message', {
      id: 17,
      method: 'item/tool/call',
      params: {
        threadId: 'parent-thread',
        turnId: 'turn-1',
        callId: 'call-1',
        namespace: 'arg_bridge',
        tool: 'spawn_agent',
        arguments: { task: 'delegate me' },
      },
    });
    await vi.waitFor(() => expect(rpc.respond).toHaveBeenCalled());
    expect(host.call).toHaveBeenCalledWith(
      'spawn_agent',
      { task: 'delegate me' },
      expect.any(AbortSignal),
    );
    expect(rpc.respond).toHaveBeenCalledWith(17, {
      contentItems: [{ type: 'inputText', text: 'worker result' }],
      success: true,
    });
    await session.close();
  });
});
