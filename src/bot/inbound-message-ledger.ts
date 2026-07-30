import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../platform/atomic-write';

const FILE_VERSION = 1;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 50_000;

interface LedgerFile {
  version: number;
  entries: Record<string, number>;
}

/**
 * Feishu delivery is at-least-once, especially across websocket reconnects.
 * Persisting the accepted message ids before a message enters PendingQueue
 * makes duplicate events harmless across both one process and later restarts.
 */
export class InboundMessageLedger {
  private readonly entries = new Map<string, number>();
  private saving: Promise<void> = Promise.resolve();

  constructor(
    private readonly path?: string,
    private readonly options: {
      now?: () => number;
      retentionMs?: number;
      maxEntries?: number;
    } = {},
  ) {}

  async load(): Promise<void> {
    if (!this.path) return;
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as Partial<LedgerFile>;
      if (raw.version !== FILE_VERSION || !raw.entries || typeof raw.entries !== 'object') return;
      for (const [messageId, acceptedAt] of Object.entries(raw.entries)) {
        if (typeof acceptedAt === 'number' && Number.isFinite(acceptedAt) && messageId) {
          this.entries.set(messageId, acceptedAt);
        }
      }
      this.prune(this.now());
      await this.flush();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  /** Returns true exactly once for a message id within the retention window. */
  async claim(messageId: string): Promise<boolean> {
    if (!messageId) return true;
    const now = this.now();
    this.prune(now);
    if (this.entries.has(messageId)) return false;
    this.entries.set(messageId, now);
    this.prune(now);
    this.schedulePersist();
    // Durably record the claim before the caller can enqueue agent work. A
    // restart after this point can therefore never re-run the same message.
    await this.flush();
    return true;
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  size(): number {
    return this.entries.size;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private retentionMs(): number {
    return this.options.retentionMs ?? DEFAULT_RETENTION_MS;
  }

  private maxEntries(): number {
    return this.options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  private prune(now: number): void {
    const oldest = now - this.retentionMs();
    for (const [messageId, acceptedAt] of this.entries) {
      if (acceptedAt < oldest) this.entries.delete(messageId);
    }
    if (this.entries.size <= this.maxEntries()) return;
    const oldestFirst = [...this.entries.entries()].sort((a, b) => a[1] - b[1]);
    const excess = this.entries.size - this.maxEntries();
    for (const [messageId] of oldestFirst.slice(0, excess)) this.entries.delete(messageId);
  }

  private schedulePersist(): void {
    if (!this.path) return;
    this.saving = this.saving.then(async () => {
      const entries = Object.fromEntries(this.entries);
      await writeFileAtomic(this.path!, `${JSON.stringify({ version: FILE_VERSION, entries }, null, 2)}\n`, {
        mode: 0o600,
      });
    });
  }
}
