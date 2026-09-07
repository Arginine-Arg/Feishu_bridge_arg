import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export type Wire = Record<string, any>;

/** JSON-RPC control channel. Never retries mutating requests after a gap. */
export class RpcClient extends EventEmitter {
  private nextId = 1;
  private failure?: Error;
  private pending = new Map<number, { resolve(value: Wire): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private constructor(private readonly socket: WebSocket) {
    super();
    socket.on('message', data => {
      let message: Wire;
      try { message = JSON.parse(data.toString()); } catch { this.fail(new Error('Invalid JSON from Codex App Server')); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) { this.fail(new Error('Invalid RPC message')); return; }
      if (typeof message.id === 'number' && !message.method) {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id); clearTimeout(request.timer);
        if (message.error) request.reject(new Error(String(message.error.message ?? 'RPC error')));
        else request.resolve(message.result ?? {});
      } else this.emit('message', message);
    });
    socket.on('error', error => this.fail(error));
    socket.on('close', () => this.fail(new Error('Codex App Server connection closed; input will not be replayed')));
  }
  static async connect(url: string): Promise<RpcClient> {
    const socket = new WebSocket(url, { handshakeTimeout: 5000, maxPayload: 32 * 1024 * 1024, perMessageDeflate: false });
    const client = new RpcClient(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve); socket.once('error', reject);
    });
    return client;
  }
  async initialize(): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'arg_bridge', version: 'structured-preview' }, capabilities: { experimentalApi: true } });
    this.notify('initialized', {});
  }
  request(method: string, params: Wire, timeoutMs = 30000): Promise<Wire> {
    if (this.failure || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(this.failure ?? new Error('RPC connection is not open'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC ${method} timed out; outcome unknown, not retried`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }), error => {
        if (!error) return;
        clearTimeout(timer); this.pending.delete(id); reject(error);
      });
    });
  }
  notify(method: string, params: Wire): void { this.socket.send(JSON.stringify({ method, params })); }
  respond(id: string | number, result: unknown): void { this.socket.send(JSON.stringify({ id, result })); }
  rejectRequest(id: string | number, message: string): void { this.socket.send(JSON.stringify({ id, error: { code: -32601, message } })); }
  close(): void { this.socket.close(); }
  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear(); this.socket.terminate(); this.emit('disconnected', error);
  }
}
