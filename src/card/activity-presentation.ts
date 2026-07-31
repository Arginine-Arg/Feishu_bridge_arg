import type { Block } from './run-state';
import { liveInteractionSurface } from '../agent/live-interaction-detection';

const ACTIVITY_CARD_BODY_MAX_BYTES = 6_000;
const ACTIVITY_TEXT_BODY_MAX_BYTES = 3_600;

export interface ActivityTranscript {
  content: string;
  entries: number;
}

export interface PresentedBlocks {
  blocks: Block[];
  activity?: ActivityTranscript;
}

type TextSegment =
  | { kind: 'text'; content: string }
  | { kind: 'activity'; content: string; entries: number };

/**
 * Keep terminal-derived activity available without letting terminal chrome
 * compete with the agent's actual progress notes and answer. This is a pure
 * presentation projection: the event stream, delivery ledger, and RunState
 * retain their exact original text for replay protection and rolling cursors.
 */
export function presentBlocks(blocks: Block[]): PresentedBlocks {
  const presented: Block[] = [];
  const activity: string[] = [];
  let entries = 0;

  for (const block of blocks) {
    if (block.kind !== 'text') {
      presented.push(block);
      continue;
    }
    for (const segment of splitTerminalActivity(block.content)) {
      if (segment.kind === 'activity') {
        activity.push(segment.content);
        entries += segment.entries;
      } else {
        appendTextBlock(
          presented,
          preserveTerminalAlignedTables(segment.content),
          block.streaming,
        );
      }
    }
  }

  const content = activity.join('\n\n').trim();
  return {
    blocks: presented,
    ...(content ? { activity: { content, entries } } : {}),
  };
}

export function activityCardBody(
  activity: ActivityTranscript,
  maxBytes = ACTIVITY_CARD_BODY_MAX_BYTES,
): string {
  return foldActivityContent(activity.content, maxBytes);
}

export function activityTextBody(activity: ActivityTranscript): string {
  return foldActivityContent(activity.content, ACTIVITY_TEXT_BODY_MAX_BYTES);
}

function appendTextBlock(blocks: Block[], content: string, streaming: boolean): void {
  if (!content) return;
  const previous = blocks.at(-1);
  if (previous?.kind === 'text' && previous.streaming === streaming) {
    previous.content += content;
    return;
  }
  blocks.push({ kind: 'text', content, streaming });
}

function splitTerminalActivity(input: string): TextSegment[] {
  // A picker must remain verbatim: its content is parsed again at delivery
  // time to build signed Feishu controls. Never hide command/menu rows here.
  if (liveInteractionSurface(input)) return [{ kind: 'text', content: input }];

  const segments: TextSegment[] = [];
  const prose: string[] = [];
  let activity: string[] = [];
  let entries = 0;

  const flushProse = (): void => {
    const content = prose.join('\n');
    prose.length = 0;
    if (content) segments.push({ kind: 'text', content });
  };
  const flushActivity = (): void => {
    const content = activity.join('\n');
    activity = [];
    if (content) segments.push({ kind: 'activity', content, entries });
    entries = 0;
  };

  for (const line of input.replace(/\r\n?/g, '\n').split('\n')) {
    if (isActivityStart(line)) {
      flushProse();
      flushActivity();
      activity.push(line);
      entries = 1;
      continue;
    }
    if (activity.length > 0) {
      const tablePreludeStart = terminalTablePreludeStart(activity, line);
      if (tablePreludeStart !== undefined) {
        const tablePrelude = activity.splice(tablePreludeStart);
        flushActivity();
        prose.push(...tablePrelude, line);
        continue;
      }
      // Codex puts tool stdout below `Ran` in an unstructured terminal
      // frame. Keep it with that activity until a new normal bullet/prose
      // message begins, so the command and its output stay together.
      if (startsNormalAgentMessage(line)) {
        flushActivity();
        prose.push(line);
      } else {
        activity.push(line);
      }
      continue;
    }
    prose.push(line);
  }
  flushActivity();
  flushProse();
  return segments;
}

function isActivityStart(line: string): boolean {
  const trimmed = line.trim();
  return (
    isCodexActivityLine(trimmed) ||
    isRawCommandActivity(trimmed) ||
    isClaudeToolActivity(trimmed) ||
    isTerminalChromeActivity(trimmed)
  );
}

