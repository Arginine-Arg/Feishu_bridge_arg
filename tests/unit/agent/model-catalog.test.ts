import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildModelCatalog, catalogHasValue } from '../../../src/agent/model-catalog';

const temporary: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'arg-bridge-catalog-'));
  temporary.push(root);
  const ccHome = join(root, 'cc-switch');
  const xdg = join(root, 'xdg');
  const magpie = join(xdg, 'magpie');
  await Promise.all([
    mkdir(ccHome, { recursive: true }),
    mkdir(magpie, { recursive: true }),
  ]);
  await writeFile(join(ccHome, 'settings.json'), JSON.stringify({
    currentProviderCodex: 'cc-a',
    providers: { codex: [{
      id: 'cc-a',
      name: 'CC A',
      settings_config: {
        auth: { OPENAI_API_KEY: 'sk-a' },
        config: 'model = "cc-model"\nmodel_provider = "custom"\n[model_providers.custom]\nbase_url = "https://cc.test/v1"\n',
      },
    }] },
  }), { mode: 0o600 });
  await writeFile(join(magpie, 'gateway.json'), JSON.stringify({
    addr: '127.0.0.1:3425',
    pid: process.pid,
  }));
  await writeFile(join(magpie, 'providers.json'), JSON.stringify({
    providers: [{ id: 'relay-a', name: 'Relay A', key: 'sk-a', chat: 'https://a.test' }],
    groups: [{ id: 'best-gpt', name: 'best-gpt', members: ['relay-a/gpt-6'] }],
  }));
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.includes('cc.test')) {
      return new Response(JSON.stringify({ data: [{ id: 'cc-model' }] }), { status: 200 });
    }
    return new Response(JSON.stringify({
      data: [{ id: 'relay-a/gpt-6' }, { id: 'group/best-gpt' }],
    }), { status: 200 });
  }));
  return {
    env: { ...process.env, CC_SWITCH_HOME: ccHome, XDG_CONFIG_HOME: xdg },
  };
}

describe('model catalog', () => {
  it('lists cc-switch models, Magpie models and Magpie routers', async () => {
    const { env } = await setup();
    const catalog = await buildModelCatalog('codex', env);
    const values = catalog.options.map(option => option.value);
    expect(values).toContain('cc-model');
    expect(values).toContain('relay-a/gpt-6');
    expect(values).toContain('group/best-gpt');
    expect(catalog.options.find(option => option.value === 'group/best-gpt')).toMatchObject({
      source: 'magpie-router',
      label: expect.stringContaining('Magpie 路由'),
    });
    expect(catalogHasValue(catalog, 'group/best-gpt')).toBe(true);
    expect(catalogHasValue(catalog, 'missing/model')).toBe(false);
  });

  it('keeps the static list when both sources are unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arg-bridge-catalog-empty-'));
    temporary.push(root);
    const catalog = await buildModelCatalog('codex', {
      ...process.env,
      CC_SWITCH_HOME: join(root, 'none'),
      XDG_CONFIG_HOME: join(root, 'none'),
    });
    expect(catalog.options[0]?.value).toBe('default');
    expect(catalog.notices.length).toBeGreaterThan(0);
  });
});
