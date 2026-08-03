// Native model pickers can list more than a single terminal viewport. Keep
// enough history to reconstruct the complete choice set instead of making the
// card depend on whatever rows happened to be visible during a redraw.
const MAX_INTERACTION_LINES = 120;
const FALLBACK_INTERACTION_LINES = 12;

const OPTION_LINE_RE = /^(?<selected>[›❯>▸])?\s*(?:(?<number>\d{1,4})(?:[.)、:：-]|\s{1,3})\s*|(?<letter>[A-Za-z])(?:[.)、:：-]|\s{1,3})\s*|\[(?<checkbox>[ xX✓✔])\]\s*|(?<bullet>[-*•])\s+|(?<radio>[◉○●◯])\s*)(?<label>\S.*)$/u;
const BARE_NAV_OPTION_RE = /^(?<selected>[›❯>▸])\s+(?<label>\S.*)$/u;
const INDENTED_NAV_OPTION_RE = /^\s{2,}(?<label>\S.*)$/u;
const BINARY_CONTROL_RE = /\b(?:y\/n|yes\/no|no\/yes)\b|\[(?:y|yes)\/(?:n|no)\]|\((?:y|yes)\/(?:n|no)\)/iu;
const KEY_HINT_RE = /(?:press\s+)?enter\s+to\s+(?:confirm|continue)|esc(?:ape)?\s+to\s+(?:go\s+back|cancel)|(?:↑|↓|up\/down|arrow keys?|use .*arrows?)|(?:按下?|点击)回车(?:键)?.*确认|(?:按下?|点击).*(?:esc|取消|返回)/iu;
const CODEX_RESUME_CONTROLS_RE = /\benter\s+(?:to\s+)?resume\b[\s\S]{0,600}\besc\s+(?:to\s+)?exit\b/iu;
const GENERIC_INPUT_HINT_RE = /(?:choose|select|pick|option|choice|answer|respond|input|type|enter|confirm|continue|proceed|approve|allow|navigate|use\s+(?:the\s+)?(?:arrow|number|letter)|按下?|请输入|输入|选择|选项|编号|确认|继续|批准|允许|回答|回复|回车)/iu;
const GENERIC_INPUT_PROMPT_RE = /(?:[?:：？]\s*$|(?:^|\s)[›❯>]\s*$|(?:^|\s)_\s*$)/u;

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
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
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

function hasBareNavigationAnchor(lines: string[], index: number): boolean {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const line = lines[cursor] ?? '';
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
  // Rendering waits for a complete picker frame so the first card does not
  // omit later options that arrive in the next terminal redraw.
  if (!candidate || !isStructuredInteraction(candidate, true)) return undefined;
  return candidate.join('\n');
}

export function isStructuredLiveInteraction(input: string): boolean {
  const candidate = interactionCandidate(input);
  // Classification still identifies an in-progress picker immediately. This
  // controls relay lifecycle and prevents its first rendered option from
  // being mistaken for a normal final response; only card publication waits
  // for a complete frame above.
  return Boolean(candidate && isStructuredInteraction(candidate, false));
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
    return recent.slice(optionStart);
  }
  return recent.slice(-FALLBACK_INTERACTION_LINES);
}

/** Non-live agent prompts may be semantic questions without terminal controls. */
export function isBareAgentConfirmation(input: string): boolean {
  const recent = input.split('\n').map((line) => line.trim()).filter(Boolean).slice(-6).join('\n');
  return /\b(?:do\s+you\s+want\s+to|would\s+you\s+like\s+to|shall\s+i)\b[\s\S]{0,240}\b(?:proceed|continue|run|execute|apply|approve|allow)\b[\s\S]*\?\s*$/iu.test(
    recent,
  );
}

export function isLiveInteractionPromptStart(line: string): boolean {
  return (
    /claude\s+code\s+running\s+in\s+bypass\s+permissions\s+mode/iu.test(line) ||
    /\bupdate\s+available\b/iu.test(line) ||
    /\bselect\s+(?:a\s+)?(?:model|reasoning|option|permission|session)\b/iu.test(line) ||
    /^(?:reasoning (?:effort|level)|skills?)\b/iu.test(line) ||
    /\bchoose\s+an\s+action\b/iu.test(line) ||
    /\b(?:command )?requires?\s+(?:approval|confirmation)\b/iu.test(line) ||
    /\bresume\s+previous\s+conversation\b/iu.test(line) ||
    isCodexResumeControlLine(line) ||
    /^(?:请选择|请(?:输入|回复).*(?:选项|编号|是|否)|等待(?:你|用户)(?:的)?(?:输入|选择|确认)|是否.*[？?])/u.test(line) ||
    // Generic terminal prompts are intentionally broad here. The structural
    // check below still requires option/control evidence, so ordinary prose
    // containing "choose" cannot become a card by itself.
    (GENERIC_INPUT_HINT_RE.test(line) && /[?:：？]$|\b(?:now|below|from)\b/iu.test(line.trim()))
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
  const genericInputEvidence =
    hasInputPrompt ||
    hasPromptMarker ||
    selectedNavigationMenu ||
    (hasQuestionBeforeOptions && hasStrongOptionRows);

  return (
    claudeBypass ||
    codexUpdate ||
    codexResume ||
    (hasPromptTitle && tailIsControl && (
      (requireCompletePickerFrame ? completeNumberedPicker : hasNumberedChoice) ||
      hasBinaryControl ||
      (hasKeyHint && tailIsControl)
    )) ||
    (hasConfirmationQuestion && (hasNumberedChoice || hasBinaryControl)) ||
    ((requireCompletePickerFrame ? completeNumberedPicker : hasNumberedChoice) && hasKeyHint && tailIsControl) ||
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
      genericInputEvidence)
  );
}

function isCodexResumeControlLine(line: string): boolean {
  return /\benter\s+(?:to\s+)?resume\b.*\besc\s+(?:to\s+)?exit\b/iu.test(line);
}
