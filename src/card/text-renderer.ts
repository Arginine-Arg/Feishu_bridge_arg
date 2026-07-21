import type { Block, RunState, ToolEntry } from './run-state';
import { toolHeaderText } from './tool-render';
import { CARD_BYTE_BUDGET } from './run-renderer';

const MARKER_RESERVE = 256;
const EFFECTIVE_BUDGET = CARD_BYTE_BUDGET - MARKER_RESERVE;

const TEXT_HEAD_BYTE_BUDGET = 2400;

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
 * Output is bounded to `EFFECTIVE_BUDGET` bytes with a global head/tail
 * fold. The marker stays in the middle so the final answer remains visible.
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

function enforceTextByteBudget(text: string): string {
  const totalBytes = Buffer.byteLength(text, 'utf8');
  if (totalBytes <= EFFECTIVE_BUDGET) return text;

  const head = utf8Head(text, TEXT_HEAD_BYTE_BUDGET);
  const headBytes = Buffer.byteLength(head, 'utf8');
  let tail = '';
  let marker = '';

  // The marker length changes slightly with the dropped-byte count. Two
  // passes converge while keeping the serialized markdown below the limit.
  for (let pass = 0; pass < 2; pass += 1) {
    const tailBytes = Buffer.byteLength(tail, 'utf8');
    const droppedBytes = Math.max(0, totalBytes - headBytes - tailBytes);
    marker = `_… ${droppedBytes} 字节已折叠（保留首尾）…_`;
    const separatorBytes = Buffer.byteLength(`\n\n${marker}\n\n`, 'utf8');
    const tailBudget = Math.max(0, EFFECTIVE_BUDGET - headBytes - separatorBytes);
    tail = utf8Tail(text, tailBudget);
  }

  const tailBytes = Buffer.byteLength(tail, 'utf8');
  marker = `_… ${Math.max(0, totalBytes - headBytes - tailBytes)} 字节已折叠（保留首尾）…_`;
  return `${head}\n\n${marker}\n\n${tail}`;
}

function utf8Head(input: string, maxBytes: number): string {
  let bytes = 0;
  let out = '';
  for (const char of input) {
    const next = Buffer.byteLength(char, 'utf8');
    if (bytes + next > maxBytes) break;
    out += char;
    bytes += next;
  }
  return out;
}

function utf8Tail(input: string, maxBytes: number): string {
  let bytes = 0;
  const out: string[] = [];
  const chars = Array.from(input);
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const char = chars[index]!;
    const next = Buffer.byteLength(char, 'utf8');
    if (bytes + next > maxBytes) break;
    out.push(char);
    bytes += next;
  }
  return out.reverse().join('');
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
