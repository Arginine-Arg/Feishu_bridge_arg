import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveRootConfig, createRootConfig, loadRootConfig } from '../../../src/config/profile-store';
import {
  createDefaultProfileConfig,
  DEFAULT_SUBAGENT_CONFIG,
} from '../../../src/config/profile-schema';
import { resolveAppPaths } from '../../../src/config/app-paths';

const prompts = vi.hoisted(() => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  select: vi.fn(),
  multiselect: vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  text: vi.fn(),
  confirm: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn(() => false),
}));

vi.mock('@clack/prompts', () => prompts);

import { runSettings } from '../../../src/cli/commands/settings';

const fixture = fileURLToPath(new URL('../../fixtures/fake-mixagents-mcp.mjs', import.meta.url));
const temporary: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('guided settings with Magpie', () => {
  it('saves a Magpie provider and model priority without cc-switch credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arg-bridge-magpie-settings-'));
    temporary.push(root);
    const ccHome = join(root, 'cc-switch');
    const xdg = join(root, 'xdg');
    const magpie = join(xdg, 'magpie');
    await Promise.all([
      mkdir(ccHome, { recursive: true }),
      mkdir(join(xdg, 'arg-bridge'), { recursive: true }),
      mkdir(magpie, { recursive: true }),
    ]);
    await writeFile(join(ccHome, 'settings.json'), JSON.stringify({
      currentProviderCodex: 'provider-a',
      providers: { codex: [{
        id: 'provider-a',
        name: 'Provider A',
        settings_config: {
          auth: { OPENAI_API_KEY: 'sk-super-secret-value' },
          config: 'model = "model-a"\nmodel_provider = "custom"\n[model_providers.custom]\nbase_url = "https://example.test/v1"\n',
        },
      }] },
    }), { mode: 0o600 });
    await writeFile(join(magpie, 'gateway.json'), JSON.stringify({
      addr: '127.0.0.1:3425',
      pid: process.pid,
    }));
    await writeFile(join(magpie, 'providers.json'), JSON.stringify({
      providers: [
        { id: 'relay-a', name: 'Relay A', key: 'sk-a', chat: 'https://a.test' },
        { id: 'relay-b', name: 'Relay B', key: 'sk-b', chat: 'https://b.test' },
      ],
    }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [
        { id: 'relay-a/gpt-6' },
        { id: 'relay-a/claude-opus' },
        { id: 'relay-b/claude-sonnet' },
      ],
    }), { status: 200 })));
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
      mode: 'auto',
      mixagents: {
        mcpCommand: process.execPath,
        mcpArgs: [fixture],
        credentialMode: 'inherit-env',
        credentialEnvKeys: ['FAKE_MIXAGENTS_STATE', 'MIXAGENTS_TEST_SECRET'],
      },
    };
    profile.rsi = {
      mode: 'off',
      projectRoot: null,
      reviewerRouteMode: 'follow-cc-switch',
      reviewerRoute: null,
      maxRepairRounds: 2,
      repairTimeoutMs: 600_000,
    };
    await saveRootConfig(createRootConfig('codex', profile), paths.configFile);

    prompts.select
      .mockResolvedValueOnce('default')
      .mockResolvedValueOnce('auto')
      .mockResolvedValueOnce('magpie')
      .mockResolvedValueOnce('__priority__')
      .mockResolvedValueOnce('relay-b')
      .mockResolvedValueOnce('relay-a/gpt-6')
      .mockResolvedValueOnce('auto')
      .mockResolvedValueOnce('all');
    prompts.multiselect
      .mockResolvedValueOnce(['relay-a', 'relay-b'])
      .mockResolvedValueOnce(['relay-b/claude-sonnet'])
      .mockResolvedValueOnce(['relay-a/gpt-6', 'relay-a/claude-opus']);
    prompts.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    prompts.text.mockResolvedValueOnce('');

    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    try {
      await runSettings({ profile: 'codex', env });
    } finally {
      if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
      if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
    }

    const saved = (await loadRootConfig(paths.configFile))?.profiles.codex;
    expect(saved?.subagents).toMatchObject({
      routeMode: 'follow-magpie',
      magpieProviderId: 'relay-b',
      ccSwitchProviderId: null,
      providerPriority: [
        { providerId: 'relay-b', models: ['relay-b/claude-sonnet'] },
        { providerId: 'relay-a', models: ['relay-a/gpt-6', 'relay-a/claude-opus'] },
      ],
      readRoute: null,
      writeRoute: null,
    });
    expect(saved?.rsi).toMatchObject({ reviewerRouteMode: 'follow-magpie' });
    expect(JSON.stringify(prompts.note.mock.calls)).toContain('Magpie');
    expect(JSON.stringify(prompts.note.mock.calls)).not.toContain('sk-super-secret-value');
    expect(await readFile(paths.configFile, 'utf8')).not.toContain('sk-super-secret-value');
  });
});
