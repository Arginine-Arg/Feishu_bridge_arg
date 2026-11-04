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
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('guided settings flow', () => {
  it.each([
    { provider: '__follow_current__', model: 'model-a-v2', effort: 'high', selected: 'provider-a', expected: 'model-a-v2' },
    { provider: 'provider-b', model: '__custom_model__', effort: 'medium', selected: 'provider-b', expected: 'custom/model-v3' },
    { provider: '__follow_current__', model: '__provider_default__', effort: 'inherit', selected: 'provider-a', expected: null },
  ])('saves provider-scoped model/effort selections: $provider $model', async ({ provider, model, effort, selected, expected }) => {
    const root = await mkdtemp(join(tmpdir(), 'arg-bridge-guided-settings-'));
    temporary.push(root);
    const ccHome = join(root, 'cc-switch');
    const xdg = join(root, 'xdg');
    await Promise.all([
      mkdir(ccHome, { recursive: true }),
      mkdir(join(xdg, 'arg-bridge'), { recursive: true }),
    ]);
    await writeFile(join(ccHome, 'settings.json'), JSON.stringify({
      currentProviderCodex: 'provider-a',
      providers: { codex: ['a', 'b'].map(id => ({
        id: `provider-${id}`,
        name: `Provider ${id}`,
        settings_config: {
          auth: { OPENAI_API_KEY: 'sk-super-secret-value' },
          config: `model = "model-${id}"\nmodel_provider = "custom"\nmodel_reasoning_effort = "max"\n` +
            `[model_providers.custom]\nbase_url = "https://example.test/v1"\n` +
            `[profiles.upgrade]\nmodel = "model-${id}-v2"\n`,
        },
      })) },
    }), { mode: 0o600 });
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
      providerOverrides: { untouched: { model: 'keep-model', reasoningEffort: 'low' } },
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
      .mockResolvedValueOnce('auto')
      .mockResolvedValueOnce(provider)
      .mockResolvedValueOnce(model)
      .mockResolvedValueOnce(effort)
      .mockResolvedValueOnce('off');
    if (model === '__custom_model__') prompts.text.mockResolvedValueOnce('custom/model-v3');
    prompts.confirm
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

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

    const savedRoot = await loadRootConfig(paths.configFile);
    const savedProfile = savedRoot?.profiles.codex;
    expect(savedProfile).toBeDefined();
    expect(savedProfile!.subagents).toMatchObject({
      mode: 'auto',
      routeMode: 'follow-cc-switch',
      ccSwitchProviderId: provider === '__follow_current__' ? null : provider,
      providerOverrides: {
        untouched: { model: 'keep-model', reasoningEffort: 'low' },
        [selected]: { model: expected, reasoningEffort: effort },
      },
      readRoute: null,
      allowWriteWorkers: true,
      mixagents: {
        credentialMode: 'inherit-env',
      },
    });
    expect(savedProfile!.rsi?.mode).toBe('off');
    await expect(readFile(join(xdg, 'arg-bridge', 'broker-routes.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(prompts.note.mock.calls.map(call => call[1])).toEqual(expect.arrayContaining([
      '步骤 1 / 5 · 自动读取主对话配置',
      '步骤 2 / 5 · 选择子代理 provider',
      '步骤 3 / 5 · 自动凭据',
      '步骤 4 / 5 · 项目完成证据校验',
      '步骤 5 / 5 · 保存前确认',
    ]));
    expect(JSON.stringify(prompts.note.mock.calls)).toContain('provider-a');
    expect(JSON.stringify(prompts.select.mock.calls)).toContain('__follow_current__');
    const modelPrompt = prompts.select.mock.calls.find(([input]) => input.message === '子代理使用哪个模型版本？')![0];
    expect(modelPrompt.options).toContainEqual({ value: selected === 'provider-a' ? 'model-a-v2' : 'model-b-v2', label: selected === 'provider-a' ? 'model-a-v2' : 'model-b-v2' });
    expect(JSON.stringify(modelPrompt)).not.toContain(selected === 'provider-a' ? 'model-b' : 'model-a');
    expect(JSON.stringify(prompts.note.mock.calls)).not.toContain('sk-super-secret-value');
    expect(await readFile(paths.configFile, 'utf8')).not.toContain('sk-super-secret-value');
  });
});
