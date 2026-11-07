import { parseLiveControlSequence } from '../live-session';
import { liveInteractionSurface, parseLiveInteractionOptions, type LiveInteractionOption } from '../live-interaction-detection';
import { isSafeTmuxSocket, type TmuxPaneTarget } from '../tmux-control';
import { spawnProcessSync } from '../../platform/spawn';

interface NativePickerSurface {
  text: string;
  options: LiveInteractionOption[];
}

/** Only menu navigation enters this lane; text, slash commands and Ctrl-C do not. */
export function isNativePickerControl(input: string): boolean {
  const text = input.trim();
  if (/^\d{1,3}(?:\s+(?:enter|return|回车|确认))?$/iu.test(text)) return true;
  const sequence = parseLiveControlSequence(text);
  return Boolean(sequence && sequence.length <= 16 && sequence.every(key =>
    ['\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D', '\r', '\x1b', '\t', ' '].includes(key),
  ));
}

export function nativePickerSurface(screen: string): NativePickerSurface | undefined {
  const lines: string[] = [];
  let fenced = false;
  for (const line of screen.split('\n')) {
    if (/^\s*(?:```|~~~)/u.test(line)) { fenced = !fenced; continue; }
    if (!fenced) lines.push(line.trimEnd());
  }
  // This informational TUI popup has no App Server request or Enter/Esc
  // legend. Require its actual heading, both choices and waiting footer.
  let start = -1;
  for (const [index, line] of lines.entries()) {
    if (/^\s*Giving this request a little extra thought\s*$/iu.test(line)) start = index;
  }
  if (start >= 0) {
    const text = lines.slice(start).join('\n').trim();
    const options = parseLiveInteractionOptions(text);
    if (options.length === 2 && options[0]?.key === '1' && options[1]?.key === '2' &&
        /^Dismiss and keep waiting$/iu.test(options[0].label) && /^Learn more$/iu.test(options[1].label) &&
        options.some(option => option.selected) &&
        /No action is required\. Codex will keep waiting, and this menu will close when the response is ready\.\s*$/iu.test(text.replace(/\s+/gu, ' '))) {
      return { text, options };
    }
  }
  const tail = lines.filter(line => line.trim()).at(-1) ?? '';
  if (!/(?:enter.*(?:confirm|continue|select)|esc.*(?:cancel|back|exit))/iu.test(tail)) return undefined;
  const text = liveInteractionSurface(lines.join('\n'));
  if (!text || !/(?:enter.*(?:confirm|continue|select)|esc.*(?:cancel|back|exit))/iu.test(text)) return undefined;
  const options = parseLiveInteractionOptions(text);
  return options.length >= 2 && options.some(option => option.selected) ? { text, options } : undefined;
}

export interface NativePickerTransport {
  capture(target: TmuxPaneTarget): string;
  send(target: TmuxPaneTarget, keys: readonly string[]): void;
}

const transport: NativePickerTransport = {
  capture(target) {
    if (!isSafeTmuxSocket(target.socketPath)) throw new Error('tmux socket 不存在或不安全');
    // No scrollback: old menus must never authorize keys in a new composer.
    const result = spawnProcessSync('tmux', ['-S', target.socketPath, 'capture-pane', '-p', '-t', target.paneId], { encoding: 'utf8', maxBuffer: 256 * 1024 });
    if (result.status !== 0) throw new Error('无法读取当前 Codex 终端菜单');
    return typeof result.stdout === 'string' ? result.stdout : result.stdout?.toString('utf8') ?? '';
  },
  send(target, keys) {
    const result = spawnProcessSync('tmux', ['-S', target.socketPath, 'send-keys', '-t', target.paneId, ...keys], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error('终端菜单按键发送失败；未自动重试');
  },
};

/** Resolve and recheck the exact thread/pane, then send a bounded menu action. */
export function sendNativePickerControl(
  resolveTarget: () => TmuxPaneTarget | undefined,
  input: string,
  io: NativePickerTransport = transport,
): void {
  if (!isNativePickerControl(input)) throw new Error('该输入不是终端菜单控制');
  const target = resolveTarget();
  if (!target?.structured?.endpoint) throw new Error('没有绑定到当前 thread 的 Codex 终端菜单；未发送按键');
  const expectedIdentity = identity(target);
  const surface = nativePickerSurface(io.capture(target));
  if (!surface) throw new Error('当前没有可操作的 Codex 终端菜单，菜单可能已自动关闭；未发送按键');
  const numeric = /^(\d{1,3})(?:\s+(?:enter|return|回车|确认))?$/iu.exec(input.trim());
  let keys: string[];
  if (numeric) {
    const requested = surface.options.findIndex(option => option.key === numeric[1]);
    const selected = surface.options.findIndex(option => option.selected);
    if (requested < 0 || selected < 0) throw new Error('无效选项；请使用当前终端菜单中的编号');
    const steps = requested - selected;
    if (Math.abs(steps) > 50) throw new Error('终端菜单导航超出范围');
    // Use native navigation, not literal text. A number selects exactly one
    // current choice and cannot become a user message or skip a nested menu.
    keys = [...Array.from({ length: Math.abs(steps) }, () => steps > 0 ? 'Down' : 'Up'), 'Enter'];
  } else {
    const map: Record<string, string> = {
      '\x1b[A': 'Up', '\x1b[B': 'Down', '\x1b[C': 'Right', '\x1b[D': 'Left',
      '\r': 'Enter', '\x1b': 'Escape', '\t': 'Tab', ' ': 'Space',
    };
    keys = parseLiveControlSequence(input)!.map(key => map[key]!);
    // A key after confirmation could affect the next menu/composer.
    if (keys.slice(0, -1).some(key => key === 'Enter' || key === 'Escape')) {
      throw new Error('确认或退出必须是本次菜单操作的最后一个按键');
    }
  }
  const latest = resolveTarget();
  if (!latest || identity(latest) !== expectedIdentity) throw new Error('pane 中的会话已经改变，旧选择未发送');
  if (nativePickerSurface(io.capture(latest))?.text !== surface.text) throw new Error('终端菜单已变化或关闭，旧选择未发送；请重新查看 /tmux tail');
  io.send(latest, keys);
}

function identity(target: TmuxPaneTarget): string {
  return [target.socketPath, target.sessionName, target.paneId, target.panePid, target.structured?.endpoint, target.structured?.threadId].join('\0');
}
