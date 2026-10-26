import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { StructuredAdapter } from '../../src/agent/structured/adapter';
import type { AgentEvent } from '../../src/agent/types';
import {
  DEFAULT_SUBAGENT_CONFIG,
  type SubagentConfig,
} from '../../src/config/profile-schema';

const native = process.env.ARG_BRIDGE_BROKER_E2E === '1' ? it : it.skip;
const fixture = fileURLToPath(new URL('../fixtures/fake-mixagents-mcp.mjs', import.meta.url));

native('StructuredAdapter completes parent -> dynamic Broker -> MCP worker -> parent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arg-bridge-structured-broker-e2e-'));
  const codexHome = join(root, 'codex-home');
  const workspace = join(root, 'workspace');
  const profileDir = join(root, 'profile');
  const brokerState = join(root, 'broker-state.json');
  await Promise.all([
    mkdir(codexHome, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(profileDir, { recursive: true }),
  ]);

  const requests: Array<Record<string, any>> = [];
  const provider = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, any>;
      requests.push(body);
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      if (requests.length === 1) {
        response.end(sse([
          created('adapter-1'),
          functionCall('adapter-spawn', 'arg_bridge', 'spawn_agent', {
            name: 'adapter-reviewer',
            task: 'PLAINTEXT_ADAPTER_WORKER_TASK',
          }),
          completed('adapter-1'),
        ]));
        return;
      }
      if (requests.length === 2) {
        response.end(sse([
          created('adapter-2'),
          functionCall('adapter-wait', 'arg_bridge', 'wait_agent', {
            logical_names: ['adapter-reviewer'],
            timeout_ms: 2000,
          }),
          completed('adapter-2'),
        ]));
        return;
      }
      if (requests.length === 4) {
        response.end(sse([
          created('adapter-resume-1'),
          functionCall('adapter-list', 'arg_bridge', 'list_agents', {}),
          completed('adapter-resume-1'),
        ]));
        return;
      }
      if (requests.length === 5) {
        response.end(sse([
          created('adapter-resume-2'),
          assistantMessage('adapter-resume-final', 'ADAPTER_RESUME_OK'),
          completed('adapter-resume-2'),
        ]));
        return;
      }
      response.end(sse([
        created('adapter-3'),
        assistantMessage('adapter-final', 'ADAPTER_PARENT_FINAL_OK'),
        completed('adapter-3'),
      ]));
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address() as { port: number };
  await writeFile(join(codexHome, 'config.toml'), [
    'model = "adapter-trace-model"',
    'model_provider = "adapter-local"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    '',
    '[model_providers.adapter-local]',
    'name = "Adapter Local"',
    `base_url = "http://127.0.0.1:${address.port}/v1"`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'env_key = "OPENAI_API_KEY"',
  ].join('\n'), { mode: 0o600 });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_HOME: codexHome,
    OPENAI_API_KEY: 'trace-only-adapter',
    FAKE_MIXAGENTS_STATE: brokerState,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
  const subagents: SubagentConfig = {
    ...DEFAULT_SUBAGENT_CONFIG,
    mode: 'broker',
    routeMode: 'manual',
    readRoute: 'read-a',
    allowForkFallback: false,
    modelTools: true,
    nativeToolPolicy: 'shadow',
    mixagents: {
      mcpCommand: process.execPath,
      mcpArgs: [fixture],
      credentialEnvKeys: ['FAKE_MIXAGENTS_STATE'],
    },
  };
  const adapter = new StructuredAdapter({
    kind: 'codex',
    binary: 'codex',
    profileDir,
    codexHome,
    nativeView: false,
    env,
    subagents,
  });
  try {
    await adapter.prepareRun();
    const events: AgentEvent[] = [];
    for await (const event of adapter.run({
      runId: 'adapter-broker-e2e',
      scopeId: 'adapter-scope',
      cwd: workspace,
      prompt: 'Delegate the review, wait for the Broker result, then finish.',
    }).events) {
      events.push(event);
    }
    expect(events.filter(event => event.type === 'error')).toEqual([]);
    expect(events.filter(event => event.type === 'text').map(event => event.delta).join(''))
      .toContain('ADAPTER_PARENT_FINAL_OK');
    expect(requests).toHaveLength(3);
    const exposedTools = Array.isArray(requests[0]?.tools) ? requests[0]!.tools : [];
    expect(exposedTools).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'namespace', name: 'arg_bridge' }),
    ]));
    expect(exposedTools.some((tool: Record<string, unknown>) =>
      tool.name === 'collaboration' || tool.name === 'multi_agent_v1'
    )).toBe(false);
    expect(JSON.stringify(requests[1])).toContain('function_call_output');
    expect(JSON.stringify(requests[2])).toContain('result:PLAINTEXT_ADAPTER_WORKER_TASK');
    const broker = JSON.parse(await readFile(brokerState, 'utf8'));
    expect(broker.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'spawn_agent',
        arguments: expect.objectContaining({
          task: 'PLAINTEXT_ADAPTER_WORKER_TASK',
          access: 'read-only',
        }),
      }),
      expect.objectContaining({
        tool: 'wait_agent',
      }),
    ]));
    const structuredFiles = await readdir(join(profileDir, 'structured'));
    expect(structuredFiles).toEqual(expect.arrayContaining([
      'broker-threads.json',
      expect.stringMatching(/^broker-workers-/),
    ]));

    await disposeStructuredViews(adapter);
    await adapter.shutdown();
    const resumed = new StructuredAdapter({
      kind: 'codex',
      binary: 'codex',
      profileDir,
      codexHome,
      nativeView: false,
      env,
      subagents,
    });
    try {
      await resumed.prepareRun();
      const resumedEvents: AgentEvent[] = [];
      for await (const event of resumed.run({
        runId: 'adapter-broker-resume',
        scopeId: 'adapter-scope',
        cwd: workspace,
        prompt: 'List the persisted workers, then finish.',
      }).events) {
        resumedEvents.push(event);
      }
      expect(resumedEvents.filter(event => event.type === 'error')).toEqual([]);
      expect(resumedEvents.filter(event => event.type === 'text').map(event => event.delta).join(''))
        .toContain('ADAPTER_RESUME_OK');
      expect(requests).toHaveLength(5);
      const resumedTools = Array.isArray(requests[3]?.tools) ? requests[3]!.tools : [];
      expect(resumedTools).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'namespace', name: 'arg_bridge' }),
      ]));
      expect(resumedTools.some((tool: Record<string, unknown>) =>
        tool.name === 'collaboration' || tool.name === 'multi_agent_v1'
      )).toBe(false);
      expect(JSON.stringify(requests[4])).toContain('adapter-reviewer');
    } finally {
      await disposeStructuredViews(resumed);
      await resumed.shutdown();
    }

    const traceOutput = process.env.ARG_BRIDGE_STRUCTURED_TRACE_OUT;
    if (traceOutput) {
      await writeFile(traceOutput, `${JSON.stringify({
        version: 1,
        codexVersion: '0.164.0',
        path: [
          'StructuredAdapter',
          'Codex App Server thread/start dynamicTools',
          'item/tool/call arg_bridge.spawn_agent',
          'MixAgents MCP spawn_agent',
          'ordinary plaintext worker task',
          'arg_bridge.wait_agent function_call_output',
          'parent final assistant message',
        ],
        providerRequests: requests.length,
        nativeCollaborationHidden: true,
        brokerCalls: broker.calls.map((call: Record<string, unknown>) => call.tool),
        workerTask: 'PLAINTEXT_ADAPTER_WORKER_TASK',
        workerResult: 'result:PLAINTEXT_ADAPTER_WORKER_TASK',
        parentFinal: 'ADAPTER_PARENT_FINAL_OK',
        resumeFinal: 'ADAPTER_RESUME_OK',
        persistedWorkerVisibleAfterRestart: true,
        secrets: 'none; all provider credentials were trace-only local values',
      }, null, 2)}\n`, { mode: 0o600 });
    }
  } finally {
    await disposeStructuredViews(adapter);
    await adapter.shutdown();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

function sse(events: Array<Record<string, unknown>>): string {
  return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
}

async function disposeStructuredViews(adapter: StructuredAdapter): Promise<void> {
  const sessions = Reflect.get(adapter, 'sessions') as Map<string, {
    view?: { dispose(): Promise<void> };
    sideView?: { dispose(): Promise<void> };
  }>;
  for (const current of sessions.values()) {
    await current.sideView?.dispose().catch(() => {});
    await current.view?.dispose().catch(() => {});
  }
}

function created(id: string): Record<string, unknown> {
  return { type: 'response.created', response: { id } };
}

function completed(id: string): Record<string, unknown> {
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

function functionCall(
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

function assistantMessage(id: string, text: string): Record<string, unknown> {
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
