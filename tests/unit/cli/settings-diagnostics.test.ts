import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDoctorReport } from '../../../src/cli/commands/doctor';
import {
  formatSettings,
  loadSettingsSnapshot,
} from '../../../src/cli/commands/settings';
import { resolveAppPaths } from '../../../src/config/app-paths';
import {
  createDefaultProfileConfig,
  DEFAULT_SUBAGENT_CONFIG,
} from '../../../src/config/profile-schema';
import {
  createRootConfig,
  saveRootConfig,
} from '../../../src/config/profile-store';
import { parseProviderTable } from '../../../src/integrations/cc-switch';
import { supportsLegacyInstalledMixAgentsBroker } from '../../../src/agent/subagents/mixagents';

const fixture = fileURLToPath(new URL('../../fixtures/fake-mixagents-mcp.mjs', import.meta.url));
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function setup(options: { mcp: boolean }) {
  const root = await mkdtemp(join(tmpdir(), 'arg-bridge-settings-'));
  temporary.push(root);
  const ccHome = join(root, 'cc-switch');
  const xdg = join(root, 'xdg');
  await Promise.all([
    mkdir(ccHome, { recursive: true }),
    mkdir(join(xdg, 'arg-bridge'), { recursive: true }),
  ]);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LARK_CHANNEL_HOME: root,
    CC_SWITCH_HOME: ccHome,
    XDG_CONFIG_HOME: xdg,
    FAKE_MIXAGENTS_STATE: join(root, 'broker-state.json'),
    MIXAGENTS_TEST_SECRET: 'sk-super-secret-value',
  };
  const paths = resolveAppPaths({ rootDir: root });
  const profile = createDefaultProfileConfig({
    agentKind: 'codex',
    accounts: { app: { id: 'cli_test', secret: 'test-secret', tenant: 'feishu' } },
    codex: { binaryPath: 'codex' },
  });
  profile.subagents = {
    ...DEFAULT_SUBAGENT_CONFIG,
    mode: 'broker',
    routeMode: 'manual',
    readRoute: 'read-a',
    writeRoute: 'write-b',
    allowForkFallback: false,
    ...(options.mcp
      ? {
          mixagents: {
            mcpCommand: process.execPath,
            mcpArgs: [fixture],
            credentialEnvKeys: ['FAKE_MIXAGENTS_STATE', 'MIXAGENTS_TEST_SECRET'],
          },
        }
      : {}),
  };
  await saveRootConfig(createRootConfig('codex', profile), paths.configFile);
  await writeFile(join(ccHome, 'settings.json'), JSON.stringify({
    currentProviderCodex: 'provider-a',
  }), { mode: 0o600 });
  await writeFile(join(xdg, 'arg-bridge', 'broker-routes.json'), JSON.stringify({
    version: 1,
    providers: {
      'provider-a': { readRoute: 'read-a', writeRoute: 'write-b' },
      'provider-b': { readRoute: 'write-b' },
    },
  }), { mode: 0o600 });
  return { root, env, ccHome, profile };
}

