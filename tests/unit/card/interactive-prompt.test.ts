import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types';
import {
  BRIDGE_PROMPT_CALLBACK_MARKER,
  buildPromptCard,
  consumeInteractivePrompts,
} from '../../../src/card/interactive-prompt';

// Recursively collect every callback button `value` object in a card.
function buttonValues(card: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (obj.tag === 'button' && Array.isArray(obj.behaviors)) {
      for (const b of obj.behaviors as Array<Record<string, unknown>>) {
        if (b.type === 'callback' && b.value && typeof b.value === 'object') {
          out.push(b.value as Record<string, unknown>);
        }
      }
    }
    for (const v of Object.values(obj)) walk(v);
  };
  walk(card);
  return out;
}

const askInput = {
  questions: [
    {
      question: 'Which caching approach?',
      header: 'Caching',
      multiSelect: false,
      options: [
        { label: 'Redis', description: 'external' },
        { label: 'In-memory', description: 'in process' },
      ],
    },
  ],
};

describe('buildPromptCard', () => {
  it('renders AskUserQuestion as a card with one signed button per option', () => {
    let n = 0;
    const card = buildPromptCard('AskUserQuestion', askInput, () => `tok-${n++}`);
    expect(card).toBeDefined();
    const values = buttonValues(card);
    expect(values).toHaveLength(2);
    expect(values.map((v) => v.answer)).toEqual(['Redis', 'In-memory']);
    for (const v of values) {
      expect(v[BRIDGE_PROMPT_CALLBACK_MARKER]).toBe(true);
      expect(v.kind).toBe('ask');
      expect(v.header).toBe('Caching');
      expect(typeof v.bridge_token).toBe('string');
    }
    // Each button gets a freshly-signed (distinct) token.
    expect(new Set(values.map((v) => v.bridge_token)).size).toBe(2);
  });

  it('renders ExitPlanMode as approve/revise buttons', () => {
    const card = buildPromptCard('ExitPlanMode', { plan: '# Do X\n1. step' }, () => 'tok');
    const values = buttonValues(card);
    expect(values.map((v) => v.decision)).toEqual(['approve', 'revise']);
    expect(values.every((v) => v.kind === 'plan')).toBe(true);
  });

  it('returns undefined for tools it does not bridge or unusable input', () => {
    expect(buildPromptCard('Bash', { command: 'ls' }, () => 't')).toBeUndefined();
    expect(buildPromptCard('AskUserQuestion', { questions: [] }, () => 't')).toBeUndefined();
    expect(buildPromptCard('AskUserQuestion', {}, () => 't')).toBeUndefined();
    expect(buildPromptCard('ExitPlanMode', { plan: '   ' }, () => 't')).toBeUndefined();
  });
});

function fakeChannel() {
  const send = vi.fn().mockResolvedValue({ messageId: 'om_x' });
  return { send } as never as { send: ReturnType<typeof vi.fn> };
}

async function* stream(events: AgentEvent[]): AsyncIterable<AgentEvent> {
  for (const e of events) yield e;
}

const deps = (channel: { send: ReturnType<typeof vi.fn> }) => ({
  channel: channel as never,
  chatId: 'oc_1',
  scope: 'oc_1',
  sendOpts: { replyTo: 'om_trigger' },
  sign: () => 'tok',
});

describe('consumeInteractivePrompts', () => {
  it('sends one card per AskUserQuestion tool_use and ignores other tools', async () => {
    const channel = fakeChannel();
    await consumeInteractivePrompts(
      stream([
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool_use', id: 't2', name: 'AskUserQuestion', input: askInput },
        { type: 'text', delta: 'hi' },
      ]),
      deps(channel),
    );
    expect(channel.send).toHaveBeenCalledTimes(1);
    const [chatId, body, opts] = channel.send.mock.calls[0]!;
    expect(chatId).toBe('oc_1');
    expect((body as { card?: unknown }).card).toBeDefined();
    expect(opts).toMatchObject({ replyTo: 'om_trigger' });
  });

  it('dedupes by tool_use id', async () => {
    const channel = fakeChannel();
    await consumeInteractivePrompts(
      stream([
        { type: 'tool_use', id: 'dup', name: 'AskUserQuestion', input: askInput },
        { type: 'tool_use', id: 'dup', name: 'AskUserQuestion', input: askInput },
      ]),
      deps(channel),
    );
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it('never throws when the card send fails', async () => {
    const channel = fakeChannel();
    channel.send.mockRejectedValueOnce(new Error('The message was withdrawn'));
    await expect(
      consumeInteractivePrompts(
        stream([{ type: 'tool_use', id: 't', name: 'AskUserQuestion', input: askInput }]),
        deps(channel),
      ),
    ).resolves.toBeUndefined();
  });
});
