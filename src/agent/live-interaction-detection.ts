// Native model pickers can list more than a single terminal viewport. Keep
// enough history to reconstruct the complete choice set instead of making the
// card depend on whatever rows happened to be visible during a redraw.
// A native picker can be redrawn after its first rows have scrolled out of the
// viewport. Keep a wider bounded window so the current frame can be reconciled
// with the immediately preceding model frame without retaining an unbounded
// terminal transcript.
const MAX_INTERACTION_LINES = 240;
const FALLBACK_INTERACTION_LINES = 12;

const OPTION_LINE_RE = /^(?<selected>[›❯>▸])?\s*(?:(?<number>\d{1,4})(?:[.)、:：-]|\s{1,3})\s*|(?<letter>[A-Za-z])(?:[.)、:：-]|\s{1,3})\s*|\[(?<checkbox>[ xX✓✔])\]\s*|(?<bullet>[-*•])\s+|(?<radio>[◉○●◯])\s*)(?<label>\S.*)$/u;
const BARE_NAV_OPTION_RE = /^(?<selected>[›❯>▸])\s+(?<label>\S.*)$/u;
const INDENTED_NAV_OPTION_RE = /^\s{2,}(?<label>\S.*)$/u;
const BINARY_CONTROL_RE = /\b(?:y\/n|yes\/no|no\/yes)\b|\[(?:y|yes)\/(?:n|no)\]|\((?:y|yes)\/(?:n|no)\)/iu;
const KEY_HINT_RE = /(?:press\s+)?enter\s+to\s+(?:confirm|continue)|esc(?:ape)?\s+to\s+(?:go\s+back|cancel)|(?:↑|↓|up\/down|arrow keys?|use .*arrows?)|(?:按下?|点击)回车(?:键)?.*确认|(?:按下?|点击).*(?:esc|取消|返回)/iu;
const CODEX_RESUME_CONTROLS_RE = /\benter\s+(?:to\s+)?resume\b[\s\S]{0,600}\besc\s+(?:to\s+)?exit\b/iu;
const GENERIC_INPUT_HINT_RE = /(?:choose|select|pick|option|choice|answer|respond|input|type|enter|confirm|continue|proceed|approve|allow|navigate|use\s+(?:the\s+)?(?:arrow|number|letter)|按下?|请输入|输入|选择|选项|编号|确认|继续|批准|允许|回答|回复|回车)/iu;
// A naked terminal cursor is an input marker. Punctuation alone is not:
// assistant updates commonly end in `:`/`：` while introducing code or a
// conclusion, and treating every such line as a prompt turns ordinary output
// into a truncated picker card.
const GENERIC_INPUT_PROMPT_RE = /(?:(?:^|\s)[›❯>]\s*$|(?:^|\s)_\s*$)/u;
const TOOL_TRACE_VERB_RE = /^(?:ran|running|explored|exploring|edited|wrote|applied|patched|worked|waiting|thinking|planning|analyzing|investigating)\b/iu;
const TOOL_TRACE_READ_RE = /^read\s+(?:[`'"/]?[A-Za-z0-9_.~$@-]+(?:[/.\\]|\b)|https?:\/\/)/iu;
const TOOL_TRACE_RUN_RE = /^run\s+(?:(?:pnpm|npm|npx|node|git|rg|grep|find|sed|awk|curl|wget|tmux|python(?:3)?|bash|sh|zsh|fish|ls|cat|cd|docker|kubectl|pytest|vitest|make)\b|[/$`]|\S+\s+--?\w)/iu;
const ACTIVITY_CONNECTOR_RE = /^(?:[│└╰├┤┌┐┘└]|\.\.\.)\s*/u;

export interface LiveInteractionOption {
  /** Explicit key printed by the terminal, such as `1` or `a`. */
  key?: string;
  /** Human-readable option text without the key/selection marker. */
  label: string;
  /** Whether the terminal marks this row as the current selection. */
  selected: boolean;
  /** Whether a checkbox row is already checked. This is not a cursor marker. */
  checked?: boolean;
  /** The row has no explicit key and must be reached with navigation keys. */
  navigationOnly: boolean;
}

