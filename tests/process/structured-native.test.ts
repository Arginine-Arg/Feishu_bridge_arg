import { mkdtemp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { StructuredAdapter } from '../../src/agent/structured/adapter';
import type { AgentEvent } from '../../src/agent/types';

const native = process.env.ARG_BRIDGE_NATIVE_PROTOCOL === '1' ? it : it.skip;
for (const kind of ['codex', 'claude'] as const) {
  native(`${kind}: ${process.env.ARG_BRIDGE_NATIVE_PROTOCOL_TURN === '1' ? 'submits real text and verifies shared output' : 'queries and selects models without a model turn'}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `bridge-native-${kind}-`));
    const adapter = new StructuredAdapter({ kind, binary: kind, profileDir: join(directory, 'state'), nativeView: kind === 'codex' });
    const events: AgentEvent[] = [];
    let cleanupTmux: { socket: string; session: string } | undefined;
    try {
      for await (const event of adapter.run({ runId: 'probe', scopeId: 'probe', cwd: directory, prompt: '/model', liveInputMode: 'command',
        ...(process.env.ARG_BRIDGE_NATIVE_MODEL ? { model: process.env.ARG_BRIDGE_NATIVE_MODEL } : {}) }).events) events.push(event);
      expect(events.filter(event => event.type === 'error')).toEqual([]);
      expect(events.some(event => event.type === 'interactive' && (event.interaction?.choices.length ?? 0) > 0)).toBe(true);
      if (process.env.ARG_BRIDGE_NATIVE_PROTOCOL_TURN !== '1') {
        const picker = events.find((event): event is Extract<AgentEvent, { type: 'interactive' }> => event.type === 'interactive' && Boolean(event.interaction))!.interaction!;
        const follow = await adapter.structuredControl('probe', `/answer ${picker.id} ${picker.choices[0]!.value}`);
        const nested = follow.find((event): event is Extract<AgentEvent, { type: 'interactive' }> => event.type === 'interactive');
        if (nested?.interaction?.choices.length) await adapter.structuredControl('probe', `/answer ${nested.interaction.id} ${nested.interaction.choices[0]!.value}`);
      }
      expect((await adapter.tmux.status('probe')).state).toBe('managed');
      if (kind === 'codex') {
        const deadline = Date.now() + 10000;
        let screen = '';
        do {
          screen = (await adapter.tmux.tail!('probe', 50)).text;
          if (screen.includes('OpenAI Codex')) break;
          await new Promise(resolve => setTimeout(resolve, 200));
        } while (Date.now() < deadline);
        expect(screen).toContain('OpenAI Codex');
        expect(screen).not.toContain('Pane is dead');
      }
      if (process.env.ARG_BRIDGE_NATIVE_PROTOCOL_TURN === '1') {
        const reply: AgentEvent[] = [];
        for await (const event of adapter.run({ runId: 'text-probe', scopeId: 'probe', cwd: directory,
          prompt: 'Reply with exactly BRIDGE_PROTOCOL_OK. Do not use tools.' }).events) reply.push(event);
        expect(reply.filter(event => event.type === 'error')).toEqual([]);
        expect(reply.filter(event => event.type === 'text').map(event => event.delta).join('')).toContain('BRIDGE_PROTOCOL_OK');
        if (kind === 'codex' && process.env.ARG_BRIDGE_NATIVE_DISCOVERY === '1') {
          let discovered = await adapter.tmux.list();
          const discoveryDeadline = Date.now() + 10000;
          while (!discovered.some(pane => pane.paneCurrentPath === directory && pane.structured?.threadId && pane.structured.endpoint) && Date.now() < discoveryDeadline) {
            await new Promise(resolve => setTimeout(resolve, 200));
            discovered = await adapter.tmux.list();
          }
          expect(discovered.some(pane => pane.paneCurrentPath === directory && pane.structured?.threadId && pane.structured.endpoint)).toBe(true);
          const bound = discovered.find(pane => pane.paneCurrentPath === directory && pane.structured?.threadId && pane.structured.endpoint);
          expect(bound?.structured?.endpoint).toMatch(/^unix:\/\//);
          expect(bound?.structured?.threadId).toMatch(/\S/);
          if (process.env.ARG_BRIDGE_NATIVE_REBIND === '1' && bound) {
            const split = spawnSync('tmux', ['-S', bound.socketPath, 'split-window', '-d', '-t', bound.sessionName,
              '-c', bound.paneCurrentPath, '--', 'codex', '-c', 'check_for_update_on_startup=false', '--remote', bound.structured!.endpoint!,
              'resume', bound.structured!.threadId, '--no-alt-screen'], { encoding: 'utf8' });
            expect(split.status).toBe(0);
            const panes = await adapter.tmux.list(bound.socketPath);
            const replacement = panes.find(pane => pane.paneId !== bound!.paneId && pane.structured?.threadId === bound!.structured?.threadId);
            expect(replacement).toBeDefined();
            spawnSync('tmux', ['-S', bound.socketPath, 'select-pane', '-t', replacement!.paneId], { stdio: 'ignore' });
            const follow: AgentEvent[] = [];
            for await (const event of adapter.run({ runId: 'rebind-probe', scopeId: 'probe', cwd: directory,
              prompt: 'Reply with exactly REBIND_PROTOCOL_OK. Do not use tools.' }).events) follow.push(event);
            expect(follow.filter(event => event.type === 'error')).toEqual([]);
            const rebound = await adapter.tmux.status('probe', directory);
            expect(rebound.target?.paneId).toBe(replacement!.paneId);
            cleanupTmux = { socket: bound.socketPath, session: bound.sessionName };
          }
        }
        if (kind === 'claude' && process.env.ARG_BRIDGE_NATIVE_FOLLOWUP === '1') {
          const followup: AgentEvent[] = [];
          for await (const event of adapter.run({ runId: 'followup-probe', scopeId: 'probe', cwd: directory,
            prompt: 'Reply with exactly FOLLOWUP_PROTOCOL_OK. Do not use tools.' }).events) followup.push(event);
          expect(followup.filter(event => event.type === 'error')).toEqual([]);
          expect(followup.filter(event => event.type === 'text').map(event => event.delta).join('').trim()).toBe('FOLLOWUP_PROTOCOL_OK');
          expect(followup.filter(event => event.type === 'done')).toEqual([expect.objectContaining({ terminationReason: 'normal' })]);
          const firstId = reply.find(event => event.type === 'system' && event.sessionId);
          expect(followup.find(event => event.type === 'system' && event.sessionId)).toMatchObject({ sessionId: (firstId as Extract<AgentEvent, { type: 'system' }>).sessionId });
          expect((await adapter.tmux.diagnostics!('probe')).inputState).toBe('empty');
          const deadline = Date.now() + 5000;
          let screen = '';
          do {
            screen = (await adapter.tmux.tail!('probe', 80)).text;
            if (/FOLLOWUP_PROTOCOL_OK\s+\[normal\]/.test(screen)) break;
            await new Promise(resolve => setTimeout(resolve, 100));
          } while (Date.now() < deadline);
          expect(screen).toMatch(/FOLLOWUP_PROTOCOL_OK\s+\[normal\]/);
        }
        if (kind === 'codex') {
          const deadline = Date.now() + 5000;
          let screen = '';
          do {
            screen = (await adapter.tmux.tail!('probe', 80)).text;
            if (/[•●]\s+BRIDGE_PROTOCOL_OK/.test(screen)) break;
            await new Promise(resolve => setTimeout(resolve, 200));
          } while (Date.now() < deadline);
          expect(screen).toMatch(/[•●]\s+BRIDGE_PROTOCOL_OK/);
          if (process.env.ARG_BRIDGE_NATIVE_SIDE === '1') {
            const side: AgentEvent[] = [];
            for await (const event of adapter.runSide({ runId: 'side-probe', scopeId: 'probe', cwd: directory,
              prompt: '/btw Reply with exactly SIDE_PROTOCOL_OK. Do not use tools.', liveInputMode: 'side' }).events) side.push(event);
            expect(side.filter(event => event.type === 'error')).toEqual([]);
            expect(side.some(event => event.type === 'system' && event.sideConversation === 'entered')).toBe(true);
            expect(side.filter(event => event.type === 'text').map(event => event.delta).join('')).toContain('SIDE_PROTOCOL_OK');
            expect((await adapter.tmux.diagnostics!('probe')).sideConversation).toBe(true);
            const out: AgentEvent[] = [];
            for await (const event of adapter.runSide({ runId: 'side-out', scopeId: 'probe', cwd: directory,
              prompt: '/btw out', liveInputMode: 'side-exit' }).events) out.push(event);
            expect(out.filter(event => event.type === 'error')).toEqual([]);
            expect((await adapter.tmux.diagnostics!('probe')).sideConversation).toBe(false);
            expect(await adapter.structuredControl('probe', '/status')).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text' })]));
          }
        }
      }
    } finally {
      if (cleanupTmux) spawnSync('tmux', ['-S', cleanupTmux.socket, 'kill-session', '-t', cleanupTmux.session], { stdio: 'ignore' });
      await adapter.shutdown();
    }
  }, 120000);
}
