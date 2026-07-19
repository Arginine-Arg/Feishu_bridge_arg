import type { LarkChannel } from '@larksuite/channel';
import type { AgentEvent } from '../agent/types';
import { log } from '../core/logger';

/**
 * Marker on a button value that flags a *deferred* callback: it answers an
 * interactive prompt (AskUserQuestion / ExitPlanMode) that the agent raised
 * during a run which has since ended. Unlike `__bridge_cb`, the dispatcher
 * verifies these WITHOUT requiring an active run for the scope — the asking
 * turn is already over by the time the user clicks (see dispatcher's
 * verifyPromptToken). Distinct sigil so it never collides with normal payload.
 */
export const BRIDGE_PROMPT_CALLBACK_MARKER = '__bridge_prompt';

/** Action string bound into the signed token for prompt-answer callbacks. */
export const PROMPT_CALLBACK_ACTION = 'prompt_answer';

/** Returns a freshly-signed, single-use callback token (new nonce each call). */
export type SignPromptToken = () => string;

export interface PromptCardDeps {
  channel: LarkChannel;
  chatId: string;
  scope: string;
  sendOpts: { replyTo: string; replyInThread?: boolean };
  sign: SignPromptToken;
}

// The tool inputs come off claude's stream-json as `unknown`; parse defensively.
interface AskOption {
  label: string;
  description: string;
}
interface AskQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AskOption[];
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

function parseQuestions(input: unknown): AskQuestion[] {
  if (!input || typeof input !== 'object') return [];
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) return [];
  const out: AskQuestion[] = [];
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue;
    const qo = q as Record<string, unknown>;
    const optionsRaw = Array.isArray(qo.options) ? qo.options : [];
    const options: AskOption[] = [];
    for (const o of optionsRaw) {
      if (!o || typeof o !== 'object') continue;
      const oo = o as Record<string, unknown>;
      const label = asString(oo.label);
      if (!label) continue;
      options.push({ label, description: asString(oo.description) });
    }
    if (options.length === 0) continue;
    out.push({
      question: asString(qo.question),
      header: asString(qo.header),
      multiSelect: qo.multiSelect === true,
      options,
    });
  }
  return out;
}

function optionButton(
  header: string,
  question: string,
  option: AskOption,
  type: 'primary' | 'default',
  sign: SignPromptToken,
): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: option.label },
    type,
    width: 'default',
    behaviors: [
      {
        type: 'callback',
        value: {
          [BRIDGE_PROMPT_CALLBACK_MARKER]: true,
          bridge_token: sign(),
          kind: 'ask',
          header,
          question,
          answer: option.label,
        },
      },
    ],
  };
}

/** Render an AskUserQuestion prompt as a CardKit 2.0 card matching the
 * /codex /model picker style: one markdown panel per question, one
 * button row per question, primary button for option index 0, default
 * for the rest. Multi-question (1–4 per AskUserQuestion call) renders
 * sequentially within the same card body, each in its own row.
 */
export function renderAskCard(questions: AskQuestion[], sign: SignPromptToken): object {
  const elements: object[] = [];
  questions.forEach((q, qi) => {
    if (qi > 0) elements.push({ tag: 'hr' });
    const title = q.header ? `**❓ ${q.header}**` : '**❓ 请选择**';
    const promptLine = q.question ? `${title}\n${q.question}` : title;
    const numberedOptions = q.options
      .map((opt, oi) => {
        const desc = opt.description ? ` — ${opt.description}` : '';
        return `**› ${oi + 1}. ${opt.label}**${desc}`;
      })
      .join('\n');
    const multiHint = q.multiSelect ? '\n\n_（可多选；每次点击提交一个选项）_' : '';
    elements.push({
      tag: 'markdown',
      content: `${promptLine}\n\n\`\`\`\n${numberedOptions}\n\`\`\`${multiHint}`,
    });
    for (let oi = 0; oi < q.options.length; oi++) {
      const opt = q.options[oi]!;
      elements.push(
        optionButton(q.header, q.question, opt, oi === 0 ? 'primary' : 'default', sign),
      );
    }
  });
  return {
    schema: '2.0',
    config: { summary: { content: '需要你选择' } },
    body: { elements },
  };
}

