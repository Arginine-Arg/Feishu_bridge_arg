import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { resolveSubagents } from '../../../src/agent/subagents/registry';
import { MixAgentsBrokerBackend } from '../../../src/agent/subagents/mixagents';
import {
  materializeCcSwitchBrokerRuntime,
  resolveCurrentCcSwitchCodexProvider,
} from '../../../src/integrations/cc-switch-provider';
import {
  DEFAULT_SUBAGENT_CONFIG,
  type SubagentConfig,
} from '../../../src/config/profile-schema';

const sqliteRuntime = Number(process.versions.node.split('.')[0]) >= 22 ? it : it.skip;
const require = createRequire(import.meta.url);
const fixture = fileURLToPath(new URL('../../fixtures/fake-mixagents-mcp.mjs', import.meta.url));
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

sqliteRuntime('auto-builds Broker route and credentials from the current cc-switch provider', async () => {
  const setup = await setupProviders();
  const config: SubagentConfig = {
    ...DEFAULT_SUBAGENT_CONFIG,
    mode: 'broker',
    routeMode: 'follow-cc-switch',
    readRoute: null,
    allowForkFallback: false,
    mixagents: {
      mcpCommand: process.execPath,
      mcpArgs: [fixture],
    },
  };
  const signal = AbortSignal.timeout(10_000);
  const first = await resolveSubagents({
    subagents: config,
    env: setup.env,
    cwd: setup.workspace,
    stateDir: setup.stateDir,
    codexHome: setup.codexHome,
    codexBin: '/opt/codex',
    signal,
  });
  try {
    expect(first).toMatchObject({
      kind: 'mixagents',
      route: {
        provider: 'deepseek',
        model: 'deepseek-flash',
        source: 'cc-switch',
        ccSwitchProviderId: 'default',
        available: true,
      },
    });
    expect(first.backend).toBeDefined();
    const agent = await first.backend!.createOrReuse({
      route: first.route!,
      task: 'ROUND=1 ACK=ORBIT-731',
      cwd: setup.workspace,
      scope: 'auto-route',
      access: 'read-only',
      signal,
    });
    await expect(first.backend!.wait(agent, signal)).resolves.toMatchObject({
      status: 'completed',
      text: 'result:ROUND=1 ACK=ORBIT-731',
    });
  } finally {
    await first.backend?.closeBackend?.();
  }

  const fixed = await resolveSubagents({
    subagents: {
      ...config,
      ccSwitchProviderId: 'other',
    },
    env: {
      ...setup.env,
      HTTPS_PROXY: 'http://127.0.0.1:7890',
    },
    cwd: setup.workspace,
    stateDir: setup.stateDir,
    codexHome: setup.codexHome,
    codexBin: '/opt/codex',
    signal,
  });
  try {
    expect(fixed).toMatchObject({
      kind: 'mixagents',
      route: {
        provider: 'custom',
        model: 'model-b',
        ccSwitchProviderId: 'other',
        source: 'cc-switch',
      },
    });
  } finally {
    await fixed.backend?.closeBackend?.();
  }
  const proxyState = JSON.parse(await readFile(setup.brokerState, 'utf8'));
  expect(proxyState.proxyEnvironmentNames).not.toContain('HTTPS_PROXY');

  await expect(resolveSubagents({
    subagents: {
      ...config,
      mode: 'fork',
      routeMode: 'follow-cc-switch',
      allowForkFallback: true,
    },
    env: setup.env,
    cwd: setup.workspace,
    stateDir: setup.stateDir,
    codexHome: setup.codexHome,
    codexBin: '/opt/codex',
    signal,
  })).rejects.toMatchObject({
    code: 'route-unavailable',
    message: expect.stringContaining('native Codex fork'),
  });

  await setCurrentProvider(setup, 'other');
  await expect(resolveCurrentCcSwitchCodexProvider({
    env: setup.env,
    codexHome: setup.codexHome,
  })).resolves.toMatchObject({
    summary: {
      id: 'other',
      model: 'model-b',
    },
  });
  const generatedB = await materializeCcSwitchBrokerRuntime({
    env: setup.env,
    cwd: setup.workspace,
    codexHome: setup.codexHome,
    codexBin: '/opt/codex',
    stateDir: setup.stateDir,
  });
  expect(generatedB.summary).toMatchObject({
    id: 'other',
    model: 'model-b',
  });
  const probe = new MixAgentsBrokerBackend(config, setup.env, {
    brokerConfigPath: generatedB.brokerConfigPath,
    credentials: generatedB.credentials,
    fingerprint: generatedB.fingerprint,
    route: generatedB.route,
  });
  const probeRoutes = await probe.listRoutes(signal);
  await probe.closeBackend?.();
  expect(probeRoutes).toEqual([
    expect.objectContaining({
      provider: 'custom',
      model: 'model-b',
      source: 'cc-switch',
      ccSwitchProviderId: 'other',
    }),
  ]);
  const second = await resolveSubagents({
    subagents: config,
    env: setup.env,
    cwd: setup.workspace,
    stateDir: setup.stateDir,
    codexHome: setup.codexHome,
    codexBin: '/opt/codex',
    signal,
  });
  try {
    expect(second).toMatchObject({
      kind: 'mixagents',
      route: {
        provider: 'custom',
        model: 'model-b',
        source: 'cc-switch',
        ccSwitchProviderId: 'other',
      },
    });
    expect(second.route?.id).not.toBe(first.route?.id);
  } finally {
    await second.backend?.closeBackend?.();
  }

  const brokerState = JSON.parse(await readFile(setup.brokerState, 'utf8'));
  expect(brokerState).toMatchObject({
    credentialNames: ['OPENAI_API_KEY'],
  });
  expect(JSON.stringify(brokerState)).not.toContain(setup.firstSecret);
  expect(JSON.stringify(brokerState)).not.toContain(setup.secondSecret);
  const generatedConfigPath = brokerState.brokerConfigPath as string;
  const generatedConfig = await readFile(generatedConfigPath, 'utf8');
  expect(generatedConfig).toContain('https://b.example.test/v1');
  expect(generatedConfig).not.toContain(setup.secondSecret);
});

