import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';
import { expect, it } from 'vitest';
import {
  BrokerToolController,
  brokerCodexThreadConfig,
  brokerToolSpecs,
} from '../../src/agent/subagents/broker-tools';
import type {
  SideAgent,
  SideAgentInput,
  SideAgentResult,
  SubagentBackend,
  SubagentRoute,
} from '../../src/agent/subagents/types';
import { DEFAULT_SUBAGENT_CONFIG } from '../../src/config/profile-schema';

const native = process.env.ARG_BRIDGE_NATIVE_DYNAMIC_TOOLS === '1' ? it : it.skip;

class TraceBackend implements SubagentBackend {
  readonly id = 'mixagents' as const;
  readonly spawns: SideAgentInput[] = [];

  async listRoutes(): Promise<SubagentRoute[]> {
    return [route];
  }

  async createOrReuse(input: SideAgentInput): Promise<SideAgent> {
    this.spawns.push(input);
    return {
      agentId: 'broker-agent-trace',
      threadId: 'broker-worker-thread-trace',
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

  async wait(): Promise<SideAgentResult> {
    return {
      status: 'completed',
      text: 'WORKER_RESULT_TRACE_OK',
    };
  }

  async send(): Promise<SideAgentResult> {
    return { status: 'completed', text: 'FOLLOWUP_TRACE_OK' };
  }

  async interrupt(): Promise<void> {}
  async close(): Promise<void> {}
}

const route: SubagentRoute = {
  id: 'trace-read',
  provider: 'trace-provider',
  model: 'trace-model',
  maxAccess: 'read-only',
  available: true,
  missingEnvironment: [],
  tags: ['trace'],
};

native('Codex 0.164 App Server routes dynamic Broker calls as function_call_output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arg-bridge-dynamic-trace-'));
  const codexHome = join(root, 'codex-home');
  const workspace = join(root, 'workspace');
  const stateFile = join(root, 'broker-workers.json');
  await Promise.all([
    mkdir(codexHome, { recursive: true }),
    mkdir(workspace, { recursive: true }),
  ]);

  const providerRequests: Array<Record<string, unknown>> = [];
  const provider = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
      providerRequests.push(body);
      const index = providerRequests.length;
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      if (index === 1) {
        response.end(sse([
          eventCreated('trace-1'),
          eventFunctionCall('trace-spawn', 'arg_bridge', 'spawn_agent', {
            name: 'trace-reviewer',
            task: 'Inspect the package as a plaintext Broker task',
          }),
          eventCompleted('trace-1'),
        ]));
        return;
      }
      if (index === 2) {
        response.end(sse([
          eventCreated('trace-2'),
          eventFunctionCall('trace-wait', 'arg_bridge', 'wait_agent', {
            logical_names: ['trace-reviewer'],
            timeout_ms: 2000,
          }),
          eventCompleted('trace-2'),
        ]));
        return;
      }
      response.end(sse([
        eventCreated('trace-3'),
        eventAssistantMessage('trace-final', 'PARENT_CONTINUED_TRACE_OK'),
        eventCompleted('trace-3'),
      ]));
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address() as { port: number };
  await writeFile(join(codexHome, 'config.toml'), [
    'model = "trace-model"',
    'model_provider = "trace-local"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    '',
    '[model_providers.trace-local]',
    'name = "Trace Local"',
    `base_url = "http://127.0.0.1:${address.port}/v1"`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'env_key = "OPENAI_API_KEY"',
  ].join('\n'), { mode: 0o600 });

  const backend = new TraceBackend();
  const controller = new BrokerToolController({
    threadId: 'trace-parent',
    cwd: workspace,
    scope: 'trace',
    stateFile,
    env: { ...process.env, CODEX_HOME: codexHome, OPENAI_API_KEY: 'trace-only' },
    getConfig: async () => ({
      ...DEFAULT_SUBAGENT_CONFIG,
      mode: 'broker',
      routeMode: 'manual',
      readRoute: route.id,
      allowForkFallback: false,
    }),
    routeResolver: async () => ({ backend, route, routes: [route] }),
  });

