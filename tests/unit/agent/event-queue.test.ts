import { describe, expect, it } from 'vitest';
import { AsyncEventQueue } from '../../../src/agent/event-queue.js';

describe('AsyncEventQueue', () => {
  it('retains events emitted before a consumer starts', async () => {
    const queue = new AsyncEventQueue<string>();
    queue.push('first');
    queue.push('second');
    queue.close();

    const values: string[] = [];
    for await (const value of queue) values.push(value);

    expect(values).toEqual(['first', 'second']);
  });

  it('resolves a waiting consumer and then closes cleanly', async () => {
    const queue = new AsyncEventQueue<string>();
    const iterator = queue[Symbol.asyncIterator]();
    const pending = iterator.next();

    queue.push('ready');
    expect(await pending).toEqual({ value: 'ready', done: false });

    queue.close();
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });
});
