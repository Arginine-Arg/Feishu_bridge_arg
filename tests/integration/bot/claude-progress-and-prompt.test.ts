/**
 * Integration tests covering the two Claude-side bugs fixed in this release:
 *
 * 1. Long-running tool calls previously appeared to freeze the streaming card
 *    because the SDK Throttle (400ms) absorbs redundant PATCH calls and the
 *    rendered card JSON was byte-identical between tool_use and tool_result.
 *    The progress heartbeat inside `processAgentStream` now re-renders the
 *    card every `progressHeartbeatMs` with the running tool's elapsed time.
 *
 * 2. When Claude pauses for input (AskUserQuestion / ExitPlanMode tool_use),
 *    `consumeInteractivePrompts` must emit a Feishu callback card. Existing
 *    unit tests cover the synthetic in-line input shape; these tests
 *    exercise the real Claude stream-json fixtures end-to-end.
 *
 * Both bugs affected both Claude and Codex (the heartbeats and prompt
 * bridging live in shared code paths), so the same tests also serve as
 * regression coverage for the Codex path.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translateEvent } from '../../../src/agent/claude/stream-json';
import type { AgentEvent } from '../../../src/agent/types';
import { renderCard } from '../../../src/card/run-renderer';
import { initialState, reduce, type RunState } from '../../../src/card/run-state';
import {
  BRIDGE_PROMPT_CALLBACK_MARKER,
  consumeInteractivePrompts,
} from '../../../src/card/interactive-prompt';
import type { LarkChannel } from '@larksuite/channel';

function makeStateFromEvents(events: AgentEvent[]): RunState {
  return events.reduce((state, event) => reduce(state, event), initialState);
}

// Find the footer note element in a rendered card. Tool panel headers also
// start with icons (✅/❌/⏳), so we match the bare footer prefixes only.
function findFooter(card: object): string | undefined {
  const elements = (
    card as { body?: { elements?: Array<{ content?: string }> } }
  ).body?.elements;
  return elements?.find(
    (el) => typeof el.content === 'string' && /^(🧠|🧰|✍️) /.test(el.content),
  )?.content;
}

describe('Claude long-task progress and interactive prompt integration', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('progress heartbeat (frozen-card fix)', () => {
    it('renders an elapsed-time suffix once a tool has been running', () => {
      const opened = makeStateFromEvents([
        { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'sleep 30' } },
      ]);
      // Heartbeat tick mutates currentToolElapsedMs but the tool is still running,
      // so the footer should carry the suffix.
      const withElapsed: RunState = { ...opened, currentToolElapsedMs: 194_000 };
      const card = renderCard(withElapsed);
      expect(findFooter(card)).toBe('🧰 正在调用工具 · 已运行 3 分 14 秒');
    });

    it('drops the elapsed suffix when the tool_result clears the tool-running state', () => {
      const closed = makeStateFromEvents([
        { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'sleep 30' } },
        { type: 'tool_result', id: 'tool-1', output: 'done', isError: false },
        { type: 'done', terminationReason: 'normal' },
      ]);
      // The reducer clears currentToolElapsedMs on tool_result; renderer omits the suffix.
      expect(closed.currentToolElapsedMs).toBeUndefined();
      const card = renderCard(closed);
      // Terminal state means the footer element is not rendered at all.
      expect(findFooter(card)).toBeUndefined();
    });

    it('uses the long-tool-call fixture to demonstrate the user-visible fix', async () => {
      // The fixture models a real claude -p stream-json sequence where a Bash
      // tool call opens, runs for several minutes, and closes. Without the
      // heartbeat, the card would freeze on "🧰 正在调用工具" until tool_result.
      // With the heartbeat, the state mutates per the contract above.
      const path = join(process.cwd(), 'tests/fixtures/claude/long-tool-call.jsonl');
      const raw = (await readFile(path, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
      const events: AgentEvent[] = [];
      for (const r of raw) for (const t of translateEvent(r)) events.push(t);

      // State at the moment right after tool_use: footer is tool_running,
      // currentToolElapsedMs starts at 0 (per reducer).
      const toolUseIdx = events.findIndex(
        (e) => e.type === 'tool_use' && e.name === 'Bash',
      );
      expect(toolUseIdx).toBeGreaterThan(0);
      const eventsUpToToolUse = events.slice(0, toolUseIdx + 1);
      const opened = makeStateFromEvents(eventsUpToToolUse);
      expect(opened.footer).toBe('tool_running');
      expect(opened.currentToolElapsedMs).toBe(0);
      expect(opened.lastToolStartedAt).toBeTypeOf('number');

      // Simulate the heartbeat tick that mutates state with a real elapsed value.
      // Use 12.5s — past the formatElapsed "12 秒" boundary, large enough to
      // exercise the suffix-append path without crossing the minute mark
      // (which would make the assertion's regex need updating).
      const ticked: RunState = { ...opened, currentToolElapsedMs: 12_500 };
      const tickedFooter = findFooter(renderCard(ticked));
      expect(tickedFooter).toBe('🧰 正在调用工具 · 已运行 12 秒');

      // State after tool_result: footer is null (terminal), elapsed cleared.
      const closed = makeStateFromEvents(events);
      expect(closed.footer).toBeNull();
      expect(closed.currentToolElapsedMs).toBeUndefined();
    });
  });

  describe('Claude interactive prompts end-to-end', () => {
    async function loadFixture(name: string): Promise<AgentEvent[]> {
      const path = join(process.cwd(), 'tests/fixtures/claude', name);
      const raw = (await readFile(path, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
      const events: AgentEvent[] = [];
      for (const r of raw) for (const t of translateEvent(r)) events.push(t);
      return events;
    }

    function fakeChannel() {
      const send = vi.fn().mockResolvedValue({ messageId: 'om_x' });
      return { send } as unknown as LarkChannel;
    }

    async function* stream(events: AgentEvent[]): AsyncIterable<AgentEvent> {
      for (const e of events) yield e;
    }

    function deps(channel: LarkChannel) {
      return {
        channel,
        chatId: 'oc_chat',
        scope: 'oc_chat',
        sendOpts: { replyTo: 'om_trigger' },
        sign: () => 'tok',
      };
    }

    it('sends a Feishu card for Claude AskUserQuestion with one button per option', async () => {
      const events = await loadFixture('ask-user-question.jsonl');
      const channel = fakeChannel();
      await consumeInteractivePrompts(stream(events), deps(channel));

      expect(channel.send).toHaveBeenCalledTimes(1);
      const [chatId, body, opts] = (channel.send as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(chatId).toBe('oc_chat');
      const card = (body as { card: { body: { elements: Array<Record<string, unknown>> } } }).card;
      expect(opts).toMatchObject({ replyTo: 'om_trigger' });

      const buttonValues: Array<Record<string, unknown>> = [];
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
              buttonValues.push(b.value as Record<string, unknown>);
            }
          }
        }
        for (const v of Object.values(obj)) walk(v);
      };
      walk(card);

      const answers = buttonValues.map((v) => v.answer);
      expect(answers).toEqual(['AWS Lambda', 'ECS Fargate', 'Vercel']);
      for (const v of buttonValues) {
        expect(v[BRIDGE_PROMPT_CALLBACK_MARKER]).toBe(true);
        expect(v.kind).toBe('ask');
        expect(v.header).toBe('Target');
      }
    });

    it('sends a Feishu plan card for Claude ExitPlanMode with approve/revise buttons', async () => {
      const events = await loadFixture('exit-plan-mode.jsonl');
      const channel = fakeChannel();
      await consumeInteractivePrompts(stream(events), deps(channel));

      expect(channel.send).toHaveBeenCalledTimes(1);
      const [, body] = (channel.send as ReturnType<typeof vi.fn>).mock.calls[0]!;
      const card = (body as { card: { body: { elements: Array<Record<string, unknown>> } } }).card;

      // The plan body is a markdown element. Find it by content (the title
      // comes first and is a different markdown element).
      const planElement = card.body.elements.find(
        (el) => el.tag === 'markdown' && typeof el.content === 'string' && el.content.includes('Refactor auth flow'),
      );
      expect(planElement).toBeDefined();
      expect((planElement as { content: string }).content).toContain('Add refresh token rotation');

      // Buttons: approve / revise.
      const buttonValues: Array<Record<string, unknown>> = [];
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
              buttonValues.push(b.value as Record<string, unknown>);
            }
          }
        }
        for (const v of Object.values(obj)) walk(v);
      };
      walk(card);
      expect(buttonValues.map((v) => v.decision)).toEqual(['approve', 'revise']);
      expect(buttonValues.every((v) => v.kind === 'plan')).toBe(true);
    });

    it('does not double-send when the same tool_use id is delivered twice', async () => {
      const events = await loadFixture('ask-user-question.jsonl');
      // Duplicate every tool_use; consumer must dedupe by id.
      const doubled: AgentEvent[] = [];
      for (const e of events) {
        doubled.push(e);
        if (e.type === 'tool_use') doubled.push({ ...e });
      }
      const channel = fakeChannel();
      await consumeInteractivePrompts(stream(doubled), deps(channel));

      expect(channel.send).toHaveBeenCalledTimes(1);
    });
  });

  describe('Codex path regression — same surface, same behavior', () => {
    // The progress heartbeat is global; it does not branch on agentKind.
    it('progressHeartbeatMs preference applies globally (not Claude-only)', async () => {
      const channelTs = await readFile(
        join(process.cwd(), 'src/bot/channel.ts'),
        'utf8',
      );
      // The heartbeat is set up inside processAgentStream, which is shared.
      expect(channelTs).toContain('startHeartbeat()');
      // The call site does not gate by agentKind.
      const heartbeatSetupIdx = channelTs.indexOf('const startHeartbeat =');
      const next200 = channelTs.slice(heartbeatSetupIdx, heartbeatSetupIdx + 200);
      expect(next200).not.toMatch(/agentKind/);
    });

    it('consumeInteractivePrompts is shared between Claude and Codex adapters', async () => {
      const channelTs = await readFile(
        join(process.cwd(), 'src/bot/channel.ts'),
        'utf8',
      );
      // One wired consumer, no agentKind gate at the call site.
      expect(channelTs).toContain('consumeInteractivePrompts(execution.subscribe()');
      const matches = channelTs.match(/consumeInteractivePrompts\(/g) ?? [];
      expect(matches).toHaveLength(1);
    });
  });
});
