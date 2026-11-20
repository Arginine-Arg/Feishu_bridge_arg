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
vi.mock('../../../src/integrations/provider-models', () => ({ discoverProviderModels: vi.fn(async (provider: any) => ({ models: provider.summary.configuredModels, source: 'api', checkedAt: 1 })) }));

import { runSettings } from '../../../src/cli/commands/settings';

const fixture = fileURLToPath(new URL('../../fixtures/fake-mixagents-mcp.mjs', import.meta.url));
const temporary: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('guided settings flow', () => {
  it.each([
    { provider: '__follow_current__', effort: 'high', selected: 'provider-a', priority: [], advanced: false, writable: true },
    { provider: 'provider-b', effort: 'medium', selected: 'provider-b', priority: [{ providerId: 'provider-b', models: ['model-b-v2', 'model-b'] }], advanced: false, writable: true },
    ...[false, true].map(writable => ({ provider: '__priority__', effort: 'inherit', selected: 'provider-b', priority: [{ providerId: 'provider-b', models: ['model-b-v2', 'model-b'] }, { providerId: 'provider-a', models: ['model-a'] }], advanced: true, writable })),
  ])('saves unified routing: $provider, advanced=$advanced, writable=$writable', async ({ provider, effort, selected, priority, advanced, writable }) => {
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
      providerPriority: [{ providerId: 'provider-b', models: ['model-b-v2', 'model-b'] }],
      writeRoute: 'old-independent-write-model',
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

    if (provider === '__priority__') {
      prompts.select.mockResolvedValueOnce('default').mockResolvedValueOnce('auto').mockResolvedValueOnce('__priority__')
        .mockResolvedValueOnce('provider-b').mockResolvedValueOnce('model-b-v2')
        .mockResolvedValueOnce('auto');
      prompts.multiselect.mockResolvedValueOnce(['provider-a', 'provider-b'])
        .mockResolvedValueOnce(['model-b', 'model-b-v2']).mockResolvedValueOnce(['model-a']);
    } else if (provider === 'provider-b') {
      prompts.select.mockResolvedValueOnce('default').mockResolvedValueOnce('auto').mockResolvedValueOnce('provider-b')
        .mockResolvedValueOnce('model-b-v2').mockResolvedValueOnce(effort)
        .mockResolvedValueOnce('off').mockResolvedValueOnce('all');
      prompts.multiselect.mockResolvedValueOnce(['model-b', 'model-b-v2']);
    } else prompts.select
      .mockResolvedValueOnce('default')
      .mockResolvedValueOnce('auto')
      .mockResolvedValueOnce(provider)
      .mockResolvedValueOnce(effort)
      .mockResolvedValueOnce('off')
      .mockResolvedValueOnce('all');
    prompts.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(advanced);
    if (advanced) {
      // RSI root, concurrency, wait windows, repair budget, MCP command/args.
      prompts.text.mockResolvedValueOnce('').mockResolvedValueOnce('4')
        .mockResolvedValueOnce('15').mockResolvedValueOnce('90')
        .mockResolvedValueOnce('2').mockResolvedValueOnce(process.execPath).mockResolvedValueOnce('');
      prompts.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(writable);
      prompts.select.mockResolvedValueOnce('shadow').mockResolvedValueOnce('low')
        .mockResolvedValueOnce('auto').mockResolvedValueOnce('all');
    }
    prompts.confirm.mockResolvedValueOnce(true);

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
      ccSwitchProviderId: provider === '__follow_current__' ? null : provider === '__priority__' ? 'provider-b' : provider,
      providerOverrides: {
        untouched: { model: null, reasoningEffort: 'low' },
        ...(provider === '__priority__'
          ? {}
          : { [selected]: { model: null, reasoningEffort: effort } }),
      },
      providerPriority: priority,
      readRoute: null,
      writeRoute: null,
      allowWriteWorkers: writable,
      mixagents: {
        credentialMode: 'inherit-env',
      },
    });
    expect(savedProfile!.rsi).toMatchObject({
      mode: advanced ? 'auto' : 'off', reviewerRouteMode: 'follow-cc-switch', reviewerRoute: null,
    });
    expect(savedProfile!.subagents?.providerPriority).toEqual(priority);
    expect(savedProfile!.codex?.providerRecovery).toMatchObject({ version: 2, enabled: true, continuous: false, providers: [], maxAttempts: 0, retryStallSeconds: 60, budgetSeconds: 3600 });
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
    expect(prompts.select.mock.calls.find(([input]) => input.message === '子代理使用哪个模型版本？')).toBeUndefined();
    expect(JSON.stringify(prompts.note.mock.calls)).toContain('子代理模型');
    expect(prompts.select.mock.calls.some(([input]) => /模型版本|模型 ID|可写子代理使用哪条线路|固定复核线路/.test(input.message))).toBe(false);
    expect(prompts.text.mock.calls.some(([input]) => /模型|model|route/i.test(input.message))).toBe(false);
    if (provider !== '__follow_current__') {
      const modelPrompt = prompts.multiselect.mock.calls.find(([input]) => input.message.startsWith('Provider b 使用哪些模型'))![0];
      expect(modelPrompt.initialValues).toEqual(['model-b-v2', 'model-b']);
      expect(prompts.select.mock.calls.find(([input]) => input.message === 'Provider b 优先使用哪个模型？')![0].initialValue).toBe('model-b-v2');
    }
    if (advanced) expect(JSON.stringify(prompts.note.mock.calls)).toContain('provider-b: model-b-v2 → model-b');
    expect(JSON.stringify(prompts.note.mock.calls)).not.toContain('sk-super-secret-value');
    expect(await readFile(paths.configFile, 'utf8')).not.toContain('sk-super-secret-value');
  });
});
