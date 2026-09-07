import { mkdtemp } from 'node:fs/promises';
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
    try {
      for await (const event of adapter.run({ runId: 'probe', scopeId: 'probe', cwd: directory, prompt: '/model', liveInputMode: 'command' }).events) events.push(event);
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
        if (kind === 'codex') {
          const deadline = Date.now() + 5000;
          let screen = '';
          do {
            screen = (await adapter.tmux.tail!('probe', 80)).text;
            if (/[•●]\s+BRIDGE_PROTOCOL_OK/.test(screen)) break;
            await new Promise(resolve => setTimeout(resolve, 200));
          } while (Date.now() < deadline);
          expect(screen).toMatch(/[•●]\s+BRIDGE_PROTOCOL_OK/);
        }
      }
    } finally { await adapter.shutdown(); }
  }, 60000);
}
