import { describe, expect, it } from 'vitest';
import {
  novelLiveSuffix,
  RunEventGate,
  SerializedDelivery,
} from '../../../src/bot/run-delivery';

describe('RunEventGate', () => {
  it('turns a complete terminal redraw into only its novel suffix', () => {
    const gate = new RunEventGate();
    const first = gate.accept({
      type: 'text',
      delta: '• first update\n• second update\n',
      source: 'live-terminal',
      sequence: 1,
    });
    const redraw = gate.accept({
      type: 'text',
      delta: '• first update\n• second update\n• final update\n',
      source: 'live-terminal',
      sequence: 2,
    });
    const replay = gate.accept({
      type: 'text',
      delta: '• first update\n• second update\n• final update\n',
      source: 'live-terminal',
      sequence: 3,
    });

    expect(first).toMatchObject({ delta: '• first update\n• second update\n' });
    expect(redraw).toMatchObject({ delta: '• final update\n' });
    expect(replay).toBeUndefined();
  });

  it('rejects a replayed terminal sequence while preserving normal agent deltas', () => {
    const gate = new RunEventGate();
    expect(gate.accept({ type: 'text', delta: 'native\n', source: 'live-terminal', sequence: 2 }))
      .toBeDefined();
    expect(gate.accept({ type: 'text', delta: 'native\n', source: 'live-terminal', sequence: 2 }))
      .toBeUndefined();
    expect(gate.accept({ type: 'text', delta: 'same prose is valid\n' })).toBeDefined();
    expect(gate.accept({ type: 'text', delta: 'same prose is valid\n' })).toBeDefined();
  });

  it('deduplicates tool events by their structured identities', () => {
    const gate = new RunEventGate();
    const use = { type: 'tool_use' as const, id: 'tool-1', name: 'Bash', input: { command: 'pwd' } };
    const result = { type: 'tool_result' as const, id: 'tool-1', output: '/tmp', isError: false };

    expect(gate.accept(use)).toBeDefined();
    expect(gate.accept(use)).toBeUndefined();
    expect(gate.accept(result)).toBeDefined();
    expect(gate.accept(result)).toBeUndefined();
  });
});

describe('novelLiveSuffix', () => {
  it('retains an appended tail but never replays the delivered prefix', () => {
    const delivered = 'alpha\nbeta\n';
    expect(novelLiveSuffix(delivered, `${delivered}gamma\n`)).toBe('gamma\n');
    expect(novelLiveSuffix(delivered, delivered)).toBe('');
    expect(novelLiveSuffix(delivered, 'beta\ngamma\n')).toBe('gamma\n');
  });

  it('keeps only the new tail when tmux changes terminal line wrapping', () => {
    const delivered = '• inspect the stream\n• verify the queue\n';
    const reflowed = '• inspect\n  the stream\n• verify the queue\n• retain the final tail\n';

    expect(novelLiveSuffix(delivered, reflowed)).toBe('• retain the final tail\n');
  });

  it('keeps intervening output when a full prior transcript appears twice', () => {
    const delivered = 'alpha\nbeta\n';
    const redraw = `${delivered}intervening update\n${delivered}final update\n`;

    expect(novelLiveSuffix(delivered, redraw)).toBe('intervening update\nalpha\nbeta\nfinal update\n');
  });

  it('drops a historical viewport fragment that is no longer the delivered tail', () => {
    const delivered = [
      '• 开始进行只读项目巡检。',
      '• Exploring',
      '  └ List src',
      '• Ran git log --oneline',
      '  └ latest commit',
      '• 项目规模已确认。',
    ].join('\n');
    const fragment = ['• 开始进行只读项目巡检。', '• Exploring', '  └ List src'].join('\n');

    expect(novelLiveSuffix(delivered, fragment)).toBe('');
  });

  it('removes a historical viewport prefix but keeps the new tail', () => {
    const old = [
      '• 开始进行只读项目巡检，检查消息入口、tmux 和投递队列。',
      '• Exploring',
      '  └ List src',
    ].join('\n');
    const delivered = `${old}\n• 已完成配置层检查。`;
    const candidate = `${old}\n• 新增：已完成测试层检查。`;

    expect(novelLiveSuffix(delivered, candidate)).toBe('• 新增：已完成测试层检查。');
  });

  it('drops a reflowed historical fragment even when its line breaks changed', () => {
    const delivered = [
      '• 开始进行只读项目巡检，检查消息入口、tmux 和投递队列。',
      '• Exploring',
      '  └ List src',
      '• 已完成配置层检查。',
    ].join('\n');
    const reflowed = [
      '• 开始进行只读项目巡检，检查消息入口、tmux',
      '  和投递队列。',
      '• Exploring',
      '  └ List src',
    ].join('\n');

    expect(novelLiveSuffix(delivered, reflowed)).toBe('');
  });
});

describe('SerializedDelivery', () => {
  it('keeps a slow heartbeat patch from overtaking a newer agent event', async () => {
    const queue = new SerializedDelivery();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.enqueue(async () => {
      order.push('heartbeat-start');
      await firstGate;
      order.push('heartbeat-end');
    });
    const second = queue.enqueue(async () => {
      order.push('event');
    });

    await Promise.resolve();
    expect(order).toEqual(['heartbeat-start']);
    releaseFirst?.();
    await Promise.all([first, second]);
    await queue.drain();
    expect(order).toEqual(['heartbeat-start', 'heartbeat-end', 'event']);
  });
});
