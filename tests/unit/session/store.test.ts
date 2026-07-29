import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../../../src/session/store.js';

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('scope output delivery policy', () => {
  it('persists independently from the idle timeout and survives session reset', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-session-store-'));
    cleanups.push(dir);
    const file = join(dir, 'sessions.json');
    const store = new SessionStore(file);

    store.set('chat-1', 'session-1', '/workspace');
    store.setIdleTimeoutMinutes('chat-1', 0);
    store.setOutputMode('chat-1', 'off');
    store.clear('chat-1');
    await store.flush();

    const restored = new SessionStore(file);
    await restored.load();
    expect(restored.resumeFor('chat-1', '/workspace')).toBeUndefined();
    expect(restored.getIdleTimeoutMinutes('chat-1')).toBe(0);
    expect(restored.getOutputMode('chat-1')).toBe('off');
  });
});
