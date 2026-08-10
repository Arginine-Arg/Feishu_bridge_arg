import type { AgentEvent } from '../types';

interface AgyNativeEvent {
  event?: string;
  conversation_id?: string;
  init?: {
    cwd?: string;
    model?: string;
    conversation_id?: string;
  };
  step_update?: {
    conversation_id?: string;
    step_index?: number;
    state?: 'ACTIVE' | 'DONE' | string;
    step_type?: 'user_input' | 'agent_response' | 'tool' | 'checkpoint' | 'thinking' | string;
    text_delta?: string;
    thinking_delta?: string;
    thinking?: string;
    tool_name?: string;
    tool_info?: {
      name?: string;
      parameters?: unknown;
      output?: unknown;
    };
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      thinking_tokens?: number;
      cache_read_tokens?: number;
      total_tokens?: number;
    };
  };
  result?: {
    conversation_id?: string;
    status?: string;
    response?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      thinking_tokens?: number;
      cache_read_tokens?: number;
      total_tokens?: number;
    };
  };

  // Fallback for Claude-style stream-json schema
  type?: string;
  subtype?: string;
  session_id?: string;
  cwd?: string;
  model?: string;
  message?: {
    content?: Array<{
      type: string;
      text?: string;
      thinking?: string;
      id?: string;
      name?: string;
      input?: unknown;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
    }>;
  };
}

export function* translateEvent(raw: unknown): Generator<AgentEvent> {
  if (!raw || typeof raw !== 'object') return;
  const evt = raw as AgyNativeEvent;

  // 1. Native agy format: event === 'init'
  if (evt.event === 'init') {
    yield {
      type: 'system',
      sessionId: evt.conversation_id || evt.init?.conversation_id,
      cwd: evt.init?.cwd,
      model: evt.init?.model,
    };
    return;
  }

  // 2. Native agy format: event === 'step_update'
  if (evt.event === 'step_update' && evt.step_update) {
    const su = evt.step_update;

    if (su.step_type === 'agent_response') {
      if (typeof su.text_delta === 'string' && su.text_delta) {
        yield { type: 'text', delta: su.text_delta };
      }
      const thinking = su.thinking_delta ?? su.thinking;
      if (typeof thinking === 'string' && thinking) {
        yield { type: 'thinking', delta: thinking };
      }
    } else if (su.step_type === 'tool') {
      const toolId = String(su.step_index ?? 'tool');
      const toolName = su.tool_name || su.tool_info?.name || 'tool';
      if (su.state === 'ACTIVE') {
        yield {
          type: 'tool_use',
          id: toolId,
          name: toolName,
          input: su.tool_info?.parameters,
        };
      } else if (su.state === 'DONE' && su.tool_info?.output !== undefined) {
        const output =
          typeof su.tool_info.output === 'string'
            ? su.tool_info.output
            : JSON.stringify(su.tool_info.output);
        yield {
          type: 'tool_result',
          id: toolId,
          output,
          isError: false,
        };
      }
    } else if (su.step_type === 'thinking') {
      const thinking = su.thinking_delta ?? su.thinking;
      if (typeof thinking === 'string' && thinking) {
        yield { type: 'thinking', delta: thinking };
      }
    }
    return;
  }

  // 3. Native agy format: event === 'result'
  if (evt.event === 'result' && evt.result) {
    const res = evt.result;
    if (res.usage) {
      yield {
        type: 'usage',
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
        cachedInputTokens: res.usage.cache_read_tokens,
      };
    }
    yield {
      type: 'done',
      sessionId: res.conversation_id || evt.conversation_id,
      terminationReason: 'normal',
    };
    return;
  }

  // 4. Fallback for Claude-style stream-json schema
  if (evt.type === 'system' && evt.subtype === 'init') {
    yield {
      type: 'system',
      sessionId: evt.session_id,
      cwd: evt.cwd,
      model: evt.model,
    };
    return;
  }

  if (evt.type === 'assistant' && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        yield { type: 'text', delta: block.text };
      } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
        yield { type: 'thinking', delta: block.thinking };
      } else if (block.type === 'tool_use' && block.id && block.name) {
        yield { type: 'tool_use', id: block.id, name: block.name, input: block.input };
      }
    }
    return;
  }

  if (evt.type === 'user' && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        const output =
          typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        yield {
          type: 'tool_result',
          id: block.tool_use_id,
          output,
          isError: block.is_error === true,
        };
      }
    }
    return;
  }

  if (evt.type === 'result') {
    yield { type: 'done', sessionId: evt.session_id, terminationReason: 'normal' };
  }
}
