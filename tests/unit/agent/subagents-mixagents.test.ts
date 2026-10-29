import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  mergeRuntimeRoutes,
  MixAgentsBrokerBackend,
  resolveLegacyInstalledMixAgentsLaunchConfig,
  resolveMixAgentsLaunchConfig,
} from '../../../src/agent/subagents/mixagents';
import { resolveSubagents } from '../../../src/agent/subagents/registry';
import {
  SubagentUnavailableError,
  type SideAgentProgress,
} from '../../../src/agent/subagents/types';
import {
  DEFAULT_SUBAGENT_CONFIG,
  type SubagentConfig,
} from '../../../src/config/profile-schema';

const fixture = fileURLToPath(new URL('../../fixtures/fake-mixagents-mcp.mjs', import.meta.url));
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'arg-bridge-mixagents-'));
  temporary.push(root);
  const statePath = join(root, 'state.json');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FAKE_MIXAGENTS_STATE: statePath,
    CC_SWITCH_HOME: join(root, 'cc-switch'),
    XDG_CONFIG_HOME: join(root, 'config'),
  };
  const config: SubagentConfig = {
    enabled: true,
    mode: 'broker',
    routeMode: 'follow-cc-switch',
    readRoute: null,
    writeRoute: null,
    modelTools: true,
    nativeToolPolicy: 'shadow',
    toolNamespace: 'arg_bridge',
    maxConcurrentWorkers: 4,
    workerTimeoutMs: 15 * 60_000,
    sideTimeoutMs: 90_000,
    sideReasoningEffort: 'low',
    webSearch: 'auto',
    allowWriteWorkers: false,
    includeProgressSnapshot: true,
    reuse: 'scope-cwd',
    allowForkFallback: false,
    mixagents: {
      mcpCommand: process.execPath,
      mcpArgs: [fixture],
      credentialEnvKeys: ['FAKE_MIXAGENTS_STATE'],
    },
  };
  return { root, statePath, env, config };
}

