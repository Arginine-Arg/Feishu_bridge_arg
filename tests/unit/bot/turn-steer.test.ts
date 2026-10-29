import { describe, expect, it } from 'vitest';
import type { RunHandle } from '../../../src/bot/active-runs';
import {
  mainTurnSteerAvailability,
  parseSteerCommand,
} from '../../../src/bot/turn-steer';

function handle(overrides: Partial<RunHandle> = {}): RunHandle {
  return {
    run: {
      runId: 'run-1',
      events: (async function* () {})(),
      stop: async () => {},
      waitForExit: async () => true,
      steer: async () => ({ status: 'steered' }),
    },
    interrupted: false,
    detached: false,
    stopRequested: false,
    ...overrides,
  };
}

describe('explicit turn steering', () => {
  it('parses only the explicit /steer prefix and removes it from the body', () => {
    expect(parseSteerCommand('/steer add the missing regression test')).toEqual({
      text: 'add the missing regression test',
    });
    expect(parseSteerCommand('/STEER\nsummarize current progress')).toEqual({
      text: 'summarize current progress',
    });
    expect(parseSteerCommand('/steer')).toEqual({ text: '' });
    expect(parseSteerCommand('/steering is not this command')).toBeUndefined();
    expect(parseSteerCommand('ordinary queued text')).toBeUndefined();
  });

  it('fails closed when side, stopping, or unsupported runs own the scope', () => {
    expect(mainTurnSteerAvailability({
      get: () => undefined,
      getSide: () => handle(),
    }, 'scope')).toEqual({ available: false, reason: 'side-active' });

    expect(mainTurnSteerAvailability({
      get: () => undefined,
      getSide: () => undefined,
    }, 'scope')).toEqual({ available: false, reason: 'no-active-main' });

    expect(mainTurnSteerAvailability({
      get: () => handle({ stopRequested: true }),
      getSide: () => undefined,
    }, 'scope')).toEqual({ available: false, reason: 'run-stopping' });

    const unsupported = handle();
    unsupported.run = { ...unsupported.run, steer: undefined };
    expect(mainTurnSteerAvailability({
      get: () => unsupported,
      getSide: () => undefined,
    }, 'scope')).toEqual({ available: false, reason: 'provider-unsupported' });
  });

  it('returns only an active main run with a steer capability', () => {
    const active = handle();
    expect(mainTurnSteerAvailability({
      get: () => active,
      getSide: () => undefined,
    }, 'scope')).toEqual({ available: true, handle: active });
  });

  it('uses the backend capability to report provider and terminal failures before sending', () => {
    const providerBlocked = handle();
    providerBlocked.run = {
      ...providerBlocked.run,
      steerCapability: () => ({
        available: false,
        kind: 'provider',
        reason: 'third-party provider cannot steer',
      }),
    };
    expect(mainTurnSteerAvailability({
      get: () => providerBlocked,
      getSide: () => undefined,
    }, 'scope')).toEqual({
      available: false,
      reason: 'provider-unsupported',
      detail: 'third-party provider cannot steer',
    });

    const terminalBusy = handle();
    terminalBusy.run = {
      ...terminalBusy.run,
      steerCapability: () => ({
        available: false,
        kind: 'terminal',
        reason: 'composer contains a draft',
      }),
    };
    expect(mainTurnSteerAvailability({
      get: () => terminalBusy,
      getSide: () => undefined,
    }, 'scope')).toEqual({
      available: false,
      reason: 'backend-unavailable',
      detail: 'composer contains a draft',
    });
  });
});
