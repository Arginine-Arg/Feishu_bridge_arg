import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { acquireNativeThreadLease, registerThreadHandoffClient, releaseThreadHandoffClients } from '../../../src/agent/structured/thread-handoff';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function home() { const p = await mkdtemp(join(tmpdir(), 'handoff-test-')); cleanup.push(() => rm(p, { recursive: true, force: true })); return p; }
const unix = process.platform === 'win32' ? it.skip : it;

it('serializes concurrent native attempts across profiles and token-safe cleanup', async () => {
  const root = await home();
  const a = await acquireNativeThreadLease(root, 'thread', 'profile-a');
  await expect(acquireNativeThreadLease(root, 'thread', 'profile-b')).rejects.toThrow(/PID.*profile=profile-a/);
  await a.release();
  const b = await acquireNativeThreadLease(root, 'thread', 'profile-b');
  await a.release();
  await expect(acquireNativeThreadLease(root, 'thread', 'profile-a')).rejects.toThrow('profile-b');
  await b.release();
});

unix('asks actual idle subscribers to release and leaves unrelated threads untouched', async () => {
  const root = await home(); const released = vi.fn(async () => {}); const other = vi.fn(async () => {});
  cleanup.push(await registerThreadHandoffClient({ codexHome: root, threadId: 'target', endpoint: 'unix:///old.sock', profile: 'bot-profile', inspect: async () => {}, release: released }));
  cleanup.push(await registerThreadHandoffClient({ codexHome: root, threadId: 'other', endpoint: 'unix:///old.sock', profile: 'bot-profile', inspect: async () => {}, release: other }));
  await releaseThreadHandoffClients(root, 'target', 'unix:///old.sock');
  expect(released).toHaveBeenCalledOnce(); expect(other).not.toHaveBeenCalled();
});

unix('inspects all clients before releasing any and accurately names a live native profile', async () => {
  const root = await home(); const idleRelease = vi.fn(async () => {}); const nativeRelease = vi.fn(async () => {});
  cleanup.push(await registerThreadHandoffClient({ codexHome: root, threadId: 'target', endpoint: 'unix:///old.sock', profile: 'bot', inspect: async () => {}, release: idleRelease }));
  cleanup.push(await registerThreadHandoffClient({ codexHome: root, threadId: 'target', endpoint: 'unix:///old.sock', profile: 'actual-native', inspect: async () => { throw new Error('native TUI 仍在连接'); }, release: nativeRelease }));
  await expect(releaseThreadHandoffClients(root, 'target', 'unix:///old.sock')).rejects.toThrow(/PID.*profile=actual-native.*native TUI/);
  expect(idleRelease).not.toHaveBeenCalled(); expect(nativeRelease).not.toHaveBeenCalled();
});