describe('MixAgentsBrokerBackend', () => {
  it('resolves the vendored MixAgents Broker entry', () => {
    const launch = resolveMixAgentsLaunchConfig({
      ...DEFAULT_SUBAGENT_CONFIG,
      mixagents: undefined,
    }, { ...process.env });
    expect(launch).toMatchObject({
      command: process.execPath,
    });
    expect(launch?.args[0]).toContain('mixagents-broker');
    expect(launch?.args[0]).toMatch(/[\\/]dist[\\/]server\.js$/u);
  });

  it('retains the legacy npm entry for pre-1.11 running processes', () => {
    const launch = resolveLegacyInstalledMixAgentsLaunchConfig();
    expect(launch).toMatchObject({
      command: process.execPath,
      args: [expect.stringMatching(/[\\/]mixagents-broker[\\/]dist[\\/]server\.js$/u)],
    });
  });

  it('maps a stale pre-1.11 profile path to the vendored Broker', async () => {
    const { root } = await setup();
    const stale = join(
      root,
      'missing-install',
      'node_modules',
      'mixagents-broker',
      'dist',
      'server.js',
    );
    const backend = new MixAgentsBrokerBackend({
      ...DEFAULT_SUBAGENT_CONFIG,
      mixagents: {
        mcpCommand: process.execPath,
        mcpArgs: [stale],
      },
    }, process.env, {
      brokerConfigPath: '/tmp/generated-broker.json',
      credentials: {},
      fingerprint: 'runtime-fingerprint',
      route: {
        id: 'generated-route',
        provider: 'custom',
        model: 'model-a',
        maxAccess: 'read-only' as const,
        available: true,
        missingEnvironment: [],
        tags: ['cc-switch'],
      },
    });

    expect(backend.launchConfig.command).toBe(process.execPath);
    expect(backend.launchConfig.args[0]).not.toBe(stale);
    expect(backend.launchConfig.args[0]).toMatch(
      /[\\/]vendor[\\/]mixagents-broker[\\/]/u,
    );
  });

  it('uses the bundled Broker directly for generated cc-switch runtimes', () => {
    const runtime = {
      brokerConfigPath: '/tmp/generated-broker.json',
      credentials: {},
      fingerprint: 'runtime-fingerprint',
      route: {
        id: 'generated-route',
        provider: 'custom',
        model: 'model-a',
        maxAccess: 'read-only' as const,
        available: true,
        missingEnvironment: [],
        tags: ['cc-switch'],
      },
    };
    const backend = new MixAgentsBrokerBackend({
      ...DEFAULT_SUBAGENT_CONFIG,
      mixagents: {
        mcpCommand: '/home/example/.local/bin/mixagents-broker-mcp',
      },
    }, process.env, runtime);

    expect(backend.launchConfig.command).toBe(process.execPath);
    expect(backend.launchConfig.args[0]).toContain('mixagents-broker');
  });

  it('replaces node-based legacy Broker wrappers for generated runtimes', () => {
    const runtime = {
      brokerConfigPath: '/tmp/generated-broker.json',
      credentials: {},
      fingerprint: 'runtime-fingerprint',
      route: {
        id: 'generated-route',
        provider: 'custom',
        model: 'model-a',
        maxAccess: 'read-only' as const,
        available: true,
        missingEnvironment: [],
        tags: ['cc-switch'],
      },
    };
    const backend = new MixAgentsBrokerBackend({
      ...DEFAULT_SUBAGENT_CONFIG,
      mixagents: {
        mcpCommand: process.execPath,
        mcpArgs: ['/home/example/.local/bin/mixagents-broker-mcp.mjs'],
      },
    }, process.env, runtime);

    expect(backend.launchConfig.command).toBe(process.execPath);
    expect(backend.launchConfig.args[0]).toContain('mixagents-broker');
  });

  it('replaces the legacy arg-bridge MixAgents wrapper for generated runtimes', () => {
    const runtime = {
      brokerConfigPath: '/tmp/generated-broker.json',
      credentials: {},
      fingerprint: 'runtime-fingerprint',
      route: {
        id: 'generated-route',
        provider: 'custom',
        model: 'model-a',
        maxAccess: 'read-only' as const,
        available: true,
        missingEnvironment: [],
        tags: ['cc-switch'],
      },
    };
    const backend = new MixAgentsBrokerBackend({
      ...DEFAULT_SUBAGENT_CONFIG,
      mixagents: {
        mcpCommand: '/home/example/.local/bin/arg-bridge-mixagents-mcp',
      },
    }, process.env, runtime);

    expect(backend.launchConfig.command).toBe(process.execPath);
    expect(backend.launchConfig.args[0]).toContain('mixagents-broker');
  });

  it('lists routes, spawns a read-only agent, reuses it, and interrupts it', async () => {
    const { root, statePath, env, config } = await setup();
    const backend = new MixAgentsBrokerBackend(config, env);
    try {
      const routes = await backend.listRoutes(new AbortController().signal);
      expect(routes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'read-a',
          provider: 'provider-a',
          model: 'model-a',
          maxAccess: 'read-only',
          available: true,
        }),
      ]));
      const route = routes.find(item => item.id === 'read-a')!;
      const signal = new AbortController().signal;
      const agent = await backend.createOrReuse({
        route,
        task: 'Review the patch',
        cwd: root,
        scope: 'scope-a',
        access: 'read-only',
        signal,
      });
      expect(agent).toMatchObject({
        route: 'read-a',
        provider: 'provider-a',
        model: 'model-a',
        access: 'read-only',
        backendId: 'mixagents',
      });
      const progress: SideAgentProgress[] = [];
      await expect(backend.wait(agent, signal, undefined, event => {
        progress.push(event);
      })).resolves.toMatchObject({
        status: 'completed',
        text: 'result:Review the patch',
      });
      expect(progress).toContainEqual(expect.objectContaining({
        type: 'text',
        text: expect.any(String),
      }));
      expect(
        progress
          .filter(event => event.type === 'text')
          .map(event => event.text)
          .join(''),
      ).toBe('result:Review the patch');
      const followupProgress: SideAgentProgress[] = [];
      await expect(backend.send(agent, 'Check tests', signal, undefined, event => {
        followupProgress.push(event);
      })).resolves.toMatchObject({
        status: 'completed',
        text: 'followup:Check tests',
      });
      expect(
        followupProgress
          .filter(event => event.type === 'text')
          .map(event => event.text)
          .join(''),
      ).toBe('followup:Check tests');
      await backend.interrupt(agent, signal);
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      const spawnCalls = state.calls.filter((call: { tool: string }) => call.tool === 'spawn_agent');
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0].arguments).toMatchObject({
        route: 'read-a',
        cwd: root,
        access: 'read-only',
      });
      expect(state.calls.filter((call: { tool: string }) => call.tool === 'wait_agent')).toHaveLength(2);
    } finally {
      await backend.closeBackend();
    }
  });

  it('keeps terminal mailbox behavior when an older Broker lacks progress events', async () => {
    const { root, env, config } = await setup();
    const backend = new MixAgentsBrokerBackend(config, {
      ...env,
      FAKE_MIXAGENTS_OMIT_TOOL: 'read_agent_events',
    });
    try {
      const [route] = await backend.listRoutes(new AbortController().signal);
      const signal = new AbortController().signal;
      const agent = await backend.createOrReuse({
        route: route!,
        task: 'Legacy mailbox',
        cwd: root,
        scope: 'legacy-progress',
        access: 'read-only',
        signal,
      });
      const progress: SideAgentProgress[] = [];
      await expect(backend.wait(agent, signal, undefined, event => {
        progress.push(event);
      })).resolves.toMatchObject({
        status: 'completed',
        text: 'result:Legacy mailbox',
      });
      expect(progress).toEqual([]);
    } finally {
      await backend.closeBackend();
    }
  });

  it('rejects workspace-write without an exact per-task authorization', async () => {
    const { root, config, env } = await setup();
    const backend = new MixAgentsBrokerBackend(config, env);
    try {
      const routes = await backend.listRoutes(new AbortController().signal);
      const route = routes.find(item => item.maxAccess === 'workspace-write');
      await expect(backend.createOrReuse({
        route: route!,
        task: 'Edit a file',
        cwd: root,
        scope: 'scope-write',
        access: 'workspace-write',
        signal: new AbortController().signal,
      })).rejects.toMatchObject({
        name: 'SubagentUnavailableError',
        code: 'write-not-authorized',
      });
    } finally {
      await backend.closeBackend();
    }
  });

  it('rejects workspace-write when the selected route is read-only', async () => {
    const { root, config, env } = await setup();
    const backend = new MixAgentsBrokerBackend(config, env);
    try {
      const [route] = await backend.listRoutes(new AbortController().signal);
      await expect(backend.createOrReuse({
        route: route!,
        task: 'Edit a file',
        cwd: root,
        scope: 'scope-read-route',
        access: 'workspace-write',
        writeAuthorization: {
          workspace: root,
          task: 'Edit a file',
        },
        signal: new AbortController().signal,
      })).rejects.toMatchObject({
        name: 'SubagentUnavailableError',
        code: 'route-unavailable',
      });
    } finally {
      await backend.closeBackend();
    }
  });

  it('delegates managed credentials and passes only an opaque provider reference', async () => {
    const { env, config, statePath } = await setup();
    const managed: SubagentConfig = {
      ...config,
      mixagents: {
        mcpCommand: process.execPath,
        mcpArgs: [fixture],
        credentialMode: 'mixagents-managed',
        credentialProvider: 'halflong',
      },
    };
    const backend = new MixAgentsBrokerBackend(managed, env);
    try {
      await expect(backend.listRoutes(new AbortController().signal)).resolves.toHaveLength(2);
      expect(managed.mixagents?.credentialEnvKeys).toBeUndefined();
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      expect(state.lastCredentialProvider).toBe('halflong');
      expect(state.lastCredentialSource).toBe('cc-switch');
      expect(JSON.stringify(state)).not.toContain('sk-');
    } finally {
      await backend.closeBackend();
    }
  });

  it('cancels in-flight creation and ignores its late response', async () => {
    const { env, config } = await setup();
    const delayedEnv = { ...env, FAKE_MIXAGENTS_DELAY_MS: '100' };
    const backend = new MixAgentsBrokerBackend(config, delayedEnv);
    try {
      const [route] = await backend.listRoutes(new AbortController().signal);
      const controller = new AbortController();
      const first = backend.createOrReuse({
        route: route!,
        task: 'Cancelled task',
        cwd: '/workspace',
        scope: 'cancel-scope',
        access: 'read-only',
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 10);
      await expect(first).rejects.toMatchObject({ name: 'AbortError' });
      await expect(backend.listRoutes(new AbortController().signal)).resolves.toHaveLength(2);
    } finally {
      await backend.closeBackend();
    }
  });

  it('fails clearly when the MCP server lacks a required versioned tool', async () => {
    const { env, config } = await setup();
    const backend = new MixAgentsBrokerBackend(config, {
      ...env,
      FAKE_MIXAGENTS_OMIT_TOOL: 'wait_agent',
    });
    try {
      await expect(backend.listRoutes(new AbortController().signal))
        .rejects.toMatchObject({
          code: 'mixagents-incompatible',
          message: expect.stringContaining('wait_agent'),
        });
    } finally {
      await backend.closeBackend();
    }
  });
});

