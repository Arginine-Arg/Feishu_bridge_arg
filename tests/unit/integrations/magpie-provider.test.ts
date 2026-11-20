import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  discoverMagpieModels,
  readMagpieProviderCatalog,
  resolveMagpieProvider,
} from '../../../src/integrations/magpie-provider';
import { materializeCcSwitchBrokerRuntime } from '../../../src/integrations/cc-switch-provider';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function setup(options: { pid?: number; providers?: unknown; models?: string[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'arg-bridge-magpie-'));
  temporary.push(root);
  const config = join(root, 'magpie');
  const codexHome = join(root, 'codex');
  const workspace = join(root, 'workspace');
  await Promise.all([
    mkdir(config, { recursive: true }),
    mkdir(codexHome, { recursive: true }),
    mkdir(workspace, { recursive: true }),
  ]);
  await writeFile(join(config, 'gateway.json'), JSON.stringify({
    addr: '127.0.0.1:3425',
    pid: options.pid ?? process.pid,
  }));
  await writeFile(join(config, 'providers.json'), JSON.stringify({
    providers: options.providers ?? [
      { id: 'relay-a', name: 'Relay A', key: 'sk-a', chat: 'https://a.test' },
      { id: 'relay-b', name: 'Relay B', key: 'sk-b', chat: 'https://b.test' },
    ],
  }));
  await writeFile(join(codexHome, 'config.toml'), 'model = "relay-b/claude-sonnet"\n');
  const models = options.models ?? [
    'relay-a/gpt-6',
    'relay-a/claude-opus',
    'relay-b/claude-sonnet',
  ];
  const fetch = (async () => new Response(JSON.stringify({
    data: models.map(id => ({ id, context_window: 200_000 })),
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof globalThis.fetch;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: root,
    CODEX_HOME: codexHome,
  };
  return { root, config, codexHome, workspace, env, fetch };
}

describe('magpie provider catalog', () => {
  it('groups exposed models by provider and marks the current Codex model', async () => {
    const setupState = await setup();
    const catalog = await readMagpieProviderCatalog(setupState.env, { fetch: setupState.fetch });
    expect(catalog.gateway.baseUrl).toBe('http://127.0.0.1:3425/v1');
    expect(catalog.providers).toEqual([
      { id: 'relay-a', name: 'Relay A', models: ['relay-a/gpt-6', 'relay-a/claude-opus'], current: false },
      { id: 'relay-b', name: 'Relay B', models: ['relay-b/claude-sonnet'], current: true },
    ]);
  });

  it('reports a dead gateway instead of silently falling back', async () => {
    const setupState = await setup({ pid: 2_147_483_000 });
    await expect(readMagpieProviderCatalog(setupState.env, { fetch: setupState.fetch }))
      .rejects.toMatchObject({ code: 'magpie-unavailable' });
  });

  it('reports a missing provider file', async () => {
    const setupState = await setup();
    await rm(join(setupState.config, 'providers.json'));
    await expect(readMagpieProviderCatalog(setupState.env, { fetch: setupState.fetch }))
      .rejects.toMatchObject({ code: 'magpie-unavailable' });
  });

  it('discovers only the selected provider models', async () => {
    const setupState = await setup();
    await expect(discoverMagpieModels('relay-a', setupState.env, { fetch: setupState.fetch }))
      .resolves.toEqual(['relay-a/gpt-6', 'relay-a/claude-opus']);
  });
});

describe('magpie provider resolution', () => {
  it('resolves the current provider and model through the local gateway', async () => {
    const setupState = await setup();
    const resolved = await resolveMagpieProvider({ env: setupState.env, fetch: setupState.fetch });
    expect(resolved.summary).toMatchObject({
      id: 'relay-b',
      source: 'magpie',
      codexProviderId: 'magpie',
      model: 'relay-b/claude-sonnet',
      baseUrl: 'http://127.0.0.1:3425/v1',
      wireApi: 'responses',
      envKey: 'MAGPIE_API_KEY',
      credential: { status: 'present' },
    });
    expect(resolved.credentials).toEqual({ MAGPIE_API_KEY: 'magpie' });
  });

  it('honours an explicit provider and model', async () => {
    const setupState = await setup();
    const resolved = await resolveMagpieProvider({
      env: setupState.env,
      providerId: 'relay-a',
      model: 'relay-a/claude-opus',
      fetch: setupState.fetch,
    });
    expect(resolved.summary.id).toBe('relay-a');
    expect(resolved.summary.model).toBe('relay-a/claude-opus');
  });

  it('writes a magpie Broker route without cc-switch credentials', async () => {
    const setupState = await setup();
    const runtime = await materializeCcSwitchBrokerRuntime({
      env: setupState.env,
      source: 'magpie',
      fetch: setupState.fetch,
      providerId: 'relay-a',
      cwd: setupState.workspace,
      codexBin: '/opt/codex',
      stateDir: join(setupState.root, 'state'),
      runtimePolicy: {
        role: 'worker',
        webSearch: 'auto',
        source: 'magpie',
        providerOverrides: { 'relay-a': { model: 'relay-a/gpt-6', reasoningEffort: 'inherit' } },
      },
    });
    expect(runtime.route).toMatchObject({
      id: expect.stringMatching(/^magpie-/u),
      source: 'magpie',
      provider: 'magpie',
      model: 'relay-a/gpt-6',
      ccSwitchProviderId: 'relay-a',
    });
    expect(runtime.credentials).toEqual({ MAGPIE_API_KEY: 'magpie' });
    const config = JSON.parse(await (await import('node:fs/promises')).readFile(runtime.brokerConfigPath, 'utf8'));
    expect(config.routes[runtime.route.id]).toMatchObject({
      baseUrl: 'http://127.0.0.1:3425/v1',
      envKey: 'MAGPIE_API_KEY',
      source: 'magpie',
    });
  });
});