describe('arg-bridge settings and doctor', () => {
  it('parses both cc-switch table border styles without reading API URL cells', () => {
    expect(parseProviderTable([
      '│   ┆ default        ┆ lixin           ┆ https://example.invalid/v1 │',
      '│ ✓ ┆ codex-official ┆ OpenAI Official ┆ N/A                       │',
    ].join('\n'))).toEqual([
      { id: 'default', name: 'lixin', current: false },
      { id: 'codex-official', name: 'OpenAI Official', current: true },
    ]);
  });

  it('never invokes the secret-printing cc-switch provider current command', async () => {
    const source = await import('node:fs/promises')
      .then(fs => fs.readFile(join(process.cwd(), 'src', 'integrations', 'cc-switch.ts'), 'utf8'));
    expect(source).not.toMatch(/['"]provider['"]\s*,\s*['"]current['"]/);
    expect(source).toContain("['-a', 'codex', 'provider', 'list']");
  });

  it('re-reads cc-switch routes and keeps secret values out of output', async () => {
    const context = await setup({ mcp: true });
    const first = await loadSettingsSnapshot({
      profile: 'codex',
      env: context.env,
    });
    expect(first.ccSwitch.currentProviderCodex).toBe('provider-a');
    expect(first.subagents.diagnostics.mcp.status).toBe('available');
    expect(first.subagents.diagnostics.selectedRoute.id).toBe('read-a');
    expect(first.subagents.diagnostics.selectedWriteRoute.id).toBe('write-b');
    expect(first.subagents.diagnostics.progress).toEqual({
      mode: 'events-v1',
      tool: 'read_agent_events',
    });
    const legacyNpmRuntime = supportsLegacyInstalledMixAgentsBroker()
      ? 'supported'
      : 'unsupported';
    const legacyNpm = legacyNpmRuntime === 'supported' ? 'present' : 'missing';
    expect(first.subagents.diagnostics.launchCompatibility).toMatchObject({
      vendor: 'present',
      legacyNpm,
      legacyNpmRuntime,
      purpose: 'new-runtime-plus-running-process-compatibility',
    });
    expect(first.subagents.diagnostics.readRoutes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'read-a',
        provider: 'provider-a',
        model: 'model-a',
        access: 'read-only',
      }),
    ]));
    expect(first.subagents.diagnostics.writeRoutes).toEqual([
      expect.objectContaining({
        id: 'write-b',
        access: 'workspace-write',
      }),
    ]);

    await writeFile(join(context.ccHome, 'settings.json'), JSON.stringify({
      currentProviderCodex: 'provider-b',
    }), { mode: 0o600 });
    const second = await loadSettingsSnapshot({
      profile: 'codex',
      env: context.env,
    });
    expect(second.ccSwitch.currentProviderCodex).toBe('provider-b');
    expect(second.subagents.diagnostics.selectedRoute.id).toBe('read-a');
    const output = `${JSON.stringify(second)}\n${formatSettings(second)}`;
    expect(output).not.toContain('sk-super-secret-value');
    expect(output).toContain('MIXAGENTS_TEST_SECRET');
    expect(output).toContain('sideTimeoutMs=90000');
    expect(output).toContain('progress=events-v1');
    expect(output).toContain('vendorBroker=present');
    expect(output).toContain(`legacyNpmBroker=${legacyNpm}`);
    expect(output).toContain(`legacyNpmRuntime=${legacyNpmRuntime}`);
    expect(output).toContain('web search mode=auto');
  });

  it('reports explicit broker configuration failure without crashing settings', async () => {
    const context = await setup({ mcp: false });
    const paths = resolveAppPaths({ rootDir: context.root, profile: 'codex' });
    await mkdir(join(paths.profileDir, 'structured'), { recursive: true });
    await writeFile(join(paths.profileDir, 'structured', 'broker-threads.json'), JSON.stringify({
      version: 1,
      threads: {
        'thread-without-mcp': {
          version: 1,
          namespace: 'arg_bridge',
          createdAt: 1,
        },
      },
    }));
    await writeFile(join(paths.profileDir, 'structured', 'app-server-registry.json'), JSON.stringify({
      version: 1,
      hosts: [{
        directory: '/tmp/runtime-without-mcp',
        pid: process.pid,
        startedAt: 1,
        binary: 'codex',
        fingerprint: { credentials: {}, networkMode: 'inherit' },
        runtimeIdentity: {
          codexProviderId: 'provider-a',
          model: 'model-a',
          recordedAt: 1,
        },
      }],
    }));
    const report = await loadDoctorReport({
      profile: 'codex',
      env: context.env,
      json: true,
    });
    expect(report.status).toBe('error');
    expect(['not-configured', 'unavailable']).toContain(report.mixagents.mcpStatus);
    expect(report.mixagents.modelTools.brokerWired).toBe(false);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'mixagents-mcp', status: 'fail' }),
    ]));
    expect(JSON.stringify(report)).not.toContain('sk-super-secret-value');
  });

  it('reports a Broker runtime as wired only when a marker and live identified host exist', async () => {
    const context = await setup({ mcp: true });
    const paths = resolveAppPaths({ rootDir: context.root, profile: 'codex' });
    await mkdir(join(paths.profileDir, 'structured'), { recursive: true });
    await writeFile(join(paths.profileDir, 'structured', 'broker-threads.json'), JSON.stringify({
      version: 1,
      threads: {
        'thread-bridge': {
          version: 1,
          namespace: 'arg_bridge',
          createdAt: 1,
        },
      },
    }));
    await writeFile(join(paths.profileDir, 'structured', 'app-server-registry.json'), JSON.stringify({
      version: 1,
      hosts: [{
        directory: '/tmp/runtime',
        pid: process.pid,
        startedAt: 1,
        binary: 'codex',
        fingerprint: {
          credentials: {},
          networkMode: 'inherit',
        },
        runtimeIdentity: {
          ccSwitchProviderId: 'provider-a',
          codexProviderId: 'provider-a',
          model: 'model-a',
          recordedAt: 1,
        },
      }],
    }));
    const report = await loadDoctorReport({
      profile: 'codex',
      env: context.env,
      json: true,
    });
    expect(report.runtimeBinding).toMatchObject({
      match: 'bound',
      namespaceBound: true,
      liveIdentifiedAppServerHosts: 1,
    });
    expect(report.mixagents.modelTools.brokerWired).toBe(true);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'runtime-binding', status: 'pass' }),
    ]));
    expect(JSON.stringify(report)).not.toContain('sk-super-secret-value');
  });

  it('runs a paid route probe only when explicitly requested and never falls back', async () => {
    const context = await setup({ mcp: true });
    const passed = await loadDoctorReport({
      profile: 'codex',
      env: context.env,
      json: true,
      probeRoute: 'read-a',
    });
    expect(passed.probe).toMatchObject({
      requestedRoute: 'read-a',
      status: 'pass',
      route: 'read-a',
      provider: 'provider-a',
      model: 'model-a',
      access: 'read-only',
    });
    expect(passed.probe?.outputHash).toMatch(/^[a-f0-9]{64}$/);

    const failed = await loadDoctorReport({
      profile: 'codex',
      env: context.env,
      json: true,
      probeRoute: 'missing-route',
    });
    expect(failed.status).toBe('error');
    expect(failed.probe).toMatchObject({
      requestedRoute: 'missing-route',
      status: 'fail',
      access: 'read-only',
    });
    expect(failed.probe?.error).toMatch(/route/i);
  });

  it('shows cc-switch, Codex-internal and Broker route identities separately', async () => {
    const context = await setup({ mcp: true });
    const codexHome = join(context.root, 'codex-home');
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, 'config.toml'), [
      'model = "model-new"',
      'model_provider = "custom"',
      '',
      '[model_providers.custom]',
      'name = "custom"',
      'base_url = "https://example.invalid/v1"',
      'wire_api = "responses"',
    ].join('\n'));
    context.profile.codex = {
      ...context.profile.codex!,
      binaryPath: 'codex',
      codexHome,
      inheritCodexHome: false,
    };
    const paths = resolveAppPaths({ rootDir: context.root, profile: 'codex' });
    await saveRootConfig(createRootConfig('codex', context.profile), paths.configFile);
    await writeFile(join(context.ccHome, 'settings.json'), JSON.stringify({
      currentProviderCodex: 'provider-b',
    }), { mode: 0o600 });
    await mkdir(join(paths.profileDir, 'structured'), { recursive: true });
    await writeFile(join(paths.profileDir, 'structured', 'app-server-registry.json'), JSON.stringify({
      version: 1,
      hosts: [{
        directory: '/tmp/runtime',
        pid: process.pid,
        startedAt: 1,
        binary: 'codex',
        fingerprint: {
          credentials: {},
          networkMode: 'inherit',
          configStamp: 'old',
        },
        runtimeIdentity: {
          ccSwitchProviderId: 'provider-a',
          codexProviderId: 'custom',
          model: 'model-old',
          recordedAt: 1,
        },
      }],
    }));

    const snapshot = await loadSettingsSnapshot({
      profile: 'codex',
      env: context.env,
    });
    expect(snapshot.mainProvider).toMatchObject({
      configuredCcSwitchProviderId: 'provider-b',
      configuredCodexProviderId: 'custom',
      configuredModel: 'model-new',
      running: [expect.objectContaining({
        ccSwitchProviderId: 'provider-a',
        codexProviderId: 'custom',
        model: 'model-old',
      })],
      pendingSwitch: 'pending-next-turn',
    });
    expect(snapshot.subagents.diagnostics.selectedRoute.id).toBe('read-a');
    expect(snapshot.mainProvider.configuredCcSwitchProviderId).not.toBe(
      snapshot.mainProvider.configuredCodexProviderId,
    );
    expect(snapshot.subagents.diagnostics.selectedRoute.id).not.toBe(
      snapshot.mainProvider.configuredCodexProviderId,
    );
  });
});
