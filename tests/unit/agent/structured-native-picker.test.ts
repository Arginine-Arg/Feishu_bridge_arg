import { describe, expect, it, vi } from 'vitest';
import { isNativePickerControl, nativePickerSurface, sendNativePickerControl } from '../../../src/agent/structured/native-picker';
import type { TmuxPaneTarget } from '../../../src/agent/tmux-control';

const waiting = [
  '• Ran python run_jobs.py',
  '  └ (no output)',
  '',
  'Giving this request a little extra thought',
  '',
  '› 1. Dismiss and keep waiting',
  '  2. Learn more',
  '',
  'No action is required. Codex will keep waiting, and this menu will close when the response is ready.',
].join('\n');
const model = 'Select Model and Effort\n› 1. gpt-test\n  2. other-model\nPress enter to confirm or esc to go back';
const target: TmuxPaneTarget = {
  socketPath: '/tmp/menu.sock', sessionName: 'codex', windowIndex: '0', paneIndex: '0', paneId: '%1',
  panePid: 123, paneCurrentCommand: 'codex', paneCurrentPath: '/workspace', agentKind: 'codex',
  ownership: 'external', attachCommand: 'tmux attach', structured: { endpoint: 'unix:///server.sock', threadId: 'thread-a' },
};

function harness(screen = waiting) {
  return { capture: vi.fn(() => screen), send: vi.fn(), resolve: vi.fn(() => target) };
}

describe('structured native picker control', () => {
  it('recognizes the exact TUI wait popup including a wrapped footer', () => {
    expect(nativePickerSurface(waiting)?.options.map(option => option.label)).toEqual(['Dismiss and keep waiting', 'Learn more']);
    expect(nativePickerSurface(waiting.replace('when the response', 'when the\nresponse'))).toBeDefined();
  });
  it('chooses a numbered option through native navigation once', () => {
    const io = harness();
    sendNativePickerControl(io.resolve, '1', io);
    expect(io.send.mock.calls).toEqual([[target, ['Enter']]]);
    io.send.mockClear();
    sendNativePickerControl(io.resolve, '2 enter', io);
    expect(io.send.mock.calls).toEqual([[target, ['Down', 'Enter']]]);
  });
  it('supports explicit escape, Enter and navigation on a visible menu', () => {
    for (const [input, keys] of [['esc', ['Escape']], ['enter', ['Enter']], ['down enter', ['Down', 'Enter']]] as const) {
      const io = harness(); sendNativePickerControl(io.resolve, input, io);
      expect(io.send.mock.calls).toEqual([[target, keys]]);
    }
    const io = harness(model); sendNativePickerControl(io.resolve, '2', io);
    expect(io.send.mock.calls).toEqual([[target, ['Down', 'Enter']]]);
  });
  it('rejects text, interrupt keys, invalid options and keys after confirmation', () => {
    for (const input of ['continue', '/goal resume', 'ctrl+c', '2 restart', '42']) {
      const io = harness();
      expect(() => sendNativePickerControl(io.resolve, input, io)).toThrow();
      expect(io.send).not.toHaveBeenCalled();
    }
    const io = harness();
    expect(() => sendNativePickerControl(io.resolve, 'enter down', io)).toThrow('最后一个按键');
    expect(io.send).not.toHaveBeenCalled();
    expect(isNativePickerControl('down '.repeat(17))).toBe(false);
  });
  it('does not turn old menus, numbered prose or tool output into controls', () => {
    for (const screen of [
      `${waiting}\n› Ask Codex to do anything`,
      `${model}\n› Ask Codex to do anything`,
      'Implementation plan:\n› 1. Read files\n  2. Run tests',
      '• Ran cat code.rs\n└ Select action\n  1. foo\n  2. bar',
      '````\n' + model + '\n````',
      '• Working (esc to interrupt)\n›',
    ]) {
      const io = harness(screen);
      expect(() => sendNativePickerControl(io.resolve, '1', io), screen).toThrow();
      expect(io.send).not.toHaveBeenCalled();
    }
  });
  it('rejects a menu that auto-closed between capture and the key send', () => {
    const io = harness();
    io.capture.mockReturnValueOnce(waiting).mockReturnValueOnce('› Ask Codex to do anything');
    expect(() => sendNativePickerControl(io.resolve, '1', io)).toThrow('变化或关闭');
    expect(io.send).not.toHaveBeenCalled();
  });
  it('rejects a changed thread or pane without sending keys', () => {
    const io = harness();
    io.resolve.mockReturnValueOnce(target).mockReturnValueOnce({ ...target, structured: { ...target.structured!, threadId: 'thread-b' } });
    expect(() => sendNativePickerControl(io.resolve, '1', io)).toThrow('会话已经改变');
    expect(io.send).not.toHaveBeenCalled();
  });
  it('requires a live native pane and the same current menu', () => {
    const io = harness();
    expect(() => sendNativePickerControl(() => undefined, '1', io)).toThrow('没有绑定');
    io.capture.mockReturnValueOnce(waiting).mockReturnValueOnce(model);
    expect(() => sendNativePickerControl(io.resolve, '1', io)).toThrow('变化或关闭');
    expect(io.send).not.toHaveBeenCalled();
  });
});
