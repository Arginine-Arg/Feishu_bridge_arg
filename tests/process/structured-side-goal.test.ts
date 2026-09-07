import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { StructuredAdapter } from '../../src/agent/structured/adapter';
import type { AgentEvent, AgentRun } from '../../src/agent/types';

const native = process.env.ARG_BRIDGE_NATIVE_GOAL_SIDE === '1' ? it : it.skip;
native('answers side while a real native goal is running without interrupting the parent', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'bridge-native-codex-goal-side-'));
  const adapter = new StructuredAdapter({ kind: 'codex', binary: 'codex', profileDir: join(cwd, 'state'), nativeView: false });
  const mainEvents: AgentEvent[] = [];
  let mainRun: AgentRun | undefined;
  let mainDone: Promise<void> | undefined;
  try {
    mainRun = adapter.run({ runId: 'goal', scopeId: 'probe', cwd, liveInputMode: 'command',
      prompt: '/goal Run the shell command sleep 25 exactly once, wait until it finishes, then mark this goal complete. Do not edit files or do other work.' });
    mainDone = (async () => { for await (const event of mainRun!.events) mainEvents.push(event); })();
    const deadline = Date.now() + 30000;
    while (!mainEvents.some(event => event.type === 'tool_use') && Date.now() < deadline) {
      if (mainEvents.some(event => event.type === 'error')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(mainEvents.filter(event => event.type === 'error')).toEqual([]);
    expect(mainEvents.some(event => event.type === 'tool_use')).toBe(true);
    expect((await adapter.tmux.diagnostics!('probe')).inputState).toBe('submitted');
    const sideEvents: AgentEvent[] = [];
    for await (const event of adapter.runSide({ runId: 'side', scopeId: 'probe', cwd, liveInputMode: 'side',
      prompt: '/btw Reply exactly GOAL_SIDE_OK. Do not execute tools or continue the inherited goal.' }).events) sideEvents.push(event);
    expect(sideEvents.filter(event => event.type === 'error')).toEqual([]);
    expect(sideEvents.filter(event => event.type === 'text').map(event => event.delta).join('')).toContain('GOAL_SIDE_OK');
    for await (const event of adapter.runSide({ runId: 'out', scopeId: 'probe', cwd, prompt: '/btw out', liveInputMode: 'side-exit' }).events) expect(event.type).not.toBe('error');
    await Promise.race([mainDone, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Goal did not finish')), 45000); timer.unref(); })]);
    expect(mainEvents.filter(event => event.type === 'error')).toEqual([]);
    expect(mainEvents.filter(event => event.type === 'done')).toEqual([expect.objectContaining({ terminationReason: 'normal' })]);
  } finally {
    await mainRun?.stop();
    await adapter.shutdown();
    await mainDone;
  }
}, 90000);
