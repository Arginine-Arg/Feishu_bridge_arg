import { log, redactDiagnosticText } from '../../core/logger';
import { BRIDGE_CODEX_INPUT_PREFIX } from './codex';
import type { RpcClient, Wire } from './rpc';

/** Subscribe before resume, and forward only turns started on this connection's watch. */
export function relayCodexTerminalReplies(
  rpc: RpcClient,
  threadId: string,
  send: (turnId: string, text: string) => Promise<void>,
): void {
  let turnId: string | undefined;
  let delivery = Promise.resolve();
  rpc.on('message', (message: Wire) => {
    const { threadId: source, turn } = message.params ?? {};
    if (source !== threadId || !turn?.id) return;
    if (message.method === 'turn/started') turnId = turn.id;
    if (message.method !== 'turn/completed' || turnId !== turn.id) return;
    turnId = undefined;
    if (turn.status !== 'completed' && turn.status !== 'failed') return;
    delivery = delivery.then(async () => {
      if (rpc.closed) return;
      const items = turn.itemsView === 'full' || (turn.itemsView === undefined && turn.items?.length)
        ? turn.items : await readTurnItems(rpc, threadId, turn.id);
      const source = items.find((item: Wire) => item.type === 'userMessage');
      if (!source || String(source.clientId ?? '').startsWith(BRIDGE_CODEX_INPUT_PREFIX)) return;
      const replies = items.filter((item: Wire) => item.type === 'agentMessage' && item.phase !== 'commentary' && typeof item.text === 'string');
      const error = turn.status === 'failed' ? `⚠️ ${redactDiagnosticText(turn.error?.message ?? 'Codex turn failed')}` : '';
      const text = [...replies.map((item: Wire) => item.text), error].filter(Boolean).join('\n\n');
      if (text.trim()) await send(turn.id, text);
    }).catch(error => log.fail('outbound', error, { step: 'terminal-reply', turnId: turn.id }));
  });
}

async function readTurnItems(rpc: RpcClient, threadId: string, turnId: string): Promise<Wire[]> {
  const items: Wire[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await rpc.request('thread/items/list', {
      threadId, turnId, limit: 24, sortDirection: 'asc', ...(cursor ? { cursor } : {}),
    });
    if (!Array.isArray(page.data)) throw new Error('Codex returned an invalid item page');
    items.push(...page.data.map((entry: Wire) => entry.item ?? entry));
    cursor = page.nextCursor ?? undefined;
    if (cursor && cursors.has(cursor)) throw new Error('Codex repeated the item cursor');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return items;
}
