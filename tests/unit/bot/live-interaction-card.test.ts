import { describe, expect, it } from 'vitest';
import { liveInteractionCard } from '../../../src/bot/channel.js';
import { BRIDGE_CALLBACK_MARKER, LIVE_INPUT_CALLBACK_ACTION } from '../../../src/card/dispatcher.js';

function buttonValues(card: unknown): Array<Record<string, unknown>> {
  const values: Array<Record<string, unknown>> = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (obj.tag === 'button' && Array.isArray(obj.behaviors)) {
      for (const behavior of obj.behaviors as Array<Record<string, unknown>>) {
        if (behavior.type === 'callback' && behavior.value && typeof behavior.value === 'object') {
          values.push(behavior.value as Record<string, unknown>);
        }
      }
    }
    for (const value of Object.values(obj)) walk(value);
  };
  walk(card);
  return values;
}

describe('liveInteractionCard', () => {
  it('signs each live input button as a bridge callback', () => {
    let n = 0;
    const card = liveInteractionCard(
      {
        signature: 'model-picker',
        prompt: 'Select Model and Effort\n1. gpt-5.5\n2. gpt-5.4\nPress enter to confirm or esc to go back',
        buttons: [
          { label: '1', input: '1' },
          { label: 'enter', input: 'enter' },
          { label: 'esc', input: 'esc' },
        ],
      },
      (action) => {
        expect(action).toBe(LIVE_INPUT_CALLBACK_ACTION);
        return `tok-${n++}`;
      },
    );

    const values = buttonValues(card);
    expect(values).toHaveLength(3);
    expect(values.map((value) => value.input)).toEqual(['1', 'enter', 'esc']);
    expect(values.map((value) => value.bridge_token)).toEqual(['tok-0', 'tok-1', 'tok-2']);
    for (const value of values) {
      expect(value.cmd).toBe('live.input');
      expect(value[BRIDGE_CALLBACK_MARKER]).toBe(true);
    }
  });
});
