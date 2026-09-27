import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { RpcClient } from '../../../src/agent/structured/rpc.js';
import { CodexStructuredSession } from '../../../src/agent/structured/codex.js';
import {
  StaleStructuredEndpointError,
  StructuredAdapter,
} from '../../../src/agent/structured/adapter.js';

const cleanups: Array<() => Promise<void>> = [];
const servers: any[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('RPC channel liveness', () => {
  it('reports closed after the App Server drops the connection', async () => {
    const socketPath = await unixSocketPath();
    const { wss, client } = await connectPair(socketPath);

    expect(client.closed).toBe(false);
    for (const socket of wss.clients) socket.terminate();
    await waitFor(() => client.closed, 3_000);
    expect(client.closed).toBe(true);
    expect(client.failureReason?.message).toContain('connection closed');
    client.close();
  });

  it('marks a structured session dead once its channel closes', async () => {
    const alive = new CodexStructuredSession('thread-1', 'unix:///tmp/x.sock', fakeRpc(false));
    const dead = new CodexStructuredSession('thread-2', 'unix:///tmp/x.sock', fakeRpc(true));

    expect(alive.isAlive()).toBe(true);
    expect(dead.isAlive()).toBe(false);
    expect(dead.failureReason).toBe('Codex App Server connection closed; input will not be replayed');
    alive.disconnect();
    dead.disconnect();
  });
});

describe('stale endpoint detection', () => {
  it('turns a vanished socket into a typed stale-endpoint error', async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'rpc-liveness-'));
    cleanups.push(() => rm(profileDir, { recursive: true, force: true }));
    const adapter = new StructuredAdapter({ kind: 'codex', binary: '/nonexistent', profileDir });
    const connect = (adapter as unknown as {
      connectExisting(endpoint: string): Promise<unknown>;
    }).connectExisting.bind(adapter);

    await expect(connect('unix:///tmp/definitely-missing-app-server.sock'))
      .rejects.toBeInstanceOf(StaleStructuredEndpointError);
  });

  it('keeps a live socket connectable', async () => {
    const socketPath = await unixSocketPath();
    const { wss, client } = await connectPair(socketPath);

    expect(client.closed).toBe(false);
    for (const socket of wss.clients) socket.close();
    client.close();
  });
});

function fakeRpc(closed: boolean): any {
  return {
    closed,
    failureReason: closed
      ? new Error('Codex App Server connection closed; input will not be replayed')
      : undefined,
    on: () => {},
    off: () => {},
    request: async () => ({}),
    notify: () => {},
    close: () => {},
  };
}

async function unixSocketPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rpc-liveness-sock-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'server.sock');
}

async function connectPair(socketPath: string): Promise<{ wss: WebSocketServer; client: RpcClient }> {
  const httpServer = createServer();
  servers.push(httpServer);
  const wss = new WebSocketServer({ server: httpServer, path: '/' });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(socketPath, () => resolve());
  });
  const client = await RpcClient.connect(`ws+unix://${socketPath}:/`);
  return { wss, client };
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for condition');
}
