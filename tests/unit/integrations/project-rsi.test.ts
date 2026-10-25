import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  discoverProjectRsi,
  projectRsiStatus,
  verifyFreshRsiRun,
  writeRsiReviewEvidence,
} from '../../../src/integrations/project-rsi';
import { DEFAULT_RSI_CONFIG } from '../../../src/config/profile-schema';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function projectWithRun(options: {
  receiptHash?: string;
  manifestTime: number;
  receiptTime: number;
}) {
  const parent = await mkdtemp(join(tmpdir(), 'arg-bridge-rsi-'));
  temporary.push(parent);
  const projectRoot = join(parent, 'project');
  const configDir = join(projectRoot, '.project-rsi');
  const validator = join(configDir, 'project_rsi.py');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'config.json'), JSON.stringify({
    version: 1,
    validator: { path: '.project-rsi/project_rsi.py' },
  }), { mode: 0o600 });
  await writeFile(validator, '#!/usr/bin/env python3\n', { mode: 0o700 });
  const runId = 'run-001';
  const runDir = join(projectRoot, '.agent', 'rsi', 'runs', runId);
  await mkdir(runDir, { recursive: true });
  const manifest = `${JSON.stringify({
    runId,
    projectRoot,
    threadId: 'thread-1',
    turnId: 'turn-1',
    taskHash: 'task-hash-1',
    outcome: 'success',
  }, null, 2)}\n`;
  const manifestPath = join(runDir, 'manifest.json');
  await writeFile(manifestPath, manifest, { mode: 0o600 });
  const manifestHash = createHash('sha256').update(manifest).digest('hex');
  await writeFile(join(runDir, 'validator.json'), JSON.stringify({
    runId,
    manifestSha256: options.receiptHash ?? manifestHash,
    passed: true,
    exitCode: 0,
  }), { mode: 0o600 });
  await utimes(manifestPath, options.manifestTime, options.manifestTime);
  await utimes(join(runDir, 'validator.json'), options.receiptTime, options.receiptTime);
  return { parent, projectRoot, runDir, runId, configDir };
}

describe('Project RSI adapter', () => {
  it('discovers only initialized canonical projects and never initializes one', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'arg-bridge-rsi-empty-'));
    temporary.push(parent);
    const project = join(parent, 'project');
    await mkdir(join(project, 'src'), { recursive: true });
    await expect(discoverProjectRsi(join(project, 'src')))
      .resolves.toBeUndefined();
    await expect(discoverProjectRsi(process.cwd(), '/')).resolves.toBeUndefined();
  });

  it('accepts only a fresh manifest with a matching, fresh validator receipt', async () => {
    const now = Math.floor(Date.now() / 1000);
    const setup = await projectWithRun({
      manifestTime: now,
      receiptTime: now + 1,
    });
    const project = await discoverProjectRsi(setup.projectRoot, setup.projectRoot);
    expect(project).toBeDefined();
    const canonicalRoot = await realpath(setup.projectRoot);
    const result = await verifyFreshRsiRun(project!, (now - 2) * 1000);
    expect(result).toMatchObject({
      ok: true,
      runId: setup.runId,
      projectRoot: canonicalRoot,
    });
    const status = await projectRsiStatus({
      ...DEFAULT_RSI_CONFIG,
      projectRoot: setup.projectRoot,
    }, setup.projectRoot);
    expect(status.initialized).toBe(true);
    expect(status.error).toBeUndefined();
    expect(['available', 'unknown']).toContain(status.validator);
    expect(status.latestRun?.runId).toBe(setup.runId);
    expect(status.latestRun?.validated).toBe(true);
  });

  it('rejects stale manifests, stale receipts, fake hashes, and future turn boundaries', async () => {
    const now = Math.floor(Date.now() / 1000);
    const stale = await projectWithRun({
      manifestTime: now - 20,
      receiptTime: now - 19,
    });
    let project = await discoverProjectRsi(stale.projectRoot, stale.projectRoot);
    await expect(verifyFreshRsiRun(project!, (now - 10) * 1000))
      .resolves.toMatchObject({ ok: false });

    const staleReceipt = await projectWithRun({
      manifestTime: now,
      receiptTime: now - 1,
    });
    project = await discoverProjectRsi(staleReceipt.projectRoot, staleReceipt.projectRoot);
    await expect(verifyFreshRsiRun(project!, (now - 2) * 1000))
      .resolves.toMatchObject({ ok: false });

    const fake = await projectWithRun({
      manifestTime: now,
      receiptTime: now + 1,
      receiptHash: '0'.repeat(64),
    });
    project = await discoverProjectRsi(fake.projectRoot, fake.projectRoot);
    await expect(verifyFreshRsiRun(project!, (now - 2) * 1000))
      .resolves.toMatchObject({ ok: false });
    await expect(verifyFreshRsiRun(project!, (now + 30) * 1000))
      .resolves.toMatchObject({ ok: false });
  });

  it('binds fresh evidence to the project, thread and task hash', async () => {
    const now = Math.floor(Date.now() / 1000);
    const setup = await projectWithRun({ manifestTime: now, receiptTime: now + 1 });
    const project = await discoverProjectRsi(setup.projectRoot, setup.projectRoot);
    await expect(verifyFreshRsiRun(project!, {
      turnStartedAt: (now - 2) * 1000,
      threadId: 'thread-1',
      turnId: 'turn-1',
      taskHash: 'task-hash-1',
    })).resolves.toMatchObject({ ok: true, runId: setup.runId });
    await expect(verifyFreshRsiRun(project!, {
      turnStartedAt: (now - 2) * 1000,
      threadId: 'thread-other',
      taskHash: 'task-hash-1',
    })).resolves.toMatchObject({ ok: false });
    await expect(verifyFreshRsiRun(project!, {
      turnStartedAt: (now - 2) * 1000,
      threadId: 'thread-1',
      taskHash: 'task-hash-other',
    })).resolves.toMatchObject({ ok: false });
  });

  it('records reviewer identity and hashes redacted response evidence', async () => {
    const now = Math.floor(Date.now() / 1000);
    const setup = await projectWithRun({ manifestTime: now, receiptTime: now + 1 });
    const path = await writeRsiReviewEvidence(setup.runDir, {
      route: 'read-a',
      provider: 'provider-a',
      model: 'model-a',
      access: 'read-only',
      agentId: 'agent-1',
      verdict: 'approve',
      response: 'reviewed; token=super-secret-value',
      startedAt: now * 1000,
      completedAt: (now + 1) * 1000,
    });
    const body = JSON.parse(await readFile(path, 'utf8'));
    expect(body).toMatchObject({
      route: 'read-a',
      access: 'read-only',
      agentId: 'agent-1',
      verdict: 'approve',
    });
    expect(body.response).not.toContain('super-secret-value');
    expect(body.responseHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
