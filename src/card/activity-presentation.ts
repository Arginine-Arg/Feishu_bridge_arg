import type { Block } from './run-state';
import { liveInteractionSurface } from '../agent/live-interaction-detection';

const ACTIVITY_CARD_BODY_MAX_BYTES = 6_000;
const ACTIVITY_TEXT_BODY_MAX_BYTES = 3_600;

export interface ActivityTranscript {
  content: string;
  entries: number;
  /** Deterministic local summary of the already-emitted terminal activity. */
  summary: ActivitySummary;
}

export interface ActivitySummary {
  commands: number;
  reads: number;
  searches: number;
  changes: number;
  tests: number;
  errors: number;
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
    for (const segment of splitTerminalActivity(block.content, block.origin)) {
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
    ...(content
      ? {
          activity: {
            content,
            entries,
            summary: summarizeActivity(content),
          },
        }
      : {}),
  };
}

export function activityCardBody(
  activity: ActivityTranscript,
  maxBytes = ACTIVITY_CARD_BODY_MAX_BYTES,
): string {
  return foldActivityContent(compactActivityContent(activity.content, maxBytes), maxBytes);
}

export function activityTextBody(
  activity: ActivityTranscript,
  maxBytes = ACTIVITY_TEXT_BODY_MAX_BYTES,
): string {
  return foldActivityContent(compactActivityContent(activity.content, maxBytes), maxBytes);
}

/** Render a short deterministic label without asking the agent to summarize. */
export function activitySummaryLabel(summary: ActivitySummary): string {
  const parts: string[] = [];
  if (summary.commands > 0) parts.push(`命令 ${summary.commands}`);
  if (summary.reads > 0) parts.push(`读取 ${summary.reads}`);
  if (summary.searches > 0) parts.push(`搜索 ${summary.searches}`);
  if (summary.changes > 0) parts.push(`修改 ${summary.changes}`);
  if (summary.tests > 0) parts.push(`测试 ${summary.tests}`);
  if (summary.errors > 0) parts.push(`错误 ${summary.errors}`);
  return parts.slice(0, 3).join(' · ');
}

function summarizeActivity(content: string): ActivitySummary {
  const summary: ActivitySummary = {
    commands: 0,
    reads: 0,
    searches: 0,
    changes: 0,
    tests: 0,
    errors: 0,
  };
  for (const entry of content.split(/\n{2,}/u)) {
    const firstLine = entry.split('\n').find((line) => line.trim())?.trim() ?? '';
    const normalized = firstLine.replace(/^(?:[•◦・⏺●]\s*)/u, '');
    if (/^(?:ran|run|running)\b/iu.test(normalized)) summary.commands += 1;
    if (/^(?:read|viewed|explored)\b/iu.test(normalized)) summary.reads += 1;
    if (/^(?:search|searched|grep|glob|find|list|listed)\b/iu.test(normalized)) summary.searches += 1;
    if (/^(?:edit|edited|add|added|create|created|remove|removed|write|wrote|apply|applied|patch|patched|delete|deleted)\b/iu.test(normalized)) {
      summary.changes += 1;
    }
    if (/\b(?:test|tests|vitest|pytest|jest|npm\s+test|pnpm\s+test|cargo\s+test|go\s+test)\b/iu.test(entry)) {
      summary.tests += 1;
    }
    if (/^(?:⚠|✖|error:|fatal:)\b/iu.test(normalized) || /\b(?:failed|failure|error)\b/iu.test(entry)) {
      summary.errors += 1;
    }
  }
  return summary;
}

/**
 * Collapse only byte-identical consecutive terminal frames. The raw activity
 * remains in RunState and diagnostics; this projection removes redraw noise
 * without guessing whether two different commands are equivalent.
 */
function compactActivityContent(content: string, maxBytes: number): string {
  if (!Number.isFinite(maxBytes)) return content;
  const entries = content.split(/\n{2,}/u).filter((entry) => entry.trim());
  if (entries.length < 2) return content;

  const compacted: string[] = [];
  let previous: string | undefined;
  let repeats = 0;
  const flushRepeats = (): void => {
    if (repeats > 0) {
      compacted.push(`_×${repeats + 1} 次相同执行帧已合并_`);
      repeats = 0;
    }
  };
  for (const entry of entries) {
    const key = entry.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '').replace(/\s+/gu, ' ').trim();
    if (previous !== undefined && key === previous) {
      repeats += 1;
      continue;
    }
    flushRepeats();
    compacted.push(entry);
    previous = key;
  }
  flushRepeats();
  return compacted.join('\n\n');
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