describe('cc-switch runtime route augmentation', () => {
  it('adds cc-switch identity without replacing MixAgents availability', () => {
    const actual = {
      id: 'generated-route',
      provider: 'custom',
      model: 'model-a',
      maxAccess: 'workspace-write' as const,
      available: false,
      missingEnvironment: ['OPENAI_API_KEY'],
      tags: ['configured'],
    };
    const generated = {
      ...actual,
      available: true,
      missingEnvironment: [],
      tags: ['cc-switch', 'third-party'],
      source: 'cc-switch' as const,
      ccSwitchProviderId: 'provider-a',
      targetFingerprint: 'f'.repeat(64),
    };
    expect(mergeRuntimeRoutes([actual], generated)).toEqual([
      expect.objectContaining({
        id: 'generated-route',
        available: false,
        missingEnvironment: ['OPENAI_API_KEY'],
        source: 'cc-switch',
        ccSwitchProviderId: 'provider-a',
      }),
    ]);
  });

  it('fails closed when MixAgents returns a different provider/model', () => {
    const generated = {
      id: 'generated-route',
      provider: 'custom',
      model: 'model-a',
      maxAccess: 'read-only' as const,
      available: true,
      missingEnvironment: [],
      tags: [],
      source: 'cc-switch' as const,
      ccSwitchProviderId: 'provider-a',
    };
    expect(() => mergeRuntimeRoutes([{
      ...generated,
      provider: 'other',
    }], generated)).toThrow(/不匹配/);
  });
});

