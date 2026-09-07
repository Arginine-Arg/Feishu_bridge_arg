import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { LiveSessionPool } from '../../src/agent/live-session';
import type { AgentEvent } from '../../src/agent/types';

// Opt-in contract test against the installed, authenticated Codex CLI. No
// model turn or tool execution is requested: only native menu navigation.
const nativeIt = process.env.ARG_BRIDGE_TEST_NATIVE_CODEX === '1' && process.platform === 'linux'
  ? it : it.skip;

nativeIt('drives real Codex model and reasoning menus using keys rather than Paste events', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'argbridge-native-picker-'));
  const pool = new LiveSessionPool();
  const session = pool.getOrCreate('native-picker', {
    command: process.env.ARG_BRIDGE_TEST_CODEX_BINARY ?? 'codex',
    args: ['--no-alt-screen', '-c', 'check_for_update_on_startup=false',
      '-c', 'disable_paste_burst=true', '-c', `projects.${JSON.stringify(cwd)}.trust_level="trusted"`],
    cwd, signature: 'native-picker', backend: 'tmux', usePty: true,
    idleMs: 500, outputFlushMs: 40, startupTimeoutMs: 15000,
  });
  const collect = async (events: AsyncIterable<AgentEvent>) => {
    let text = '';
    for await (const event of events) {
      if (event.type === 'text') text += event.delta;
      if (event.type === 'error') throw new Error(event.message);
    }
    return text;
  };
  try {
    // Codex versions using the shared daemon may ask for trust even with a
    // launch override. This freshly created empty test directory is ours;
    // acknowledge only its startup screen before testing commands.
    await collect(session.run('startup', 'enter', cwd, 'control').events);
    expect(await collect(session.run('model', '/model', cwd, 'command').events)).toContain('Select Model');
    const reasoning = await collect(session.run('choice', '1', cwd, 'control').events);
    expect(reasoning).toMatch(/(?:Reasoning Level|Reasoning Effort)/);
    expect(reasoning).not.toContain('Model changed to');
    expect(await collect(session.run('back', 'esc', cwd, 'control').events)).toContain('Select Model');
  } finally {
    await pool.closeAll();
  }
}, 60000);
