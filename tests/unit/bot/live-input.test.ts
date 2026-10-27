import { describe, expect, it } from 'vitest';
import {
  effectiveLiveInputMode,
  effectiveRunIdleTimeoutMs,
} from '../../../src/bot/live-input';

describe('live input idle timeout policy', () => {
  it('leaves Broker side operations to their worker timeout', () => {
    expect(effectiveRunIdleTimeoutMs(60_000, 'side')).toBeUndefined();
    expect(effectiveRunIdleTimeoutMs(60_000, 'side-exit')).toBeUndefined();
  });

  it('keeps the conversational watchdog for main and control turns', () => {
    expect(effectiveRunIdleTimeoutMs(60_000, undefined)).toBe(60_000);
    expect(effectiveRunIdleTimeoutMs(60_000, 'command')).toBe(60_000);
    expect(effectiveRunIdleTimeoutMs(60_000, 'control')).toBe(60_000);
  });

  it('preserves a native /btw marker when the bridge route omits its mode', () => {
    expect(effectiveLiveInputMode(undefined, 'side')).toBe('side');
    expect(effectiveLiveInputMode(undefined, 'side-exit')).toBe('side-exit');
    expect(effectiveLiveInputMode('control', 'side')).toBe('control');
  });
});
