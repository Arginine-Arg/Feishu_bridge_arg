import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';

type JsonRpcId = string | number;

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  removeAbort?: () => void;
}

interface JsonRpcMessage {
  jsonrpc?: '2.0';
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface McpToolResult {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export class McpRequestError extends Error {
  constructor(
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'McpRequestError';
  }
}

export class McpToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'McpToolError';
  }
}

export interface McpStdioClientOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Default per-request timeout. */
  timeoutMs?: number;
  clientVersion?: string;
}

/**
 * Minimal MCP stdio client for MixAgents Broker.
 *
 * Broker uses newline-delimited JSON-RPC (not Content-Length framing). The
 * client declares elicitation support and declines host-interaction requests:
 * arg-bridge never grants workspace or write access through a terminal prompt.
 */
export class McpStdioClient {
  private readonly child: SpawnedProcessByStdio<Writable, Readable, Readable>;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private nextId = 1;
  private closedError: Error | undefined;
  private readonly stderrTail: string[] = [];
  private readonly timeoutMs: number;
  private readonly clientVersion: string;

  private constructor(
    child: SpawnedProcessByStdio<Writable, Readable, Readable>,
    timeoutMs: number,
    clientVersion: string,
  ) {
    this.child = child;
    this.timeoutMs = timeoutMs;
    this.clientVersion = clientVersion;
    const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
    stdout.on('line', line => {
      if (line.trim()) this.accept(line);
    });
    const stderr = createInterface({ input: child.stderr, crlfDelay: Infinity });
    stderr.on('line', line => {
      this.stderrTail.push(line);
      if (this.stderrTail.length > 40) this.stderrTail.shift();
    });
    child.once('error', error => this.closeWith(error));
    child.once('exit', (code, signal) => {
      this.closeWith(new Error(
        `MixAgents MCP server exited (${signal ?? code ?? 'unknown'})` +
          (this.stderrTail.length ? `: ${redactSecrets(this.stderrTail.slice(-5).join(' ')).slice(0, 800)}` : ''),
      ));
    });
  }

  static async start(options: McpStdioClientOptions): Promise<McpStdioClient> {
    const child = spawnProcess(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as SpawnedProcessByStdio<Writable, Readable, Readable>;
    const client = new McpStdioClient(
      child,
      options.timeoutMs ?? 30_000,
      options.clientVersion ?? '1.7.0',
    );
    const initialized = await client.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: { elicitation: {} },
      clientInfo: { name: 'arg_bridge', version: client.clientVersion },
    }, 20_000) as Record<string, unknown>;
    if (!initialized || typeof initialized !== 'object') {
      client.close();
      throw new McpRequestError(undefined, 'MixAgents MCP server returned an invalid initialize response');
    }
    client.notify('notifications/initialized');
    const serverInfo = initialized.serverInfo;
    if (serverInfo && typeof serverInfo === 'object') {
      const version = (serverInfo as Record<string, unknown>).version;
      if (typeof version === 'string') client.serverVersion = version;
    }
    return client;
  }

  serverVersion?: string;

  async listTools(): Promise<Array<{ name: string; inputSchema?: unknown }>> {
    const result = await this.request('tools/list', {}, 20_000) as { tools?: unknown };
    if (!Array.isArray(result.tools)) return [];
    return result.tools
      .filter((tool): tool is { name: string; inputSchema?: unknown } =>
        Boolean(tool && typeof tool === 'object' && typeof (tool as { name?: unknown }).name === 'string'))
      .map(tool => ({ name: tool.name, inputSchema: tool.inputSchema }));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<Record<string, unknown>> {
    const result = await this.request('tools/call', { name, arguments: args }, options.timeoutMs ?? this.timeoutMs, options.signal) as McpToolResult;
    if (result.isError) {
      const structured = result.structuredContent ?? {};
      const message = typeof structured.message === 'string'
        ? structured.message
        : result.content?.map(item => item.text).filter(Boolean).join(' ') || `${name} failed`;
      throw new McpToolError(
        typeof structured.code === 'string' ? structured.code : 'mcp_tool_error',
        redactSecrets(message),
        structured.details && typeof structured.details === 'object'
          ? structured.details as Record<string, unknown>
          : undefined,
      );
    }
    return result.structuredContent ?? {};
  }

  request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = this.timeoutMs,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.closedError) return Promise.reject(this.closedError);
    if (signal?.aborted) return Promise.reject(abortError());
    const id = `arg-bridge-${this.nextId++}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.notify('notifications/cancelled', { requestId: id, reason: 'timeout' });
        reject(new McpRequestError(undefined, `${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      const pending: Pending = { resolve, reject, timer };
      if (signal) {
        const onAbort = () => {
          this.pending.delete(id);
          clearTimeout(timer);
          this.notify('notifications/cancelled', { requestId: id, reason: 'aborted' });
          reject(abortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        pending.removeAbort = () => signal.removeEventListener('abort', onAbort);
      }
      this.pending.set(id, pending);
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    if (!this.closedError) this.write({ jsonrpc: '2.0', method, params });
  }

  close(): void {
    this.closeWith(new Error('MixAgents MCP client closed'));
    if (!this.child.killed) {
      this.child.kill('SIGTERM');
      setTimeout(() => {
        if (!this.child.killed) this.child.kill('SIGKILL');
      }, 2_000).unref?.();
    }
  }

  private write(message: JsonRpcMessage): void {
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.closeWith(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private accept(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (typeof message.id === 'string' || typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (message.method) {
        // Server -> client request. Decline every host interaction: workspace
        // approval must come from Broker's preauthorized roots, never from a
        // non-interactive bridge prompt.
        this.write({ jsonrpc: '2.0', id: message.id, result: { action: 'decline' } });
        return;
      }
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.removeAbort?.();
      if (message.error) {
        pending.reject(new McpRequestError(
          message.error.code,
          redactSecrets(String(message.error.message ?? 'MCP request failed')),
        ));
      } else {
        pending.resolve(message.result ?? {});
      }
    }
  }

  private closeWith(error: Error): void {
    if (this.closedError) return;
    const safe = new Error(redactSecrets(error.message), { cause: error });
    safe.name = error.name;
    this.closedError = safe;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.removeAbort?.();
      pending.reject(safe);
    }
  }
}

function abortError(): Error {
  const error = new Error('子代理请求已取消');
  error.name = 'AbortError';
  return error;
}

/** Remove common credential shapes from diagnostics. */
export function redactSecrets(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{8,}/gu, 'sk-[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]')
    .replace(/("(?:api[_-]?key|token|authorization|secret)"\s*:\s*")[^"]+"/giu, '$1[REDACTED]"')
    .replace(/\b(api[_-]?key|token|authorization|secret)\s*([=:])\s*[^\s,;}]+/giu, '$1$2[REDACTED]')
    .replace(/\b([A-Z][A-Z0-9_]*KEY|TOKEN|SECRET)\s*[=:]\s*[^\s,}]+/gu, '$1=[REDACTED]');
}
