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
  it('shows cc-switch accounts and writes a provider-to-route mapping in plain flow', async () => {
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
      .mockResolvedValueOnce('provider-a')
      .mockResolvedValueOnce('read-a')
      .mockResolvedValueOnce('follow')
      .mockResolvedValueOnce('inherit-env')
      .mockResolvedValueOnce('off');
    prompts.text.mockResolvedValueOnce('MIXAGENTS_BROKER_CREDENTIALS_JSON');
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
      readRoute: null,
      allowWriteWorkers: false,
      mixagents: {
        credentialMode: 'inherit-env',
        credentialEnvKeys: ['MIXAGENTS_BROKER_CREDENTIALS_JSON'],
      },
    });
    expect(savedProfile!.rsi?.mode).toBe('off');
    const routeMap = JSON.parse(await readFile(join(xdg, 'arg-bridge', 'broker-routes.json'), 'utf8'));
    expect(routeMap).toMatchObject({
      version: 1,
      providers: {
        'provider-a': { readRoute: 'read-a' },
      },
    });
    expect(prompts.note.mock.calls.map(call => call[1])).toEqual(expect.arrayContaining([
      '步骤 1 / 5 · 自动读取主对话配置',
      '步骤 2 / 5 · 选择子代理账号',
      '步骤 3 / 5 · 子代理 Key 由谁提供',
      '步骤 4 / 5 · 项目完成证据校验',
      '步骤 5 / 5 · 保存前确认',
    ]));
    expect(JSON.stringify(prompts.note.mock.calls)).toContain('provider-a');
    expect(JSON.stringify(prompts.select.mock.calls)).toContain('read-a');
    expect(JSON.stringify(prompts.note.mock.calls)).not.toContain('sk-super-secret-value');
  });
});
