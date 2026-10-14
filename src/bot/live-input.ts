import type { NormalizedMessage } from '@larksuite/channel';

export type LiveInputMode = 'command' | 'control' | 'side' | 'side-exit';

const NATIVE_AGENT_COMMAND_RAW_KEY = '__larkChannelNativeAgentCommand';
const FORCE_LIVE_AGENT_COMMAND_RAW_KEY = '__larkChannelForceLiveAgentCommand';
const LIVE_INPUT_MODE_RAW_KEY = '__larkChannelLiveInputMode';

export function markNativeAgentCommand(
  msg: NormalizedMessage,
  mode?: LiveInputMode,
): NormalizedMessage {
  const raw = msg.raw && typeof msg.raw === 'object' && !Array.isArray(msg.raw)
    ? { ...(msg.raw as Record<string, unknown>) }
    : {};
  return {
    ...msg,
    content: msg.content.trimStart(),
    raw: {
      ...raw,
      [NATIVE_AGENT_COMMAND_RAW_KEY]: true,
      ...(mode ? { [FORCE_LIVE_AGENT_COMMAND_RAW_KEY]: true, [LIVE_INPUT_MODE_RAW_KEY]: mode } : {}),
    },
  };
}

export function isNativeAgentCommandMessage(msg: NormalizedMessage): boolean {
  return Boolean(
    msg.raw &&
      typeof msg.raw === 'object' &&
      !Array.isArray(msg.raw) &&
      (msg.raw as Record<string, unknown>)[NATIVE_AGENT_COMMAND_RAW_KEY] === true,
  );
}

export function isForceLiveAgentCommandMessage(msg: NormalizedMessage): boolean {
  return Boolean(
    msg.raw &&
      typeof msg.raw === 'object' &&
      !Array.isArray(msg.raw) &&
      (msg.raw as Record<string, unknown>)[FORCE_LIVE_AGENT_COMMAND_RAW_KEY] === true,
  );
}

export function liveInputModeForMessage(msg: NormalizedMessage): LiveInputMode | undefined {
  if (!msg.raw || typeof msg.raw !== 'object' || Array.isArray(msg.raw)) return undefined;
  const mode = (msg.raw as Record<string, unknown>)[LIVE_INPUT_MODE_RAW_KEY];
  return mode === 'command' || mode === 'control' || mode === 'side' || mode === 'side-exit'
    ? mode
    : undefined;
}

/**
 * Group messages can still carry a leading `@bot` token when the platform did
 * not match the mention to the bot identity (for example a missing bot
 * `open_id`, or a client that inserted the mention as plain text). Such a
 * prefix must not hide an otherwise valid `/command`: without this the bridge
 * classifies `/goal …`, `/model`, `/stop` as ordinary prompts and types
 * "@bot /goal …" into the agent instead of running the command.
 *
 * Only a mention immediately followed by a slash command is removed, so
 * ordinary conversation that starts with a mention is untouched.
 */
export function contentWithoutLeadingMention(
  content: string,
  mentionedBot: boolean,
): string {
  if (!mentionedBot) return content;
  const match = /^\s*@[^\s/]+\s+(\/[\s\S]*)$/u.exec(content);
  return match ? match[1]!.trimStart() : content;
}
