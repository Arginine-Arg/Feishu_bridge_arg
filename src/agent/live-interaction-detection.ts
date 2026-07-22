const MAX_INTERACTION_LINES = 40;
const FALLBACK_INTERACTION_LINES = 12;

const NUMBERED_CHOICE_RE = /^(?:[›❯>▸*+-]\s*)?\d{1,2}[.)、:\s-]+\S/u;
const BINARY_CONTROL_RE = /\b(?:y\/n|yes\/no|no\/yes)\b|\[(?:y|yes)\/(?:n|no)\]|\((?:y|yes)\/(?:n|no)\)/iu;
const KEY_HINT_RE = /(?:press\s+)?enter\s+to\s+(?:confirm|continue)|esc(?:ape)?\s+to\s+(?:go\s+back|cancel)|(?:↑|↓|up\/down|arrow keys?|use .*arrows?)|(?:按下?|点击)回车(?:键)?.*确认|(?:按下?|点击).*(?:esc|取消|返回)/iu;

/**
 * Return only the active terminal picker/approval surface. Ordinary prose can
 * contain words such as "select", "请选择", or "是否", so a title alone is
 * never sufficient: the current tail must expose an actionable control.
 */
export function liveInteractionSurface(input: string): string | undefined {
  const recent = input
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^_(?:🧠 正在思考…|🧰 正在调用工具…|✍️ 正在输出…)_$/u.test(line))
    .slice(-MAX_INTERACTION_LINES);
  if (recent.length === 0) return undefined;

  let start = -1;
  for (let index = 0; index < recent.length; index += 1) {
    if (isLiveInteractionPromptStart(recent[index]!)) start = index;
  }
  const candidate = start >= 0 ? recent.slice(start) : recent.slice(-FALLBACK_INTERACTION_LINES);
  if (!isStructuredInteraction(candidate)) return undefined;
  return candidate.join('\n');
}

export function isStructuredLiveInteraction(input: string): boolean {
  return liveInteractionSurface(input) !== undefined;
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
    /^(?:请选择|请(?:输入|回复).*(?:选项|编号|是|否)|等待(?:你|用户)(?:的)?(?:输入|选择|确认)|是否.*[？?])/u.test(
      line,
    )
  );
}

function isStructuredInteraction(lines: string[]): boolean {
  const text = lines.join('\n');
  const tail = lines.at(-1) ?? '';
  const tailIsControl =
    NUMBERED_CHOICE_RE.test(tail) || BINARY_CONTROL_RE.test(tail) || KEY_HINT_RE.test(tail);
  if (!tailIsControl) return false;

  const hasNumberedChoice = lines.some((line) => NUMBERED_CHOICE_RE.test(line));
  const hasBinaryControl = BINARY_CONTROL_RE.test(text);
  const hasKeyHint = KEY_HINT_RE.test(text);
  const hasPromptTitle = lines.some(isLiveInteractionPromptStart);
  const hasConfirmationQuestion = /\b(?:do\s+you\s+want\s+to|would\s+you\s+like\s+to|shall\s+i)\b[\s\S]{0,240}\b(?:proceed|continue|run|execute|apply|approve|allow)\b/iu.test(
    text,
  );
  const claudeBypass =
    /claude\s+code\s+running\s+in\s+bypass\s+permissions\s+mode/iu.test(text) &&
    /\b(?:no,?\s+exit|yes,?\s+i\s+accept)\b/iu.test(text);
  const codexUpdate =
    /\bupdate\s+available\b/iu.test(text) &&
    /\bskip(?:\s+until\s+next\s+version)?\b/iu.test(text);

  return (
    claudeBypass ||
    codexUpdate ||
    (hasPromptTitle && (hasNumberedChoice || hasBinaryControl || hasKeyHint)) ||
    (hasConfirmationQuestion && (hasNumberedChoice || hasBinaryControl)) ||
    (hasNumberedChoice && hasKeyHint) ||
    (hasBinaryControl && /(?:approval|confirmation|allow|proceed|continue|确认|允许|继续)/iu.test(text))
  );
}
