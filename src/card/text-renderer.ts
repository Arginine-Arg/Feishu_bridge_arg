import type { Block, RunState, ToolEntry } from './run-state';
import { toolHeaderText } from './tool-render';
import { CARD_BYTE_BUDGET } from './run-renderer';
import { activityTextBody, presentBlocks, type ActivityTranscript } from './activity-presentation';

const MARKER_RESERVE = 256;
const EFFECTIVE_BUDGET = CARD_BYTE_BUDGET - MARKER_RESERVE;

const TEXT_HEAD_BYTE_BUDGET = 2400;

export interface RenderTextOptions {
  /** Set to Infinity when the caller will split the complete text itself. */
  maxBytes?: number;
  /**
   * Controls how terminal-derived execution activity is represented.
   *
   * `full` keeps the existing quoted trace for an in-progress diagnostic
   * view, `summary` keeps only the item count, and `none` removes the trace
   * from user-facing final-answer delivery. Activity is still retained in
   * RunState and can be inspected through the run diagnostics.
   */
  activityMode?: 'full' | 'summary' | 'none';
}

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
export function renderText(state: RunState, options: RenderTextOptions = {}): string {
  const parts: string[] = [];
  const presentation = presentBlocks(state.blocks);
  const activityMode = options.activityMode ?? 'full';

  if (presentation.activity && activityMode !== 'none') {
    const activityBody =
      activityMode === 'summary'
        ? undefined
        : activityTextBody(
            presentation.activity,
            options.maxBytes === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : undefined,
          );
    parts.push(activityQuote(presentation.activity, activityBody));
  }

  for (const block of presentation.blocks) {
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

  return enforceTextByteBudget(parts.join('\n\n'), options.maxBytes ?? EFFECTIVE_BUDGET);
}

/**
 * Split a complete markdown reply into independently sendable messages.
 * Splitting at paragraph/line boundaries keeps headings and code blocks
 * readable while the byte limit leaves room for Feishu message metadata.
 */
export function splitTextForDelivery(text: string, maxBytes = 12_000): string[] {
  if (!text.trim()) return [];
  if (!Number.isFinite(maxBytes) || Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return [text];
  }

  const chunks: string[] = [];
  let current = '';
  const append = (piece: string): void => {
    const trimmed = piece.trim();
    if (!trimmed) return;
    const candidate = current ? `${current}\n\n${trimmed}` : trimmed;
    if (Buffer.byteLength(candidate, 'utf8') <= maxBytes) {
      current = candidate;
      return;
    }
    if (current) {
      chunks.push(current);
      current = '';
    }
    if (Buffer.byteLength(trimmed, 'utf8') <= maxBytes) {
      current = trimmed;
      return;
    }
    const pieces = splitOversizedMarkdownPiece(trimmed, maxBytes);
    chunks.push(...pieces.slice(0, -1));
    current = pieces.at(-1) ?? '';
  };

  for (const paragraph of text.split(/\n{2,}/u)) append(paragraph);
  if (current) chunks.push(current);
  return chunks;
}

function splitOversizedMarkdownPiece(input: string, maxBytes: number): string[] {
  const pieces: string[] = [];
  let remaining = input;
  while (remaining) {
    if (Buffer.byteLength(remaining, 'utf8') <= maxBytes) {
      pieces.push(remaining);
      break;
    }
    const head = utf8Head(remaining, maxBytes);
    let cut = head.lastIndexOf('\n');
    if (cut <= 0) cut = head.length;
    const piece = remaining.slice(0, cut).trim();
    if (piece) pieces.push(piece);
    remaining = remaining.slice(cut).replace(/^\n+/u, '').trimStart();
  }
  return pieces;
}

function activityQuote(activity: ActivityTranscript, content?: string): string {
  if (content === undefined) {
    return `> _▸ 执行活动（${activity.entries} 项，已折叠）_`;
  }
  return [
    `> _▸ 执行活动（${activity.entries} 项）_`,
    ...content.split('\n').map((line) => `> ${line}`),
  ].join('\n');
}

function enforceTextByteBudget(text: string, maxBytes: number): string {
  const totalBytes = Buffer.byteLength(text, 'utf8');
  if (!Number.isFinite(maxBytes) || totalBytes <= maxBytes) return text;

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
    const tailBudget = Math.max(0, maxBytes - headBytes - separatorBytes);
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
