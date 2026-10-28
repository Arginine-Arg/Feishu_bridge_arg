import { describe, expect, it } from 'vitest';
import { initialState, markRunFailed, reduce } from '../../../src/card/run-state';

describe('run state terminal event schema', () => {
  it('maps done termination reasons onto visible terminal states', () => {
    expect(reduce(initialState, { type: 'done', terminationReason: 'normal' }).terminal).toBe(
      'done',
    );
    expect(
      reduce(initialState, { type: 'done', terminationReason: 'interrupted' }).terminal,
    ).toBe('interrupted');
    expect(reduce(initialState, { type: 'done', terminationReason: 'timeout' })).toMatchObject({
      terminal: 'error',
      errorMsg: 'agent 执行超时',
    });
  });

  it('maps error termination reasons onto visible terminal states', () => {
    expect(
      reduce(initialState, {
        type: 'error',
        message: 'failed',
        terminationReason: 'failed',
      }).terminal,
    ).toBe('error');
    expect(
      reduce(initialState, {
        type: 'error',
        message: 'stopped',
        terminationReason: 'interrupted',
      }).terminal,
    ).toBe('interrupted');
    expect(
      reduce(initialState, {
        type: 'error',
        message: 'timeout',
        terminationReason: 'timeout',
      }),
    ).toMatchObject({
      terminal: 'error',
      errorMsg: 'timeout',
    });
  });

  it('keeps idle-watchdog timeouts distinct from agent timeouts', () => {
    const reduced = reduce(initialState, {
      type: 'error',
      message: 'MixAgents side 90 秒超时，worker 已停止。',
      terminationReason: 'timeout',
    });
    expect(reduced.terminal).toBe('error');
    expect(reduced.errorMsg).toContain('90 秒超时');
    expect(reduced.idleTimeoutMinutes).toBeUndefined();
  });

  it('does not present an unterminated agent event stream as successful', () => {
    const state = markRunFailed(
      reduce(initialState, { type: 'text', delta: 'partial result' }),
      'agent 事件流在未报告完成状态时结束。请检查 tmux 或重试。',
    );

    expect(state.terminal).toBe('error');
    expect(state.errorMsg).toContain('未报告完成状态');
  });
});
