import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { RpcClient } from '../../../src/agent/structured/rpc.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('RPC codexHome', () => {
  it('keeps the seeded home until initialize reports the authoritative one', async () => {
    const { url } = await serve({ codexHome: '/server/codex-home' });
    const client = await RpcClient.connect(url, { codexHome: '/seeded/codex-home' });
    cleanups.push(clientCleanup(client));

    expect(client.codexHome).toBe('/seeded/codex-home');
    await client.initialize();
    expect(client.codexHome).toBe('/server/codex-home');
  });

  it('preserves the seeded home when an older server omits codexHome', async () => {
    const { url } = await serve({});
    const client = await RpcClient.connect(url, { codexHome: '/seeded/codex-home' });
    cleanups.push(clientCleanup(client));

    await client.initialize();
    expect(client.codexHome).toBe('/seeded/codex-home');
  });

  it('leaves codexHome undefined when neither source provides it', async () => {
    const { url } = await serve({});
    const client = await RpcClient.connect(url);
    cleanups.push(clientCleanup(client));

    await client.initialize();
    expect(client.codexHome).toBeUndefined();
  });
});

async function serve(initializeResult: Record<string, unknown>) {
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer, path: '/' });
  wss.on('connection', socket => {
    socket.on('message', raw => {
      let message: { id?: number; method?: string };
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message.method === 'initialized' || message.id === undefined) return;
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: initializeResult }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('no server address');
  const url = `ws://127.0.0.1:${address.port}`;
  cleanups.push(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>(resolve => httpServer.close(() => resolve()));
  });
  return { url };
}

function clientCleanup(client: RpcClient): () => Promise<void> {
  return async () => client.close();
}
