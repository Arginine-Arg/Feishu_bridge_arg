/**
 * Return only the part of a terminal capture that has not already been
 * delivered. Tmux reflows history when an attached client changes size, which
 * changes line breaks without changing the underlying text. Exact matching is
 * preferred; whitespace-normalized matching is a conservative recovery path
 * for those reflows.
 */
export function novelTerminalTextSuffix(delivered: string, candidate: string): string {
  if (!candidate || !delivered) return candidate;

  // Preserve full snapshot structure while determining its novel suffix.
  // In particular, a reflowed line can need a later historical line as its
  // whitespace-normalized anchor. Only then remove isolated replay rows from
  // the already-scoped suffix.
  const withoutShortReplays = (suffix: string): string =>
    stripReplayedTerminalLines(delivered, suffix);

  // A complete redraw normally includes the delivered transcript verbatim.
  // Keep the earliest copy: a later copy may be legitimate new output.
  const exactReplay = candidate.indexOf(delivered);
  if (exactReplay >= 0) return withoutShortReplays(candidate.slice(exactReplay + delivered.length));
  // A scrolled/repainted terminal frame can contain only a *middle* fragment
  // of already-delivered history. `endsWith()` alone misses that case and
  // repeatedly forwards the fragment whenever tmux changes the viewport or
  // Codex redraws its progress region.
  if (delivered.includes(candidate)) return '';
  if (delivered.endsWith(candidate)) return '';

  const semantic = whitespaceNormalizedSuffix(delivered, candidate);
  if (semantic !== undefined) return withoutShortReplays(semantic);

  const overlap = longestSuffixPrefix(delivered, candidate);
  return withoutShortReplays(overlap > 0 ? candidate.slice(overlap) : candidate);
}

const REPLAY_SEGMENT_MIN_LINES = 3;
const REPLAY_SEGMENT_MIN_CHARS = 72;

/**
 * Terminal captures are state snapshots rather than an append-only event log.
 * When tmux/Codex redraws a scrolled viewport, the previously-delivered
 * transcript can occur *inside* an otherwise-new candidate. A suffix-only
 * comparison cannot remove that internal replay, so it leaks back into the
 * outbound card and eventually pushes the actual final answer out of view.
 *
 * This deliberately only removes a proven, substantial contiguous replay of
 * the current run's terminal transcript. Short repeated prose remains valid
 * agent output; a terminal-history replay is normally several adjacent lines
 * or a long block.
 */
export function stripReplayedTerminalSegments(history: string, candidate: string): string {
  if (!history || !candidate) return candidate;

  let remaining = stripWholeHistoryReplays(history, candidate);
  if (!remaining) return '';

  const historyLines = history.split('\n');
  const candidateLines = remaining.split('\n');
  const positions = new Map<string, number[]>();
  for (let index = 0; index < historyLines.length; index += 1) {
    const normalized = normalizeReplayLine(historyLines[index]!);
    if (!normalized) continue;
    const matches = positions.get(normalized);
    if (matches) matches.push(index);
    else positions.set(normalized, [index]);
  }

  const out: string[] = [];
  for (let index = 0; index < candidateLines.length;) {
    const normalized = normalizeReplayLine(candidateLines[index]!);
    const matches = normalized ? positions.get(normalized) : undefined;
    const replayLength = matches
      ? longestReplayLineRun(historyLines, candidateLines, matches, index)
      : 0;
    if (replayLength > 0 && isSubstantialReplay(candidateLines, index, replayLength)) {
      index += replayLength;
      continue;
    }
    out.push(candidateLines[index]!);
    index += 1;
  }
  remaining = out.join('\n');
  return remaining;
}

/**
 * A terminal viewport can redraw only one already-delivered progress line
 * before showing a new tool row. It is too small for the conservative
 * multi-line replay detector above, yet forwarding it makes every live card
 * repeat its opening status and can duplicate individual table rows. Apply
 * this only to terminal-shaped lines and only against the current run's
 * delivered transcript; structured agent text is never passed here.
 */
