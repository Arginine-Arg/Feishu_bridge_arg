import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types';
import {
  cleanTerminalOutput,
  isLiveControlInput,
  LiveSessionPool,
  LiveTerminalSession,
  parseLiveControlSequence,
} from '../../../src/agent/live-session';

describe('parseLiveControlSequence', () => {
  it('maps single and multi-key navigation words to terminal keys', () => {
    expect(parseLiveControlSequence('up')).toEqual(['\x1B[A']);
    expect(parseLiveControlSequence('down')).toEqual(['\x1B[B']);
    expect(parseLiveControlSequence('enter')).toEqual(['\r']);
    expect(parseLiveControlSequence('esc')).toEqual(['\x1B']);
    // Multi-key in one message: move then confirm.
    expect(parseLiveControlSequence('down down enter')).toEqual(['\x1B[B', '\x1B[B', '\r']);
    expect(parseLiveControlSequence('UP Enter')).toEqual(['\x1B[A', '\r']);
    expect(parseLiveControlSequence('上 回车')).toEqual(['\x1B[A', '\r']);
  });

  it('returns null for ordinary text (not a pure control sequence)', () => {
    expect(parseLiveControlSequence('你好')).toBeNull();
    expect(parseLiveControlSequence('up please')).toBeNull();
    expect(parseLiveControlSequence('/model')).toBeNull();
    expect(parseLiveControlSequence('')).toBeNull();
    expect(isLiveControlInput('down enter')).toBe(true);
    expect(isLiveControlInput('summarize commits')).toBe(false);
  });
});

describe('LiveTerminalSession prime slot', () => {
  it('grants the system-prompt prime slot exactly once', () => {
    const session = new LiveTerminalSession({
      command: 'true',
      args: [],
      cwd: '/tmp',
      env: {},
      signature: 'sig',
    });
    expect(session.takePrimeSlot()).toBe(true);
    expect(session.takePrimeSlot()).toBe(false);
    expect(session.takePrimeSlot()).toBe(false);
  });
});

