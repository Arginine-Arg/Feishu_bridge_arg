import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createNativeBridgeSession } from '../../src/agent/structured/native-bridge';
import { processAlive } from '../../src/agent/structured/host-registry';
import { shutdownProfileHosts } from '../../src/agent/structured/host';
import { RpcClient } from '../../src/agent/structured/rpc';
import { CodexStructuredSession } from '../../src/agent/structured/codex';
import { createDefaultProfileConfig, DEFAULT_SUBAGENT_CONFIG } from '../../src/config/profile-schema';

const nativeBridge = process.env.ARG_BRIDGE_NATIVE_BRIDGE_E2E === '1' ? it : it.skip;
const fixture = fileURLToPath(new URL('../fixtures/fake-mixagents-mcp.mjs', import.meta.url));

nativeBridge('registers dynamic tools and safely migrates a legacy thread into a new Bridge thread', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arg-bridge-native-bridge-'));
  const codexHome = join(root, 'codex-home');
  const workspace = join(root, 'workspace');
  const profileDir = join(root, 'profile');
  const ccSwitchHome = join(root, 'cc-switch');
  const brokerState = join(root, 'broker-state.json');
  await Promise.all([
    mkdir(codexHome, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(profileDir, { recursive: true }),
    mkdir(ccSwitchHome, { recursive: true }),
  ]);
  await writeFile(join(ccSwitchHome, 'settings.json'), JSON.stringify({
    currentProviderCodex: 'native-test-provider',
  }), { mode: 0o600 });

  const requests: Array<Record<string, any>> = [];
  let dynamicMode = true;
  let simpleMode = false;
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
      if (simpleMode) {
        response.end(sse([
          created('follow-final'),
          assistantMessage('follow-final', 'FOLLOW_CURRENT_PROVIDER_OK'),
          completed('follow-final'),
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
    CC_SWITCH_HOME: ccSwitchHome,
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
    const seed = await runCodex([
      'exec',
      '--json',
      '--skip-git-repo-check',
      'Reply exactly LEGACY_THREAD_CONTEXT_ORBIT_731. Do not use tools.',
    ], workspace, env);
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
    await bridge.close();
    bridge = undefined;

    await writeFile(join(codexHome, 'config.toml'), [
      'model = "native-follow-model"',
      'model_provider = "native-local-follow"',
      'approval_policy = "never"',
      'sandbox_mode = "read-only"',
      '',
      '[model_providers.native-local-follow]',
      'name = "Native Local Follow"',
      `base_url = "http://127.0.0.1:${address.port}/v1"`,
      'wire_api = "responses"',
      'requires_openai_auth = false',
      'env_key = "OPENAI_API_KEY"',
    ].join('\n'), { mode: 0o600 });
    requests.length = 0;
    simpleMode = true;
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
      followCurrentProvider: true,
    });
    expect(bridge).toMatchObject({
      mode: 'adopted',
      oldThreadId: adoptedThreadId,
      providerSelection: {
        modelProvider: 'native-local-follow',
        model: 'native-follow-model',
      },
    });
    expect(bridge.threadId).not.toBe(adoptedThreadId);
    const followHostRegistry = JSON.parse(await readFile(
      join(profileDir, 'structured', 'app-server-registry.json'),
      'utf8',
    ));
    expect(followHostRegistry.hosts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        directory: bridge.endpoint.slice('unix://'.length).replace(/\/server\.sock$/u, ''),
        runtimeIdentity: expect.objectContaining({
          codexProviderId: 'native-local-follow',
          model: 'native-follow-model',
        }),
      }),
    ]));
    const followEvents: Array<{ type: string; delta?: string }> = [];
    await bridge.session!.submit({
      runId: 'native-follow-provider',
      scopeId: 'native-scope',
      cwd: workspace,
      prompt: 'Confirm the new provider thread.',
    }, event => followEvents.push(event), AbortSignal.timeout(60_000));
    expect(followEvents.filter(event => event.type === 'error')).toEqual([]);
    expect(followEvents.filter(event => event.type === 'text').map(event => event.delta).join(''))
      .toContain('FOLLOW_CURRENT_PROVIDER_OK');
    expect(requests.some(request => request.model === 'native-follow-model')).toBe(true);
    expect(requests.some(request =>
      request.model === 'native-follow-model' &&
      JSON.stringify(request).includes('LEGACY_THREAD_CONTEXT_ORBIT_731')
    )).toBe(true);
    const followMarker = JSON.parse(await readFile(
      join(profileDir, 'structured', 'broker-threads.json'),
      'utf8',
    ));
    expect(followMarker.threads[bridge.threadId]).toMatchObject({
      adoptedFrom: oldThreadId,
      previousThreadId: adoptedThreadId,
      followCurrentProvider: true,
      modelProvider: 'native-local-follow',
      model: 'native-follow-model',
      runtimeFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const followThreadId = bridge.threadId;
    const retained = await RpcClient.connect(`ws+unix://${bridge.endpoint.slice('unix://'.length)}:/`, { codexHome });
    await retained.initialize();
    await retained.request('thread/resume', { threadId: followThreadId, excludeTurns: true });
    await retained.request('thread/settings/update', { threadId: followThreadId, model: 'native-tui-changed-model' });
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
      followCurrentProvider: true,
    });
    expect(bridge).toMatchObject({
      mode: 'adopted',
      threadId: followThreadId,
      oldThreadId: adoptedThreadId,
      reusedAdoption: true,
      providerSelection: {
        modelProvider: 'native-local-follow',
        model: 'native-follow-model',
      },
    });
    const actualModel = await retained.request('thread/read', { threadId: followThreadId, includeTurns: false });
    expect(actualModel.thread.model).toBe('native-follow-model');
    await retained.request('thread/unsubscribe', { threadId: followThreadId });
    retained.close();
    await bridge.close();
    bridge = undefined;

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
      followCurrentProvider: true,
    });
    expect(bridge).toMatchObject({
      mode: 'adopted',
      oldThreadId: followThreadId,
      providerSelection: {
        modelProvider: 'native-local',
        model: 'native-bridge-model',
      },
    });
    expect(bridge.threadId).not.toBe(followThreadId);
    expect(bridge.threadId).not.toBe(adoptedThreadId);
    const switchedBackEvents: Array<{ type: string; delta?: string }> = [];
    await bridge.session!.submit({
      runId: 'native-switch-back',
      scopeId: 'native-scope',
      cwd: workspace,
      prompt: 'Continue with context from the provider B generation.',
    }, event => switchedBackEvents.push(event), AbortSignal.timeout(60_000));
    expect(switchedBackEvents.filter(event => event.type === 'error')).toEqual([]);
    expect(requests.some(request =>
      request.model === 'native-bridge-model' &&
      JSON.stringify(request).includes('FOLLOW_CURRENT_PROVIDER_OK')
    )).toBe(true);
    const switchedBackMarker = JSON.parse(await readFile(
      join(profileDir, 'structured', 'broker-threads.json'),
      'utf8',
    ));
    expect(switchedBackMarker.threads[bridge.threadId]).toMatchObject({
      adoptedFrom: oldThreadId,
      previousThreadId: followThreadId,
      followCurrentProvider: true,
      modelProvider: 'native-local',
      model: 'native-bridge-model',
    });
    const historyDir = join(profileDir, 'structured', 'broker-thread-history');
    const historyText = (await Promise.all(
      (await readdir(historyDir)).map(file => readFile(join(historyDir, file), 'utf8')),
    )).join('\n');
    expect(historyText).toContain('LEGACY_THREAD_CONTEXT_ORBIT_731');
    expect(historyText).toContain('FOLLOW_CURRENT_PROVIDER_OK');
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