function startsNormalAgentMessage(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (isActivityStart(trimmed)) return false;
  // Codex assistant prose conventionally starts with a filled bullet. This
  // boundary is deliberately narrow: bare terminal output remains attached
  // to the preceding command instead of being mistaken for an answer.
  return /^[•]\s+/u.test(trimmed) || /^[⏺●]\s+/u.test(trimmed);
}

function isCodexActivityLine(line: string): boolean {
  return /^[•◦]\s*(?:ran|running|explored|exploring|viewed(?:\s+\w+)?|read|searched|search|listed|list|edited|wrote|applied|patched|checked|inspected|worked(?:\s+for)?|planning|analyzing|investigating)\b/iu.test(
    line,
  );
}

function isRawCommandActivity(line: string): boolean {
  return (
    /^[›❯>]\s*\/[\w-]+\b/u.test(line) ||
    /^(?:ran|run|running)\s+(?:\/[\w-]+|(?:pnpm|npm|npx|node|git|rg|grep|find|sed|awk|curl|wget|tmux|python(?:3)?|bash|sh|zsh|fish|ls|cat|cd|docker|kubectl|pytest|vitest|make)\b)/iu.test(
      line,
    )
  );
}

function isClaudeToolActivity(line: string): boolean {
  return /^[⏺●]\s*(?:bash|read|write|edit|multiedit|glob|grep|task|websearch|webfetch|todowrite|skill|notebookedit|askuserquestion|exitplanmode|ls|lsp)\s*\(/iu.test(
    line,
  );
}

function isTerminalChromeActivity(line: string): boolean {
  return /^(?:◦\s*)?(?:exploring|working|thinking|planning)\b/iu.test(line) ||
    /^(?:✻|⏵⏵)\s*(?:thinking|working|running|planning)\b/iu.test(line);
}

/**
 * Codex renders Markdown tables into a terminal-width, space-aligned table
 * before tmux can observe them. Feishu Markdown collapses those spaces, so a
 * second Markdown render destroys the columns and can make the wide rule rows
 * dominate the card. Preserve only proven terminal table paragraphs as
 * monospace text; ordinary prose and already-fenced code remain untouched.
 */
export function preserveTerminalAlignedTables(input: string): string {
  if (!input || !/[━─═╌╍┄┅]/u.test(input)) return input;

  const lines = input.split('\n');
  const fenced = existingFenceLines(lines);
  const ranges: Array<{ start: number; end: number }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (fenced[index] || !isTerminalTableRule(lines[index] ?? '')) continue;

    let start = index;
    while (start > 0 && !fenced[start - 1] && isTerminalTableLine(lines[start - 1] ?? '')) {
      start -= 1;
    }
    // A terminal renders a compact two-column header with a single space in
    // some locales. The rule row proves the surrounding structure is a table,
    // so include the immediately preceding cell header even without a wide
    // gap rather than leaving it to Feishu's proportional Markdown renderer.
    if (
      start > 0 &&
      !fenced[start - 1] &&
      isTerminalTableHeader(lines[start - 1] ?? '', lines[index] ?? '')
    ) {
      start -= 1;
    }
    let end = index;
    while (end + 1 < lines.length && !fenced[end + 1] && isTerminalTableLine(lines[end + 1] ?? '')) {
      end += 1;
    }

    const previous = ranges.at(-1);
    if (previous && start <= previous.end + 1) previous.end = Math.max(previous.end, end);
    else ranges.push({ start, end });
    index = end;
  }

  if (ranges.length === 0) return input;
  const out: string[] = [];
  let cursor = 0;
  for (const range of ranges) {
    const redundantMarkdownStart = redundantMarkdownHeaderStart(lines, range.start);
    out.push(...lines.slice(cursor, redundantMarkdownStart));
    const body = lines.slice(range.start, range.end + 1).join('\n');
    const fence = '`'.repeat(Math.max(3, longestBacktickRun(body) + 1));
    out.push(`${fence}PLAIN_TEXT`, body, fence);
    cursor = range.end + 1;
  }
  out.push(...lines.slice(cursor));
  return out.join('\n');
}

function isTerminalTableRule(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || !/^[━─═╌╍┄┅\s]+$/u.test(trimmed)) return false;
  return (trimmed.match(/[━─═╌╍┄┅]{3,}/gu) ?? []).length >= 2;
}

/**
 * Tool output is usually terminal chrome, but an agent can emit a table right
 * after an `Explored`/`Ran` frame. Move the table header out of that activity
 * block so it reaches the table-preserving Markdown renderer as normal prose.
 */
