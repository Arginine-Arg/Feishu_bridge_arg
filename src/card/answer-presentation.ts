/**
 * Presentation helpers for completed assistant answers.
 *
 * A streamed run is intentionally rendered by the existing run renderer. Once
 * the answer is complete, however, Markdown code fences and terminal-style
 * layouts need a semantic boundary so a delivery split cannot put half of a
 * fence in one Feishu message and the other half in the next one.
 */

export type AnswerBlockKind = 'markdown' | 'code' | 'diff' | 'layout';
export type LayoutKind = 'table' | 'diagram';

export interface AnswerBlock {
  kind: AnswerBlockKind;
  /** Content without Markdown fence markers. For markdown this is raw text. */
  content: string;
  language?: string;
  layoutKind?: LayoutKind;
}

const DEFAULT_CARD_CHUNK_BYTES = 12_000;
const CARD_OVERHEAD_BYTES = 900;
const MIN_LAYOUT_LINES = 3;

/** Parse a completed answer into delivery-safe semantic blocks. */
export function parseAnswerBlocks(input: string): AnswerBlock[] {
  if (!input.trim()) return [];
  const lines = input.replace(/\r\n?/gu, '\n').split('\n');
  const blocks: AnswerBlock[] = [];
  let markdownLines: string[] = [];

  const flushMarkdown = (): void => {
    if (markdownLines.length === 0) return;
    const content = markdownLines.join('\n');
    if (content.trim()) blocks.push({ kind: 'markdown', content });
    markdownLines = [];
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    const fence = parseFenceStart(line);
    if (fence) {
      flushMarkdown();
      const body: string[] = [];
      let cursor = index + 1;
      let closed = false;
      for (; cursor < lines.length; cursor += 1) {
        if (isFenceClose(lines[cursor] ?? '', fence)) {
          closed = true;
          break;
        }
        body.push(lines[cursor] ?? '');
      }
      blocks.push({
        kind: classifyCodeFence(fence.info),
        content: body.join('\n'),
        ...(fence.info ? { language: fence.info } : {}),
      });
      index = closed ? cursor + 1 : lines.length;
      continue;
    }

    const patchKind = explicitPatchStart(line);
    if (patchKind) {
      flushMarkdown();
      const patch: string[] = [line];
      let cursor = index + 1;
      if (patchKind === 'begin-patch') {
        while (cursor < lines.length) {
          patch.push(lines[cursor] ?? '');
          const done = /^\s*\*{3}\s+End\s+Patch\s*$/u.test(lines[cursor] ?? '');
          cursor += 1;
          if (done) break;
        }
      } else {
        // A normal git diff is explicitly anchored by `diff --git`/`@@`.
        // Stop at a blank line followed by ordinary prose, while retaining
        // blank lines that are part of the diff hunk itself.
        let blankRun = 0;
        while (cursor < lines.length) {
          const next = lines[cursor] ?? '';
          if (!next.trim()) {
            blankRun += 1;
            patch.push(next);
            cursor += 1;
            if (blankRun >= 2) break;
            continue;
          }
          if (blankRun > 0 && !isPatchContinuation(next)) break;
          blankRun = 0;
          patch.push(next);
          cursor += 1;
        }
      }
      blocks.push({ kind: 'diff', content: trimBlockEnd(patch.join('\n')) });
      index = cursor;
      continue;
    }

    const table = readTable(lines, index);
    if (table) {
      flushMarkdown();
      blocks.push({ kind: 'layout', layoutKind: 'table', content: table.content });
      index = table.nextIndex;
      continue;
    }

    const diagram = readDiagram(lines, index);
    if (diagram) {
      flushMarkdown();
      blocks.push({ kind: 'layout', layoutKind: 'diagram', content: diagram.content });
      index = diagram.nextIndex;
      continue;
    }

    markdownLines.push(line);
    index += 1;
  }
  flushMarkdown();
  return blocks;
}

export function answerHasStructuredBlocks(input: string): boolean {
  return parseAnswerBlocks(input).some((block) => block.kind !== 'markdown');
}

/**
 * Split semantic blocks into complete delivery units. Every returned unit can
 * be rendered independently; a code/diff/layout block is only split on a line
 * boundary and each fragment gets its own fenced panel.
 */