nativeBridge.each([false, true])('resumes exclusive idle writers and preserves shared retained writers: %s', async shared => {
  const root = await mkdtemp(join(tmpdir(), 'arg-bridge-native-rebind-'));
  const codexHome = join(root, 'codex-home');
  const workspace = join(root, 'workspace');
  const profileDir = join(root, 'profile');
  const ccSwitchHome = join(root, 'cc-switch');
  const brokerState = join(root, 'broker-state.json');
  await Promise.all([
    mkdir(codexHome, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(profileDir, { recursive: true }),
    mkdir(ccSwitchHome, { recursive: true }),
  ]);
  await writeFile(join(ccSwitchHome, 'settings.json'), JSON.stringify({
    currentProviderCodex: 'native-test-provider',
  }), { mode: 0o600 });

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
      response.end(sse([
        created('provider-rebind'),
        assistantMessage('provider-rebind', 'PROVIDER_REBIND_OK'),
        completed('provider-rebind'),
      ]));
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address() as { port: number };
  const writeProvider = async (providerId: string, model: string): Promise<void> => {
    await writeFile(join(codexHome, 'config.toml'), [
      `model = "${model}"`,
      `model_provider = "${providerId}"`,
      'approval_policy = "never"',
      'sandbox_mode = "read-only"',
      '',
      `[model_providers.${providerId}]`,
      `name = "${providerId}"`,
      `base_url = "http://127.0.0.1:${address.port}/v1"`,
      'wire_api = "responses"',
      'requires_openai_auth = false',
      'env_key = "OPENAI_API_KEY"',
    ].join('\n'), { mode: 0o600 });
  };
  await writeProvider('native-local', 'native-bridge-model');

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_HOME: codexHome,
    CC_SWITCH_HOME: ccSwitchHome,
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
  let botObserver: CodexStructuredSession | undefined;
  let otherRpc: RpcClient | undefined;
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
    const threadId = bridge.threadId;
    const initialEvents: Array<{ type: string; delta?: string }> = [];
    await bridge.session!.submit({
      runId: 'native-before-rebind',
      scopeId: 'native-rebind-scope',
      cwd: workspace,
      prompt: 'Establish the original provider thread.',
    }, event => initialEvents.push(event), AbortSignal.timeout(60_000));
    expect(initialEvents.filter(event => event.type === 'error')).toEqual([]);
    const originalMarker = JSON.parse(await readFile(
      join(profileDir, 'structured', 'broker-threads.json'),
      'utf8',
    ));
    const originalEndpoint = bridge.endpoint;
    if (shared) {
      const observerRpc = await RpcClient.connect(`ws+unix://${originalEndpoint.slice('unix://'.length)}:/`, { codexHome });
      await observerRpc.initialize();
      await observerRpc.request('thread/resume', { threadId, excludeTurns: true });
      botObserver = new CodexStructuredSession(threadId, originalEndpoint, observerRpc);
      await botObserver.initializeLifecycle(codexHome, 'background-bot', originalEndpoint);
      await botObserver.syncState();
      otherRpc = await RpcClient.connect(`ws+unix://${originalEndpoint.slice('unix://'.length)}:/`, { codexHome });
      await otherRpc.initialize();
      await otherRpc.request('thread/start', { cwd: workspace, approvalPolicy: 'never', sandbox: 'read-only' });
    }
    await bridge.close();
    bridge = undefined;
    const oldHost = JSON.parse(await readFile(
      join(profileDir, 'structured', 'app-server-registry.json'),
      'utf8',
    )).hosts.find((host: { directory: string }) =>
      host.directory === originalEndpoint.slice('unix://'.length).replace(/\/server\.sock$/u, '')
    );
    expect(oldHost).toBeDefined();
    expect(processAlive(oldHost.pid)).toBe(true);

    // The original provider is gone. The current provider must still reopen
    // the exact same thread ID and safely reclaim the idle old provider host.
    await writeProvider('native-local-follow', 'native-follow-model');
    requests.length = 0;
    if (shared) {
      await expect(createNativeBridgeSession({ profileName: 'codex', profileDir, cwd: workspace, config: profile,
        env, binary: 'codex', codexHome, sandbox: 'read-only', threadId, followCurrentProvider: true,
      })).rejects.toThrow('保留共享 Server');
      expect(processAlive(oldHost.pid)).toBe(true);
      expect(botObserver!.isAlive()).toBe(false);
      expect(otherRpc!.closed).toBe(false);
      const after = JSON.parse(await readFile(join(profileDir, 'structured', 'broker-threads.json'), 'utf8'));
      expect(after.threads[threadId]).toEqual(originalMarker.threads[threadId]);
      return;
    }
    bridge = await createNativeBridgeSession({
      profileName: 'codex',
      profileDir,
      cwd: workspace,
      config: profile,
      env,
      binary: 'codex',
      codexHome,
      sandbox: 'read-only',
      threadId,
      followCurrentProvider: true,
    });
    expect(bridge).toMatchObject({
      mode: 'attached',
      threadId,
      providerRebound: true,
      providerSelection: {
        ccSwitchProviderId: 'native-test-provider',
        modelProvider: 'native-local-follow',
        model: 'native-follow-model',
      },
    });
    expect(processAlive(oldHost.pid)).toBe(shared);
    if (shared) {
      expect(botObserver!.isAlive()).toBe(false);
      expect(otherRpc!.closed).toBe(false);
    }
    const reboundEvents: Array<{ type: string; delta?: string }> = [];
    await bridge.session!.submit({
      runId: 'native-after-rebind',
      scopeId: 'native-rebind-scope',
      cwd: workspace,
      prompt: 'Continue in the same thread through the new provider.',
    }, event => reboundEvents.push(event), AbortSignal.timeout(60_000));
    expect(reboundEvents.filter(event => event.type === 'error')).toEqual([]);
    expect(reboundEvents.filter(event => event.type === 'text').map(event => event.delta).join(''))
      .toContain('PROVIDER_REBIND_OK');
    expect(requests.some(request => request.model === 'native-follow-model')).toBe(true);

    const marker = JSON.parse(await readFile(
      join(profileDir, 'structured', 'broker-threads.json'),
      'utf8',
    ));
    expect(marker.threads[threadId]).toMatchObject({
      createdAt: originalMarker.threads[threadId].createdAt,
      followCurrentProvider: true,
      modelProvider: 'native-local-follow',
      model: 'native-follow-model',
      runtimeFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      compatibilityProvider: 'native-local',
    });
    const reboundCreatedAt = marker.threads[threadId].createdAt;
    await bridge.close();
    bridge = undefined;
    otherRpc?.close(); otherRpc = undefined;
    await shutdownProfileHosts(profileDir);

    // Repeating the command is idempotent and reconstructs the same
    // compatibility host after the previous one has been reclaimed.
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
      threadId,
      followCurrentProvider: true,
    });
    expect(bridge).toMatchObject({
      mode: 'attached',
      threadId,
      providerSelection: {
        modelProvider: 'native-local-follow',
        model: 'native-follow-model',
      },
    });
    expect(bridge.providerRebound).toBeUndefined();
    const repeatedMarker = JSON.parse(await readFile(
      join(profileDir, 'structured', 'broker-threads.json'),
      'utf8',
    ));
    expect(repeatedMarker.threads[threadId]).toMatchObject({
      createdAt: reboundCreatedAt,
      compatibilityProvider: 'native-local',
      modelProvider: 'native-local-follow',
    });
  } finally {
    await botObserver?.close(); botObserver?.disconnect();
    otherRpc?.close();
    await bridge?.close();
    await shutdownProfileHosts(profileDir);
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}, 120_000);

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

async function runCodex(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn('codex', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', data => { stdout += data.toString(); });
  child.stderr.on('data', data => { stderr += data.toString(); });
  const timeout = setTimeout(() => child.kill('SIGTERM'), 60_000);
  try {
    const status = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    return { status, stdout, stderr };
  } finally { clearTimeout(timeout); }
}