function splitTerminalActivity(input: string, origin?: 'agent' | 'terminal'): TextSegment[] {
  // Structured adapters already separate tool events from assistant text.
  // Treat their text as prose even when it happens to contain words such as
  // `Ran` or `Read`; only live terminal-origin text needs chrome parsing.
  // Blocks without provenance retain the legacy parser for replay fixtures and
  // older persisted state.
  if (origin === 'agent') {
    return [{ kind: 'text', content: input }];
  }
  // A picker must remain verbatim: its content is parsed again at delivery
  // time to build signed Feishu controls. Never hide command/menu rows here.
  if (liveInteractionSurface(input)) return [{ kind: 'text', content: input }];

  const segments: TextSegment[] = [];
  const prose: string[] = [];
  let activity: string[] = [];
  let entries = 0;
  let activityHasBlankLine = false;

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
    activityHasBlankLine = false;
  };

  for (const line of normalizeActivityBoundaries(input).replace(/\r\n?/g, '\n').split('\n')) {
    if (activity.length > 0 && isTerminalTraceContinuation(line)) {
      activity.push(line);
      continue;
    }
    if (isActivityStart(line)) {
      flushProse();
      flushActivity();
      activity.push(line);
      entries = 1;
      activityHasBlankLine = false;
      continue;
    }
    // Terminal redraws can split a single tool frame across RunState text
    // blocks. When the next delta starts with a known continuation marker,
    // recover it as activity even though its `• Ran`/`• Explored` header was
    // in the preceding block. This prevents source listings and summary.json
    // output from leaking into the final answer as ordinary Markdown.
    if (activity.length === 0 && isOrphanTerminalActivityStart(line)) {
      flushProse();
      activity.push(line);
      entries = 1;
      activityHasBlankLine = false;
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
      if (!line.trim()) {
        activity.push(line);
        activityHasBlankLine = true;
        continue;
      }
      // Codex puts tool stdout below `Ran` in an unstructured terminal
      // frame. Keep it with that activity until a new normal bullet/prose
      // message begins, so the command and its output stay together.
      if (startsNormalAgentMessage(line) || (activityHasBlankLine && isLikelyPlainProse(line))) {
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

/**
 * A stream delta can be appended directly to the previous terminal frame.
 * When the provider omits the separator, `...answer.• Explored` would make
 * the following `└ Read ...` row look like ordinary prose and leak into the
 * final answer. Split only well-known activity markers; ordinary inline
 * bullets remain untouched.
 */
function normalizeActivityBoundaries(input: string): string {
  return input.replace(
    /([^\n])([•◦・]\s*(?:ran|running|explored|exploring|viewed(?:\s+\w+)?|read|searched|search|listed|list|edited|added|created|removed|wrote|applied|patched|checked|inspected|worked(?:\s+for)?|waiting|waited|planning|analyzing|investigating)\b)/giu,
    '$1\n$2',
  );
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
  return /^[•・]\s+/u.test(trimmed) || /^[⏺●]\s+/u.test(trimmed);
}

/**
 * A terminal tool frame is followed by indented/box-drawn stdout most of the
 * time, while the final assistant answer often resumes as a bare paragraph.
 * Once a blank line has separated the two, recognize that paragraph as prose.
 * Conservative terminal-looking prefixes stay attached to the activity so a
 * shell transcript or source listing is not promoted into the answer.
 */
function isLikelyPlainProse(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || isActivityStart(trimmed)) return false;
  if (/^[│└├╰╭╴|>`~$]/u.test(trimmed)) return false;
  if (/^(?:[A-Za-z]:[\\/]|\.\.?[\\/]|\/(?:\w|tmp|home)|~[\\/])/u.test(trimmed)) return false;
  if (/^(?:pid|ppid|stat|cmd|fatal:|error:|warning:|npm\s|pnpm\s|node\s|git\s|curl\s|tmux\s)/iu.test(trimmed)) {
    return false;
  }
  // Keep one-character cursor fragments and shell punctuation in the frame;
  // ordinary prose, headings, and Chinese paragraphs are longer than that.
  return trimmed.length >= 8 || /[\u3400-\u9fff]/u.test(trimmed);
}

function isCodexActivityLine(line: string): boolean {
  return (
    /^[•◦・]\s*(?:ran|running|explored|exploring|viewed(?:\s+\w+)?|read|searched|search|listed|list|edited|added|created|removed|wrote|applied|patched|checked|inspected|worked(?:\s+for)?|waiting|waited|planning|analyzing|investigating)\b/iu.test(
      line,
    ) ||
    /^(?:ran|running|explored|exploring|edited|added|created|removed|wrote|applied|patched|checked|inspected|waiting|waited)\b/iu.test(line)
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
  return (
    /^(?:◦\s*)?(?:exploring|working|thinking|planning)\b/iu.test(line) ||
    /^(?:✻|⏵⏵)\s*(?:thinking|working|running|planning)\b/iu.test(line) ||
    /^(?:[•◦・]\s*)?waiting for background terminal\b/iu.test(line) ||
    /(?:esc to interrupt|background terminal running|\/ps to view|\/stop to close)/iu.test(line)
  );
}

function isActivityContinuation(line: string): boolean {
  return /(?:esc to interrupt|background terminal running|\/ps to view|\/stop to close)/iu.test(
    line.trim(),
  );
}

function isTerminalTraceContinuation(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return (
    isActivityContinuation(line) ||
    /^(?:[└├│╰╭])\s*/u.test(trimmed) ||
    /^…\s*\+\d+\s+lines?\b/iu.test(trimmed) ||
    /^\d+\s*[+-]\s*\S/u.test(trimmed) ||
    /^(?:2>\/dev\/null\s*\|?|\|\s*(?:sort|tail|rg|sed|awk)\b)/iu.test(trimmed) ||
    /^###\s+summary\.json\b/iu.test(trimmed)
  );
}

function isOrphanTerminalActivityStart(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return (
    /^(?:[└├╰])\s*(?:search|read|list|listed|ran|run|edited|added|created|removed|wrote|applied|patched|checked|inspected)\b/iu.test(
      trimmed,
    ) ||
    /^(?:search|searched|read|list|listed|ran|run)\s+(?:[./~$]|[A-Za-z0-9_-]+\b)/iu.test(trimmed) ||
    /^###\s+summary\.json\b/iu.test(trimmed) ||
    /^…\s*\+\d+\s+lines?\s*(?:\(ctrl\s*\+\s*t\b)?/iu.test(trimmed)
  );
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
