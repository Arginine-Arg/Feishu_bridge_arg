import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  extractAssistantHistory,
  findAdoptedThreadMarker,
} from '../../../src/agent/structured/native-bridge';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('Bridge managed native history migration', () => {
  it('migrates bounded user and assistant text without tool or encrypted items', () => {
    const history = extractAssistantHistory({
      thread: {
        turns: [{
          items: [
            {
              type: 'userMessage',
              content: [
                { type: 'inputText', text: 'keep this context' },
                { type: 'image', path: '/tmp/not-copied.png' },
              ],
            },
            {
              type: 'agentMessage',
              text: 'assistant answer',
            },
            {
              type: 'agentMessage',
              text: 'secret sk-this-value-must-be-redacted',
            },
            {
              type: 'functionCallOutput',
              name: 'shell',
              output: 'tool output must not be copied',
            },
          ],
        }],
      },
    });

    expect(history.items).toEqual([
      expect.objectContaining({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'keep this context' }],
      }),
      expect.objectContaining({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'assistant answer' }],
      }),
      expect.objectContaining({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: expect.stringContaining('sk-[REDACTED]') }],
      }),
    ]);
    expect(JSON.stringify(history)).not.toContain('tool output must not be copied');
    expect(JSON.stringify(history)).not.toContain('/tmp/not-copied.png');
  });

  it('keeps only a bounded recent tail when the old transcript is large', () => {
    const turns = Array.from({ length: 100 }, (_, index) => ({
      items: [{
        type: 'userMessage',
        content: [{ type: 'inputText', text: `${index}:`.padEnd(300, 'x') }],
      }],
    }));
    const history = extractAssistantHistory({ thread: { turns } });
    expect(history.sourceChars).toBeLessThanOrEqual(12_000);
    expect(history.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(history.items)).toContain('99:');
  });

  it('reuses the newest existing adoption instead of creating another thread', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-adopt-marker-'));
    temporary.push(root);
    const markerPath = join(root, 'broker-threads.json');
    await writeFile(markerPath, JSON.stringify({
      version: 1,
      threads: {
        older: {
          version: 1,
          namespace: 'arg_bridge',
          createdAt: 10,
          adoptedFrom: 'legacy-thread',
        },
        newest: {
          version: 1,
          namespace: 'arg_bridge',
          createdAt: 20,
          adoptedFrom: 'legacy-thread',
        },
        other: {
          version: 1,
          namespace: 'other',
          createdAt: 30,
          adoptedFrom: 'legacy-thread',
        },
      },
    }));

    await expect(findAdoptedThreadMarker(markerPath, 'legacy-thread', 'arg_bridge'))
      .resolves.toEqual({ threadId: 'newest', createdAt: 20 });
  });
});
