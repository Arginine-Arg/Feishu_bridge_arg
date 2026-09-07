import { describe, expect, it, vi } from 'vitest';
import { AsyncEventQueue } from '../../../src/agent/event-queue';
import type { AgentEvent } from '../../../src/agent/types';

const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => sdk);
import { ClaudeStructuredSession } from '../../../src/agent/structured/claude';

function harness() {
  const raw = new AsyncEventQueue<any>();
  const close = raw.close.bind(raw);
  const query = Object.assign(raw, {
    initializationResult: async () => ({}), interrupt: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}), supportedModels: async () => [{ value: 'model-a', displayName: 'Model A' }],
    supportedCommands: async () => [{ name: 'review', description: 'Review' }], close,
  });
  sdk.query.mockReturnValue(query);
  const session = new ClaudeStructuredSession('session-id', { cwd: '/test', permissionMode: 'default' }, sdk.query);
  const options = sdk.query.mock.calls.at(-1)![0];
  const events: AgentEvent[] = [];
  return { raw, query, session, options, events };
}

describe('Claude structured transport', () => {
  it('interrupts once and waits for the explicit result before completing', async () => {
    const h = harness(); await h.session.ready();
    const abort = new AbortController();
    let complete = false;
    const done = h.session.submit({ runId: 'r', prompt: 'task' }, event => h.events.push(event), abort.signal).then(() => { complete = true; });
    abort.abort(); abort.abort();
    await Promise.resolve();
    expect(h.query.interrupt).toHaveBeenCalledTimes(1); expect(complete).toBe(false);
    h.raw.push({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['interrupted'] });
    await done;
    expect(h.events.some(event => event.type === 'done' && event.terminationReason === 'interrupted')).toBe(true);
    expect(h.events.some(event => event.type === 'error')).toBe(false);
    await h.session.close();
  });
  it('preserves native prompt preset and sends exact text once, with no Enter or text replay', async () => {
    const h = harness(); await h.session.ready();
    expect(h.options.options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' });
    expect(h.options.options).not.toHaveProperty('appendSystemPrompt');
    const done = h.session.submit({ runId: 'r', prompt: 'exact\ntext' }, event => h.events.push(event), new AbortController().signal);
    const input = await h.options.prompt[Symbol.asyncIterator]().next();
    expect(input.value.message.content).toEqual([{ type: 'text', text: 'exact\ntext' }]);
    h.raw.push({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm' } } });
    h.raw.push({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } } });
    h.raw.push({ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'answer' }] } });
    h.raw.push({ type: 'result', subtype: 'success', is_error: false, result: 'answer' });
    await done;
    expect(h.events.filter(e => e.type === 'text').map(e => e.delta).join('')).toBe('answer');
    await h.session.close();
  });
  it('resolves one permission request from a numeric choice without starting another model task', async () => {
    const h = harness(); await h.session.ready();
    const done = h.session.submit({ runId: 'r', prompt: 'task' }, event => h.events.push(event), new AbortController().signal);
    const approval = h.options.options.canUseTool('Bash', { command: 'echo test' }, { signal: new AbortController().signal, toolUseID: 'tool-1' });
    expect(h.session.freeTextRequest()).toBeUndefined();
    expect(h.events.some(e => e.type === 'interactive' && e.interaction?.id === 'tool-1')).toBe(true);
    await h.session.command('2');
    expect(await approval).toMatchObject({ behavior: 'deny' });
    expect(sdk.query).toHaveBeenCalled();
    await expect(h.session.answer('tool-1', 'allow')).rejects.toThrow();
    h.raw.push({ type: 'result', subtype: 'success', is_error: false, result: 'done' });
    await done; await h.session.close();
  });

  it('answers AskUserQuestion through its tool response rather than starting a new turn', async () => {
    const h = harness(); await h.session.ready();
    const done = h.session.submit({ runId: 'r', prompt: 'task' }, event => h.events.push(event), new AbortController().signal);
    const answer = h.options.options.canUseTool('AskUserQuestion', { questions: [{ question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] },
      { signal: new AbortController().signal, toolUseID: 'question-1' });
    expect(h.session.freeTextRequest()).toBe('question-1.q0');
    await h.session.command('/answer question-1.q0 2');
    expect(await answer).toMatchObject({ behavior: 'allow', updatedInput: { answers: { 'Which database?': 'SQLite' } } });
    h.raw.push({ type: 'result', subtype: 'success', is_error: false, result: 'done' });
    await done; await h.session.close();
  });
  it('keeps provider failures as failures rather than a successful empty completion', async () => {
    const h = harness(); await h.session.ready();
    const done = h.session.submit({ runId: 'r', prompt: 'task' }, event => h.events.push(event), new AbortController().signal);
    h.raw.push({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['quota exhausted'] });
    await done;
    expect(h.events.some(e => e.type === 'error' && e.message === 'quota exhausted')).toBe(true);
    await h.session.close();
  });
});
