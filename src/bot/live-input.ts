import type { NormalizedMessage } from '@larksuite/channel';

export type LiveInputMode = 'command' | 'control';

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
  return mode === 'command' || mode === 'control' ? mode : undefined;
}
