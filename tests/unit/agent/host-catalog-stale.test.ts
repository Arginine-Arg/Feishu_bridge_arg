import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hostCatalogIsStale } from '../../../src/agent/structured/native-bridge';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function setup(startedAt: number, catalogMtime: number) {
  const root = await mkdtemp(join(tmpdir(), 'arg-bridge-catalog-stale-'));
  temporary.push(root);
  const profileDir = join(root, 'profile');
  const codexHome = join(root, 'codex');
  const hostDir = join(root, 'host');
  const catalog = join(root, 'catalog.json');
  await Promise.all([
    mkdir(join(profileDir, 'structured'), { recursive: true }),
    mkdir(codexHome, { recursive: true }),
    mkdir(hostDir, { recursive: true }),
  ]);
  await writeFile(join(codexHome, 'config.toml'), `model_catalog_json = "${catalog}"\n`);
  await writeFile(catalog, '{}');
  await utimes(catalog, catalogMtime / 1000, catalogMtime / 1000);
  await writeFile(join(profileDir, 'structured', 'app-server-registry.json'), JSON.stringify({
    version: 1,
    hosts: [{
      directory: hostDir,
      pid: process.pid,
      startedAt,
      binary: 'codex',
      fingerprint: {},
    }],
  }));
  return {
    profileDir,
    host: { directory: hostDir, endpoint: `unix://${join(hostDir, 'server.sock')}`, rpc: {} as any },
    env: { ...process.env, CODEX_HOME: codexHome },
  };
}

describe('host catalog staleness', () => {
  it('is stale when the catalog was rewritten after the host started', async () => {
    const state = await setup(1_000, 2_000);
    await expect(hostCatalogIsStale(state.profileDir, state.host, state.env)).resolves.toBe(true);
  });

  it('is fresh when the host started after the catalog', async () => {
    const state = await setup(2_000, 1_000);
    await expect(hostCatalogIsStale(state.profileDir, state.host, state.env)).resolves.toBe(false);
  });

  it('is fresh when no catalog is configured', async () => {
    const state = await setup(1_000, 2_000);
    await writeFile(join(state.env.CODEX_HOME!, 'config.toml'), 'model = "x"\n');
    await expect(hostCatalogIsStale(state.profileDir, state.host, state.env)).resolves.toBe(false);
  });
});
