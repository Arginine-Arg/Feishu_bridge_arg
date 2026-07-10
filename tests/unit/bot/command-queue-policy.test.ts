import { describe, expect, it } from 'vitest';
import { commandPreservesPendingMessages } from '../../../src/bot/channel.js';

describe('command pending-message policy', () => {
  it('preserves queued work for read-only status commands', () => {
    expect(commandPreservesPendingMessages('/status')).toBe(true);
    expect(commandPreservesPendingMessages('/session status')).toBe(true);
    expect(commandPreservesPendingMessages('/session /status')).toBe(true);
    expect(commandPreservesPendingMessages('/help')).toBe(true);
    expect(commandPreservesPendingMessages('/ps')).toBe(true);
  });

  it('drops queued work for context-changing commands', () => {
    expect(commandPreservesPendingMessages('/new')).toBe(false);
    expect(commandPreservesPendingMessages('/stop')).toBe(false);
    expect(commandPreservesPendingMessages('/session live')).toBe(false);
    expect(commandPreservesPendingMessages('/resume')).toBe(false);
  });
});
