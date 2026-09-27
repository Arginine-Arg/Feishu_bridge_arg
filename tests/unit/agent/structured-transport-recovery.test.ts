import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexStructuredSession } from '../../../src/agent/structured/codex.js';
import { StructuredAdapter, isTransportUnavailable } from '../../../src/agent/structured/adapter.js';
import type { AgentEvent } from '../../../src/agent/types.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('structured transport recovery', () => {
  it('classifies rejected requests as retryable and timeouts as fatal', () => {
    expect(isTransportUnavailable(new Error('Server is draining; retry after reconnecting'))).toBe(true);
    expect(isTransportUnavailable(new Error('Codex App Server connection closed; input will not be replayed'))).toBe(true);
    expect(isTransportUnavailable(new Error('RPC connection is not open'))).toBe(true);
    expect(isTransportUnavailable(new Error('RPC turn/start timed out; outcome unknown, not retried'))).toBe(false);
    expect(isTransportUnavailable(new Error('some other failure'))).toBe(false);
  });

  it('rebuilds the session and re-sends a turn that the server rejected before starting it', async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'transport-recovery-'));
    cleanups.push(() => rm(profileDir, { recursive: true, force: true }));
    const adapter = new StructuredAdapter({ kind: 'codex', binary: '/nonexistent', profileDir });
    const internals = adapter as unknown as {
      sessions: Map<string, unknown>;
      createSession(scope: string, options: unknown, bound?: unknown): Promise<unknown>;
    };

    const submissions: string[] = [];
    const makeSession = (endpoint: string, failFirst: boolean) => {
      const session = new CodexStructuredSession('thread-1', endpoint, aliveRpc());
      session.submit = async () => {
        submissions.push(endpoint);
        if (failFirst && submissions.length === 1) {
          throw new Error('Server is draining; retry after reconnecting');
        }
      };
      return session;
    };

    const view = fakeView();
    internals.sessions.set('scope-1', { main: makeSession('unix:///old.sock', true), view, cwd: '/workspace' });
    internals.createSession = async () => ({
      main: makeSession('unix:///new.sock', false),
      view: fakeView(),
      cwd: '/workspace',
    });

    const events: AgentEvent[] = [];
    for await (const event of adapter.run({
      runId: 'run-1',
      scopeId: 'scope-1',
      cwd: '/workspace',
      prompt: 'hello',
    }).events) events.push(event);

    // The prompt reached the replacement server, and the first (rejected)
    // attempt was not treated as a delivered turn.
    expect(submissions).toEqual(['unix:///old.sock', 'unix:///new.sock']);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.some((event) => event.type === 'done')).toBe(true);
  });

  it('does not retry when a turn may already be running', async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'transport-no-retry-'));
    cleanups.push(() => rm(profileDir, { recursive: true, force: true }));
    const adapter = new StructuredAdapter({ kind: 'codex', binary: '/nonexistent', profileDir });
    const internals = adapter as unknown as {
      sessions: Map<string, unknown>;
      createSession(...args: unknown[]): Promise<unknown>;
    };

    const session = new CodexStructuredSession('thread-1', 'unix:///old.sock', aliveRpc());
    // A recorded turn means the request was accepted before the channel died.
    (session as unknown as { turnId: string }).turnId = 'turn-1';
    let submissions = 0;
    session.submit = async () => {
      submissions += 1;
      throw new Error('Server is draining; retry after reconnecting');
    };
    internals.sessions.set('scope-2', { main: session, view: fakeView(), cwd: '/workspace' });
    let rebuilt = 0;
    internals.createSession = async () => {
      rebuilt += 1;
      return { main: session, view: fakeView(), cwd: '/workspace' };
    };

    const events: AgentEvent[] = [];
    for await (const event of adapter.run({
      runId: 'run-2',
      scopeId: 'scope-2',
      cwd: '/workspace',
      prompt: 'hello',
    }).events) events.push(event);

    expect(submissions).toBe(1);
    expect(rebuilt).toBe(0);
    expect(events.some((event) => event.type === 'error')).toBe(true);
  });
});

function aliveRpc(): any {
  return {
    closed: false,
    failureReason: undefined,
    on: () => {},
    off: () => {},
    request: async () => ({}),
    notify: () => {},
    close: () => {},
  };
}

function fakeView(): any {
  return {
    status: () => ({ state: 'none' }),
    event: () => {},
    start: async () => {},
    close: async () => {},
    dispose: async () => {},
    ensureNative: async () => {},
  };
}
