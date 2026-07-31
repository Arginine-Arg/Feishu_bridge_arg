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
        appendTextBlock(presented, segment.content, block.streaming);
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
