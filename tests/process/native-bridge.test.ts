import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createNativeBridgeSession } from '../../src/agent/structured/native-bridge';
import { shutdownProfileHosts } from '../../src/agent/structured/host';
import { createDefaultProfileConfig, DEFAULT_SUBAGENT_CONFIG } from '../../src/config/profile-schema';

const nativeBridge = process.env.ARG_BRIDGE_NATIVE_BRIDGE_E2E === '1' ? it : it.skip;
const fixture = fileURLToPath(new URL('../fixtures/fake-mixagents-mcp.mjs', import.meta.url));

nativeBridge('registers dynamic tools and safely migrates a legacy thread into a new Bridge thread', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arg-bridge-native-bridge-'));
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
  let dynamicMode = true;
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
      if (!dynamicMode) {
        response.end(sse([
          created('legacy-1'),
          assistantMessage('legacy-final', 'LEGACY_THREAD_CONTEXT_ORBIT_731'),
          completed('legacy-1'),
        ]));
        return;
      }
      if (requests.length === 1) {
        response.end(sse([
          created('native-1'),
          functionCall('native-spawn', 'arg_bridge', 'spawn_agent', {
            name: 'native-reviewer',
            task: 'NATIVE_BRIDGE_PLAINTEXT_TASK',
          }),
          completed('native-1'),
        ]));
        return;
      }
      if (requests.length === 2) {
        response.end(sse([
          created('native-2'),
          functionCall('native-wait', 'arg_bridge', 'wait_agent', {
            logical_names: ['native-reviewer'],
            timeout_ms: 2000,
          }),
          completed('native-2'),
        ]));
        return;
      }
      response.end(sse([
        created('native-3'),
        assistantMessage('native-final', 'NATIVE_BRIDGE_PARENT_OK'),
        completed('native-3'),
      ]));
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address() as { port: number };
  await writeFile(join(codexHome, 'config.toml'), [
    'model = "native-bridge-model"',
    'model_provider = "native-local"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    '',
    '[model_providers.native-local]',
    'name = "Native Local"',
    `base_url = "http://127.0.0.1:${address.port}/v1"`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'env_key = "OPENAI_API_KEY"',
  ].join('\n'), { mode: 0o600 });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_HOME: codexHome,
    OPENAI_API_KEY: 'trace-only-native',
    XDG_RUNTIME_DIR: join(root, 'runtime'),
    FAKE_MIXAGENTS_STATE: brokerState,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
  const profile = createDefaultProfileConfig({
    agentKind: 'codex',
    accounts: { app: { id: 'native-test', secret: 'not-used', tenant: 'feishu' } },
    codex: {
      binaryPath: 'codex',
      codexHome,
      inheritCodexHome: false,
    },
  });
  profile.subagents = {
    ...DEFAULT_SUBAGENT_CONFIG,
    mode: 'broker',
    routeMode: 'manual',
    readRoute: 'read-a',
    allowForkFallback: false,
    mixagents: {
      mcpCommand: process.execPath,
      mcpArgs: [fixture],
      credentialEnvKeys: ['FAKE_MIXAGENTS_STATE'],
    },
  };
  let bridge: Awaited<ReturnType<typeof createNativeBridgeSession>> | undefined;
  let firstThreadId: string | undefined;
  try {
    bridge = await createNativeBridgeSession({
      profileName: 'codex',
      profileDir,
      cwd: workspace,
      config: profile,
      env,
      binary: 'codex',
      codexHome,
      sandbox: 'read-only',
    });
    expect(bridge.mode).toBe('new');
    expect(bridge.session).toBeDefined();
    const newEvents: Array<{ type: string; delta?: string }> = [];
    await bridge.session!.submit({
      runId: 'native-new',
      scopeId: 'native-scope',
      cwd: workspace,
      prompt: 'Delegate a native review, then finish.',
    }, event => newEvents.push(event), AbortSignal.timeout(60_000));
    expect(newEvents.filter(event => event.type === 'error')).toEqual([]);
    expect(newEvents.filter(event => event.type === 'text').map(event => event.delta).join(''))
      .toContain('NATIVE_BRIDGE_PARENT_OK');
    const tools = requests[0]?.tools ?? [];
    expect(tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'namespace', name: 'arg_bridge' }),
    ]));
    expect(JSON.stringify(tools)).not.toContain('collaboration');
    expect(JSON.stringify(tools)).not.toContain('multi_agent_v1');
    const broker = JSON.parse(await readFile(brokerState, 'utf8'));
    expect(broker.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'spawn_agent',
        arguments: expect.objectContaining({
          task: 'NATIVE_BRIDGE_PLAINTEXT_TASK',
          access: 'read-only',
        }),
      }),
    ]));
    const marker = JSON.parse(await readFile(
      join(profileDir, 'structured', 'broker-threads.json'),
      'utf8',
    ));
    expect(marker.threads[bridge.threadId]).toMatchObject({
      namespace: 'arg_bridge',
      version: 1,
    });
    firstThreadId = bridge.threadId;
    await bridge.close();
    bridge = undefined;
    requests.length = 0;
    bridge = await createNativeBridgeSession({
      profileName: 'codex',
      profileDir,
      cwd: workspace,
      config: profile,
      env,
      binary: 'codex',
      codexHome,
      sandbox: 'read-only',
      threadId: firstThreadId,
    });
    expect(bridge.mode).toBe('attached');
    expect(bridge.threadId).toBe(firstThreadId);
    expect(bridge.session).toBeDefined();
    const attachedEvents: Array<{ type: string; delta?: string }> = [];
    await bridge.session!.submit({
      runId: 'native-attach',
      scopeId: 'native-scope',
      cwd: workspace,
      prompt: 'Continue the attached Bridge thread.',
    }, event => attachedEvents.push(event), AbortSignal.timeout(60_000));
    expect(attachedEvents.filter(event => event.type === 'error')).toEqual([]);
    expect(JSON.stringify(requests[0]?.tools)).toContain('arg_bridge');
    await bridge.close();
    bridge = undefined;

    // Simulate a clean owner exit, then confirm the same persisted thread can
    // cold-resume through a replacement App Server.
    await shutdownProfileHosts(profileDir);
    requests.length = 0;
    bridge = await createNativeBridgeSession({
      profileName: 'codex',
      profileDir,
      cwd: workspace,
      config: profile,
      env,
      binary: 'codex',
      codexHome,
      sandbox: 'read-only',
      threadId: firstThreadId,
    });
    expect(bridge.mode).toBe('attached');
    expect(bridge.threadId).toBe(firstThreadId);
    await bridge.close();
    bridge = undefined;

    dynamicMode = false;
    requests.length = 0;
    const seed = spawnSync('codex', [
      'exec',
      '--json',
      '--skip-git-repo-check',
      'Reply exactly LEGACY_THREAD_CONTEXT_ORBIT_731. Do not use tools.',
    ], { cwd: workspace, env, encoding: 'utf8', timeout: 60_000 });
    expect(seed.status, seed.stderr).toBe(0);
    const oldThreadId = seed.stdout.split('\n').flatMap(line => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    }).find(item => item.type === 'thread.started')?.thread_id;
    expect(oldThreadId).toBeTruthy();

    dynamicMode = true;
    requests.length = 0;
    bridge = await createNativeBridgeSession({
      profileName: 'codex',
      profileDir,
      cwd: workspace,
      config: profile,
      env,
      binary: 'codex',
      codexHome,
      sandbox: 'read-only',
      adoptThreadId: oldThreadId,
    });
    expect(bridge.mode).toBe('adopted');
    expect(bridge.oldThreadId).toBe(oldThreadId);
    expect(bridge.threadId).not.toBe(oldThreadId);
    const adoptedEvents: Array<{ type: string; delta?: string }> = [];
    await bridge.session!.submit({
      runId: 'native-adopt',
      scopeId: 'native-scope',
      cwd: workspace,
      prompt: 'Continue from the migrated context.',
    }, event => adoptedEvents.push(event), AbortSignal.timeout(60_000));
    expect(adoptedEvents.filter(event => event.type === 'error')).toEqual([]);
    const adoptedRequest = requests.find(request =>
      JSON.stringify(request.tools ?? []).includes('arg_bridge')
    );
    expect(adoptedRequest?.input).toBeDefined();
    expect(JSON.stringify(adoptedRequest)).toContain('LEGACY_THREAD_CONTEXT_ORBIT_731');
    expect(JSON.stringify(adoptedRequest?.tools)).toContain('arg_bridge');
    expect(JSON.stringify(adoptedRequest?.tools)).not.toContain('multi_agent_v1');
    const adoptedMarker = JSON.parse(await readFile(
      join(profileDir, 'structured', 'broker-threads.json'),
      'utf8',
    ));
    expect(adoptedMarker.threads[bridge.threadId]).toMatchObject({
      namespace: 'arg_bridge',
      version: 1,
      adoptedFrom: oldThreadId,
    });
    const adoptedThreadId = bridge.threadId;
    const adoptedCreatedAt = adoptedMarker.threads[adoptedThreadId].createdAt;
    await bridge.close();
    bridge = undefined;

    bridge = await createNativeBridgeSession({
      profileName: 'codex',
      profileDir,
      cwd: workspace,
      config: profile,
      env,
      binary: 'codex',
      codexHome,
      sandbox: 'read-only',
      adoptThreadId: oldThreadId,
    });
    expect(bridge).toMatchObject({
      mode: 'adopted',
      threadId: adoptedThreadId,
      oldThreadId,
      reusedAdoption: true,
    });
    const repeatedMarker = JSON.parse(await readFile(
      join(profileDir, 'structured', 'broker-threads.json'),
      'utf8',
    ));
    expect(repeatedMarker.threads[adoptedThreadId].createdAt).toBe(adoptedCreatedAt);
  } finally {
    await bridge?.close();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}, 180_000);

function sse(events: Array<Record<string, unknown>>): string {
  return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
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
