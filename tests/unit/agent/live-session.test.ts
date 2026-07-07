import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types';
import { cleanTerminalOutput, LiveSessionPool } from '../../../src/agent/live-session';

const linuxIt = process.platform === 'linux' ? it : it.skip;

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
  if (chunk.includes('\\x1b[A')) {
    process.stdout.write('arrow-up\\n');
    chunk = chunk.replaceAll('\\x1b[A', '');
  }
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
    else if (line === '/warning-tail') {
      process.stdout.write('r\\n\\n\`\\n\\nm\\n\\nu\\n\\ns\\n\\nt\\n\\nd\\n\\ne\\n\\nf\\n\\ni\\n\\nn\\n\\ne\\n\\na\\n\\nd\\n\\ne\\n\\ns\\n\\nc\\n\\nr\\n\\ni\\n\\np\\n\\nt\\n\\ni\\n\\no\\n\\nn\\nanswer\\n');
    }
    else if (line === '/noise-then-answer') {
      process.stdout.write('r\\n\\nm\\n\\nu\\n\\ns\\n\\nt\\n\\nd\\n\\ne\\n\\nf\\n\\ni\\n\\nn\\n\\ne\\n\\na\\n\\nd\\n\\ne\\n\\ns\\n\\nc\\n\\nr\\n\\ni\\n\\np\\n\\nt\\n\\ni\\n\\no\\nn\\ng\\n\\nm\\n\\na\\n\\nl\\n\\nf\\n\\no\\n\\nr\\n\\nm\\n\\ne\\n\\nd\\n\\na\\n\\ng\\n\\ne\\n\\nn\\n\\nt\\n\\nr\\n\\no\\n\\nl\\n\\ne\\n\\nd\\n\\ne\\n\\nf\\n\\ni\\n');
      setTimeout(() => process.stdout.write('real answer\\n'), 80);
    }
    else if (line === '/startup-noise') process.stdout.write('clean answer\\n');
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
    const sixth = await collect(secondSession.run('run-6', 'up', dir).events);
    const seventh = await collect(secondSession.run('run-7', '/warning-tail', dir).events);
    const eighth = await collect(secondSession.run('run-8', '/noise-then-answer', dir).events);
    await pool.closeAll();

    expect(textOf(first)).toContain('echo:hello');
    expect(textOf(second)).toContain('native-help');
    expect(textOf(third).match(/same-frame/g)).toHaveLength(1);
    expect(textOf(fourth)).toBe('clean-frame\n');
    expect(textOf(fifth)).toBe('answer\n');
    expect(textOf(sixth)).toContain('arrow-up');
    expect(textOf(seventh)).toBe('answer\n');
    expect(textOf(eighth)).toBe('real answer\n');
    expect(await readFile(countFile, 'utf8')).toBe('start\n');
  });

  it('ignores startup terminal output before the turn input is sent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'live-session-startup-noise-test-'));
    const bin = join(dir, 'fake-startup-noise-agent.mjs');
    await writeFile(
      bin,
      `#!/usr/bin/env node
process.stdout.write('nfiglayer⚠Ignoringmalfor\\nn\\n\\nt\\n\\nr\\n\\no\\n\\nl\\n\\ne\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', () => setTimeout(() => process.stdout.write('clean answer\\n'), 20));
setInterval(() => {}, 1000);
`,
      'utf8',
    );
    await chmod(bin, 0o755);

    const pool = new LiveSessionPool();
    const session = pool.getOrCreate('startup-noise-scope', {
      command: process.execPath,
      args: [bin],
      cwd: dir,
      signature: 'startup-noise',
      usePty: true,
      idleMs: 40,
      outputFlushMs: 20,
      startupTimeoutMs: 300,
    });

    const events = await collect(session.run('run-startup-noise', '/startup-noise', dir).events);
    await pool.closeAll();

    expect(textOf(events)).toBe('clean answer\n');
  });

  linuxIt('starts live PTY sessions with a stable terminal size', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'live-session-pty-size-test-'));
    const bin = join(dir, 'fake-pty-size-agent.mjs');
    await writeFile(
      bin,
      `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
process.stdin.setEncoding('utf8');
process.stdin.on('data', () => {
  const size = execFileSync('stty', ['size'], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] }).trim();
  process.stdout.write(size + '\\n' + process.env.LINES + 'x' + process.env.COLUMNS + '\\n');
});
setInterval(() => {}, 1000);
`,
      'utf8',
    );
    await chmod(bin, 0o755);

    const pool = new LiveSessionPool();
    const session = pool.getOrCreate('pty-size-scope', {
      command: process.execPath,
      args: [bin],
      cwd: dir,
      signature: 'pty-size',
      usePty: true,
      idleMs: 40,
      outputFlushMs: 20,
      startupTimeoutMs: 300,
    });

    const events = await collect(session.run('run-pty-size', 'size', dir).events);
    await pool.closeAll();

    expect(textOf(events)).toBe('48 120\n48x120\n');
  });

  it('normalizes terminal redraws instead of appending every frame', () => {
    expect(cleanTerminalOutput('progress 1\rprogress 2\rdone\n')).toBe('done\n');
  });

  it('renders PTY terminal redraws as a stable screen snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'live-session-pty-test-'));
    const bin = join(dir, 'fake-pty-agent.mjs');
    await writeFile(
      bin,
      `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
process.stdin.on('data', () => {
  process.stdout.write('\\x1b[?1049h\\x1b[2J\\x1b[1;1Hfirst frame');
  setTimeout(() => process.stdout.write('\\x1b[s\\x1b[1;1Hfinal frame\\x1b[K\\x1b[u\\n'), 5);
});
setInterval(() => {}, 1000);
`,
      'utf8',
    );
    await chmod(bin, 0o755);

    const pool = new LiveSessionPool();
    const session = pool.getOrCreate('pty-scope', {
      command: process.execPath,
      args: [bin],
      cwd: dir,
      signature: 'pty',
      usePty: true,
      idleMs: 40,
      outputFlushMs: 20,
      startupTimeoutMs: 300,
    });

    const events = await collect(session.run('run-pty', '/screen', dir).events);
    await pool.closeAll();

    expect(textOf(events)).toBe('final frame\n');
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
