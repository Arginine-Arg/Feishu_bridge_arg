import { mkdtemp, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { LiveSessionPool } from '../../../src/agent/live-session';
import type { AgentEvent } from '../../../src/agent/types';

const tmuxIt = process.platform === 'linux' && spawnSync('tmux', ['-V']).status === 0 ? it : it.skip;

tmuxIt('honors TUI Paste/Key semantics and relays a final answer after a long Working/suggestion frame', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'argbridge-transport-contract-'));
  const script = join(cwd, 'tui.mjs');
  await writeFile(script, String.raw`
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdout.write('\x1b[?2004h');
let state = 'editor', pending = '', draft = '', paste = false;
function screen(lines) { process.stdout.write('\x1b[2J\x1b[H' + lines.join('\r\n') + '\r\n'); }
function menu() { screen(['Select Model and Effort', '› 1. gpt-test', '2. gpt-other', 'Press enter to confirm or esc to go back']); }
screen(['› Ask Codex to do anything', 'gpt-test · /tmp · Main [default]']);
process.stdin.on('data', chunk => {
  pending += chunk;
  while (pending) {
    if (pending.startsWith('\x1b[200~')) { paste = true; pending = pending.slice(6); continue; }
    if (pending.startsWith('\x1b[201~')) { paste = false; pending = pending.slice(6); continue; }
    if (pending.startsWith('\x1b') && pending.length < 6) return;
    const char = pending[0]; pending = pending.slice(1);
    // Like Codex's ListSelectionView, a menu ignores Paste events.
    if (paste) { if (state === 'editor') draft += char; continue; }
    if (state === 'model' && char === '1') {
      state = 'reasoning'; screen(['Select Reasoning Level for gpt-test', '› 1. Low', '2. High', 'Press enter to confirm or esc to go back']); continue;
    }
    if (state === 'reasoning' && char === '\r') { state = 'editor'; screen(['BAD: unsolicited default confirmation']); continue; }
    if (char !== '\r') { if (state === 'editor') draft += char; continue; }
    if (draft === '/model') { draft = ''; state = 'model'; menu(); continue; }
    if (draft === 'run delayed work') {
      draft = '';
      screen(['• initial update', '• Working (1s • esc to interrupt)', '› Ask Codex to do anything', 'gpt-test · /tmp · Main [default]']);
      setTimeout(() => screen(['• final answer after delayed work', '─ Worked for 8s ─', '› Ask Codex to do anything', 'gpt-test · /tmp · Main [default]']), 8000);
    }
  }
});
setInterval(() => {}, 1000);
`);
  const pool = new LiveSessionPool();
  const create = (key: string) => pool.getOrCreate(key, {
    command: process.execPath, args: [script], cwd, signature: key,
    backend: 'tmux', usePty: true, idleMs: 200, startupTimeoutMs: 12000, outputFlushMs: 30,
  });
  const collect = async (events: AsyncIterable<AgentEvent>) => {
    let text = '';
    for await (const event of events) { if (event.type === 'text') text += event.delta; }
    return text;
  };
  try {
    const menuSession = create('menu');
    expect(await collect(menuSession.run('open', '/model', cwd, 'command').events)).toContain('Select Model');
    const result = await collect(menuSession.run('select', '1', cwd, 'control').events);
    expect(result).toContain('Select Reasoning Level');
    expect(result).not.toContain('unsolicited');
    const workSession = create('work');
    expect(await collect(workSession.run('work', 'run delayed work', cwd).events)).toContain('final answer after delayed work');
  } finally { await pool.closeAll(); }
}, 40000);