function terminalTablePreludeStart(activity: string[], rule: string): number | undefined {
  if (!isTerminalTableRule(rule) || activity.length === 0) return undefined;
  const headerStart = activity.length - 1;
  const header = activity[headerStart] ?? '';
  if (!isTerminalTableHeader(header, rule)) return undefined;
  const possibleMarkdownHeader = headerStart - 1;
  if (isEquivalentPipeHeader(activity[possibleMarkdownHeader] ?? '', header)) {
    return possibleMarkdownHeader;
  }
  const possibleDelimiter = headerStart - 1;
  const markdownHeader = headerStart - 2;
  if (
    isPipeTableDelimiter(activity[possibleDelimiter] ?? '') &&
    isEquivalentPipeHeader(activity[markdownHeader] ?? '', header)
  ) {
    return markdownHeader;
  }
  return headerStart;
}

function isTerminalTableLine(line: string): boolean {
  if (isTerminalTableRule(line)) return true;
  // The rule row is the proof that this is a table. A two-column terminal
  // table has only one wide column gap, so requiring two gaps would fence the
  // rule alone and leave its header/data vulnerable to Markdown reflow.
  return /\S(?: {2,}|\t+)\S/u.test(line);
}

function isTerminalTableHeader(line: string, rule: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.includes('|')) return false;
  if (/^(?:[•◦⏺●]|[-*+]\s|#{1,6}\s|>\s)/u.test(trimmed)) return false;
  const columns = (rule.match(/[━─═╌╍┄┅]{3,}/gu) ?? []).length;
  return columns >= 2 && trimmed.split(/\s+/u).filter(Boolean).length >= columns;
}

function redundantMarkdownHeaderStart(lines: string[], terminalHeaderStart: number): number {
  const terminalHeader = lines[terminalHeaderStart] ?? '';
  const direct = terminalHeaderStart - 1;
  if (isEquivalentPipeHeader(lines[direct] ?? '', terminalHeader)) return direct;

  const delimiter = terminalHeaderStart - 1;
  const header = terminalHeaderStart - 2;
  if (isPipeTableDelimiter(lines[delimiter] ?? '') && isEquivalentPipeHeader(lines[header] ?? '', terminalHeader)) {
    return header;
  }
  return terminalHeaderStart;
}

function isEquivalentPipeHeader(pipeLine: string, terminalHeader: string): boolean {
  const cells = pipeLine
    .trim()
    .replace(/^\|/u, '')
    .replace(/\|$/u, '')
    .split('|')
    .map((cell) => cell.trim())
    .filter(Boolean);
  if (cells.length < 2) return false;
  return cells.join(' ') === terminalHeader.trim().replace(/\s+/gu, ' ');
}

function isPipeTableDelimiter(line: string): boolean {
  const trimmed = line.trim();
  return /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/u.test(trimmed);
}

function existingFenceLines(lines: string[]): boolean[] {
  const fenced = Array.from({ length: lines.length }, () => false);
  let marker: { char: '`' | '~'; length: number } | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!marker) {
      const opening = line.match(/^\s{0,3}(`{3,}|~{3,})/u)?.[1];
      if (!opening) continue;
      marker = { char: opening[0] as '`' | '~', length: opening.length };
      fenced[index] = true;
      continue;
    }

    fenced[index] = true;
    const closing = new RegExp(`^\\s{0,3}${escapeRegExp(marker.char)}{${marker.length},}\\s*$`, 'u');
    if (closing.test(line)) marker = undefined;
  }
  return fenced;
}

function longestBacktickRun(input: string): number {
  return Math.max(0, ...(input.match(/`+/gu) ?? []).map((run) => run.length));
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function foldActivityContent(content: string, maxBytes: number): string {
  if (Buffer.byteLength(content, 'utf8') <= maxBytes) return content;
  const head = utf8Head(content, Math.floor(maxBytes * 0.42));
  const tail = utf8Tail(content, Math.floor(maxBytes * 0.42));
  const dropped = Math.max(0, Buffer.byteLength(content, 'utf8') - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(tail, 'utf8'));
  return `${head}\n\n_… ${dropped} 字节执行活动已折叠（保留首尾）…_\n\n${tail}`;
}

function utf8Head(input: string, maxBytes: number): string {
  let bytes = 0;
  let output = '';
  for (const char of input) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    output += char;
    bytes += size;
  }
  return output;
}

function utf8Tail(input: string, maxBytes: number): string {
  let bytes = 0;
  const output: string[] = [];
  const chars = Array.from(input);
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const char = chars[index]!;
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    output.push(char);
    bytes += size;
  }
  return output.reverse().join('');
}