function stripReplayedTerminalLines(history: string, candidate: string): string {
  if (!history || !candidate) return candidate;

  const delivered = new Set(
    history
      .split('\n')
      .filter((line) => isReplayableTerminalLine(line))
      .map(normalizeReplayLine)
      .filter(Boolean),
  );
  if (delivered.size === 0) return candidate;

  return candidate
    .split('\n')
    .filter((line) => {
      const normalized = normalizeReplayLine(line);
      return !normalized || !isReplayableTerminalLine(line) || !delivered.has(normalized);
    })
    .join('\n');
}

function isReplayableTerminalLine(line: string): boolean {
  const normalized = normalizeReplayLine(line);
  if (!normalized) return false;
  // Codex/Claude prose bullets, command frames, and terminal table rows are
  // stable screen content. A repeat of one of these rows in a later snapshot
  // is a redraw, not a second assistant event.
  if (/^[•◦⏺●]\s*(?:ran|running|explored|exploring|viewed|read|search|listed|list|edited|wrote|applied|patched|checked|inspected|worked|planning|analyzing|investigating)\b/iu.test(normalized)) {
    return true;
  }
  if (/^[•◦⏺●]\s+\S/u.test(normalized) && normalized.length >= 12) return true;
  if (/^[└│╰⎿]\s*\S/u.test(normalized)) return true;
  if (/^[━─═╌╍┄┅\s]+$/u.test(normalized)) return true;
  if (/\S(?: {2,}|\t+)\S/u.test(line)) return true;
  return normalized.length >= REPLAY_SEGMENT_MIN_CHARS;
}

function stripWholeHistoryReplays(history: string, candidate: string): string {
  // An exact current-run ledger embedded in a new frame is unambiguously a
  // redraw. Keep the floor so a brief intentional repeated sentence is never
  // erased simply because it happens to equal all earlier text.
  if (history.length < REPLAY_SEGMENT_MIN_CHARS) return candidate;
  let out = candidate;
  let replayAt = out.indexOf(history);
  while (replayAt >= 0) {
    out = out.slice(0, replayAt) + out.slice(replayAt + history.length);
    replayAt = out.indexOf(history);
  }
  return out;
}

function longestReplayLineRun(
  historyLines: string[],
  candidateLines: string[],
  historyPositions: number[],
  candidateStart: number,
): number {
  let longest = 0;
  for (const historyStart of historyPositions) {
    let length = 0;
    while (
      historyStart + length < historyLines.length &&
      candidateStart + length < candidateLines.length &&
      normalizeReplayLine(historyLines[historyStart + length]!) ===
        normalizeReplayLine(candidateLines[candidateStart + length]!)
    ) {
      length += 1;
    }
    longest = Math.max(longest, length);
  }
  return longest;
}

function isSubstantialReplay(lines: string[], start: number, length: number): boolean {
  if (length >= REPLAY_SEGMENT_MIN_LINES) return true;
  const chars = lines
    .slice(start, start + length)
    .map(normalizeReplayLine)
    .join('\n').length;
  return chars >= REPLAY_SEGMENT_MIN_CHARS;
}

function normalizeReplayLine(line: string): string {
  return line.replace(/\s+/gu, ' ').trim();
}

function whitespaceNormalizedSuffix(delivered: string, candidate: string): string | undefined {
  const left = normalizeWhitespace(delivered);
  const right = normalizeWhitespace(candidate);
  if (!left.text || !right.text) return undefined;

  const replay = right.text.indexOf(left.text);
  if (replay >= 0) {
    return right.sliceAfter(
      replay + left.text.length,
      /\s$/u.test(delivered),
    );
  }
  // The candidate may be a historical viewport fragment rather than the
  // whole redraw. Treat a non-trivial normalized fragment already present in
  // the delivered ledger as replay. The size floor keeps a coincidental word
  // or short status line from suppressing genuine output.
  if (right.text.length >= HISTORY_FRAGMENT_MIN_CHARS && left.text.includes(right.text)) {
    return '';
  }
  if (left.text.endsWith(right.text)) return '';

  // A malformed positioned-history delta can begin with an older region and
  // then include a real new tail. Remove the longest proven historical prefix
  // instead of appending that region a second time. This is deliberately only
  // applied to a sufficiently long match: ordinary agent prose may repeat a
  // short phrase, while a terminal history replay is a substantial block.
  const historicalPrefix = longestContainedPrefix(left.text, right.text);
  const safeHistoricalPrefix = prefixBeforeNewToken(right.text, historicalPrefix);
  if (safeHistoricalPrefix >= HISTORY_FRAGMENT_MIN_CHARS && safeHistoricalPrefix < right.text.length) {
    return right.sliceAfter(safeHistoricalPrefix, /\s$/u.test(delivered));
  }

  // Ignore a tiny common word or punctuation match. It is not a trustworthy
  // reflow anchor; the exact overlap fallback below remains available.
  const overlap = longestSuffixPrefix(left.text, right.text);
  if (overlap < 24) return undefined;
  return right.sliceAfter(overlap, /\s$/u.test(delivered));
}