  let rpc: AppServerHarness | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  const toolCalls: Array<{ namespace?: string; tool: string; arguments: unknown }> = [];
  let markSpawnStarted!: () => void;
  const spawnStarted = new Promise<void>(resolve => { markSpawnStarted = resolve; });
  let releaseSpawn!: () => void;
  const spawnGate = new Promise<void>(resolve => { releaseSpawn = resolve; });
  try {
    child = spawn('codex', ['app-server'], {
      cwd: workspace,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        OPENAI_API_KEY: 'trace-only',
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    rpc = new AppServerHarness(child, async request => {
      if (request.method !== 'item/tool/call') return false;
      const params = request.params ?? {};
      const tool = String(params.tool ?? '');
      toolCalls.push({
        ...(typeof params.namespace === 'string' ? { namespace: params.namespace } : {}),
        tool,
        arguments: params.arguments,
      });
      if (tool === 'spawn_agent') {
        markSpawnStarted();
        await spawnGate;
      }
      const result = await controller.call(tool, params.arguments);
      rpc!.respond(request.id!, {
        contentItems: [{ type: 'inputText', text: result.text }],
        success: result.success,
      });
      return true;
    });
    await rpc.request('initialize', {
      clientInfo: { name: 'arg_bridge_trace', version: 'audit' },
      capabilities: { experimentalApi: true },
    });
    rpc.notify('initialized', {});
    const started = await rpc.request('thread/start', {
      cwd: workspace,
      config: brokerCodexThreadConfig({
        ...DEFAULT_SUBAGENT_CONFIG,
        mode: 'broker',
        nativeToolPolicy: 'shadow',
      }),
      developerInstructions: BrokerToolController.instructions(),
      dynamicTools: brokerToolSpecs(),
    });
    const threadId = started.thread?.id;
    expect(threadId).toMatch(/\S/);
    const completed = rpc.waitFor(message =>
      message.method === 'turn/completed' &&
      message.params?.threadId === threadId
    );
    const turn = await rpc.request('turn/start', {
      threadId,
      cwd: workspace,
      input: [{
        type: 'text',
        text: 'Delegate a read-only review, collect the worker result, then report completion.',
      }],
    });
    await spawnStarted;
    try {
      const steered = await rpc.request('turn/steer', {
        threadId,
        expectedTurnId: turn.turn?.id,
        input: [{ type: 'text', text: 'MID_TURN_STEER_CHECK' }],
        clientUserMessageId: 'om-mid-turn-steer',
      });
      expect(steered.turnId).toBe(turn.turn?.id);
    } finally {
      releaseSpawn();
    }
    await completed;

    expect(toolCalls).toEqual([
      {
        namespace: 'arg_bridge',
        tool: 'spawn_agent',
        arguments: {
          name: 'trace-reviewer',
          task: 'Inspect the package as a plaintext Broker task',
        },
      },
      {
        namespace: 'arg_bridge',
        tool: 'wait_agent',
        arguments: {
          logical_names: ['trace-reviewer'],
          timeout_ms: 2000,
        },
      },
    ]);
    expect(backend.spawns[0]).toMatchObject({
      task: 'Inspect the package as a plaintext Broker task',
      access: 'read-only',
    });
    expect(backend.spawns[0]?.task).not.toContain('agent_message');
    expect(backend.spawns[0]?.task).not.toContain('encrypted_content');
    expect(providerRequests).toHaveLength(3);
    expect(JSON.stringify(providerRequests[1])).toContain('function_call_output');
    expect(JSON.stringify(providerRequests[2])).toContain('WORKER_RESULT_TRACE_OK');
    expect(JSON.stringify(providerRequests)).toContain('MID_TURN_STEER_CHECK');
    const providerInput = Array.isArray(providerRequests[2]?.input)
      ? providerRequests[2]!.input as Array<Record<string, unknown>>
      : [];
    expect(providerInput.some(item => item.type === 'agent_message')).toBe(false);
    const exposedTools = Array.isArray(providerRequests[0]?.tools)
      ? providerRequests[0]!.tools as Array<Record<string, unknown>>
      : [];
    expect(exposedTools).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'namespace', name: 'arg_bridge' }),
    ]));
    expect(exposedTools.some(tool =>
      tool.name === 'collaboration' || tool.name === 'multi_agent_v1'
    )).toBe(false);

    const traceOutput = process.env.ARG_BRIDGE_DYNAMIC_TRACE_OUT;
    if (traceOutput) {
      await writeFile(traceOutput, `${JSON.stringify({
        version: 1,
        codexVersion: '0.164.0',
        threadId,
        transport: 'codex app-server stdio',
        nativeCollaboration: 'shadowed by features.multi_agent_v2.disable_native_tools',
        toolCalls,
        worker: {
          route: route.id,
          provider: route.provider,
          model: route.model,
          access: 'read-only',
          agentId: 'broker-agent-trace',
          threadId: 'broker-worker-thread-trace',
          taskDelivery: 'ordinary plaintext MCP input',
          result: 'WORKER_RESULT_TRACE_OK',
        },
        providerTrace: {
          requests: providerRequests.length,
          secondRequestContainsFunctionCallOutput: JSON.stringify(providerRequests[1])
            .includes('function_call_output'),
          thirdRequestContainsWorkerResult: JSON.stringify(providerRequests[2])
            .includes('WORKER_RESULT_TRACE_OK'),
          usedAgentMessageEncryptedContent: false,
        },
        secrets: 'none; OPENAI_API_KEY was a non-network trace-only value',
      }, null, 2)}\n`, { mode: 0o600 });
    }
  } finally {
    await controller.close();
    rpc?.close();
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        once(child, 'exit'),
        new Promise(resolve => setTimeout(resolve, 2_000)),
      ]);
    }
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

