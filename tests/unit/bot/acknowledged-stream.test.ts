import { afterEach, describe, expect, it, vi } from 'vitest';
import { acknowledgedStream } from '../../../src/bot/acknowledged-stream';
import type { LarkChannel, MarkdownStreamController } from '@larksuite/channel';

afterEach(() => vi.useRealTimers());
function harness() {
  const send = vi.fn(async () => ({ messageId: 'message-id' }));
  const patch = vi.fn(async (_: unknown) => ({ code: 0 }));
  const channel = { send, rawClient: { im: { v1: { message: { patch } } } } } as unknown as LarkChannel;
  let controller!: MarkdownStreamController;
  let finish!: () => void;
  const done = acknowledgedStream(channel, 'chat', { markdown: async ctrl => {
    controller = ctrl; await new Promise<void>(resolve => { finish = resolve; });
  } }, { replyTo: 'origin', replyInThread: true });
  return { send, patch, done, ctrl: () => controller, finish: () => finish() };
}
describe('acknowledged structured streaming', () => {
  it('coalesces tiny tokens and flushes the exact complete final text', async () => {
    vi.useFakeTimers(); const h = harness(); await Promise.resolve();
    const answer = '这是完整的中文正文，包含 emoji 🧬 and English.';
    for (const ch of answer) await h.ctrl().append(ch);
    expect(h.patch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400); expect(h.patch).toHaveBeenCalledTimes(1);
    await h.ctrl().append(' final tail'); h.finish(); await h.done;
    expect(JSON.parse((h.patch.mock.calls.at(-1)![0] as any).data.content)).toMatchObject({ config: { streaming_mode: false }, body: { elements: [{ content: answer + ' final tail' }] } });
    expect(h.send.mock.calls[0]).toMatchObject(['chat', expect.anything(), { replyTo: 'origin', replyInThread: true }]);
  });
  it('rebuilds a rejected card using the full latest text, not its prefix', async () => {
    vi.useFakeTimers(); const h = harness(); await Promise.resolve();
    h.patch.mockResolvedValueOnce({ code: 230011 });
    await h.ctrl().setContent('完整内容'); await vi.advanceTimersByTimeAsync(400);
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.send.mock.calls[1]).toMatchObject(['chat', { card: { body: { elements: [{ content: '完整内容' }] } } }, { replyTo: 'origin', replyInThread: true }]);
    await h.ctrl().append('末尾'); h.finish(); await h.done;
    expect(JSON.stringify(h.patch.mock.calls.at(-1))).toContain('完整内容末尾');
  });
  it('propagates repeated API rejection to the final fallback', async () => {
    vi.useFakeTimers(); const h = harness(); await Promise.resolve();
    h.patch.mockResolvedValue({ code: 230011 });
    await h.ctrl().setContent('prefix'); await vi.advanceTimersByTimeAsync(400);
    await h.ctrl().setContent('full final text'); h.finish();
    await expect(h.done).rejects.toThrow('PATCH rejected');
    expect(h.send).toHaveBeenCalledTimes(2);
  });
  it('drains an in-flight patch before sending the final state', async () => {
    vi.useFakeTimers(); const h = harness(); await Promise.resolve();
    let release!: (value: { code: number }) => void;
    h.patch.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await h.ctrl().setContent('prefix'); await vi.advanceTimersByTimeAsync(400);
    await h.ctrl().setContent('prefix plus all remaining characters'); h.finish();
    release({ code: 0 }); await h.done;
    expect(JSON.stringify(h.patch.mock.calls.at(-1))).toContain('prefix plus all remaining characters');
  });
});