const linuxIt = process.platform === 'linux' ? it : it.skip;
const tmuxIt = process.platform === 'linux' && hasTmux() ? it : it.skip;

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
let pickerOpen = false;
process.stdin.on('data', (chunk) => {
  if (chunk.includes('\\x15')) {
    buf = '';
    chunk = chunk.replaceAll('\\x15', '');
  }
  if (pickerOpen && chunk.includes('\\x1b')) {
    pickerOpen = false;
    setTimeout(() => process.stdout.write('Select Model and Effort\\n1. stale-picker\\nPress enter to confirm or esc to go back\\n'), 120);
  }
  if (chunk.includes('\\x1b[A')) {
    process.stdout.write('arrow-up\\n');
    chunk = chunk.replaceAll('\\x1b[A', '');
  }
  if (chunk.includes('\\x1b')) {
    chunk = chunk.replaceAll('\\x1b', '');
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
    else if (line === '/fast') {
      process.stdout.write('╭───────────────────────────────────────────────────────╮\\n');
      process.stdout.write('│ >_ OpenAI Codex (v0.142.5)                            │\\n');
      process.stdout.write('│ model:       gpt-5.5 high   /model to change          │\\n');
      process.stdout.write('╰───────────────────────────────────────────────────────╯\\n\\n');
      process.stdout.write('Tip: Run /review to get a code review of your current changes.\\n\\n');
      process.stdout.write('› /fast\\n\\n');
      process.stdout.write('• Service tier set to fast\\n\\n');
      process.stdout.write('gpt-5.5 high · ~/.lark-channel-workspaces/codex/default\\n');
    }
    else if (line === '/goal-frame') {
      process.stdout.write('• Service tier set to priority\\n\\n');
      process.stdout.write('• Working (0s • esc to interrupt)\\n\\n');
      process.stdout.write('› goal-frame\\n\\n');
      process.stdout.write('tab to queue message 100% context left\\n');
      setTimeout(() => {
        process.stdout.write('• Service tier set to priority\\n\\n');
        process.stdout.write('◦ Working (1s • esc to interrupt)\\n\\n');
        process.stdout.write('› goal-frame\\n\\n');
        process.stdout.write('tab to queue message 100% context left\\n');
      }, 10);
      setTimeout(() => {
        process.stdout.write('• Context compacted\\n\\n');
        process.stdout.write('⚠ Heads up: Long threads and multiple compactions can cause the model to be less accurate.\\n');
      }, 20);
    }
    else if (line === '/prime-buffer') {
      process.stdout.write('primed\\n');
      buf = 'goal';
    }
    else if (line === '/status') {
      process.stdout.write('status-ok\\n');
    }
    else if (line === '/open-picker') {
      pickerOpen = true;
      process.stdout.write('Select Model and Effort\\n1. gpt-5.5\\nPress enter to confirm or esc to go back\\n');
    }
    else if (line === '/slow-compact') {
      setTimeout(() => process.stdout.write('• Context compacted\\n'), 600);
    }
    else if (line === '/slow-goal') {
      process.stdout.write('› Explain this codebase\\n');
      setTimeout(() => process.stdout.write('• Usage: /goal [<objective>|clear|edit|pause|resume] No goal is currently set.\\n'), 600);
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
    const sixth = await collect(secondSession.run('run-6', 'up', dir).events);
    const seventh = await collect(secondSession.run('run-7', '/warning-tail', dir).events);
    const eighth = await collect(secondSession.run('run-8', '/noise-then-answer', dir).events);
    const ninth = await collect(secondSession.run('run-9', '/fast', dir).events);
    const tenth = await collect(secondSession.run('run-10', '/goal-frame', dir).events);
    await collect(secondSession.run('run-11', '/prime-buffer', dir).events);
    const eleventh = await collect(secondSession.run('run-12', '/status', dir, 'command').events);
    await collect(secondSession.run('run-13', '/open-picker', dir).events);
    const twelfth = await collect(secondSession.run('run-14', '/fast', dir, 'command').events);
    const thirteenth = await collect(secondSession.run('run-15', '/slow-compact', dir, 'command').events);
    const fourteenth = await collect(secondSession.run('run-16', '/slow-goal', dir, 'command').events);
    await pool.closeAll();

    expect(textOf(first)).toContain('echo:hello');
    expect(textOf(second)).toContain('native-help');
    expect(textOf(third).match(/same-frame/g)).toHaveLength(1);
    expect(textOf(fourth)).toBe('clean-frame\n');
    expect(textOf(fifth)).toBe('answer\n');
    expect(textOf(sixth)).toContain('arrow-up');
    expect(textOf(seventh)).toBe('answer\n');
    expect(textOf(eighth)).toBe('real answer\n');
    expect(textOf(ninth)).toBe('• Service tier set to fast\n');
    expect(textOf(tenth)).toBe(
      '• Context compacted\n\n⚠ Heads up: Long threads and multiple compactions can cause the model to be less accurate.\n',
    );
    expect(textOf(eleventh)).toBe('status-ok\n');
    expect(textOf(twelfth)).toBe('• Service tier set to fast\n');
    expect(textOf(thirteenth)).toBe('• Context compacted\n');
    expect(textOf(fourteenth)).toBe('• Usage: /goal [<objective>|clear|edit|pause|resume] No goal is currently set.\n');
    expect(await readFile(countFile, 'utf8')).toBe('start\n');
  }, 15_000);

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
      backend: 'pty',
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
      backend: 'pty',
      idleMs: 40,
      outputFlushMs: 20,
      startupTimeoutMs: 300,
    });

    const events = await collect(session.run('run-pty-size', 'size', dir).events);
    await pool.closeAll();

    expect(textOf(events)).toBe('48 120\n48x120\n');
  });

  tmuxIt('can run live sessions through tmux capture-pane and send-keys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'live-session-tmux-test-'));
    const bin = join(dir, 'fake-tmux-agent.mjs');
    await writeFile(
      bin,
      `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.search(/[\\r\\n]/)) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const size = execFileSync('stty', ['size'], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] }).trim();
    process.stdout.write('tmux:' + line + '\\n' + size + '\\n' + process.env.LINES + 'x' + process.env.COLUMNS + '\\n');
  }
});
setInterval(() => {}, 1000);
`,
      'utf8',
    );
    await chmod(bin, 0o755);

    const pool = new LiveSessionPool();
    const session = pool.getOrCreate('tmux-scope', {
      command: process.execPath,
      args: [bin],
      cwd: dir,
      signature: 'tmux',
      usePty: true,
      backend: 'tmux',
      idleMs: 300,
      outputFlushMs: 40,
      startupTimeoutMs: 1000,
    });

    const events = await collect(session.run('run-tmux', 'hello', dir).events);
    await pool.closeAll();

    expect(textOf(events)).toContain('tmux:hello\n48 120\n48x120\n');
  });

  tmuxIt('pastes multiline live prompts into tmux before submitting once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'live-session-tmux-paste-test-'));
    const bin = join(dir, 'fake-tmux-paste-agent.mjs');
    await writeFile(
      bin,
      `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
let text = '';
let inPaste = false;
process.stdin.on('data', (chunk) => {
  for (let i = 0; i < chunk.length; i += 1) {
    if (chunk.startsWith('\\x1b[200~', i)) {
      inPaste = true;
      i += '\\x1b[200~'.length - 1;
      continue;
    }
    if (chunk.startsWith('\\x1b[201~', i)) {
      inPaste = false;
      i += '\\x1b[201~'.length - 1;
      continue;
    }
    const char = chunk[i];
    if ((char === '\\r' || char === '\\n') && !inPaste) {
      process.stdout.write('submitted:' + JSON.stringify(text) + '\\n');
      text = '';
      continue;
    }
    text += char;
  }
});
setInterval(() => {}, 1000);
`,
      'utf8',
    );
    await chmod(bin, 0o755);

    const pool = new LiveSessionPool();
    const session = pool.getOrCreate('tmux-paste-scope', {
      command: process.execPath,
      args: [bin],
      cwd: dir,
      signature: 'tmux-paste',
      usePty: true,
      backend: 'tmux',
      idleMs: 300,
      outputFlushMs: 40,
      startupTimeoutMs: 1000,
    });

    const events = await collect(session.run('run-tmux-paste', 'alpha\nbeta', dir).events);
    await pool.closeAll();

    expect(textOf(events)).toContain('submitted:"alpha\\nbeta"\n');
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
      backend: 'pty',
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

function hasTmux(): boolean {
  return spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
}
