import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  materializeCcSwitchBrokerRuntime,
  resolveCurrentCcSwitchCodexProvider,
} from '../../../src/integrations/cc-switch-provider';

const sqliteRuntime = Number(process.versions.node.split('.')[0]) >= 22 ? it : it.skip;
const unixIt = process.platform === 'win32' ? it.skip : it;
const temporary: string[] = [];
const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('cc-switch provider resolver', () => {
  sqliteRuntime('resolves the selected SQLite provider into a secret-free Broker runtime', async () => {
    const setup = await sqliteSetup();
    const resolved = await resolveCurrentCcSwitchCodexProvider({
      env: setup.env,
      codexHome: setup.codexHome,
      parentProviderId: 'default',
    });
    expect(resolved.summary).toMatchObject({
      id: 'default',
      name: 'lixin',
      codexProviderId: 'deepseek',
      model: 'deepseek-flash',
      baseUrlHost: 'api.example.test',
      wireApi: 'responses',
      envKey: 'OPENAI_API_KEY',
      thirdParty: true,
      providerSwitchPending: false,
      credential: {
        status: 'present',
        sourcePath: 'settings_config.auth.OPENAI_API_KEY',
      },
    });
    expect(resolved.summary.credential.fingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(JSON.stringify(resolved.summary)).not.toContain(setup.secret);

    const runtime = await materializeCcSwitchBrokerRuntime({
      env: setup.env,
      codexHome: setup.codexHome,
      parentProviderId: 'default',
      cwd: setup.workspace,
      codexBin: '/opt/codex',
      stateDir: setup.stateDir,
    });
    expect(runtime.route).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-flash',
      source: 'cc-switch',
      ccSwitchProviderId: 'default',
      available: true,
      maxAccess: 'workspace-write',
    });
    expect(runtime.credentials).toEqual({ OPENAI_API_KEY: setup.secret });
    expect(JSON.stringify(runtime.route)).not.toContain(setup.secret);
    const brokerConfig = await readFile(runtime.brokerConfigPath, 'utf8');
    expect(brokerConfig).toContain('https://api.example.test/v1');
    expect(brokerConfig).not.toContain(setup.secret);
    const broker = JSON.parse(brokerConfig);
    expect(broker.codexBin).toContain('codex-wrapper');
    expect(broker.codexBin).not.toBe('/opt/codex');
  });

  unixIt('disables unsupported web search on the third-party Broker Codex wrapper', async () => {
    const setup = await sqliteSetup();
    const fakeCodex = join(setup.root, 'fake-codex.mjs');
    const argsFile = join(setup.root, 'fake-codex-args.json');
    await writeFile(fakeCodex, [
      '#!/usr/bin/env node',
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));`,
      '',
    ].join('\n'));
    await chmod(fakeCodex, 0o700);
    const runtime = await materializeCcSwitchBrokerRuntime({
      env: setup.env,
      codexHome: setup.codexHome,
      cwd: setup.workspace,
      codexBin: fakeCodex,
      stateDir: setup.stateDir,
    });
    const broker = JSON.parse(await readFile(runtime.brokerConfigPath, 'utf8')) as {
      codexBin: string;
    };
    await execFileAsync(broker.codexBin, ['app-server', '--stdio'], {
      env: { ...process.env, FAKE_CODEX_ARGS: argsFile },
    });
    expect(JSON.parse(await readFile(argsFile, 'utf8'))).toEqual([
      '-c',
      'web_search="disabled"',
      'app-server',
      '--stdio',
    ]);
  });

  sqliteRuntime('fails closed when the selected provider has no key', async () => {
    const setup = await sqliteSetup({ auth: {} });
    const resolved = await resolveCurrentCcSwitchCodexProvider({
      env: setup.env,
      codexHome: setup.codexHome,
    });
    expect(resolved.summary.credential).toMatchObject({
      status: 'missing',
      sourcePath: null,
    });
    await expect(materializeCcSwitchBrokerRuntime({
      env: setup.env,
      codexHome: setup.codexHome,
      cwd: setup.workspace,
      codexBin: '/opt/codex',
      stateDir: setup.stateDir,
    })).rejects.toMatchObject({
      name: 'CcSwitchProviderError',
      code: 'credential-missing',
    });
  });

  sqliteRuntime('rejects a settings/database current-provider mismatch', async () => {
    const setup = await sqliteSetup({ databaseCurrent: 'other' });
    await expect(resolveCurrentCcSwitchCodexProvider({
      env: setup.env,
      codexHome: setup.codexHome,
    })).rejects.toMatchObject({
      name: 'CcSwitchProviderError',
      code: 'provider-current-mismatch',
    });
  });

  sqliteRuntime('changes route, model, endpoint and credential fingerprint after provider switch', async () => {
    const setup = await sqliteSetup();
    const first = await materializeCcSwitchBrokerRuntime({
      env: setup.env,
      codexHome: setup.codexHome,
      cwd: setup.workspace,
      codexBin: '/opt/codex',
      stateDir: setup.stateDir,
    });
    await updateCurrentProvider(setup, 'other');
    await writeFile(setup.codexHomeConfig, configToml({
      model: 'model-b',
      provider: 'custom',
      name: 'Provider B',
      baseUrl: 'https://b.example.test/v1',
    }), { mode: 0o600 });
    const second = await materializeCcSwitchBrokerRuntime({
      env: setup.env,
      codexHome: setup.codexHome,
      cwd: setup.workspace,
      codexBin: '/opt/codex',
      stateDir: setup.stateDir,
    });
    expect(second.summary.parentProviderId).toBeNull();
    expect(second.route.model).toBe('model-b');
    expect(second.route.provider).toBe('custom');
    expect(second.route.id).not.toBe(first.route.id);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(second.credentials).toEqual({ OPENAI_API_KEY: setup.secondSecret });
  });

  it('falls back to legacy settings.json providers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arg-bridge-cc-switch-legacy-'));
    temporary.push(root);
    const ccHome = join(root, '.cc-switch');
    const workspace = join(root, 'workspace');
    const stateDir = join(root, 'state');
    await Promise.all([
      mkdir(ccHome, { recursive: true }),
      mkdir(workspace, { recursive: true }),
    ]);
    const secret = 'sk-legacy-secret-value';
    await writeFile(join(ccHome, 'settings.json'), JSON.stringify({
      currentProviderCodex: 'legacy',
      providers: {
        codex: [{
          id: 'legacy',
          name: 'Legacy Provider',
          isCurrent: true,
          settings_config: {
            auth: { OPENAI_API_KEY: secret },
            config: configToml({
              model: 'legacy-model',
              provider: 'legacy-provider',
              name: 'Legacy Provider',
              baseUrl: 'https://legacy.example.test/v1',
            }),
          },
        }],
      },
    }), { mode: 0o600 });
    const env = { ...process.env, CC_SWITCH_HOME: ccHome };
    const runtime = await materializeCcSwitchBrokerRuntime({
      env,
      cwd: workspace,
      codexBin: '/opt/codex',
      stateDir,
    });
    expect(runtime.summary).toMatchObject({
      id: 'legacy',
      name: 'Legacy Provider',
      codexProviderId: 'legacy-provider',
      model: 'legacy-model',
      source: 'legacy-json',
    });
    expect(runtime.credentials.OPENAI_API_KEY).toBe(secret);
    expect(JSON.stringify(runtime.summary)).not.toContain(secret);
  });
});

async function sqliteSetup(options: {
  auth?: Record<string, unknown>;
  databaseCurrent?: string;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'arg-bridge-cc-switch-sqlite-'));
  temporary.push(root);
  const ccHome = join(root, '.cc-switch');
  const codexHome = join(root, 'codex-home');
  const workspace = join(root, 'workspace');
  const stateDir = join(root, 'state');
  await Promise.all([
    mkdir(ccHome, { recursive: true }),
    mkdir(codexHome, { recursive: true }),
    mkdir(workspace, { recursive: true }),
  ]);
  const secret = 'sk-main-secret-value';
  const secondSecret = 'sk-second-secret-value';
  const databasePath = join(ccHome, 'cc-switch.db');
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => {
      exec(sql: string): void;
      prepare(sql: string): { run(...values: unknown[]): void };
      close(): void;
    };
  };
  const database = new DatabaseSync(databasePath);
  database.exec([
    'CREATE TABLE providers (id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL,',
    'settings_config TEXT NOT NULL, is_current BOOLEAN NOT NULL DEFAULT 0,',
    "provider_type TEXT, category TEXT, sort_index INTEGER, meta TEXT NOT NULL DEFAULT '{}',",
    'PRIMARY KEY (id, app_type));',
    'CREATE TABLE provider_endpoints (id INTEGER PRIMARY KEY, provider_id TEXT NOT NULL,',
    'app_type TEXT NOT NULL, url TEXT NOT NULL, added_at INTEGER);',
  ].join(' '));
  const insert = database.prepare(
    'INSERT INTO providers (id, app_type, name, settings_config, is_current, provider_type, category, sort_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  insert.run(
    'default',
    'codex',
    'lixin',
    JSON.stringify({
      auth: options.auth ?? { OPENAI_API_KEY: secret },
      config: configToml({
        model: 'deepseek-flash',
        provider: 'deepseek',
        name: 'lixin',
        baseUrl: 'https://api.example.test/v1',
      }),
    }),
    options.databaseCurrent === 'other' ? 0 : 1,
    'custom',
    null,
    0,
  );
  insert.run(
    'other',
    'codex',
    'Provider B',
    JSON.stringify({
      auth: { OPENAI_API_KEY: secondSecret },
      config: configToml({
        model: 'model-b',
        provider: 'custom',
        name: 'Provider B',
        baseUrl: 'https://b.example.test/v1',
      }),
    }),
    options.databaseCurrent === 'other' ? 1 : 0,
    'custom',
    null,
    1,
  );
  database.close();
  await writeFile(join(ccHome, 'settings.json'), JSON.stringify({
    currentProviderCodex: 'default',
  }), { mode: 0o600 });
  const codexHomeConfig = join(codexHome, 'config.toml');
  await writeFile(codexHomeConfig, configToml({
    model: 'deepseek-flash',
    provider: 'deepseek',
    name: 'lixin',
    baseUrl: 'https://api.example.test/v1',
  }), { mode: 0o600 });
  return {
    root,
    env: { ...process.env, CC_SWITCH_HOME: ccHome },
    codexHome,
    codexHomeConfig,
    workspace,
    stateDir,
    secret,
    secondSecret,
    databasePath,
    ccHome,
  };
}

async function updateCurrentProvider(
  setup: Awaited<ReturnType<typeof sqliteSetup>>,
  providerId: string,
): Promise<void> {
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => {
      prepare(sql: string): { run(...values: unknown[]): void };
      close(): void;
    };
  };
  const database = new DatabaseSync(setup.databasePath);
  database.prepare('UPDATE providers SET is_current = CASE WHEN id = ? THEN 1 ELSE 0 END').run(providerId);
  database.close();
  await writeFile(join(setup.ccHome, 'settings.json'), JSON.stringify({
    currentProviderCodex: providerId,
  }), { mode: 0o600 });
}

function configToml(input: {
  model: string;
  provider: string;
  name: string;
  baseUrl: string;
}): string {
  return [
    `model = "${input.model}"`,
    `model_provider = "${input.provider}"`,
    'preferred_auth_method = "apikey"',
    'model_reasoning_effort = "max"',
    `[model_providers.${input.provider}]`,
    `name = "${input.name}"`,
    `base_url = "${input.baseUrl}"`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'env_key = "OPENAI_API_KEY"',
  ].join('\n');
}