const HISTORY_FRAGMENT_MIN_CHARS = 48;

/**
 * Length of the longest prefix of `needle` occurring anywhere in `haystack`.
 * The predicate is monotonic, so binary search avoids repeatedly scanning
 * increasingly large terminal captures during a long task.
 */
function longestContainedPrefix(haystack: string, needle: string): number {
  let low = 0;
  let high = Math.min(haystack.length, needle.length);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (haystack.includes(needle.slice(0, middle))) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * Do not consume the first token of a genuinely new line just because its
 * marker (for example `•`) happens to match the historical text. The last
 * normalized whitespace boundary is the safe place to begin the new suffix.
 */
function prefixBeforeNewToken(text: string, matchedLength: number): number {
  if (matchedLength <= 0) return matchedLength;
  // Codex's output blocks commonly start with one of these markers. A match
  // can extend through `• ` because that prefix is also present on an older
  // line, but the marker itself belongs to the new block.
  const marker = Math.max(
    text.lastIndexOf('•', matchedLength - 1),
    text.lastIndexOf('›', matchedLength - 1),
    text.lastIndexOf('❯', matchedLength - 1),
  );
  if (marker >= HISTORY_FRAGMENT_MIN_CHARS && marker < matchedLength) return marker;
  const boundary = text.lastIndexOf(' ', matchedLength - 1);
  return boundary >= HISTORY_FRAGMENT_MIN_CHARS ? boundary : matchedLength;
}

function longestSuffixPrefix(left: string, right: string): number {
  const values = `${right}\u0000${left}`;
  const prefix = new Uint32Array(values.length);
  for (let index = 1; index < values.length; index += 1) {
    let matched = prefix[index - 1]!;
    while (matched > 0 && values[index] !== values[matched]) matched = prefix[matched - 1]!;
    if (values[index] === values[matched]) matched += 1;
    prefix[index] = matched;
  }
  return Math.min(prefix.at(-1) ?? 0, right.length);
}

function normalizeWhitespace(input: string): {
  text: string;
  sliceAfter(normalizedLength: number, skipFollowingWhitespace?: boolean): string;
} {
  let text = '';
  const ends: number[] = [];
  let pendingWhitespace = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (/\s/u.test(char)) {
      pendingWhitespace ||= text.length > 0;
      continue;
    }
    if (pendingWhitespace) {
      text += ' ';
      // The normalized separator ends immediately before the next substantive
      // character, so a suffix starts with that character rather than a wrap.
      ends.push(index);
      pendingWhitespace = false;
    }
    text += char;
    ends.push(index + 1);
  }

  return {
    text,
    sliceAfter(normalizedLength: number, skipFollowingWhitespace = false): string {
      if (normalizedLength <= 0) return input;
      if (normalizedLength >= ends.length) return '';
      let rawIndex = ends[normalizedLength - 1]!;
      // A terminal wrap can replace an already-delivered trailing newline
      // with a different run of whitespace. That boundary belongs to the
      // prior capture, not the new suffix.
      if (skipFollowingWhitespace) {
        while (rawIndex < input.length && /\s/u.test(input[rawIndex]!)) rawIndex += 1;
      }
      return input.slice(rawIndex);
    },
  };
}
