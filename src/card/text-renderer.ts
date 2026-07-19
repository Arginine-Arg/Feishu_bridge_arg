import type { Block, RunState, ToolEntry } from './run-state';
import { toolHeaderText } from './tool-render';
import { CARD_BYTE_BUDGET } from './run-renderer';

const MARKER_RESERVE = 256;
const EFFECTIVE_BUDGET = CARD_BYTE_BUDGET - MARKER_RESERVE;

/**
 * Render `RunState` as plain markdown text — used in `messageReply: 'text'`
 * mode where we stream a markdown message instead of a card.
 *
 * Differences vs `renderCard`:
 *   - No collapsible panels, no buttons (markdown messages have neither)
 *   - Tool calls collapse to a single short line each (no body)
 *   - No reasoning / thinking output (no place to fold it; would be noise)
 *   - Footer is appended inline at the bottom while running
 *
 * Output is bounded to `EFFECTIVE_BUDGET` bytes by progressively
 * truncating trailing text blocks; each fold appends a marker so the
 * user can tell content was dropped.
 */
export function renderText(state: RunState): string {
  const parts: string[] = [];

  for (const block of state.blocks) {
    const piece = renderBlock(block);
    if (piece) parts.push(piece);
  }

  if (state.terminal === 'interrupted') {
    parts.push('_⏹ 已被中断_');
  } else if (state.terminal === 'idle_timeout') {
    const mins = state.idleTimeoutMinutes ?? 0;
    parts.push(`_⏱ ${mins} 分钟无响应,已自动终止_`);
  } else if (state.terminal === 'error' && state.errorMsg) {
    parts.push(`⚠️ agent 失败:${state.errorMsg}`);
  } else if (state.terminal === 'running' && state.footer) {
    parts.push(footerLine(state.footer));
  }

  return enforceTextByteBudget(parts.join('\n\n'));
}

/**
 * Truncate the joined text to fit under `EFFECTIVE_BUDGET` by walking
 * backwards through text blocks and trimming their content. Non-text
 * blocks (tool lines / footer / status) are always preserved.
 */
function enforceTextByteBudget(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= EFFECTIVE_BUDGET) return text;

  // Walk the parts backwards. Drop text parts entirely when they are
  // the obvious offender; trim trailing whitespace from a still-useful
  // text part if it alone blows the budget.
  const parts = text.split('\n\n');
  let working = parts.join('\n\n');
  let droppedBytes = 0;

  while (Buffer.byteLength(working, 'utf8') > EFFECTIVE_BUDGET && parts.length > 1) {
    const removed = parts.pop();
    if (removed === undefined) break;
    droppedBytes += Buffer.byteLength(removed, 'utf8') + 2; // +2 for \n\n
    working = parts.join('\n\n');
  }

  // If a single text block alone exceeds the budget (rare), hard-truncate it.
  if (Buffer.byteLength(working, 'utf8') > EFFECTIVE_BUDGET) {
    const buf = Buffer.from(working, 'utf8');
    working = buf.subarray(0, EFFECTIVE_BUDGET).toString('utf8');
    droppedBytes += Buffer.byteLength(text, 'utf8') - Buffer.byteLength(working, 'utf8');
  }

  if (droppedBytes > 0) {
    return `${working}\n\n_… 已截断（${droppedBytes} 字节已折叠）_`;
  }
  return working;
}

function renderBlock(block: Block): string {
  if (block.kind === 'text') {
    return block.content.trim();
  }
  return toolLine(block.tool);
}

/**
 * One-line summary for a tool call:
 *   `> ⏳ **Bash** — git status`
 *   `> ✅ **Read** — ~/code/foo.ts`
 * Reuses `toolHeaderText` so the format matches the card mode header.
 */
function toolLine(tool: ToolEntry): string {
  return `> ${toolHeaderText(tool)}`;
}

function footerLine(status: 'thinking' | 'tool_running' | 'streaming'): string {
  if (status === 'thinking') return '_🧠 正在思考…_';
  if (status === 'tool_running') return '_🧰 正在调用工具…_';
  return '_✍️ 正在输出…_';
}
