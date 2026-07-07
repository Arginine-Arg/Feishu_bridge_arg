import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types';
import { cleanTerminalOutput, LiveSessionPool } from '../../../src/agent/live-session';

describe('LiveSessionPool', () => {
  it('reuses a background process and forwards slash commands through stdin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'live-session-test-'));
    const bin = join(dir, 'fake-agent.mjs');
    const countFile = join(dir, 'count.txt');
    await writeFile(
      bin,
      `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(countFile)}, 'start\\n');
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.search(/[\\r\\n]/)) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    if (line === '/help') process.stdout.write('native-help\\n');
    else if (line === '/repeat') process.stdout.write('same-frame\\nsame-frame\\nsame-frame\\n');
    else if (line === '/split-ansi') {
      process.stdout.write('\\x1b[');
      setTimeout(() => process.stdout.write('78Gclean-frame\\n'), 5);
    }
    else if (line === '/warning') {
      process.stdout.write('⚠Ignoringmalformedagentroledefinition:duplicateagentrolenameweb-researcherdeclaredinthesameconfiglayer');
      process.stdout.write('⚠Ignoringmalformedagentroledefinition:agentrole\`w78 e\\n\\n78 b\\n\\n78 -\\n\\n78 r\\n\\n78 e\\n\\n78 s\\n\\n78 e\\n\\n78 a\\n\\n78 r\\n\\n78 c\\n\\n78 h\\n\\n78 e\\n\\n78 r\\n\\n78 \`\\n\\n78 m\\n\\n78 u\\n\\n78 s\\n\\n78 t\\n\\n78 d\\n\\n78 e\\n\\n78 f\\n\\n78 i\\n\\n78 n\\n\\n78 e\\n\\n78 a\\n\\n78 d\\n\\n78 e\\n\\n78 s\\n\\n78 c\\n\\n78 r\\n\\n78 i\\n\\n78 p\\n\\n78 t\\n\\n78 i\\n\\n78 o\\n\\n78 n\\n');
      process.stdout.write('Tip:Use/inittocreateanAGENTS.mdwithproject-specificguidanc\\n78 e\\n78 .\\nanswer\\n');
    }
    else process.stdout.write('echo:' + line + '\\n');
  }
});
setInterval(() => {}, 1000);
`,
      'utf8',
    );
    await chmod(bin, 0o755);

    const pool = new LiveSessionPool();
    const session = pool.getOrCreate('scope-1', {
      command: process.execPath,
      args: [bin],
      cwd: dir,
      signature: 'same',
      usePty: false,
      idleMs: 30,
      outputFlushMs: 5,
      startupTimeoutMs: 300,
    });

    const first = await collect(session.run('run-1', 'hello', dir).events);
    const secondSession = pool.getOrCreate('scope-1', {
      command: process.execPath,
      args: [bin],
      cwd: dir,
      signature: 'same',
      usePty: false,
      idleMs: 30,
      outputFlushMs: 5,
      startupTimeoutMs: 300,
    });
    const second = await collect(secondSession.run('run-2', '/help', dir).events);
    const third = await collect(secondSession.run('run-3', '/repeat', dir).events);
    const fourth = await collect(secondSession.run('run-4', '/split-ansi', dir).events);
    const fifth = await collect(secondSession.run('run-5', '/warning', dir).events);
    await pool.closeAll();

    expect(textOf(first)).toContain('echo:hello');
    expect(textOf(second)).toContain('native-help');
    expect(textOf(third).match(/same-frame/g)).toHaveLength(1);
    expect(textOf(fourth)).toBe('clean-frame\n');
    expect(textOf(fifth)).toBe('answer\n');
    expect(await readFile(countFile, 'utf8')).toBe('start\n');
  });

  it('normalizes terminal redraws instead of appending every frame', () => {
    expect(cleanTerminalOutput('progress 1\rprogress 2\rdone\n')).toBe('done\n');
  });

  it('removes orphan cursor controls left after terminal chunks are split', () => {
    expect(cleanTerminalOutput('78Gclean\n')).toBe('clean\n');
  });

  it('reassembles cursor-scattered warning text', () => {
    expect(cleanTerminalOutput('⚠\nI\n\n78 g\n\n78 n\n\n78 o\n\n78 r\n\n78 i\n\n78 n\n\n78 g\n')).toBe(
      '⚠Ignoring',
    );
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function textOf(events: AgentEvent[]): string {
  return events
    .filter((event): event is Extract<AgentEvent, { type: 'text' }> => event.type === 'text')
    .map((event) => event.delta)
    .join('');
}