const PLAN_MAX = 3000;

/** Render an ExitPlanMode prompt as a card showing the plan + approve/revise buttons. */
export function renderPlanCard(plan: string, sign: SignPromptToken): object {
  const body = plan.length > PLAN_MAX ? `${plan.slice(0, PLAN_MAX)}…` : plan;
  const mkValue = (decision: string): object => ({
    [BRIDGE_PROMPT_CALLBACK_MARKER]: true,
    bridge_token: sign(),
    kind: 'plan',
    decision,
  });
  return {
    schema: '2.0',
    config: { summary: { content: '需要你确认执行计划' } },
    body: {
      elements: [
        { tag: 'markdown', content: '**📝 执行计划（待确认）**' },
        { tag: 'markdown', content: body },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '✅ 批准执行' },
          type: 'primary',
          behaviors: [{ type: 'callback', value: mkValue('approve') }],
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '✋ 先别，我要改' },
          type: 'default',
          behaviors: [{ type: 'callback', value: mkValue('revise') }],
        },
      ],
    },
  };
}

/**
 * Build a Feishu card for an interactive-prompt tool_use, or undefined if the
 * tool isn't one we bridge (or its input is unusable).
 */
export function buildPromptCard(
  toolName: string,
  input: unknown,
  sign: SignPromptToken,
): object | undefined {
  if (toolName === 'AskUserQuestion') {
    const questions = parseQuestions(input);
    return questions.length > 0 ? renderAskCard(questions, sign) : undefined;
  }
  if (toolName === 'ExitPlanMode') {
    const plan = asString((input as { plan?: unknown } | null)?.plan);
    return plan.trim() ? renderPlanCard(plan, sign) : undefined;
  }
  return undefined;
}

/**
 * Watch an agent event stream and, whenever the agent raises an interactive
 * prompt (AskUserQuestion / ExitPlanMode) — which headless CLIs auto-decline —
 * post a Feishu callback card so the user can answer with a click. The click
 * routes back through handleCardAction → the pending queue, resuming the
 * session as a follow-up turn that carries the chosen answer.
 *
 * Runs as an independent subscriber alongside the main render loop; a failure
 * to send one card never aborts the run.
 */
export async function consumeInteractivePrompts(
  events: AsyncIterable<AgentEvent>,
  deps: PromptCardDeps,
): Promise<void> {
  const seen = new Set<string>();
  try {
    for await (const evt of events) {
      if (evt.type !== 'tool_use') continue;
      // Dedup on tool_use.id: stream-json can re-deliver the same block on
      // resume/replay. A repeated id means we've already issued the card —
      // surface the skip so misbehaving agents are visible in logs.
      if (seen.has(evt.id)) {
        log.info('prompt-card', 'skipped-duplicate', { scope: deps.scope, tool: evt.name, id: evt.id });
        continue;
      }
      const card = buildPromptCard(evt.name, evt.input, deps.sign);
      if (!card) {
        // buildPromptCard returns undefined for any tool we don't bridge
        // (e.g. 'Bash', 'Read'). Log so operators can spot a missed tool
        // name without grepping every run's stream-json.
        log.info('prompt-card', 'skipped-no-card', { scope: deps.scope, tool: evt.name });
        continue;
      }
      seen.add(evt.id);
      try {
        await deps.channel.send(deps.chatId, { card }, deps.sendOpts);
        log.info('prompt-card', 'sent', { scope: deps.scope, tool: evt.name, id: evt.id });
      } catch (err) {
        log.warn('prompt-card', 'send-failed', {
          scope: deps.scope,
          tool: evt.name,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    log.warn('prompt-card', 'stream-failed', {
      scope: deps.scope,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
