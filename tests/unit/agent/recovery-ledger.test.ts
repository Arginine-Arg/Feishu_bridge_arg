import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { RecoveryLedger } from '../../../src/agent/structured/recovery-ledger';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'recovery-ledger-')); roots.push(home);
  const a = new RecoveryLedger('thread'); const b = new RecoveryLedger('thread');
  await Promise.all([a.persistIn(home, 'provider-a'), b.persistIn(home, 'provider-a')]);
  return { home, a, b };
}

it('has one owner across two observers, profiles and native clients', async () => {
  const { a, b } = await fixture();
  const owners = await Promise.all([a.episode(3600, '503', 't1'), b.episode(3600, '503', 't1')]);
  expect(owners.filter(Boolean)).toHaveLength(1);
  const winner = owners[0] ? a : b; const loser = owners[0] ? b : a;
  const op = await winner.reserve('t1', winner.record.epoch, 0);
  expect(op?.id).toMatch(/^arg-bridge-recovery-/);
  expect(await loser.reserve('t1', loser.record.epoch, 0)).toBeUndefined();
  await winner.release();
  expect(await loser.episode(3600, '503', 't1')).toBe(true);
  expect(await loser.reserve('t1', loser.record.epoch, 0)).toBeUndefined();
});

it('keeps the original deadline and uncertain operation across restart', async () => {
  const { home, a } = await fixture();
  await a.episode(3600, '503', 't1');
  const deadline = a.record.deadline;
  const op = await a.reserve('t1', a.record.epoch, 0);
  await a.acknowledge('t1'); await a.release();
  const restarted = new RecoveryLedger('thread'); await restarted.persistIn(home, 'provider-a');
  expect(restarted.record.deadline).toBe(deadline);
  expect(restarted.record.operations.t1).toMatchObject({ id: op!.id, state: 'uncertain' });
  expect(await restarted.episode(7200, '503 again', 't2')).toBe(true);
  expect(restarted.record.deadline).toBe(deadline);
  expect(await restarted.reserve('t1', restarted.record.epoch, 0)).toBeUndefined();
  const now = vi.spyOn(Date, 'now').mockReturnValue(deadline! + 1);
  expect(await restarted.episode(7200, '503', 't2')).toBe(false);
  expect(await restarted.reserve('t2', restarted.record.epoch, 0)).toBeUndefined();
  expect(restarted.record.phase).toBe('recovery_exhausted'); now.mockRestore();
});

it('isolates old callbacks on stop/off/provider generation and never resets via on', async () => {
  const { home, a } = await fixture();
  await a.episode(3600, '503', 't1'); const epoch = a.record.epoch; const deadline = a.record.deadline;
  await a.invalidate('off'); await a.enable();
  expect(a.record.deadline).toBe(deadline);
  expect(await a.reserve('t1', epoch, 0)).toBeUndefined();
  await a.invalidate('stop'); await a.enable();
  expect(await a.episode(3600, '503', 't2')).toBe(false);
  await a.reset('user_input'); expect(await a.episode(3600, '503', 't2')).toBe(true);
  await a.release();
  const next = new RecoveryLedger('thread'); await next.persistIn(home, 'provider-b');
  expect(next.record.blocked).toBe('provider_changed');
  expect(await a.reserve('t2', a.record.epoch, 0)).toBeUndefined();
});

it('uses the same journal through CODEX_HOME symlinks', async () => {
  const { a } = await fixture();
  await a.episode(3600, '503', 't1'); await a.reset('completed');
  expect(a.record.startedAt).toBeUndefined(); expect(a.record.attempts).toBe(0);
});