interface WireMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, any>;
  result?: Record<string, any>;
  error?: { message?: string };
}

class AppServerHarness {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve(value: any): void;
    reject(error: Error): void;
  }>();
  private readonly waiters: Array<{
    predicate(message: WireMessage): boolean;
    resolve(message: WireMessage): void;
  }> = [];
  private readonly reader: readline.Interface;
  private stderr = '';

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly serverRequest: (message: WireMessage) => Promise<boolean>,
  ) {
    this.reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.reader.on('line', line => this.onLine(line));
    child.stderr.on('data', chunk => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-16_000);
    });
    child.once('exit', code => {
      const error = new Error(
        `codex app-server exited (${code ?? 'signal'}): ${this.stderr.slice(-4_000)}`,
      );
      for (const waiter of this.pending.values()) waiter.reject(error);
      this.pending.clear();
    });
  }

  request(method: string, params: Record<string, unknown>): Promise<Record<string, any>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.send({ method, params });
  }

  respond(id: number | string, result: unknown): void {
    this.send({ id, result });
  }

  waitFor(predicate: (message: WireMessage) => boolean): Promise<WireMessage> {
    return new Promise(resolve => this.waiters.push({ predicate, resolve }));
  }

  close(): void {
    this.reader.close();
  }

  private send(message: unknown): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async onLine(line: string): Promise<void> {
    let message: WireMessage;
    try {
      message = JSON.parse(line) as WireMessage;
    } catch {
      return;
    }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(Number(message.id));
      if (!pending) return;
      this.pending.delete(Number(message.id));
      if (message.error) pending.reject(new Error(message.error.message ?? 'App Server RPC error'));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (message.id !== undefined && message.method) {
      if (await this.serverRequest(message)) return;
      this.send({
        id: message.id,
        error: { code: -32601, message: `unsupported request ${message.method}` },
      });
      return;
    }
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      if (!this.waiters[index]!.predicate(message)) continue;
      const [waiter] = this.waiters.splice(index, 1);
      waiter!.resolve(message);
    }
  }
}

function sse(events: Array<Record<string, unknown>>): string {
  return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
}

function eventCreated(id: string): Record<string, unknown> {
  return { type: 'response.created', response: { id } };
}

function eventCompleted(id: string): Record<string, unknown> {
  return {
    type: 'response.completed',
    response: {
      id,
      usage: {
        input_tokens: 0,
        input_tokens_details: null,
        output_tokens: 0,
        output_tokens_details: null,
        total_tokens: 0,
      },
    },
  };
}

function eventFunctionCall(
  callId: string,
  namespace: string,
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: 'response.output_item.done',
    item: {
      type: 'function_call',
      call_id: callId,
      namespace,
      name,
      arguments: JSON.stringify(args),
    },
  };
}

function eventAssistantMessage(id: string, text: string): Record<string, unknown> {
  return {
    type: 'response.output_item.done',
    item: {
      type: 'message',
      role: 'assistant',
      id,
      content: [{ type: 'output_text', text }],
    },
  };
}
