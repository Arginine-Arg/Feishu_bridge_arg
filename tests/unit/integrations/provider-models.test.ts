import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { discoverProviderModels } from '../../../src/integrations/provider-models';
import { materializeCcSwitchBrokerRuntime, type ResolvedCcSwitchProvider } from '../../../src/integrations/cc-switch-provider';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function provider(url = 'https://catalog.test/v1'): ResolvedCcSwitchProvider {
  return { summary: { baseUrl: url, envKey: 'API_TOKEN', envHttpHeaders: { 'X-Account': 'ACCOUNT' }, model: 'model-a', configuredModels: ['model-a'] },
    credentials: { API_TOKEN: 'private-test-key', ACCOUNT: 'private-test-account' } } as unknown as ResolvedCcSwitchProvider;
}
it('discovers authenticated models without issuing an inference request', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }, { id: 'model-a' }, { id: 'invalid name' }] })));
  expect(await discoverProviderModels(provider(), { fetch: fetcher as typeof fetch })).toMatchObject({ models: ['model-a', 'model-b'], source: 'api' });
  expect(fetcher.mock.calls).toHaveLength(1);
  const [url, init] = (fetcher.mock.calls as unknown as [URL, RequestInit][])[0]!;
  expect(String(url)).toBe('https://catalog.test/v1/models');
  expect(init.headers).toMatchObject({ Authorization: 'Bearer private-test-key', 'X-Account': 'private-test-account' });
  expect(init.redirect).toBe('error'); expect(init.body).toBeUndefined();
});
it.each([401, 429, 503])('reports HTTP %s without exposing credentials or upstream error bodies', async status => {
  await expect(discoverProviderModels(provider(), { fetch: (async () => new Response('private-test-key', { status })) as typeof fetch })).rejects.toThrow(`HTTP ${status}`);
});
it('labels the fallback clearly when no server catalogue exists', async () => {
  const found = await discoverProviderModels(provider(), { fetch: (async () => new Response('', { status: 404 })) as typeof fetch });
  expect(found).toMatchObject({ source: 'local-config', models: ['model-a'] });
  expect(found.notice).toContain('尚未验证');
});
it('bounds response size and rejects malformed model catalogues', async () => {
  await expect(discoverProviderModels(provider(), { fetch: (async () => new Response('x'.repeat(1024 * 1024 + 1))) as typeof fetch })).rejects.toThrow('1 MiB');
  await expect(discoverProviderModels(provider(), { fetch: (async () => new Response('{')) as typeof fetch })).rejects.toThrow('有效 JSON');
});
it('routes new work by provider/model order, respecting failed-route cooldown and never changing cc-switch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'priority-routes-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  let firstStatus = 503;
  const server = createServer((req, res) => {
    expect(req.url).toMatch(/\/models$/);
    if (req.url === '/a/models' && firstStatus !== 200) { res.writeHead(firstStatus); res.end(); return; }
    expect(req.headers.authorization).toBe(req.url === '/a/models' ? 'Bearer key-a' : 'Bearer key-b');
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const port = (server.address() as { port: number }).port;
  const ccHome = join(root, 'cc'); const workspace = join(root, 'project'); await mkdir(ccHome); await mkdir(workspace);
  const settings = JSON.stringify({ currentProviderCodex: 'a', providers: { codex: ['a', 'b'].map(id => ({ id, name: id, settings_config: {
    auth: { OPENAI_API_KEY: `key-${id}` }, config: `model="model-a"\nmodel_provider="custom"\n[model_providers.custom]\nbase_url="http://127.0.0.1:${port}/${id}"\nwire_api="responses"\nenv_key="OPENAI_API_KEY"`,
  } })) } });
  await writeFile(join(ccHome, 'settings.json'), settings);
  const options = { env: { ...process.env, CC_SWITCH_HOME: ccHome }, cwd: workspace, codexBin: 'codex', stateDir: join(root, 'runtime'),
    runtimePolicy: { role: 'worker' as const, webSearch: 'auto' as const, providerPriority: [{ providerId: 'a', models: ['model-a', 'model-b'] }, { providerId: 'b', models: ['model-b'] }] } };
  const fallback = await materializeCcSwitchBrokerRuntime(options);
  expect(fallback.route.ccSwitchProviderId).toBe('b'); expect(fallback.route.model).toBe('model-b');
  firstStatus = 200;
  const first = await materializeCcSwitchBrokerRuntime(options);
  expect(first.route.ccSwitchProviderId).toBe('a'); expect(first.route.model).toBe('model-a');
  await mkdir(join(root, 'runtime', 'route-health'), { recursive: true });
  await writeFile(first.healthFile!, JSON.stringify({ retryAt: Date.now() + 120000 }));
  const secondModel = await materializeCcSwitchBrokerRuntime(options);
  expect(secondModel.route.ccSwitchProviderId).toBe('a'); expect(secondModel.route.model).toBe('model-b');
  expect(await readFile(join(ccHome, 'settings.json'), 'utf8')).toBe(settings);
  expect(await readFile(first.brokerConfigPath, 'utf8')).not.toContain('key-a');
});