/** Parse common TUI option rows without depending on an agent/vendor name. */
export function parseLiveInteractionOptions(
  input: string,
  parseOptions: { includeAmbiguousBullets?: boolean } = {},
): LiveInteractionOption[] {
  const parsed: LiveInteractionOption[] = [];
  const seen = new Set<string>();
  const lines = input.split('\n');
  const ambiguousRows = lines.map((line) =>
    Boolean(line.trim().match(OPTION_LINE_RE)?.groups?.bullet),
  );
  let inMarkdownFence = false;
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (/^(?:```|~~~)/u.test(trimmed)) {
      inMarkdownFence = !inMarkdownFence;
      continue;
    }
    if (inMarkdownFence) continue;
    // Terminal pickers commonly indent their Enter/Esc legend. It is part of
    // the prompt surface, never an answer row, even when it follows a bare
    // arrow option and therefore looks like a navigation continuation.
    if (isInteractionHintLine(trimmed)) continue;
    // Diff hunks and quoted source literals can contain perfectly valid
    // looking `1. ...` rows. They are output prose, not terminal controls.
    if (isCodeLikeInteractionLine(trimmed)) continue;
    // Activity blocks are rendered as Markdown quotes by the Feishu card
    // renderer. A quoted `> • Ran`/`> └ Read` row must never become an option
    // merely because a nearby prompt happens to mention Enter or choose.
    if (/^>\s+(?:_|[•◦⏺●]|└|│|╰|⚠|✖)\s*/u.test(trimmed)) continue;
    const match = trimmed.match(OPTION_LINE_RE);
    const bare = match ? undefined : trimmed.match(BARE_NAV_OPTION_RE);
    const continuation = match || bare ? undefined : line.match(INDENTED_NAV_OPTION_RE);
    const groups =
      match?.groups ??
      bare?.groups ??
      (continuation && hasBareNavigationAnchor(lines, index) ? continuation.groups : undefined);
    if (!groups?.label) continue;
    // `renderText()` prefixes collapsed activity with Markdown quote markers
    // (`> • Ran`, `> └ output`). Those are presentation chrome, not a TUI row;
    // only a bare arrow followed by ordinary option text is actionable.
    if (
      isRenderedActivityQuote(groups.label) &&
      (bare || (groups.selected === '>' && groups.bullet !== undefined))
    ) {
      continue;
    }
    const bullet = groups.bullet !== undefined;
    if (
      bullet &&
      (!parseOptions.includeAmbiguousBullets || !isAmbiguousOptionRun(ambiguousRows, index))
    ) continue;
    const key = groups.number ?? groups.letter;
    const label = groups.label.trim();
    const identity = `${key ?? ''}\0${label}`.toLowerCase();
    if (seen.has(identity)) continue;
    seen.add(identity);
    parsed.push({
      ...(key ? { key: key.toLowerCase() } : {}),
      label,
      selected: Boolean(
        groups.selected ||
          (groups.radio !== undefined && /^(?:◉|●)$/u.test(groups.radio)),
      ),
      ...(groups.checkbox && /^(?:x|X|✓|✔)$/u.test(groups.checkbox)
        ? { checked: true }
        : {}),
      navigationOnly: !key,
    });
  }
  return parsed;
}

function isRenderedActivityQuote(label: string): boolean {
  return /^(?:_|[•◦⏺●]|└|│|╰|⚠|✖)\s*/u.test(label);
}

function isToolTraceLine(line: string): boolean {
  const trimmed = line.trim().replace(/^(?:[•◦⏺●]\s*)/u, '');
  return (
    TOOL_TRACE_VERB_RE.test(trimmed) ||
    TOOL_TRACE_READ_RE.test(trimmed) ||
    TOOL_TRACE_RUN_RE.test(trimmed) ||
    /^(?:searched|search|listed|list|checked|inspected)\b/iu.test(trimmed)
  );
}

function isActivityConnectorLine(line: string): boolean {
  return ACTIVITY_CONNECTOR_RE.test(line.trim());
}

function isExplicitPickerHeading(line: string): boolean {
  const trimmed = line.trim();
  return (
    /^(?:select|choose|pick)\b/iu.test(trimmed) ||
    /^(?:reasoning (?:effort|level)|skills?)\b/iu.test(trimmed) ||
    /^(?:command )?requires?\s+(?:approval|confirmation)\b/iu.test(trimmed) ||
    /^resume\s+previous\s+conversation\b/iu.test(trimmed) ||
    /^(?:请选择|请(?:输入|回复).*(?:选项|编号|是|否)|等待(?:你|用户)(?:的)?(?:输入|选择|确认))/u.test(trimmed) ||
    /\b(?:update\s+available|claude\s+code\s+running\s+in\s+bypass\s+permissions\s+mode)\b/iu.test(trimmed)
  );
}

function hasBareNavigationAnchor(lines: string[], index: number): boolean {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const line = lines[cursor] ?? '';
    if (isInteractionHintLine(line)) return false;
    if (!line.trim()) return false;
    if (line.trim().match(BARE_NAV_OPTION_RE)?.groups?.label) {
      const label = line.trim().match(BARE_NAV_OPTION_RE)?.groups?.label ?? '';
      return !isRenderedActivityQuote(label);
    }
    if (INDENTED_NAV_OPTION_RE.test(line)) continue;
    return false;
  }
  return false;
}

function isInteractionHintLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || OPTION_LINE_RE.test(trimmed) || BARE_NAV_OPTION_RE.test(trimmed)) return false;
  return Boolean(
    /^(?:press|hit|type)\s+(?:enter|return|esc|escape)\b/iu.test(trimmed) ||
      /^(?:enter|return)\s+to\s+(?:confirm|continue|choose|select)\b/iu.test(trimmed) ||
      /^(?:esc|escape)\s+to\s+(?:go\s+back|cancel|exit)\b/iu.test(trimmed) ||
      /^(?:use\s+)?(?:↑|↓|up\/down|arrow\s+keys?)(?:\s|$)/iu.test(trimmed) ||
      /^(?:按下?|点击)(?:回车|回车键|esc|方向键).*(?:确认|继续|取消|返回|选择)/u.test(trimmed),
  );
}

function isCodeLikeInteractionLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    /^\d{1,5}\s+[+-]\s*['"`]/u.test(trimmed) ||
    /^[+-]\s*(?:['"`]|(?:const|let|var|function|return|import|export)\b)/iu.test(trimmed) ||
    /^['"`].*['"`],?$/u.test(trimmed)
  );
}

function isOptionSyntaxLine(line: string): boolean {
  const trimmed = line.trim();
  const match = trimmed.match(OPTION_LINE_RE);
  if (match) return true;
  const bare = trimmed.match(BARE_NAV_OPTION_RE);
  return Boolean(bare?.groups?.label && !isRenderedActivityQuote(bare.groups.label));
}

/** Strong option evidence excludes ambiguous prose/activity bullets. */
function isStrongOptionSyntaxLine(line: string): boolean {
  const trimmed = line.trim();
  const match = trimmed.match(OPTION_LINE_RE);
  if (match?.groups?.bullet) return false;
  return Boolean(match || trimmed.match(BARE_NAV_OPTION_RE)?.groups?.label);
}

function isOptionSyntaxLineAt(lines: string[], index: number): boolean {
  return isOptionSyntaxLine(lines[index] ?? '') || hasBareNavigationAnchor(lines, index);
}

function isAmbiguousOptionRun(rows: boolean[], index: number): boolean {
  let start = index;
  while (start > 0 && rows[start - 1]) start -= 1;
  let end = index;
  while (end + 1 < rows.length && rows[end + 1]) end += 1;
  // A lone `• Model changed ...` or `• Ran ...` is activity, not a picker row.
  // Require a contiguous pair before accepting ambiguous bullet syntax.
  return end - start + 1 >= 2;
}

/** True when a terminal row looks like it is waiting for an answer. */
export function isLiveInputPromptLine(line: string): boolean {
  const trimmed = line.trim();
  return Boolean(trimmed) && (GENERIC_INPUT_HINT_RE.test(trimmed) || GENERIC_INPUT_PROMPT_RE.test(trimmed));
}

/**
 * Return only the active terminal picker/approval surface. Ordinary prose can
 * contain words such as "select", "请选择", or "是否", so a title alone is
 * never sufficient: the current tail must expose an actionable control.
 */
export function liveInteractionSurface(input: string): string | undefined {
  const candidate = interactionCandidate(input);
  const usable = candidate ? stripInteractionCodeFences(candidate) : undefined;
  // Rendering waits for a complete picker frame so the first card does not
  // omit later options that arrive in the next terminal redraw.
  if (!usable || !isStructuredInteraction(usable, true)) return undefined;
  return usable.join('\n');
}

export function isStructuredLiveInteraction(input: string): boolean {
  const candidate = interactionCandidate(input);
  // Classification still identifies an in-progress picker immediately. This
  // controls relay lifecycle and prevents its first rendered option from
  // being mistaken for a normal final response; only card publication waits
  // for a complete frame above.
  const usable = candidate ? stripInteractionCodeFences(candidate) : undefined;
  return Boolean(usable && isStructuredInteraction(usable, false));
}

function stripInteractionCodeFences(lines: string[]): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(?:```|~~~)/u.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) out.push(line);
  }
  return out;
}

function interactionCandidate(input: string): string[] | undefined {
  const recent = input
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => Boolean(line.trim()))
    .filter((line) => !/^_(?:🧠 正在思考…|🧰 正在调用工具…|✍️ 正在输出…)_$/u.test(line.trim()))
    .slice(-MAX_INTERACTION_LINES);
  if (recent.length === 0) return undefined;

  let start = -1;
  for (let index = 0; index < recent.length; index += 1) {
    const line = recent[index]!.trim();
    // Keep an explicit picker/approval heading as the anchor. A later
    // semantic question such as `Do you want to allow ...?` is part of that
    // same surface, not a new prompt that should hide the heading.
    if (start >= 0 && /^\s*(?:do\s+you|would\s+you|shall\s+i|which\s+)/iu.test(line)) continue;
    if (isLiveInteractionPromptStart(line)) start = index;
  }
  if (start >= 0 && isCodexResumeControlLine(recent[start]!)) {
    return recent.slice(Math.max(0, start - 24));
  }
  if (start >= 0) {
    // A generic prompt often appears *after* its option rows (for example
    // `a) staging`, `b) production`, `Choose one:`). Keep the contiguous
    // option block and a preceding question line with the prompt instead of
    // scoping the surface to the final hint alone.
    let optionStart = start;
    while (optionStart > 0 && isOptionSyntaxLineAt(recent, optionStart - 1)) {
      optionStart -= 1;
    }
    if (optionStart > 0 && /[?:：？]\s*$/u.test(recent[optionStart - 1]!)) optionStart -= 1;
    return mergeRepeatedPickerOptions(recent, start, recent.slice(optionStart));
  }
  return fallbackInteractionCandidate(recent);
}

/**
 * Pickers without a recognizable title still commonly end with an Enter/Esc
 * legend.  A fixed tail window can cut off the first rows (and, more
 * importantly, the source/diff line that made those rows look like a menu).
 * Scope the fallback to the latest control hint and the contiguous option
 * block immediately before it, retaining one adjacent question/code line for
 * the structural checks.
 */
function fallbackInteractionCandidate(lines: string[]): string[] {
  // A partially visible native picker often keeps its numbered choices on
  // screen after the title and Enter/Esc legend have scrolled away. Prefer
  // that latest contiguous block over a broad history tail: old composer
  // drafts such as `› c`, `› continue`, and `/m` are not menu choices.
  const numericBlock = latestContiguousNumericOptionBlock(lines);
  if (numericBlock) {
    // Codex's model picker often redraws as `2..5` after the first frame's
    // `1..5` has scrolled away. Recover only a matching native-model frame;
    // generic numbered prose must continue through the stricter path below.
    const recoveredModelFrame = recoverNativeModelPickerFrame(lines, numericBlock);
    if (recoveredModelFrame) return recoveredModelFrame;
    // Preserve the question for untitled, vendor-neutral pickers, but never
    // reach farther into scrollback. A previous composer draft such as
    // `› /mod` must not be carried into the card merely because the menu
    // header has scrolled out of the captured viewport.
    const previous = lines[numericBlock.start - 1]?.trim() ?? '';
    const includePrevious =
      /[?？]\s*$/u.test(previous) || isExplicitPickerHeading(previous);
    return lines.slice(
      includePrevious ? numericBlock.start - 1 : numericBlock.start,
      numericBlock.end + 1,
    );
  }

  let controlIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? '';
    if (
      !isOptionSyntaxLine(line) &&
      KEY_HINT_RE.test(line)
    ) {
      controlIndex = index;
      break;
    }
  }
  const lastOption = lines.reduce(
    (last, line, index) => (isOptionSyntaxLine(line) ? index : last),
    -1,
  );
  if (lastOption < 0) return lines.slice(-FALLBACK_INTERACTION_LINES);

  const end = Math.max(lastOption, controlIndex);
  let optionStart = lastOption;
  while (optionStart >= 0 && isOptionSyntaxLine(lines[optionStart] ?? '')) optionStart -= 1;

  let contextStart = optionStart;
  for (let index = optionStart - 1; index >= Math.max(0, optionStart - MAX_INTERACTION_LINES); index -= 1) {
    const line = lines[index]?.trim() ?? '';
    if (isLiveInteractionPromptStart(line) || /[?？]\s*$/u.test(line)) {
      contextStart = index;
      break;
    }
  }
  // If no title/question was found, keep the nearby context. This preserves
  // known vendor prompts (which may use a warning prefix) while still keeping
  // the candidate bounded to one terminal surface.
  if (contextStart === optionStart) {
    contextStart = Math.max(0, optionStart - MAX_INTERACTION_LINES);
  }
  return lines.slice(contextStart, end + 1);
}

interface NumericOptionBlock {
  start: number;
  end: number;
}

/**
 * Recover a native model picker whose title and first row were scrolled out of
 * the current terminal viewport. This is deliberately model-specific: blindly
 * merging arbitrary numbered blocks is how source-code traces become fake
 * selection cards.
 */
function recoverNativeModelPickerFrame(
  lines: string[],
  currentBlock: NumericOptionBlock,
): string[] | undefined {
  const current = lines.slice(currentBlock.start, currentBlock.end + 1);
  const currentOptions = parseLiveInteractionOptions(current.join('\n'));
  if (!isNativeModelOptionSet(currentOptions)) return undefined;
  const currentKeys = new Set(
    currentOptions.flatMap((option) => (option.key ? [option.key] : [])),
  );
  const currentNumericKeys = currentOptions
    .flatMap((option) => (option.key && /^\d+$/u.test(option.key) ? [Number(option.key)] : []))
    .sort((left, right) => left - right);
  if (currentNumericKeys.length === 0 || currentNumericKeys[0]! <= 1) return undefined;

  // A model label appearing under multiple numeric keys is characteristic of
  // a source diff/history replay, not a redraw of the same menu. Reject the
  // recovery before it can manufacture an apparently complete picker.
  if (hasConflictingNativeModelKeys(lines)) return undefined;

  const blocks = contiguousNumericOptionBlocks(lines);
  const blockIndex = blocks.findIndex(
    (block) => block.start === currentBlock.start && block.end === currentBlock.end,
  );
  if (blockIndex > 0) {
    for (let index = blockIndex - 1; index >= 0; index -= 1) {
      const previousBlock = blocks[index]!;
      const previousOptions = parseLiveInteractionOptions(
        lines.slice(previousBlock.start, previousBlock.end + 1).join('\n'),
      );
      if (!isNativeModelOptionSet(previousOptions)) continue;
      const overlap = previousOptions.filter(
        (option) =>
          option.key &&
          currentKeys.has(option.key) &&
          modelOptionId(option.label) === modelOptionId(
            currentOptions.find((candidate) => candidate.key === option.key)?.label ?? '',
          ),
      ).length;
      if (overlap < 2) continue;
      const missing = previousOptions.filter(
        (option) => option.key && !currentKeys.has(option.key),
      );
      if (missing.length === 0) return undefined;
      return composeRecoveredModelFrame(
        lines,
        previousBlock,
        currentBlock,
        current,
        missing,
      );
    }
  }

  // If the previous frame is no longer in the bounded buffer, the selected
  // contiguous gpt/model rows are still strong enough to label the surface.
  // This restores arrow-navigation semantics, while never applying to generic
  // numbered output or a block with no current selection.
  if (currentOptions.some((option) => option.selected)) {
    return composeRecoveredModelFrame(lines, undefined, currentBlock, current, []);
  }
  return undefined;
}

function composeRecoveredModelFrame(
  lines: string[],
  previousBlock: NumericOptionBlock | undefined,
  currentBlock: NumericOptionBlock,
  current: string[],
  missing: LiveInteractionOption[],
): string[] {
  const heading = findNativeModelHeading(lines, previousBlock?.start ?? currentBlock.start);
  const missingRows = missing
    .sort((left, right) => Number(left.key) - Number(right.key))
    .map((option) => {
      const source = previousBlock
        ? lines
            .slice(previousBlock.start, previousBlock.end + 1)
            .find((line) => line.trim().match(OPTION_LINE_RE)?.groups?.number === option.key)
        : undefined;
      if (source) return source.replace(/^(\s*)[›❯>▸]\s*/u, '$1  ');
      return `  ${option.key}. ${option.label}`;
    });
  const hint = findNativeModelHint(lines, currentBlock.end, previousBlock?.end);
  return [
    heading ?? 'Select Model and Effort',
    ...missingRows,
    ...current,
    ...(hint && !current.some((line) => KEY_HINT_RE.test(line)) ? [hint] : []),
  ];
}

function contiguousNumericOptionBlocks(lines: string[]): NumericOptionBlock[] {
  const blocks: NumericOptionBlock[] = [];
  let runLength = 0;
  let previousKey: number | undefined;
  let runStart = 0;
  const finish = (end: number): void => {
    if (runLength >= 2) blocks.push({ start: runStart, end });
    runLength = 0;
    previousKey = undefined;
  };
  for (const [index, line] of lines.entries()) {
    const match = line.trim().match(OPTION_LINE_RE);
    const rawKey = match?.groups?.number;
    if (!rawKey || isCodeLikeInteractionLine(line)) {
      finish(index - 1);
      continue;
    }
    const key = Number(rawKey);
    if (previousKey !== undefined && key === previousKey + 1) {
      runLength += 1;
    } else {
      finish(index - 1);
      runLength = 1;
      runStart = index;
    }
    previousKey = key;
  }
  finish(lines.length - 1);
  return blocks;
}

function isNativeModelOptionSet(options: LiveInteractionOption[]): boolean {
  return (
    options.length >= 2 &&
    options.filter((option) => Boolean(option.key && modelOptionId(option.label))).length >= 2
  );
}

function modelOptionId(label: string): string | undefined {
  return label.match(/\b(?:gpt|claude|gemini|llama|deepseek|qwen|o\d)[a-z0-9._-]*/iu)?.[0]?.toLowerCase();
}

function hasConflictingNativeModelKeys(lines: string[]): boolean {
  const keysByModel = new Map<string, Set<string>>();
  for (const option of parseLiveInteractionOptions(lines.join('\n'))) {
    if (!option.key) continue;
    const model = modelOptionId(option.label);
    if (!model) continue;
    const keys = keysByModel.get(model) ?? new Set<string>();
    keys.add(option.key);
    keysByModel.set(model, keys);
  }
  return [...keysByModel.values()].some((keys) => keys.size > 1);
}

function findNativeModelHeading(lines: string[], before: number): string | undefined {
  for (let index = before - 1; index >= Math.max(0, before - 12); index -= 1) {
    const line = lines[index]?.trim() ?? '';
    if (isCodeLikeInteractionLine(line)) continue;
    const isHeading = /^(?:select\s+(?:a\s+)?model|model(?:\s+and\s+effort)?|reasoning\s+(?:effort|level))\b/iu.test(line);
    if (isHeading && !/^model\s+changed\b/iu.test(line)) {
      return line;
    }
  }
  return undefined;
}

function findNativeModelHint(
  lines: string[],
  currentEnd: number,
  previousEnd: number | undefined,
): string | undefined {
  const start = currentEnd + 1;
  const end = Math.min(lines.length, start + 8);
  for (let index = start; index < end; index += 1) {
    const line = lines[index]?.trim() ?? '';
    if (KEY_HINT_RE.test(line)) return line;
  }
  if (previousEnd !== undefined) {
    for (let index = previousEnd + 1; index < Math.min(lines.length, previousEnd + 8); index += 1) {
      const line = lines[index]?.trim() ?? '';
      if (KEY_HINT_RE.test(line)) return line;
    }
  }
  return undefined;
}

/**
 * A full-screen picker may redraw after the selected row moves. The redraw can
 * scroll the first rows out of the viewport even though an earlier frame in
 * the same turn contained them. Retain only missing explicitly keyed rows
 * from an immediately preceding frame with the same heading; a different
 * heading starts a genuinely nested menu and must not inherit stale choices.
 */
function mergeRepeatedPickerOptions(
  lines: string[],
  latestStart: number,
  current: string[],
): string[] {
  const title = lines[latestStart]?.trim();
  if (!title) return current;

  let previousStart = -1;
  for (let index = latestStart - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? '';
    if (!line) continue;
    if (!isLiveInteractionPromptStart(line)) continue;
    if (line === title) previousStart = index;
    break;
  }
  if (previousStart < 0) return current;

  const currentOptions = parseLiveInteractionOptions(current.join('\n'));
  // Do not turn a redraw that contains only the heading into a stale card.
  // Wait until the current frame exposes at least a real pair of rows.
  if (currentOptions.length < 2) return current;
  const previousOptions = parseLiveInteractionOptions(
    lines.slice(previousStart, latestStart).join('\n'),
  );
  const keyedCurrent = new Set(
    currentOptions.flatMap((option) => (option.key ? [option.key] : [])),
  );
  const missing = previousOptions.filter(
    (option) => option.key && !keyedCurrent.has(option.key),
  );
  if (missing.length === 0) return current;

  const rows = missing
    .sort((left, right) => {
      if (/^\d+$/u.test(left.key!) && /^\d+$/u.test(right.key!)) {
        return Number(left.key) - Number(right.key);
      }
      return 0;
    })
    .map((option) => `${option.selected ? '›' : ' '} ${option.key}. ${option.label}`);
  const firstOption = current.findIndex((line) => isOptionSyntaxLine(line));
  const insertion = firstOption >= 0 ? firstOption : Math.min(1, current.length);
  return [...current.slice(0, insertion), ...rows, ...current.slice(insertion)];
}

/** Non-live agent prompts may be semantic questions without terminal controls. */
export function isBareAgentConfirmation(input: string): boolean {
  const recent = input.split('\n').map((line) => line.trim()).filter(Boolean).slice(-6).join('\n');
  return /\b(?:do\s+you\s+want\s+to|would\s+you\s+like\s+to|shall\s+i)\b[\s\S]{0,240}\b(?:proceed|continue|run|execute|apply|approve|allow)\b[\s\S]*\?\s*$/iu.test(
    recent,
  );
}

export function isActionableBinaryConfirmation(text: string): boolean {
  return (
    /\b(?:do\s+you\s+want\s+to|would\s+you\s+like\s+to|shall\s+i)\s+(?:proceed|continue|run|execute|apply|approve|allow|save|delete|overwrite|install|restart|stop|cancel)\b/iu.test(
      text,
    ) ||
    /\b(?:requires?\s+(?:approval|confirmation)|approve|allow)\b[\s\S]{0,240}\b(?:proceed|continue|run|execute|apply|approve|allow)\b/iu.test(
      text,
    )
  );
}

export function isLiveInteractionPromptStart(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || isCodeLikeInteractionLine(trimmed)) return false;
  return (
    /\bclaude\s+code\s+running\s+in\s+bypass\s+permissions\s+mode/iu.test(trimmed) ||
    /\bupdate\s+available\b/iu.test(trimmed) ||
    (/^select\b/iu.test(trimmed) && !/[.!。！？]\s*$/u.test(trimmed)) ||
    /^(?:reasoning (?:effort|level)|skills?)\b/iu.test(trimmed) ||
    /^choose\s+an\s+action\b/iu.test(trimmed) ||
    /^(?:command )?requires?\s+(?:approval|confirmation)\b/iu.test(trimmed) ||
    /^resume\s+previous\s+conversation\b/iu.test(trimmed) ||
    isCodexResumeControlLine(trimmed) ||
    /^(?:请选择|请(?:输入|回复).*(?:选项|编号|是|否)|等待(?:你|用户)(?:的)?(?:输入|选择|确认)|是否.*[？?])/u.test(line) ||
    // Generic terminal prompts are intentionally broad here. The structural
    // check below still requires option/control evidence, so ordinary prose
    // containing "choose" cannot become a card by itself.
    (GENERIC_INPUT_HINT_RE.test(trimmed) && /[?:：？]$|\b(?:now|below|from)\b/iu.test(trimmed))
  );
}

function isStructuredInteraction(lines: string[], requireCompletePickerFrame: boolean): boolean {
  const text = lines.join('\n');
  const tail = lines.at(-1) ?? '';
  const codexResume = CODEX_RESUME_CONTROLS_RE.test(text);
  const tailIsControl =
    codexResume ||
    BINARY_CONTROL_RE.test(tail) ||
    KEY_HINT_RE.test(tail) ||
    isLiveInputPromptLine(tail) ||
    GENERIC_INPUT_PROMPT_RE.test(tail) ||
    isStrongOptionSyntaxLine(tail);
  const hasPromptTitle = lines.some((line) => isLiveInteractionPromptStart(line.trim()));
  const hasPromptMarker = GENERIC_INPUT_PROMPT_RE.test(tail);
  const options = parseLiveInteractionOptions(lines.join('\n'), {
    includeAmbiguousBullets: hasPromptTitle || hasPromptMarker || KEY_HINT_RE.test(text),
  });
  const numberedChoiceCount = options.filter((option) => option.key && /^\d+$/u.test(option.key)).length;
  const hasNumberedChoice = numberedChoiceCount > 0;
  const hasOptions = options.length > 0;
  const hasBinaryControl = BINARY_CONTROL_RE.test(text);
  const hasKeyHint = KEY_HINT_RE.test(text);
  const firstOptionIndex = lines.findIndex((line) => isOptionSyntaxLine(line));
  const hasQuestionBeforeOptions =
    firstOptionIndex > 0 &&
    lines
      .slice(Math.max(0, firstOptionIndex - 2), firstOptionIndex)
      .some((line) => /[?？]\s*$/u.test(line.trim()));
  const lastOptionIndex = lines.reduce(
    (last, line, index) => (isOptionSyntaxLine(line) ? index : last),
    -1,
  );
  const hasInputPrompt =
    lastOptionIndex >= 0 &&
    lines
      .slice(lastOptionIndex + 1, lastOptionIndex + 5)
      .some(
        (line) =>
          !isOptionSyntaxLine(line) &&
          !GENERIC_INPUT_PROMPT_RE.test(line.trim()) &&
          isLiveInputPromptLine(line),
      );
  const selectedNavigationMenu =
    options.filter((option) => option.selected).length === 1 &&
    options.some((option) => !option.selected && option.navigationOnly) &&
    lines.filter((line) => /^\s*[›❯>▸]\s+\S/u.test(line)).length >= 2;
  const hasConfirmationQuestion = /\b(?:do\s+you\s+want\s+to|would\s+you\s+like\s+to|shall\s+i)\b[\s\S]{0,240}\b(?:proceed|continue|run|execute|apply|approve|allow)\b/iu.test(
    text,
  );
  const claudeBypass =
    /claude\s+code\s+running\s+in\s+bypass\s+permissions\s+mode/iu.test(text) &&
    /\b(?:no,?\s+exit|yes,?\s+i\s+accept)\b/iu.test(text);
  const codexUpdate =
    /\bupdate\s+available\b/iu.test(text) &&
    /\bskip(?:\s+until\s+next\s+version)?\b/iu.test(text);
  const completeNumberedPicker =
    numberedChoiceCount >= 2 ||
    (hasNumberedChoice && (hasKeyHint || hasPromptMarker || hasInputPrompt));
  const genericOptionCount = requireCompletePickerFrame
    ? options.length >= 2
    : options.length >= 2 || (hasOptions && (hasInputPrompt || hasPromptTitle));
  const hasStrongOptionRows = lines.some((line) => isStrongOptionSyntaxLine(line));
  const hasCodeLikeNoise = lines.some((line) => isCodeLikeInteractionLine(line));
  const hasRepeatedKeyedOptionLabels = repeatedKeyedOptionLabelGroups(options) >= 2;
  const hasCleanNumericOptionBlock = hasContiguousNumericOptionBlock(lines);
  const hasSelectedNumberedChoice = options.some(
    (option) => option.selected && Boolean(option.key && /^\d+$/u.test(option.key)),
  );
  const toolTraceRows = lines.filter(isToolTraceLine).length;
  const strongToolTraceRows = lines.filter((line) => {
    const trimmed = line.trim().replace(/^(?:[•◦⏺●]\s*)/u, '');
    return TOOL_TRACE_VERB_RE.test(trimmed) || TOOL_TRACE_RUN_RE.test(trimmed);
  }).length;
  const hasActivityConnector = lines.some(isActivityConnectorLine);
  const hasToolTraceEvidence =
    strongToolTraceRows >= 2 ||
    (strongToolTraceRows >= 1 && hasActivityConnector) ||
    (toolTraceRows >= 3 && hasActivityConnector);
  const hasExplicitPickerHeading = lines.some(isExplicitPickerHeading);
  const hasDocumentEvidence = lines.some(isAnswerDocumentLine) || hasAnswerDocumentShape(lines);
  // A stream of bridge activity can contain bullets, arrows, command output,
  // and even an `Esc`/`Enter` phrase from a status footer. Those rows are not
  // actionable choices. Only allow such a surface through when a real picker
  // heading or an explicit approval/resume/update protocol anchors it.
  const activityOnlySurface =
    hasToolTraceEvidence &&
    !hasExplicitPickerHeading &&
    !hasConfirmationQuestion &&
    !hasBinaryControl &&
    !codexResume &&
    !codexUpdate;
  const documentOnlySurface =
    hasDocumentEvidence &&
    !hasExplicitPickerHeading &&
    !hasConfirmationQuestion &&
    !codexResume &&
    !codexUpdate &&
    !selectedNavigationMenu;
  const genericInputEvidence =
    hasInputPrompt ||
    hasPromptMarker ||
    selectedNavigationMenu ||
    (hasQuestionBeforeOptions && hasStrongOptionRows);

  return (
    !hasCodeLikeNoise &&
    !hasRepeatedKeyedOptionLabels &&
    !activityOnlySurface &&
    !documentOnlySurface &&
    (claudeBypass ||
    codexUpdate ||
    codexResume ||
    (hasPromptTitle && tailIsControl && (
      (requireCompletePickerFrame ? completeNumberedPicker : hasNumberedChoice) ||
      hasBinaryControl ||
      (hasKeyHint && tailIsControl)
    )) ||
    (hasConfirmationQuestion && (hasNumberedChoice || hasBinaryControl)) ||
    ((requireCompletePickerFrame ? completeNumberedPicker : hasNumberedChoice) &&
      hasKeyHint &&
      tailIsControl &&
      !hasCodeLikeNoise &&
      (hasPromptTitle || hasQuestionBeforeOptions || hasCleanNumericOptionBlock)) ||
    // A native picker may retain only its numbered viewport rows. A selected
    // numeric row is the TUI's direct evidence that this is an active menu;
    // do not infer that state from arbitrary numbered prose.
    (hasCleanNumericOptionBlock && hasSelectedNumberedChoice) ||
    (hasBinaryControl && /(?:approval|confirmation|allow|proceed|continue|确认|允许|继续)/iu.test(text)) ||
    // Vendor-neutral menus may have no title or Enter/Esc legend. Requiring
    // multiple option rows plus a nearby input prompt/marker prevents normal
      // bullet lists from being promoted to interactive cards. A question mark
    // immediately before the option block is equivalent prompt evidence for
    // CLIs that render no title or key legend.
    (hasOptions &&
      // A single highlighted `▸ Running ...` line is ordinary terminal
      // activity, not enough evidence of a picker. Generic menus need a
      // complete pair unless an explicit prompt proves that the terminal is
      // waiting, while titled/native pickers can publish a one-row frame with
      // an Enter/answer prompt.
      genericOptionCount &&
      genericInputEvidence))
  );
}

function isAnswerDocumentLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return (
    /^(?:#{1,6}\s+|[一二三四五六七八九十百]+[、.]\s*|(?:建议|推荐|当前|完整|详细|方案|说明|实现|优化|测试|验证|正文|另外|这里|因此|首先|其次)\b)/u.test(
      trimmed,
    ) ||
    /(?:^|\s)(?:src|tests?|lib|dist|chem|research_[a-z0-9_-]+)\/[A-Za-z0-9_.~@+-]+(?:\/[A-Za-z0-9_.~@+-]+)*(?::\d+)?/u.test(
      trimmed,
    ) ||
    /\b(?:sendCompleteReplyChunks|collapsible_panel|Markdown|TypeScript|Python|DeFoG|MMELON)\b/u.test(
      trimmed,
    )
  );
}

function hasAnswerDocumentShape(lines: string[]): boolean {
  const numberedRows = lines.filter((line) => /^\s*\d{1,2}[.)、:：]\s+\S/u.test(line)).length;
  const proseRows = lines.filter((line) => {
    const trimmed = line.trim();
    return trimmed.length >= 24 && !isOptionSyntaxLine(trimmed) && !isInteractionHintLine(trimmed);
  }).length;
  return numberedRows >= 2 && proseRows >= 2;
}

/**
 * A source diff or a reflowed history replay can leave several numbered
 * copies of the same model row in the tail (for example keys 2, 173 and 179
 * all carrying `gpt-5.6-terra`). Real pickers assign one key per label; two or
 * more repeated labels are therefore strong evidence that the visible rows
 * are not one actionable menu.
 */
function repeatedKeyedOptionLabelGroups(options: LiveInteractionOption[]): number {
  const keysByLabel = new Map<string, Set<string>>();
  for (const option of options) {
    if (!option.key) continue;
    const label = option.label
      .replace(/\s*\((?:current|selected|default)\)\s*$/iu, '')
      .replace(/\s+/gu, ' ')
      .trim()
      .toLocaleLowerCase();
    if (!label) continue;
    const keys = keysByLabel.get(label) ?? new Set<string>();
    keys.add(option.key);
    keysByLabel.set(label, keys);
  }
  let groups = 0;
  for (const keys of keysByLabel.values()) {
    if (keys.size >= 2) groups += 1;
  }
  return groups;
}

function hasContiguousNumericOptionBlock(lines: string[]): boolean {
  return latestContiguousNumericOptionBlock(lines) !== undefined;
}

function latestContiguousNumericOptionBlock(
  lines: string[],
): { start: number; end: number } | undefined {
  let runLength = 0;
  let previousKey: number | undefined;
  let runStart = 0;
  let latest: { start: number; end: number } | undefined;
  for (const [index, line] of lines.entries()) {
    const match = line.trim().match(OPTION_LINE_RE);
    const rawKey = match?.groups?.number;
    if (!rawKey || isCodeLikeInteractionLine(line)) {
      if (runLength >= 2) latest = { start: runStart, end: index - 1 };
      runLength = 0;
      previousKey = undefined;
      continue;
    }
    const key = Number(rawKey);
    if (previousKey !== undefined && key === previousKey + 1) {
      runLength += 1;
    } else {
      runLength = 1;
      runStart = index;
    }
    previousKey = key;
  }
  if (runLength >= 2) latest = { start: runStart, end: lines.length - 1 };
  return latest;
}

function isCodexResumeControlLine(line: string): boolean {
  return /\benter\s+(?:to\s+)?resume\b.*\besc\s+(?:to\s+)?exit\b/iu.test(line);
}
