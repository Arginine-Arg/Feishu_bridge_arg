import { describe, expect, it } from 'vitest';
import {
  liveInteractionCard,
  liveInteractionCardForText,
  parseNativeCodexModelSelection,
  renderLiveAwareReplyCard,
} from '../../../src/bot/channel.js';
import type { AgentEvent } from '../../../src/agent/types.js';
import { initialState, reduce, type RunState } from '../../../src/card/run-state.js';
import {
  AGENT_INPUT_CALLBACK_ACTION,
  BRIDGE_CALLBACK_MARKER,
  LIVE_INPUT_CALLBACK_ACTION,
} from '../../../src/card/dispatcher.js';

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

function tags(card: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (typeof obj.tag === 'string') out.push(obj.tag);
    for (const value of Object.values(obj)) walk(value);
  };
  walk(card);
  return out;
}

describe('liveInteractionCard', () => {
  it('parses native Codex model confirmations with new reasoning levels', () => {
    expect(parseNativeCodexModelSelection('• Model changed to gpt-5.6-sol ultra')).toEqual({
      model: 'gpt-5.6-sol',
      reasoningEffort: 'ultra',
    });
    expect(parseNativeCodexModelSelection('Model changed to gpt-5.6-terra Extra high')).toEqual({
      model: 'gpt-5.6-terra',
      reasoningEffort: 'xhigh',
    });
    expect(parseNativeCodexModelSelection('Model changed to gpt-5.6-luna (reasoning max)')).toEqual({
      model: 'gpt-5.6-luna',
      reasoningEffort: 'max',
    });
    expect(parseNativeCodexModelSelection('Model changed to claude-opus-4-8 high')).toBeUndefined();
  });

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
    expect(tags(card)).toContain('button');
    expect(tags(card)).not.toContain('action');
  });

  it('renders model picker text as signed live input controls', () => {
    let n = 0;
    const card = liveInteractionCardForText(
      [
        'Select Model and Effort',
        'Access legacy models by running codex -m <model_name> or in your config.toml',
        '',
        '› 1. gpt-5.5 (current)  Frontier model for complex coding, research, and real-world work.',
        '2. gpt-5.4            Strong model for everyday coding.',
        '3. gpt-5.4-mini       Small, fast, and cost-efficient model for simpler coding tasks.',
        '4. gpt-5.3-codex      Coding-optimized model.',
        '5. gpt-5.2            Optimized for professional work and long-running agents.',
        'Press enter to confirm or esc to go back',
      ].join('\n'),
      (action) => {
        expect(action).toBe(LIVE_INPUT_CALLBACK_ACTION);
        return `picker-token-${n++}`;
      },
    );

    expect(card).toBeDefined();
    const values = buttonValues(card);
    expect(values.map((value) => value.input)).toEqual(['1', '2', '3', '4', '5', 'enter', 'esc']);
    expect(values.map((value) => value.bridge_token)).toEqual([
      'picker-token-0',
      'picker-token-1',
      'picker-token-2',
      'picker-token-3',
      'picker-token-4',
      'picker-token-5',
      'picker-token-6',
    ]);
    for (const value of values) {
      expect(value.cmd).toBe('live.input');
      expect(value[BRIDGE_CALLBACK_MARKER]).toBe(true);
    }
  });

  it('renders skills picker text as signed live input controls', () => {
    let n = 0;
    const card = liveInteractionCardForText(
      [
        'Skills',
        'Choose an action',
        '',
        '› 1. List skills            Tip: press @ to open this list directly.',
        '2. Enable/Disable Skills  Enable or disable skills.',
      ].join('\n'),
      (action) => {
        expect(action).toBe(LIVE_INPUT_CALLBACK_ACTION);
        return `skills-token-${n++}`;
      },
    );

    expect(card).toBeDefined();
    const values = buttonValues(card);
    expect(values.map((value) => value.input)).toEqual(['1', '2', 'enter', 'esc']);
    expect(values.map((value) => value.bridge_token)).toEqual([
      'skills-token-0',
      'skills-token-1',
      'skills-token-2',
      'skills-token-3',
    ]);
    for (const value of values) {
      expect(value.cmd).toBe('live.input');
      expect(value[BRIDGE_CALLBACK_MARKER]).toBe(true);
    }
  });

  it('renders picker output as controls from the main card reply path', () => {
    let n = 0;
    const card = renderLiveAwareReplyCard(
      stateFrom([
        {
          type: 'text',
          delta: [
            'Select Model and Effort',
            '1. gpt-5.5',
            '2. gpt-5.4',
            'Press enter to confirm or esc to go back',
          ].join('\n'),
        },
      ]),
      {
        signCallback: (action) => {
          expect(action).toBe(LIVE_INPUT_CALLBACK_ACTION);
          return `main-path-token-${n++}`;
        },
      },
      'live',
    );

    const values = buttonValues(card);
    expect(values.map((value) => value.cmd)).toEqual([
      'live.input',
      'live.input',
      'live.input',
      'live.input',
    ]);
    expect(values.map((value) => value.input)).toEqual(['1', '2', 'enter', 'esc']);
    expect(values.map((value) => value.bridge_token)).toEqual([
      'main-path-token-0',
      'main-path-token-1',
      'main-path-token-2',
      'main-path-token-3',
    ]);
  });

  it('renders non-live prompts as signed agent input controls', () => {
    let n = 0;
    const card = liveInteractionCardForText(
      'Do you want to proceed with applying this patch?',
      (action) => {
        expect(action).toBe(AGENT_INPUT_CALLBACK_ACTION);
        return `agent-token-${n++}`;
      },
      'agent',
    );

    expect(card).toBeDefined();
    const values = buttonValues(card);
    expect(values.map((value) => value.cmd)).toEqual(['agent.input', 'agent.input']);
    expect(values.map((value) => value.input)).toEqual(['yes', 'no']);
    expect(values.map((value) => value.bridge_token)).toEqual(['agent-token-0', 'agent-token-1']);
    for (const value of values) {
      expect(value[BRIDGE_CALLBACK_MARKER]).toBe(true);
    }
  });

  it('can skip prompts already sent as standalone interaction cards', () => {
    const text = [
      'Select Model and Effort',
      '1. gpt-5.5',
      '2. gpt-5.4',
      'Press enter to confirm or esc to go back',
    ].join('\n');
    const first = liveInteractionCardForText(text, () => 'tok');
    expect(first).toBeDefined();
    expect(liveInteractionCardForText(text, () => 'tok', 'live', new Set([`${text}\n1|2|enter|esc`]))).toBeUndefined();
  });

  it('does not convert ordinary text into a live input card', () => {
    expect(liveInteractionCardForText('哈喽，我在。有什么要我处理的任务，直接发我就行。')).toBeUndefined();
    expect(liveInteractionCardForText('处理结果：\n1. 已更新依赖\n2. 已运行测试')).toBeUndefined();
    expect(liveInteractionCardForText('The query will select rows from the table.')).toBeUndefined();
  });
});

function stateFrom(events: AgentEvent[]): RunState {
  return events.reduce((state, event) => reduce(state, event), initialState);
}
