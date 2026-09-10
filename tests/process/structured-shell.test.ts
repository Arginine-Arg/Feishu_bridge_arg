import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { StructuredView } from '../../src/agent/structured/view';

const available = process.platform !== 'win32' && spawnSync('tmux', ['-V']).status === 0;
it.skipIf(!available)('keeps an interactive shell after the native program exits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ab-shell-'));
  const view = new StructuredView(dir, dir);
  try {
    // Keep the shell hand-off deterministic: the worker's real .bashrc may
    // initialize Conda/modules and delay (or suppress) the first prompt for a
    // detached tmux pane. Production sessions still inherit the user's HOME;
    // this process contract only needs to prove that the shell remains alive
    // and interactive after the native program exits.
    await view.start({ binary: '/bin/true', endpoint: 'unix:///unused', threadId: 'unused', env: { ...process.env, HOME: dir, SHELL: '/bin/bash' } }, dir);
    const terminal = view.status().terminal!;
    expect(terminal).toBeDefined();
    const tmux = (...args: string[]) => spawnSync('tmux', ['-S', terminal.socketPath, ...args], { encoding: 'utf8' });
    await expect.poll(() => tmux('capture-pane', '-p', '-t', terminal.target).stdout, { timeout: 10000 }).toContain('shell remains');
    // The exit notice precedes exec'ing the user's interactive shell. Wait
    // for its real prompt before injecting keys; otherwise Ctrl-C can race
    // shell startup/readline initialization rather than exercise an idle shell.
    await expect.poll(() => tmux('capture-pane', '-p', '-t', terminal.target).stdout.trimEnd(), { timeout: 15000 }).toMatch(/[$#]$/);
    tmux('send-keys', '-t', terminal.target, 'C-c');
    tmux('send-keys', '-t', terminal.target, 'C-c');
    tmux('send-keys', '-t', terminal.target, '-l', "printf 'SHELL_%s\\n' 'USABLE'");
    tmux('send-keys', '-t', terminal.target, 'Enter');
    await expect.poll(() => tmux('capture-pane', '-p', '-t', terminal.target).stdout, { timeout: 5000 }).toContain('SHELL_USABLE');
    expect(tmux('display-message', '-p', '-t', terminal.target, '#{pane_dead}').stdout.trim()).toBe('0');
  } finally { await view.dispose(); }
}, 20000);