describe('subagent route resolution', () => {
  it('re-reads cc-switch on every resolution without changing the main provider', async () => {
    const { root, env, config } = await setup();
    const ccDir = join(root, 'cc-switch');
    const routeDir = join(root, 'config', 'arg-bridge');
    await Promise.all([
      mkdir(ccDir, { recursive: true }),
      mkdir(routeDir, { recursive: true }),
    ]);
    const settingsPath = join(ccDir, 'settings.json');
    await writeFile(settingsPath, JSON.stringify({ currentProviderCodex: 'provider-a' }), { mode: 0o600 });
    await writeFile(join(routeDir, 'broker-routes.json'), JSON.stringify({
      version: 1,
      providers: {
        'provider-a': { readRoute: 'read-a' },
        'provider-b': { readRoute: 'write-b' },
      },
    }), { mode: 0o600 });

    const first = await resolveSubagents({
      subagents: config,
      env,
      cwd: root,
      signal: new AbortController().signal,
    });
    expect(first).toMatchObject({ kind: 'mixagents', route: { id: 'read-a' } });
    await first.backend?.closeBackend?.();

    await writeFile(settingsPath, JSON.stringify({ currentProviderCodex: 'provider-b' }), { mode: 0o600 });
    const second = await resolveSubagents({
      subagents: config,
      env,
      cwd: root,
      signal: new AbortController().signal,
    });
    expect(second).toMatchObject({ kind: 'mixagents', route: { id: 'write-b' } });
    await second.backend?.closeBackend?.();
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual({
      currentProviderCodex: 'provider-b',
    });
  });

  it('does not silently fork in explicit broker mode', async () => {
    const { root, env } = await setup();
    const config: SubagentConfig = {
      enabled: true,
      mode: 'broker',
      routeMode: 'follow-cc-switch',
      readRoute: null,
      writeRoute: null,
      modelTools: true,
      nativeToolPolicy: 'shadow',
      toolNamespace: 'arg_bridge',
      maxConcurrentWorkers: 4,
      workerTimeoutMs: 15 * 60_000,
      sideTimeoutMs: 90_000,
      sideReasoningEffort: 'low',
      webSearch: 'auto',
      allowWriteWorkers: false,
      includeProgressSnapshot: true,
      reuse: 'scope-cwd',
      allowForkFallback: true,
    };
    await expect(resolveSubagents({
      subagents: config,
      env,
      cwd: root,
      signal: new AbortController().signal,
    }))
      .rejects.toBeInstanceOf(SubagentUnavailableError);
  });

  it('auto mode falls back to the main Codex provider when MixAgents startup fails', async () => {
    const { root, env, config } = await setup();
    const resolved = await resolveSubagents({
      subagents: {
        ...config,
        mode: 'auto',
        allowForkFallback: true,
      },
      env: {
        ...env,
        FAKE_MIXAGENTS_OMIT_TOOL: 'wait_agent',
      },
      cwd: root,
      signal: new AbortController().signal,
    });
    expect(resolved).toMatchObject({
      kind: 'fork',
      routes: [],
    });
    expect(resolved.notice).toContain('主 Codex session');
    expect(resolved.error).toContain('wait_agent');
  });

  it('never forks a workspace-write side request', async () => {
    const { root, env, config } = await setup();
    await expect(resolveSubagents({
      subagents: {
        ...config,
        mode: 'auto',
        allowWriteWorkers: true,
        writeRoute: 'write-b',
        allowForkFallback: true,
      },
      env: {
        ...env,
        FAKE_MIXAGENTS_OMIT_TOOL: 'wait_agent',
      },
      cwd: root,
      access: 'workspace-write',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'mixagents-not-configured',
    });
  });

  it('never resolves workspace-write through explicit fork mode', async () => {
    const { root, env, config } = await setup();
    await expect(resolveSubagents({
      subagents: {
        ...config,
        mode: 'fork',
        allowWriteWorkers: true,
        writeRoute: 'write-b',
      },
      env,
      cwd: root,
      access: 'workspace-write',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'write-not-authorized',
      message: expect.stringContaining('不允许通过 Codex fork fallback'),
    });
  });

  it('an explicit /btw route never falls back to main Codex', async () => {
    const { root, env, config } = await setup();
    await expect(resolveSubagents({
      subagents: {
        ...config,
        mode: 'auto',
        allowForkFallback: true,
      },
      env: {
        ...env,
        FAKE_MIXAGENTS_OMIT_TOOL: 'wait_agent',
      },
      cwd: root,
      requestedRoute: 'read-a',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'mixagents-not-configured',
    });
  });

  it('auto mode falls back to main Codex when the selected mapped route is unavailable', async () => {
    const { root, env, config } = await setup();
    const ccDir = join(root, 'cc-switch');
    const routeDir = join(root, 'config', 'arg-bridge');
    await Promise.all([
      mkdir(ccDir, { recursive: true }),
      mkdir(routeDir, { recursive: true }),
    ]);
    await writeFile(join(ccDir, 'settings.json'), JSON.stringify({
      currentProviderCodex: 'provider-b',
    }), { mode: 0o600 });
    await writeFile(join(routeDir, 'broker-routes.json'), JSON.stringify({
      version: 1,
      providers: {
        'provider-b': { readRoute: 'write-b' },
      },
    }), { mode: 0o600 });
    const resolved = await resolveSubagents({
      subagents: {
        ...config,
        mode: 'auto',
        allowForkFallback: true,
      },
      env: { ...env, FAKE_ROUTE_B_MISSING: 'MISSING_PROVIDER_KEY' },
      cwd: root,
      signal: new AbortController().signal,
    });
    expect(resolved).toMatchObject({
      kind: 'fork',
      error: expect.stringContaining('MISSING_PROVIDER_KEY'),
    });
  });

  it('never forks when the user explicitly requests a missing route', async () => {
    const { root, env, config } = await setup();
    await expect(resolveSubagents({
      subagents: {
        ...config,
        mode: 'auto',
        allowForkFallback: true,
      },
      env,
      cwd: root,
      requestedRoute: 'not-configured',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'route-unavailable',
    });
  });
});
