import { describe, expect, it } from 'vitest';
import {
  answerCard,
  answerHasStructuredBlocks,
  parseAnswerBlocks,
  splitAnswerForDelivery,
} from '../../../src/card/answer-presentation';

describe('completed answer presentation', () => {
  it('keeps fenced code as one semantic block with its language', () => {
    const blocks = parseAnswerBlocks([
      '说明文字',
      '',
      '```python',
      'def train(step):',
      '    return step + 1',
      '```',
      '',
      '结论',
    ].join('\n'));

    expect(blocks.map((block) => block.kind)).toEqual(['markdown', 'code', 'markdown']);
    expect(blocks[1]).toMatchObject({
      kind: 'code',
      language: 'python',
      content: 'def train(step):\n    return step + 1',
    });
    expect(answerHasStructuredBlocks([
      '说明文字',
      '',
      '```python',
      'def train(step):',
      '    return step + 1',
      '```',
    ].join('\n'))).toBe(true);
  });

  it('classifies patch fences and explicit patch blocks as diffs', () => {
    const blocks = parseAnswerBlocks([
      '```diff',
      '*** Begin Patch',
      '*** Update File: src/index.ts',
      '+export const ready = true;',
      '*** End Patch',
      '```',
      '',
      '*** Begin Patch',
      '*** Delete File: old.ts',
      '*** End Patch',
    ].join('\n'));

    expect(blocks.map((block) => block.kind)).toEqual(['diff', 'diff']);
    expect(blocks[0]?.content).toContain('+export const ready = true;');
    expect(blocks[1]?.content).toContain('*** Delete File: old.ts');
  });

  it('keeps tables and architecture diagrams in monospace layout panels', () => {
    const blocks = parseAnswerBlocks([
      '| stage | output |',
      '| --- | --- |',
      '| Bio | c_bio |',
      '',
      'Bio condition',
      '      |',
      '      v',
      'DeFoG graph flow',
    ].join('\n'));

    expect(blocks.map((block) => block.layoutKind)).toEqual(['table', 'diagram']);
    const card = answerCard(blocks);
    const serialized = JSON.stringify(card);
    expect(serialized).toContain('collapsible_panel');
    expect(serialized).toContain('stage');
    expect(serialized).toContain('      |');
  });

  it('splits oversized code only at complete line boundaries', () => {
    const lines = Array.from({ length: 220 }, (_, index) => `    emit(${index});`);
    const source = `前言\n\n\`\`\`ts\n${lines.join('\n')}\n\`\`\`\n\n结论`;
    const chunks = splitAnswerForDelivery(source, 1_600);
    expect(chunks.length).toBeGreaterThan(1);
    const codeLines = chunks
      .flatMap((chunk) => chunk)
      .filter((block) => block.kind === 'code')
      .flatMap((block) => block.content.split('\n'));
    expect(codeLines).toEqual(lines);
    expect(chunks.every((chunk, index) => Buffer.byteLength(JSON.stringify(answerCard(chunk, index + 1, chunks.length)), 'utf8') <= 1_600)).toBe(true);
  });
});
