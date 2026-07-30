/**
 * Return only the part of a terminal capture that has not already been
 * delivered. Tmux reflows history when an attached client changes size, which
 * changes line breaks without changing the underlying text. Exact matching is
 * preferred; whitespace-normalized matching is a conservative recovery path
 * for those reflows.
 */
export function novelTerminalTextSuffix(delivered: string, candidate: string): string {
  if (!candidate || !delivered) return candidate;

  // A complete redraw normally includes the delivered transcript verbatim.
  // Keep the earliest copy: a later copy may be legitimate new output.
  const exactReplay = candidate.indexOf(delivered);
  if (exactReplay >= 0) return candidate.slice(exactReplay + delivered.length);
  if (delivered.endsWith(candidate)) return '';

  const semantic = whitespaceNormalizedSuffix(delivered, candidate);
  if (semantic !== undefined) return semantic;

  const overlap = longestSuffixPrefix(delivered, candidate);
  return overlap > 0 ? candidate.slice(overlap) : candidate;
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
  if (left.text.endsWith(right.text)) return '';

  // Ignore a tiny common word or punctuation match. It is not a trustworthy
  // reflow anchor; the exact overlap fallback below remains available.
  const overlap = longestSuffixPrefix(left.text, right.text);
  if (overlap < 24) return undefined;
  return right.sliceAfter(overlap, /\s$/u.test(delivered));
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
