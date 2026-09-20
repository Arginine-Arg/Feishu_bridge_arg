import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fileStamp,
  fingerprintCredentialEnv,
  liveOwners,
  ownerDirectory,
  readHostRegistry,
  recordHost,
  recordOwner,
  sameCredentials,
  sameFingerprint,
  terminateProfileHosts,
  writeHostRegistry,
  type CodexHostEnvironmentFingerprint,
} from '../../../src/agent/structured/host-registry.js';
import { findStaleHost } from '../../../src/agent/structured/host.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function fingerprint(
  overrides: Partial<CodexHostEnvironmentFingerprint> = {},
): CodexHostEnvironmentFingerprint {
  return {
    credentials: { OPENAI_API_KEY: 'sk-a' },
    networkMode: 'inherit',
    configStamp: '1:10',
    authStamp: '2:20',
    ...overrides,
  };
}

describe('app server environment fingerprints', () => {
  it('compares credential sets order-independently', () => {
    const a = fingerprintCredentialEnv({ B: '2', A: '1' });
    const b = fingerprintCredentialEnv({ A: '1', B: '2' });

    expect(Object.keys(a)).toEqual(['A', 'B']);
    expect(sameCredentials(a, b)).toBe(true);
    expect(sameCredentials(a, { ...b, B: 'changed' })).toBe(false);
  });

  it('stores credential digests instead of token values', () => {
    const fingerprintValue = fingerprintCredentialEnv({
      OPENAI_API_KEY: 'sk-do-not-store-me',
    });

    expect(fingerprintValue.OPENAI_API_KEY).toMatch(/^sha256:[0-9a-f]{32}$/u);
    expect(JSON.stringify(fingerprintValue)).not.toContain('sk-do-not-store-me');
  });

  it('detects provider, credential, proxy-policy, and config changes', () => {
    const base = fingerprint();

    expect(sameFingerprint(base, fingerprint())).toBe(true);
    expect(sameFingerprint(base, fingerprint({ credentials: { OPENAI_API_KEY: 'sk-b' } }))).toBe(false);
    expect(sameFingerprint(base, fingerprint({ configStamp: '9:99' }))).toBe(false);
    expect(sameFingerprint(base, fingerprint({ authStamp: '9:99' }))).toBe(false);
    expect(sameFingerprint(base, fingerprint({ networkMode: 'direct' }))).toBe(false);
    expect(sameFingerprint(undefined, base)).toBe(false);
  });

  it('stamps files without reading their contents', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'host-registry-stamp-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));

    expect(fileStamp(join(dir, 'missing.toml'))).toBeUndefined();
    await writeFile(join(dir, 'config.toml'), 'model_provider = "deepseek"\n');
    const first = fileStamp(join(dir, 'config.toml'));
    expect(first).toMatch(/^\d+(\.\d+)?:\d+$/u);

    await writeFile(join(dir, 'config.toml'), 'model_provider = "openai"\n');
    expect(fileStamp(join(dir, 'config.toml'))).not.toBe(first);
  });
});

describe('app server registry bookkeeping', () => {
  it('records, replaces, and clears host entries per profile', async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'host-registry-'));
    cleanups.push(() => rm(profileDir, { recursive: true, force: true }));

    await recordHost(profileDir, {
      directory: '/run/host-a',
      pid: process.pid,
      startedAt: 1,
      binary: 'codex',
      fingerprint: fingerprint(),
    });
    await recordHost(profileDir, {
      directory: '/run/host-a',
      pid: process.pid,
      startedAt: 2,
      binary: 'codex',
      fingerprint: fingerprint({ credentials: { OPENAI_API_KEY: 'sk-b' } }),
    });
    await recordHost(profileDir, {
      directory: '/run/host-b',
      pid: process.pid,
      startedAt: 3,
      binary: 'codex',
      fingerprint: fingerprint(),
    });

    const hosts = await readHostRegistry(profileDir);
    expect(hosts).toHaveLength(2);
    expect(hosts.find((host) => host.directory === '/run/host-a')?.startedAt).toBe(2);

    await writeHostRegistry(profileDir, []);
    expect(await readHostRegistry(profileDir)).toEqual([]);
  });

  it('prunes dead owners and reports the last one leaving', async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'host-registry-owners-'));
    cleanups.push(() => rm(profileDir, { recursive: true, force: true }));

    // A PID that cannot exist, so the assertion does not race a real process.
    const deadPid = 2_147_483_647;
    await mkdir(ownerDirectory(profileDir), { recursive: true });
    await writeFile(join(ownerDirectory(profileDir), String(deadPid)), '1\n');

    // A dead marker is pruned and an excluded PID is not reported.
    expect(await liveOwners(profileDir, process.pid)).toEqual([]);

    await recordOwner(profileDir, process.pid);
    expect(await liveOwners(profileDir)).toEqual([process.pid]);
  });
});

