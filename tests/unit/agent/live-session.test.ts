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
    process.stdout.write('• No previous message to edit.\\n');
    chunk = chunk.replaceAll('\\x15', '');
  }
  if (chunk.includes('\\x01')) {
    chunk = chunk.replaceAll('\\x01', '');
  }
  if (chunk.includes('\\x0b')) {
    buf = '';
    chunk = chunk.replaceAll('\\x0b', '');
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
    else if (line === '/status-stale-picker') {
      process.stdout.write('Select Model and Effort\\n');
      process.stdout.write('Access legacy models by running codex -m <model_name> or in your config.toml\\n');
      process.stdout.write('› 1. gpt-5.5 (current)\\n');
      process.stdout.write('Press enter to confirm or esc to go back\\n');
    }
    else if (line === '/model') {
      process.stdout.write('│  >_ OpenAI Codex (v0.142.5)                                                │\\n');
      process.stdout.write('│  Model:                gpt-5.5 (reasoning high, summaries auto)            │\\n');
      process.stdout.write('│  Directory:            ~/.lark-channel-workspaces/codex/default            │\\n');
      process.stdout.write('│  Token usage:          0 total  (0 input + 0 output)                       │\\n');
      process.stdout.write('╰────────────────────────────────────────────────────────────────────────────╯\\n');
      process.stdout.write('• No previous message to edit.\\n');
      process.stdout.write('• Context compacted\\n');
      process.stdout.write('⚠ Heads up: Long threads and multiple compactions can cause the model to be less accurate. Start a new thread when\\n');
      process.stdout.write('possible to keep threads small and targeted.\\n');
      setTimeout(() => {
        process.stdout.write('Select Model and Effort\\n');
        process.stdout.write('Access legacy models by running codex -m <model_name> or in your config.toml\\n');
        process.stdout.write('› 1. gpt-5.5 (current)\\n');
        process.stdout.write('2. gpt-5.4\\n');
        process.stdout.write('Press enter to confirm or esc to go back\\n');
      }, 20);
    }
    else if (line === '/clear') {
      // Codex /clear intentionally redraws to an empty screen and may not emit
      // any stable text. The bridge should end this command on the short idle
      // timer instead of waiting for the long startup timeout.
    }
    else if (line === '/clear-noise') {
      process.stdout.write('• No previous message to edit.\\n');
    }
    else if (line === '/open-picker') {
      pickerOpen = true;
      process.stdout.write('Select Model and Effort\\n1. gpt-5.5\\nPress enter to confirm or esc to go back\\n');
    }
    else if (line === '/slow-compact') {
      setTimeout(() => process.stdout.write('• Context compacted\\n'), 600);
    }
    else if (line === '/skills') {
      process.stdout.write('• No previous message to edit.\\n');
      process.stdout.write('• Context compacted\\n');
      process.stdout.write('⚠ Heads up: Long threads and multiple compactions can cause the model to be less accurate. Start a new thread when\\n');
      process.stdout.write('possible to keep threads small and targeted.\\n');
      setTimeout(() => process.stdout.write('Available skills: research, imagegen\\n'), 20);
    }
    else if (line === '/goal') {
      process.stdout.write('• No previous message to edit.\\n');
      process.stdout.write('• Context compacted\\n');
      process.stdout.write('⚠ Heads up: Long threads and multiple compactions can cause the model to be less accurate. Start a new thread when\\n');
      process.stdout.write('possible to keep threads small and targeted.\\n');
      process.stdout.write('/status\\n\\n');
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
    const stalePicker = await collect(
      secondSession.run('run-12a', '/status-stale-picker', dir, 'command').events,
    );
    const modelAfterCompact = await collect(
      secondSession.run('run-12a2', '/model', dir, 'command').events,
    );
    const silent = await collect(secondSession.run('run-12b', '/clear', dir, 'command').events);
    const editNoise = await collect(secondSession.run('run-12b2', '/clear-noise', dir, 'command').events);
    await collect(secondSession.run('run-13', '/open-picker', dir).events);
    const twelfth = await collect(secondSession.run('run-14', '/fast', dir, 'command').events);
    const thirteenth = await collect(secondSession.run('run-15', '/slow-compact', dir, 'command').events);
    const fourteenth = await collect(secondSession.run('run-16', '/goal', dir, 'command').events);
    const fifteenth = await collect(secondSession.run('run-17', '/skills', dir, 'command').events);
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
    expect(textOf(stalePicker)).toBe('');
    expect(textOf(modelAfterCompact)).toBe(
      'Select Model and Effort\nAccess legacy models by running codex -m <model_name> or in your config.toml\n› 1. gpt-5.5 (current)\n2. gpt-5.4\nPress enter to confirm or esc to go back\n',
    );
    expect(textOf(silent)).toBe('');
    expect(textOf(editNoise)).toBe('');
    expect(textOf(twelfth)).toBe('• Service tier set to fast\n');
    expect(textOf(thirteenth)).toBe('• Context compacted\n');
    expect(textOf(fourteenth)).toBe('• Usage: /goal [<objective>|clear|edit|pause|resume] No goal is currently set.\n');
    expect(textOf(fifteenth)).toBe('Available skills: research, imagegen\n');
    expect(await readFile(countFile, 'utf8')).toBe('start\n');
  }, 70_000);

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

  it('returns a live status fallback when Codex does not render /status output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'live-session-status-fallback-test-'));
    const bin = join(dir, 'fake-status-empty-agent.mjs');
    await writeFile(
      bin,
      `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (chunk.includes('/status')) process.stdout.write('› /status\\n');
});
setInterval(() => {}, 1000);
`,
      'utf8',
    );
    await chmod(bin, 0o755);

    const pool = new LiveSessionPool();
    const session = pool.getOrCreate('status-fallback-scope', {
      command: process.execPath,
      args: [
        bin,
        '--sandbox',
        'danger-full-access',
        '-c',
        'approval_policy="never"',
        '-c',
        'model_reasoning_effort="high"',
      ],
      cwd: dir,
      signature: 'status-fallback',
      usePty: false,
      idleMs: 30,
      outputFlushMs: 5,
      startupTimeoutMs: 300,
    });

    const events = await collect(session.run('status-fallback-run', '/status', dir, 'command').events);
    await pool.closeAll();
    const text = textOf(events);
    expect(text).toContain('Codex live session status');
    expect(text).toContain(`Directory: ${dir}`);
    expect(text).toContain('Sandbox: danger-full-access');
    expect(text).toContain('Approval policy: never');
    expect(text).toContain('Reasoning effort: high');
    expect(text).toContain('Terminal backend: pipe');
  }, 15_000);

  it('presses enter again when a slash command only produces a non-result redraw', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'live-session-slash-confirm-redraw-test-'));
    const bin = join(dir, 'fake-slash-confirm-redraw-agent.mjs');
    await writeFile(
      bin,
      `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
let sawModel = false;
process.stdin.on('data', (chunk) => {
  if (!sawModel && chunk.includes('/model')) {
    sawModel = true;
    process.stdout.write('redraw-only\\n');
    return;
  }
  if (sawModel && /[\\r\\n]/.test(chunk)) {
    process.stdout.write('Select Model and Effort\\n');
    process.stdout.write('› 1. gpt-5.5 (current)\\n');
    process.stdout.write('2. gpt-5.4\\n');
    process.stdout.write('Press enter to confirm or esc to go back\\n');
  }
});
setInterval(() => {}, 1000);
`,
      'utf8',
    );
    await chmod(bin, 0o755);

    const pool = new LiveSessionPool();
    const session = pool.getOrCreate('slash-confirm-redraw-scope', {
      command: process.execPath,
      args: [bin],
      cwd: dir,
      signature: 'slash-confirm-redraw',
      usePty: false,
      idleMs: 60,
      outputFlushMs: 10,
      startupTimeoutMs: 500,
    });

    const events = await collect(session.run('slash-confirm-redraw-run', '/model', dir, 'command').events);
    await pool.closeAll();

    const text = textOf(events);
    expect(text).toContain('redraw-only');
    expect(text).toContain('Select Model and Effort');
    expect(text).toContain('Press enter to confirm or esc to go back');
  }, 15_000);

  it('presses enter again when the initial slash command submit produces no redraw', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'live-session-slash-confirm-silent-test-'));
    const bin = join(dir, 'fake-slash-confirm-silent-agent.mjs');
    await writeFile(
      bin,
      `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
let sawModel = false;
let submitCount = 0;
let sent = false;
process.stdin.on('data', (chunk) => {
  if (chunk.includes('/model')) sawModel = true;
  if (!sawModel) return;
  submitCount += (chunk.match(/[\\r\\n]/g) || []).length;
  if (!sent && submitCount >= 2) {
    sent = true;
    process.stdout.write('Select Model and Effort\\n');
    process.stdout.write('› 1. gpt-5.6-sol (current)\\n');
    process.stdout.write('Press enter to confirm or esc to go back\\n');
  }
});
setInterval(() => {}, 1000);
`,
      'utf8',
    );
    await chmod(bin, 0o755);

    const pool = new LiveSessionPool();
    const session = pool.getOrCreate('slash-confirm-silent-scope', {
      command: process.execPath,
      args: [bin],
      cwd: dir,
      signature: 'slash-confirm-silent',
      usePty: false,
      idleMs: 60,
      outputFlushMs: 10,
      startupTimeoutMs: 500,
    });

    const events = await collect(session.run('slash-confirm-silent-run', '/model', dir, 'command').events);
    await pool.closeAll();

    expect(textOf(events)).toContain('Select Model and Effort');
  }, 15_000);

  it('uses one escape before clearing pending slash-command input', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'live-session-command-clear-sequence-test-'));
    const bin = join(dir, 'fake-command-clear-sequence-agent.mjs');
    const traceFile = join(dir, 'input-trace.txt');
    await writeFile(
      bin,
      `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
process.stdin.setEncoding('utf8');
let sent = false;
process.stdin.on('data', (chunk) => {
  for (const char of chunk) {
    if (char === '\\x1b') appendFileSync(${JSON.stringify(traceFile)}, 'esc\\n');
    if (char === '\\x01') appendFileSync(${JSON.stringify(traceFile)}, 'home\\n');
    if (char === '\\x0b') appendFileSync(${JSON.stringify(traceFile)}, 'kill\\n');
  }
  if (!sent && chunk.includes('/model')) {
    sent = true;
    process.stdout.write('Select Model and Effort\\n');
    process.stdout.write('› 1. gpt-5.6-sol (current)\\n');
    process.stdout.write('Press enter to confirm or esc to go back\\n');
  }
});
setInterval(() => {}, 1000);
`,
      'utf8',
    );
    await chmod(bin, 0o755);

    const pool = new LiveSessionPool();
    const session = pool.getOrCreate('command-clear-sequence-scope', {
      command: process.execPath,
      args: [bin],
      cwd: dir,
      signature: 'command-clear-sequence',
      usePty: false,
      idleMs: 60,
      outputFlushMs: 10,
      startupTimeoutMs: 500,
    });

    await collect(session.run('command-clear-sequence-run', '/model', dir, 'command').events);
    await pool.closeAll();

    expect((await readFile(traceFile, 'utf8')).trim().split('\n')).toEqual(['esc', 'home', 'kill']);
  }, 15_000);

  tmuxIt('returns tmux attach details in live status fallback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'live-session-tmux-status-test-'));
    const bin = join(dir, 'fake-tmux-status-empty-agent.mjs');
    await writeFile(
      bin,
      `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (chunk.includes('/status')) process.stdout.write('› /status\\n');
});
setInterval(() => {}, 1000);
`,
      'utf8',
    );
    await chmod(bin, 0o755);

    const pool = new LiveSessionPool();
    const session = pool.getOrCreate('tmux-status-fallback-scope', {
      command: process.execPath,
      args: [bin],
      cwd: dir,
      signature: 'tmux-status-fallback',
      usePty: true,
      backend: 'tmux',
      idleMs: 30,
      outputFlushMs: 5,
      startupTimeoutMs: 300,
    });

    const events = await collect(session.run('tmux-status-fallback-run', '/status', dir, 'command').events);
    await pool.closeAll();
    const text = textOf(events);
    expect(text).toContain('Codex live session status');
    expect(text).toContain('Terminal backend: tmux');
    expect(text).toMatch(/Tmux socket: lark-channel-/);
    expect(text).toContain('Tmux target: main:0.0');
    expect(text).toMatch(/Attach command: tmux -L lark-channel-[^ ]+ attach -t main/);
  }, 15_000);

  it('ignores stale status panels for other commands and strips stale goal usage from status', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'live-session-stale-status-panel-test-'));
    const bin = join(dir, 'fake-stale-status-panel-agent.mjs');
    await writeFile(
      bin,
      `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
let sentFast = false;
let sentStatus = false;
function statusPanel() {
  process.stdout.write('│  >_ OpenAI Codex (v0.142.5)                                                │\\n');
  process.stdout.write('│  Model:                gpt-5.5 (reasoning high, summaries auto)            │\\n');
  process.stdout.write('│  Directory:            ~/.lark-channel-workspaces/codex/default            │\\n');
  process.stdout.write('│  Token usage:          0 total  (0 input + 0 output)                       │\\n');
  process.stdout.write('╰────────────────────────────────────────────────────────────────────────────╯\\n');
}
process.stdin.on('data', (chunk) => {
  if (!sentFast && chunk.includes('/fast')) {
    sentFast = true;
    statusPanel();
    process.stdout.write('• Usage: /goal [<objective>|clear|edit|pause|resume] No goal is currently set.\\n');
    setTimeout(() => process.stdout.write('• Service tier set to fast\\n'), 20);
  }
  if (!sentStatus && chunk.includes('/status')) {
    sentStatus = true;
    statusPanel();
    process.stdout.write('• Usage: /goal [<objective>|clear|edit|pause|resume] No goal is currently set.\\n');
  }
});
setInterval(() => {}, 1000);
`,
      'utf8',
    );
    await chmod(bin, 0o755);

    const pool = new LiveSessionPool();
    const session = pool.getOrCreate('stale-status-panel-scope', {
      command: process.execPath,
      args: [bin],
      cwd: dir,
      signature: 'stale-status-panel',
      usePty: false,
      idleMs: 40,
      outputFlushMs: 5,
      startupTimeoutMs: 300,
    });

    const fast = await collect(session.run('stale-status-fast', '/fast', dir, 'command').events);
    const status = await collect(session.run('status-with-stale-goal', '/status', dir, 'command').events);
    await pool.closeAll();

    expect(textOf(fast)).toBe('• Service tier set to fast\n');
    expect(textOf(status)).toContain('Token usage');
    expect(textOf(status)).not.toContain('Usage: /goal');
  }, 20_000);

  it('keeps model-change confirmation for control input but not later slash commands', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'live-session-stale-model-change-test-'));
    const bin = join(dir, 'fake-stale-model-change-agent.mjs');
    await writeFile(
      bin,
      `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
let sentChoice = false;
let sentFast = false;
process.stdin.on('data', (chunk) => {
  if (!sentChoice && chunk.includes('2')) {
    sentChoice = true;
    process.stdout.write('/status\\n\\n');
    process.stdout.write('• Model changed to gpt-5.4 medium\\n\\n');
    process.stdout.write('› Find and fix a bug in @filename\\n');
  }
  if (!sentFast && chunk.includes('/fast')) {
    sentFast = true;
    process.stdout.write('• Model changed to gpt-5.4 medium\\n');
    process.stdout.write('• Service tier set to fast\\n');
  }
});
setInterval(() => {}, 1000);
`,
      'utf8',
    );
    await chmod(bin, 0o755);

    const pool = new LiveSessionPool();
    const session = pool.getOrCreate('stale-model-change-scope', {
      command: process.execPath,
      args: [bin],
      cwd: dir,
      signature: 'stale-model-change',
      usePty: false,
      idleMs: 40,
      outputFlushMs: 5,
      startupTimeoutMs: 300,
    });

    const choice = await collect(session.run('model-choice', '2', dir, 'control').events);
    const fast = await collect(session.run('fast-after-choice', '/fast', dir, 'command').events);
    await pool.closeAll();

    expect(textOf(choice)).toBe('• Model changed to gpt-5.4 medium\n');
    expect(textOf(fast)).toBe('• Service tier set to fast\n');
  }, 15_000);

  it('does not press enter after a picker literal when typing it already produces output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'live-session-control-literal-test-'));
    const bin = join(dir, 'fake-control-literal-agent.mjs');
    await writeFile(
      bin,
      `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
let sawChoice = false;
process.stdin.on('data', (chunk) => {
  if (!sawChoice && chunk.includes('1')) {
    sawChoice = true;
    process.stdout.write('Reasoning Effort\\n');
    process.stdout.write('1. Low\\n');
    process.stdout.write('2. Medium\\n');
    process.stdout.write('Press enter to confirm or esc to go back\\n');
  }
  if (sawChoice && /[\\r\\n]/.test(chunk)) {
    process.stdout.write('confirmed-too-early\\n');
  }
});
setInterval(() => {}, 1000);
`,
      'utf8',
    );
    await chmod(bin, 0o755);

    const pool = new LiveSessionPool();
    const session = pool.getOrCreate('control-literal-scope', {
      command: process.execPath,
      args: [bin],
      cwd: dir,
      signature: 'control-literal',
      usePty: false,
      idleMs: 80,
      outputFlushMs: 10,
      startupTimeoutMs: 1000,
    });

    const events = await collect(session.run('control-literal-run', '1', dir, 'control').events);
    await pool.closeAll();

    const text = textOf(events);
    expect(text).toContain('Reasoning Effort');
    expect(text).toContain('Press enter to confirm or esc to go back');
    expect(text).not.toContain('confirmed-too-early');
  }, 15_000);

  it('presses enter after a picker literal when typing it produces no output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'live-session-control-literal-confirm-test-'));
    const bin = join(dir, 'fake-control-literal-confirm-agent.mjs');
    await writeFile(
      bin,
      `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  if (buf.includes('1') && /[\\r\\n]/.test(buf)) {
    process.stdout.write('confirmed-after-delay\\n');
    buf = '';
  }
});
setInterval(() => {}, 1000);
`,
      'utf8',
    );
    await chmod(bin, 0o755);

    const pool = new LiveSessionPool();
    const session = pool.getOrCreate('control-literal-confirm-scope', {
      command: process.execPath,
      args: [bin],
      cwd: dir,
      signature: 'control-literal-confirm',
      usePty: false,
      idleMs: 80,
      outputFlushMs: 10,
      startupTimeoutMs: 1000,
    });

    const events = await collect(session.run('control-literal-confirm-run', '1', dir, 'control').events);
    await pool.closeAll();

    expect(textOf(events)).toContain('confirmed-after-delay');
  }, 15_000);

  it('cleans up a previous live turn when a new turn starts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'live-session-turn-cleanup-test-'));
    const bin = join(dir, 'fake-turn-cleanup-agent.mjs');
    await writeFile(
      bin,
      `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.search(/[\\r\\n]/)) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line === 'second') process.stdout.write('second-ok\\n');
  }
});
setInterval(() => {}, 1000);
`,
      'utf8',
    );
    await chmod(bin, 0o755);

    const pool = new LiveSessionPool();
    const session = pool.getOrCreate('turn-cleanup-scope', {
      command: process.execPath,
      args: [bin],
      cwd: dir,
      signature: 'turn-cleanup',
      usePty: false,
      idleMs: 1000,
      outputFlushMs: 5,
      startupTimeoutMs: 1000,
    });

    const first = session.run('run-turn-cleanup-1', 'first', dir).events[Symbol.asyncIterator]();
    expect(await first.next()).toMatchObject({ done: false, value: { type: 'system' } });
    const stalePending = first.next();
    await testDelay(80);

    const second = await collect(session.run('run-turn-cleanup-2', 'second', dir).events);
    const staleResult = await Promise.race([
      stalePending,
      testDelay(200).then(() => 'timeout' as const),
    ]);
    await pool.closeAll();

    expect(staleResult).not.toBe('timeout');
    expect(textOf(second)).toBe('second-ok\n');
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

  tmuxIt('does not send enter after a tmux picker literal when the screen changes first', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'live-session-tmux-control-literal-test-'));
    const bin = join(dir, 'fake-tmux-control-literal-agent.mjs');
    await writeFile(
      bin,
      `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
let sawChoice = false;
process.stdin.on('data', (chunk) => {
  if (!sawChoice && chunk.includes('1')) {
    sawChoice = true;
    process.stdout.write('Reasoning Effort\\n');
    process.stdout.write('1. Low\\n');
    process.stdout.write('2. Medium\\n');
    process.stdout.write('Press enter to confirm or esc to go back\\n');
  }
  if (sawChoice && /[\\r\\n]/.test(chunk)) {
    process.stdout.write('confirmed-too-early\\n');
  }
});
setInterval(() => {}, 1000);
`,
      'utf8',
    );
    await chmod(bin, 0o755);

    const pool = new LiveSessionPool();
    const session = pool.getOrCreate('tmux-control-literal-scope', {
      command: process.execPath,
      args: [bin],
      cwd: dir,
      signature: 'tmux-control-literal',
      usePty: true,
      backend: 'tmux',
      idleMs: 500,
      outputFlushMs: 40,
      startupTimeoutMs: 1500,
    });

    const events = await collect(session.run('tmux-control-literal-run', '1', dir, 'control').events);
    await pool.closeAll();

    const text = textOf(events);
    expect(text).toContain('Reasoning Effort');
    expect(text).toContain('Press enter to confirm or esc to go back');
    expect(text).not.toContain('confirmed-too-early');
  }, 20_000);

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

function testDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