async function setupProviders() {
  const root = await mkdtemp(join(tmpdir(), 'arg-bridge-auto-cc-switch-'));
  temporary.push(root);
  const ccHome = join(root, '.cc-switch');
  const codexHome = join(root, 'codex-home');
  const workspace = join(root, 'workspace');
  const stateDir = join(root, 'state');
  const brokerState = join(root, 'broker-state.json');
  await Promise.all([
    mkdir(ccHome, { recursive: true }),
    mkdir(codexHome, { recursive: true }),
    mkdir(workspace, { recursive: true }),
  ]);
  const firstSecret = 'sk-auto-first-secret';
  const secondSecret = 'sk-auto-second-secret';
  const databasePath = join(ccHome, 'cc-switch.db');
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => {
      exec(sql: string): void;
      prepare(sql: string): { run(...values: unknown[]): void };
      close(): void;
    };
  };
  const db = new DatabaseSync(databasePath);
  db.exec([
    'CREATE TABLE providers (id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL,',
    'settings_config TEXT NOT NULL, is_current BOOLEAN NOT NULL DEFAULT 0,',
    "provider_type TEXT, category TEXT, sort_index INTEGER, meta TEXT NOT NULL DEFAULT '{}',",
    'PRIMARY KEY (id, app_type));',
  ].join(' '));
  const insert = db.prepare(
    'INSERT INTO providers (id, app_type, name, settings_config, is_current, provider_type, sort_index) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  insert.run('default', 'codex', 'lixin', JSON.stringify({
    auth: { OPENAI_API_KEY: firstSecret },
    config: configToml('deepseek-flash', 'deepseek', 'lixin', 'https://a.example.test/v1'),
  }), 1, 'custom', 0);
  insert.run('other', 'codex', 'Provider B', JSON.stringify({
    auth: { OPENAI_API_KEY: secondSecret },
    config: configToml('model-b', 'custom', 'Provider B', 'https://b.example.test/v1'),
  }), 0, 'custom', 1);
  db.close();
  await writeFile(join(ccHome, 'settings.json'), JSON.stringify({
    currentProviderCodex: 'default',
  }), { mode: 0o600 });
  await writeFile(join(codexHome, 'config.toml'), configToml(
    'deepseek-flash',
    'deepseek',
    'lixin',
    'https://a.example.test/v1',
  ), { mode: 0o600 });
  return {
    root,
    ccHome,
    codexHome,
    workspace,
    stateDir,
    brokerState,
    firstSecret,
    secondSecret,
    env: {
      ...process.env,
      CC_SWITCH_HOME: ccHome,
      FAKE_MIXAGENTS_STATE: brokerState,
    },
  };
}

async function setCurrentProvider(
  setup: Awaited<ReturnType<typeof setupProviders>>,
  id: string,
): Promise<void> {
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => {
      prepare(sql: string): {
        run(...values: unknown[]): void;
        all(): Array<Record<string, unknown>>;
      };
      close(): void;
    };
  };
  const db = new DatabaseSync(join(setup.ccHome, 'cc-switch.db'));
  db.prepare('UPDATE providers SET is_current = CASE WHEN id = ? THEN 1 ELSE 0 END').run(id);
  db.close();
  await writeFile(join(setup.ccHome, 'settings.json'), JSON.stringify({
    currentProviderCodex: id,
  }), { mode: 0o600 });
  await writeFile(join(setup.codexHome, 'config.toml'), id === 'other'
    ? configToml('model-b', 'custom', 'Provider B', 'https://b.example.test/v1')
    : configToml('deepseek-flash', 'deepseek', 'lixin', 'https://a.example.test/v1'),
  { mode: 0o600 });
  const check = new DatabaseSync(join(setup.ccHome, 'cc-switch.db'));
  expect(check.prepare('SELECT id, is_current FROM providers ORDER BY id').all())
    .toEqual(expect.arrayContaining([
      { id: 'other', is_current: 1 },
    ]));
  check.close();
}

function configToml(
  model: string,
  provider: string,
  name: string,
  baseUrl: string,
): string {
  return [
    `model = "${model}"`,
    `model_provider = "${provider}"`,
    'preferred_auth_method = "apikey"',
    `[model_providers.${provider}]`,
    `name = "${name}"`,
    `base_url = "${baseUrl}"`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'env_key = "OPENAI_API_KEY"',
  ].join('\n');
}
