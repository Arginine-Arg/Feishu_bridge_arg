import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateLocalPoc } from '../../../src/cli/commands/migrate-local-poc';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function setup(options: { original: boolean }) {
  const root = await mkdtemp(join(tmpdir(), 'arg-bridge-poc-migrate-'));
  temporary.push(root);
  const packageDir = join(root, 'package');
  const profileDir = join(root, 'state', 'profiles', 'codex');
  await Promise.all([
    mkdir(join(packageDir, 'dist'), { recursive: true }),
    mkdir(join(profileDir, 'structured'), { recursive: true }),
  ]);
  const cli = join(packageDir, 'dist', 'cli.js');
  await writeFile(cli, '// ARG_BRIDGE_LOCAL_POC_MANAGED\npatched();\n');
  if (options.original) {
    await writeFile(`${cli}.orig`, 'clean();\n');
  }
  const sideMap = join(profileDir, 'structured', 'subagent-sides.json');
  const key = 'scope\0/workspace';
  await writeFile(sideMap, JSON.stringify({
    [key]: {
      agent: {
        agentId: 'agent-1',
        route: 'route-a',
        provider: 'provider-a',
        model: 'model-a',
        access: 'read-only',
        cwd: '/workspace',
        scope: 'scope',
        backendId: 'mixagents',
        status: 'completed',
        createdAt: 1,
      },
      route: {
        id: 'route-a',
        provider: 'provider-a',
        model: 'model-a',
        maxAccess: 'read-only',
        available: true,
        missingEnvironment: [],
        tags: ['review'],
      },
      cwd: '/workspace',
      scope: 'scope',
      updatedAt: 1,
    },
  }));
  return { root, packageDir, profileDir, cli, sideMap };
}

describe('migrate-local-poc', () => {
  it('plans recognized package and side-map migrations without writing', async () => {
    const ctx = await setup({ original: true });
    const report = await migrateLocalPoc({
      profile: 'codex',
      dryRun: true,
      packageDir: ctx.packageDir,
      env: { ...process.env, LARK_CHANNEL_HOME: join(ctx.root, 'state') },
    });
    expect(report.status).toBe('planned');
    expect(report.package.patchedFiles).toEqual([
      expect.objectContaining({
        path: ctx.cli,
        managementMarker: true,
        action: 'restore-backup',
      }),
    ]);
    expect(report.sideMap?.action).toBe('upgrade');
    expect(await readFile(ctx.cli, 'utf8')).toContain('ARG_BRIDGE_LOCAL_POC_MANAGED');
    expect(JSON.parse(await readFile(ctx.sideMap, 'utf8'))).not.toHaveProperty('version');
  });

  it('applies with backups and is idempotent', async () => {
    const ctx = await setup({ original: true });
    const env = { ...process.env, LARK_CHANNEL_HOME: join(ctx.root, 'state') };
    const applied = await migrateLocalPoc({
      profile: 'codex',
      apply: true,
      packageDir: ctx.packageDir,
      env,
    });
    expect(applied.status).toBe('applied');
    expect(await readFile(ctx.cli, 'utf8')).toBe('clean();\n');
    const map = JSON.parse(await readFile(ctx.sideMap, 'utf8'));
    expect(map.version).toBe(1);
    expect(Object.values(map.sides)[0]).toMatchObject({
      routeFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(applied.markerFile).toBeTruthy();

    const again = await migrateLocalPoc({
      profile: 'codex',
      apply: true,
      packageDir: ctx.packageDir,
      env,
    });
    expect(again.status).toBe('clean');
    expect(again.rollback).toEqual([]);
  });

  it('does not touch unknown patched files and blocks partial migration', async () => {
    const ctx = await setup({ original: false });
    const before = await readFile(ctx.sideMap, 'utf8');
    const report = await migrateLocalPoc({
      profile: 'codex',
      apply: true,
      packageDir: ctx.packageDir,
      env: { ...process.env, LARK_CHANNEL_HOME: join(ctx.root, 'state') },
    });
    expect(report.status).toBe('conflict');
    expect(report.conflicts[0]).toMatch(/no recognized original backup/i);
    expect(await readFile(ctx.cli, 'utf8')).toContain('ARG_BRIDGE_LOCAL_POC_MANAGED');
    expect(await readFile(ctx.sideMap, 'utf8')).toBe(before);
  });
});
