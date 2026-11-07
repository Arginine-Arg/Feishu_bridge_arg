import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { StructuredAdapter } from '../../src/agent/structured/adapter';
import { listStructuredTmuxPanes } from '../../src/agent/structured/tmux-discovery';
import type { AgentEvent } from '../../src/agent/types';

const tmuxAvailable = process.platform === 'linux' && spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;

it.skipIf(!tmuxAvailable)('selects the TUI-only wait popup after bot recreation without a new App Server turn', async () => {
  // A short /tmp path avoids the Unix-domain socket pathname limit on hosts
  // whose configured TMPDIR is already deeply nested.
  const root = await mkdtemp('/tmp/ab-picker-');
  const socket = join(root, 'tmux.sock');
  const audit = join(root, 'keys.json');
  const binary = join(root, 'codex');
  const profileDir = join(root, 'profile');
  const directory = join(profileDir, 'structured');
  const tmux = (...args: string[]) => spawnSync('tmux', ['-S', socket, ...args], { encoding: 'utf8' });
  const adapters: StructuredAdapter[] = [];
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(binary, [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      `const audit = ${JSON.stringify(audit)};`,
      'let selected = 1, open = true, keys = "", choices = [], buffer = "";',
      'process.stdin.setRawMode(true); process.stdin.resume();',
      'function render() {',
      ' process.stdout.write("\\x1b[2J\\x1b[H");',
      ' if (!open) { process.stdout.write("Task continues\\r\\n› Ask Codex to do anything\\r\\n"); return; }',
      ' process.stdout.write("Giving this request a little extra thought\\r\\n\\r\\n");',
      ' process.stdout.write((selected === 1 ? "› " : "  ") + "1. Dismiss and keep waiting\\r\\n");',
      ' process.stdout.write((selected === 2 ? "› " : "  ") + "2. Learn more\\r\\n\\r\\n");',
      ' process.stdout.write("No action is required. Codex will keep waiting, and this menu will close when the response is ready.\\r\\n");',
      '}',
      'function record() { fs.writeFileSync(audit, JSON.stringify({ keys, choices })); }',
      'process.stdin.on("data", data => {',
      ' keys += data.toString(); buffer += data.toString();',
      ' while (buffer) {',
      '  if (buffer === "\\x1b" || buffer === "\\x1b[") break;',
      '  if (buffer.startsWith("\\x1b[B")) { selected = Math.min(2, selected + 1); buffer = buffer.slice(3); }',
      '  else if (buffer.startsWith("\\x1b[A")) { selected = Math.max(1, selected - 1); buffer = buffer.slice(3); }',
      '  else { const char = buffer[0]; buffer = buffer.slice(1);',
      '    if (char === "r") { open = true; selected = 1; }',
      '    if (char === "\\r" && open) { choices.push(selected); open = false; }',
      '  }',
      ' } record(); render();',
      '});',
      'record(); render();',
    ].join('\n'), { mode: 0o700 });
    expect(tmux('new-session', '-d', '-s', 'native', '-x', '120', '-y', '30', binary,
      '--remote', 'unix:///no-app-server-needed.sock', 'resume', 'existing-thread').status).toBe(0);
    await expect.poll(() => tmux('capture-pane', '-p', '-t', 'native').stdout, { timeout: 15_000 }).toContain('Dismiss and keep waiting');
    const pane = listStructuredTmuxPanes(socket)[0]!;
    expect(pane.structured).toMatchObject({ threadId: 'existing-thread', endpoint: 'unix:///no-app-server-needed.sock' });
    await writeFile(join(directory, 'tmux-bindings.json'), JSON.stringify({ version: 1, bindings: {
      scope: { target: pane, threadId: 'existing-thread', endpoint: pane.structured.endpoint, cwd: root, updatedAt: Date.now() },
    } }));
    const adapter = new StructuredAdapter({ kind: 'codex', binary: '/must-not-start-codex', profileDir }); adapters.push(adapter);
    const events: AgentEvent[] = [];
    for await (const event of adapter.run({ runId: 'choice', scopeId: 'scope', cwd: root, prompt: '1', liveInputMode: 'control' }).events) events.push(event);
    expect(events.filter(event => event.type === 'error')).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ type: 'text', delta: expect.stringContaining('终端菜单') }));
    await expect.poll(async () => JSON.parse(await readFile(audit, 'utf8')).choices).toEqual([1]);
    expect(JSON.parse(await readFile(audit, 'utf8')).keys).toBe('\r');
    await expect.poll(() => tmux('capture-pane', '-p', '-t', 'native').stdout).toContain('Task continues');
    await expect(adapter.structuredControl('scope', '1')).rejects.toThrow('没有可操作');
    expect(JSON.parse(await readFile(audit, 'utf8')).keys).toBe('\r');

    // Managed structured views are also recovered from their saved identity,
    // with no protocol resume or new turn on a freshly started bot.
    await rm(join(directory, 'tmux-bindings.json'));
    await writeFile(join(directory, `${'a'.repeat(64)}.json`), JSON.stringify({
      kind: 'codex', scope: 'scope', id: 'existing-thread', endpoint: pane.structured.endpoint, cwd: root,
      view: { state: 'managed', terminal: { socketPath: socket, target: 'native', ownership: 'managed', attachCommand: 'tmux attach' } },
    }));
    tmux('send-keys', '-t', 'native', 'r');
    await expect.poll(() => tmux('capture-pane', '-p', '-t', 'native').stdout).toContain('Dismiss and keep waiting');
    const recreated = new StructuredAdapter({ kind: 'codex', binary: '/must-not-start-codex', profileDir }); adapters.push(recreated);
    await recreated.structuredControl('scope', '2');
    await expect.poll(async () => JSON.parse(await readFile(audit, 'utf8')).choices).toEqual([1, 2]);
    expect(JSON.parse(await readFile(audit, 'utf8')).keys).toBe('\rr\x1b[B\r');
  } finally {
    for (const adapter of adapters) await adapter.shutdown();
    tmux('kill-server');
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);