describe('stale app server detection', () => {
  it('reuses a server whose fingerprint and owner are unchanged', async () => {
    const profileDir = await profileFixture();
    await recordOwner(profileDir, process.pid);
    await recordHost(profileDir, {
      directory: '/run/host-a',
      pid: process.pid,
      startedAt: 1,
      binary: 'codex',
      fingerprint: fingerprint(),
    });

    await expect(findStaleHost(profileDir, '/run/host-a', 'codex', fingerprint()))
      .resolves.toBeUndefined();
  });

  it('replaces a server after a cc-switch provider change', async () => {
    const profileDir = await profileFixture();
    await recordOwner(profileDir, process.pid);
    await recordHost(profileDir, {
      directory: '/run/host-a',
      pid: process.pid,
      startedAt: 1,
      binary: 'codex',
      fingerprint: fingerprint({ configStamp: '1:10', credentials: { OPENAI_API_KEY: 'sk-old' } }),
    });

    const stale = await findStaleHost(
      profileDir,
      '/run/host-a',
      'codex',
      fingerprint({ configStamp: '5:50', credentials: { OPENAI_API_KEY: 'sk-new' } }),
    );
    expect(stale).toMatchObject({ directory: '/run/host-a', reason: 'environment-changed' });
  });

  it('replaces an orphan whose every owner exited', async () => {
    const profileDir = await profileFixture();
    await recordHost(profileDir, {
      directory: '/run/host-a',
      pid: process.pid,
      startedAt: 1,
      binary: 'codex',
      fingerprint: fingerprint(),
    });

    const stale = await findStaleHost(profileDir, '/run/host-a', 'codex', fingerprint());
    expect(stale).toMatchObject({ reason: 'owner-dead' });
  });

  it('replaces a server whose process already exited', async () => {
    const profileDir = await profileFixture();
    await recordOwner(profileDir, process.pid);
    await recordHost(profileDir, {
      directory: '/run/host-a',
      pid: 0,
      startedAt: 1,
      binary: 'codex',
      fingerprint: fingerprint(),
    });

    const stale = await findStaleHost(profileDir, '/run/host-a', 'codex', fingerprint());
    expect(stale).toMatchObject({ reason: 'process-gone' });
  });

  it('ignores directories that were never recorded', async () => {
    const profileDir = await profileFixture();

    await expect(findStaleHost(profileDir, '/run/unknown', 'codex', fingerprint()))
      .resolves.toBeUndefined();
  });
});

describe('profile host termination', () => {
  it('prunes dead entries without signalling anything', async () => {
    const profileDir = await profileFixture();
    await recordHost(profileDir, {
      directory: '/run/host-dead',
      pid: 0,
      startedAt: 1,
      binary: 'codex',
      fingerprint: fingerprint(),
    });

    const terminated = await terminateProfileHosts(profileDir);

    expect(terminated).toBe(0);
    expect(await readHostRegistry(profileDir)).toEqual([]);
  });
});

async function profileFixture(): Promise<string> {
  const profileDir = await mkdtemp(join(tmpdir(), 'host-registry-fixture-'));
  cleanups.push(() => rm(profileDir, { recursive: true, force: true }));
  return profileDir;
}