export function splitAnswerForDelivery(
  input: string,
  maxBytes = DEFAULT_CARD_CHUNK_BYTES,
): AnswerBlock[][] {
  const blocks = parseAnswerBlocks(input);
  if (blocks.length === 0) return [];
  const limit = Math.max(256, maxBytes - CARD_OVERHEAD_BYTES);
  const fragments = blocks.flatMap((block) => splitBlock(block, limit));
  const chunks: AnswerBlock[][] = [];
  let current: AnswerBlock[] = [];

  const safeMaxBytes = Math.max(800, maxBytes - 256);
  const fits = (candidate: AnswerBlock[]): boolean =>
    Buffer.byteLength(JSON.stringify(answerCard(candidate, 1, 999)), 'utf8') <= safeMaxBytes;

  for (const fragment of fragments) {
    const candidate = [...current, fragment];
    if (current.length > 0 && !fits(candidate)) {
      chunks.push(current);
      current = [fragment];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Render one completed-answer card. */
export function answerCard(
  blocks: AnswerBlock[],
  segment = 1,
  total = 1,
): object {
  const elements: object[] = [];
  if (total > 1) {
    elements.push({
      tag: 'markdown',
      content: `（${segment}/${total}）`,
      text_size: 'notation',
    });
  }
  for (const block of blocks) {
    const element = renderBlock(block);
    if (element) elements.push(element);
  }
  return {
    schema: '2.0',
    config: {
      streaming_mode: false,
      summary: { content: total > 1 ? '完整答复（分段）' : '完整答复' },
    },
    body: { elements },
  };
}

function renderBlock(block: AnswerBlock): object | undefined {
  if (!block.content && block.kind === 'markdown') return undefined;
  if (block.kind === 'markdown') return { tag: 'markdown', content: block.content };

  const title = blockTitle(block);
  const body = fencedText(block.content, block.language);
  return {
    tag: 'collapsible_panel',
    expanded: block.kind === 'layout',
    header: {
      title: { tag: 'markdown', content: title },
      vertical_align: 'center',
      icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
      icon_position: 'follow_text',
      icon_expanded_angle: -180,
    },
    border: { color: block.kind === 'diff' ? 'blue' : 'grey', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: body, text_size: 'notation' }],
  };
}

function blockTitle(block: AnswerBlock): string {
  const lineCount = Math.max(1, block.content.split('\n').length);
  if (block.kind === 'diff') return `代码修改 · ${lineCount} 行`;
  if (block.kind === 'layout') {
    return `${block.layoutKind === 'table' ? '表格' : '结构图'} · ${lineCount} 行`;
  }
  const language = block.language ? displayLanguage(block.language) : '代码';
  return `${language} · ${lineCount} 行`;
}

function displayLanguage(language: string): string {
  const normalized = language.trim().toLowerCase();
  const names: Record<string, string> = {
    js: 'JavaScript 代码',
    jsx: 'JSX 代码',
    ts: 'TypeScript 代码',
    tsx: 'TSX 代码',
    py: 'Python 代码',
    python: 'Python 代码',
    sh: 'Shell 代码',
    bash: 'Shell 代码',
    zsh: 'Shell 代码',
    json: 'JSON 代码',
    yaml: 'YAML 代码',
    yml: 'YAML 代码',
    sql: 'SQL 代码',
    diff: '代码修改',
    patch: '代码修改',
    text: '文本',
    plain: '文本',
  };
  return names[normalized] ?? `${language.trim()} 代码`;
}

function fencedText(content: string, language?: string): string {
  const maxBackticks = Math.max(
    2,
    ...Array.from(content.matchAll(/`+/gu), (match) => match[0].length),
  );
  const fence = '`'.repeat(Math.max(3, maxBackticks + 1));
  const suffix = content.endsWith('\n') ? '' : '\n';
  return `${fence}${language ?? 'text'}\n${content}${suffix}${fence}`;
}

function splitBlock(block: AnswerBlock, maxBytes: number): AnswerBlock[] {
  const safeMaxBytes = Math.max(800, maxBytes - 256);
  if (Buffer.byteLength(JSON.stringify(answerCard([block], 1, 999)), 'utf8') <= safeMaxBytes) {
    return [block];
  }
  const lines = block.content.split('\n');
  const parts: AnswerBlock[] = [];
  let current: string[] = [];
  const pushCurrent = (): void => {
    if (current.length === 0) return;
    parts.push({ ...block, content: current.join('\n') });
    current = [];
  };
  for (const line of lines) {
    const candidate = [...current, line].join('\n');
    const candidateBlock = { ...block, content: candidate };
    if (current.length > 0 && Buffer.byteLength(JSON.stringify(answerCard([candidateBlock], 1, 999)), 'utf8') > safeMaxBytes) {
      pushCurrent();
      current = [line];
      continue;
    }
    if (current.length === 0 && Buffer.byteLength(JSON.stringify(answerCard([candidateBlock], 1, 999)), 'utf8') > safeMaxBytes) {
      const pieces = splitLongLine(line, block, safeMaxBytes);
      parts.push(...pieces);
      continue;
    }
    current.push(line);
  }
  pushCurrent();
  return parts.length > 0 ? parts : [{ ...block, content: '' }];
}

function splitLongLine(line: string, block: AnswerBlock, maxBytes: number): AnswerBlock[] {
  const pieces: AnswerBlock[] = [];
  let rest = Array.from(line);
  while (rest.length > 0) {
    let low = 1;
    let high = rest.length;
    let best = 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = { ...block, content: rest.slice(0, mid).join('') };
      if (Buffer.byteLength(JSON.stringify(answerCard([candidate], 1, 999)), 'utf8') <= maxBytes) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    pieces.push({ ...block, content: rest.slice(0, best).join('') });
    rest = rest.slice(best);
  }
  return pieces;
}

function parseFenceStart(line: string): { marker: '`' | '~'; length: number; info: string } | undefined {
  const match = line.match(/^\s*(?<marker>`{3,}|~{3,})\s*(?<info>[^\s`]*)[^`]*$/u);
  if (!match?.groups?.marker) return undefined;
  return {
    marker: match.groups.marker[0] as '`' | '~',
    length: match.groups.marker.length,
    info: match.groups.info?.trim() ?? '',
  };
}

function isFenceClose(line: string, fence: { marker: '`' | '~'; length: number }): boolean {
  const match = line.match(/^\s*(?<marker>`{3,}|~{3,})\s*$/u);
  return Boolean(
    match?.groups?.marker &&
      match.groups.marker[0] === fence.marker &&
      match.groups.marker.length >= fence.length,
  );
}

function classifyCodeFence(info: string): AnswerBlockKind {
  return /^(?:diff|patch)$/iu.test(info.trim()) ? 'diff' : 'code';
}

function explicitPatchStart(line: string): 'begin-patch' | 'diff' | undefined {
  const trimmed = line.trim();
  if (/^\*{3}\s+(?:Begin|Update|Add|Delete)\s+Patch\b/iu.test(trimmed)) return 'begin-patch';
  if (/^diff --git\s+/u.test(trimmed) || /^Index:\s+\S/u.test(trimmed)) return 'diff';
  if (/^@@\s*[-+]?\d+(?:,\d+)?\s+[-+]\d+(?:,\d+)?\s*@@/u.test(trimmed)) return 'diff';
  return undefined;
}

function isPatchContinuation(line: string): boolean {
  const trimmed = line.trim();
  return (
    /^diff --git\s+/u.test(trimmed) ||
    /^(?:index|old mode|new mode|similarity index|rename from|rename to|---|\+\+\+|@@)\b/u.test(trimmed) ||
    /^[ +\\-]/u.test(line) ||
    /^\*{3}\s+(?:Begin|End|Update|Add|Delete)\s+Patch\b/iu.test(trimmed)
  );
}

function readTable(lines: string[], start: number): { content: string; nextIndex: number } | undefined {
  if (start + 1 >= lines.length || !isTableRow(lines[start] ?? '') || !isTableDivider(lines[start + 1] ?? '')) {
    return undefined;
  }
  const table: string[] = [];
  let index = start;
  while (index < lines.length && isTableRow(lines[index] ?? '')) {
    table.push(lines[index] ?? '');
    index += 1;
  }
  return { content: table.join('\n'), nextIndex: index };
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return Boolean(trimmed && trimmed.includes('|') && trimmed.split('|').length >= 3);
}

function isTableDivider(line: string): boolean {
  const cells = line.trim().replace(/^\||\|$/gu, '').split('|');
  return cells.length >= 2 && cells.every((cell) => /^\s*:?-{3,}:?\s*$/u.test(cell));
}

function readDiagram(lines: string[], start: number): { content: string; nextIndex: number } | undefined {
  let index = start;
  const candidate: string[] = [];
  while (index < lines.length && lines[index]?.trim()) {
    candidate.push(lines[index] ?? '');
    index += 1;
  }
  if (candidate.length < MIN_LAYOUT_LINES) return undefined;
  const score = candidate.reduce((total, line) => total + diagramLineScore(line), 0);
  const specialLines = candidate.filter(
    (line) => /[│└├┌┐┘┤┬┴─═]/u.test(line) || /(?:-{2,}|={2,})\s*[>↓←↑]/u.test(line) || /(?:^|\s)[|v^<>](?:\s|$)/u.test(line),
  ).length;
  if (score < 2 || specialLines < 2) {
    return undefined;
  }
  return { content: candidate.join('\n'), nextIndex: index };
}

function diagramLineScore(line: string): number {
  let score = 0;
  if (/[│└├┌┐┘┤┬┴─═]/u.test(line)) score += 2;
  if (/(?:^|\s)[|v^<>](?:\s|$)/u.test(line)) score += 1;
  if (/(?:-{2,}|={2,})\s*[>↓←↑]/u.test(line)) score += 2;
  if (/\[[^\]]+\]/u.test(line) && /(?:->|→|↓|\|)/u.test(line)) score += 1;
  return score;
}

function trimBlockEnd(value: string): string {
  return value.replace(/\n+$/u, '');
}
