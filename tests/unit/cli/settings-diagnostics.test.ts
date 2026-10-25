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
      'provider-a': { readRoute: 'read-a' },
      'provider-b': { readRoute: 'write-b' },
    },
  }), { mode: 0o600 });
  return { root, env, ccHome, profile };
}

describe('arg-bridge settings and doctor', () => {
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
    expect(second.subagents.diagnostics.selectedRoute.id).toBe('write-b');
    const output = `${JSON.stringify(second)}\n${formatSettings(second)}`;
    expect(output).not.toContain('sk-super-secret-value');
    expect(output).toContain('MIXAGENTS_TEST_SECRET');
  });

  it('reports explicit broker configuration failure without crashing settings', async () => {
    const context = await setup({ mcp: false });
    const report = await loadDoctorReport({
      profile: 'codex',
      env: context.env,
      json: true,
    });
    expect(report.status).toBe('error');
    expect(report.mixagents.mcpStatus).toBe('not-configured');
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'mixagents-mcp', status: 'fail' }),
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
    expect(snapshot.subagents.diagnostics.selectedRoute.id).toBe('write-b');
    expect(snapshot.mainProvider.configuredCcSwitchProviderId).not.toBe(
      snapshot.mainProvider.configuredCodexProviderId,
    );
    expect(snapshot.subagents.diagnostics.selectedRoute.id).not.toBe(
      snapshot.mainProvider.configuredCodexProviderId,
    );
  });
});
