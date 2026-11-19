import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { withConfigFileLock } from '../../config/profile-store';
import { writeFileAtomic } from '../../platform/atomic-write';
import { processAlive } from './host-registry';

export type RecoveryPhase = 'normal' | 'tool_running' | 'working_stalled' | 'provider_retrying' | 'bridge_backoff' |
  'recovery_exhausted' | 'needs_attention' | 'status_unknown' | 'disabled' | 'stopped';

export interface RecoveryOperation {
  id: string;
  failedTurnId: string;
  state: 'reserved' | 'accepted' | 'uncertain';
  createdAt: number;
  turnId?: string;
}

export interface RecoveryRecord {
  version: 1;
  epoch: number;
  phase: RecoveryPhase;
  attempts: number;
  startedAt?: number;
  deadline?: number;
  episodeId?: string;
  lastError?: string;
  nextAt?: number;
  failedTurnId?: string;
  generation?: string;
  blocked?: string;
  owner?: { pid: number; start?: string; token: string };
  operations: Record<string, RecoveryOperation>;
}

async function startTime(pid: number): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/u)[19];
  } catch { return undefined; }
}

/**
 * One journal per CODEX_HOME/thread, shared across profiles, native and Bot.
 * Reservation is persisted BEFORE turn/start. Unknown results are never
 * replayed, including after a process restart. This file is not chat history.
 */
export class RecoveryLedger {
  record: RecoveryRecord = { version: 1, epoch: 0, phase: 'normal', attempts: 0, operations: {} };
  private readonly token = randomUUID();
  private serial: Promise<unknown> = Promise.resolve();
  private file?: string;
  constructor(readonly threadId: string) {}

  async persistIn(codexHome: string, generation: string): Promise<void> {
    const home = await realpath(codexHome);
    this.file = join(home, 'arg-bridge', 'recovery', `${createHash('sha256').update(this.threadId).digest('hex')}.json`);
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    await this.change(state => {
      if (state.generation && state.generation !== generation) {
        state.epoch += 1; state.blocked = 'provider_changed'; state.phase = 'needs_attention';
        state.nextAt = undefined; state.owner = undefined;
      }
      state.generation = generation;
    });
  }

  private change<T>(action: (state: RecoveryRecord) => T | Promise<T>): Promise<T> {
    const run = async () => {
      const transaction = async () => {
        if (this.file) {
          try {
            const saved = JSON.parse(await readFile(this.file, 'utf8')) as RecoveryRecord;
            if (saved.version !== 1 || !saved.operations || typeof saved.epoch !== 'number') throw new Error('Invalid recovery journal');
            this.record = saved;
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        const result = await action(this.record);
        if (this.file) await writeFileAtomic(this.file, JSON.stringify(this.record), { mode: 0o600 });
        return result;
      };
      return this.file ? withConfigFileLock(this.file, transaction) : transaction();
    };
    const next = this.serial.then(run, run);
    this.serial = next;
    return next;
  }

  private async claim(state: RecoveryRecord): Promise<boolean> {
    if (state.owner && state.owner.token !== this.token && processAlive(state.owner.pid)) {
      if (!state.owner.start || state.owner.start === await startTime(state.owner.pid)) return false;
    }
    state.owner = { pid: process.pid, start: this.file ? await startTime(process.pid) : undefined, token: this.token };
    return true;
  }

  async episode(budgetSeconds: number, error: string, turnId: string): Promise<boolean> {
    return this.change(async state => {
      if (state.blocked || !await this.claim(state)) return false;
      if (state.startedAt === undefined) {
        state.startedAt = Date.now(); state.deadline = Date.now() + budgetSeconds * 1000;
        state.episodeId = randomUUID(); state.attempts = 0;
      }
      state.lastError = error; state.failedTurnId = turnId;
      if (Date.now() >= state.deadline!) { state.phase = 'recovery_exhausted'; state.nextAt = undefined; return false; }
      return true;
    });
  }

  async waiting(phase: RecoveryPhase, nextAt?: number): Promise<void> {
    await this.change(state => {
      if (state.owner?.token !== this.token || state.blocked) return;
      state.phase = phase; state.nextAt = nextAt;
    });
  }

  async reserve(failedTurnId: string, epoch: number, maxAttempts: number): Promise<RecoveryOperation | undefined> {
    return this.change(async state => {
      if (epoch !== state.epoch || state.blocked || !await this.claim(state)) return;
      if (!state.deadline || Date.now() >= state.deadline || (maxAttempts > 0 && state.attempts >= maxAttempts)) {
        state.phase = 'recovery_exhausted'; state.nextAt = undefined; return;
      }
      if (state.operations[failedTurnId]) return;
      const id = `arg-bridge-recovery-${createHash('sha256').update(`${this.threadId}:${state.episodeId}:${failedTurnId}:${epoch}`).digest('hex').slice(0, 32)}`;
      const operation: RecoveryOperation = { id, failedTurnId, state: 'reserved', createdAt: Date.now() };
      state.operations[failedTurnId] = operation;
      state.attempts += 1; state.nextAt = undefined;
      return operation;
    });
  }

  async acknowledge(failedTurnId: string, turnId?: string): Promise<void> {
    await this.change(state => {
      const operation = state.operations[failedTurnId];
      if (!operation) return;
      operation.state = turnId ? 'accepted' : 'uncertain'; operation.turnId = turnId;
    });
  }

  /** Only explicit user work or an authoritative successful turn resets time. */
  async reset(reason: 'user_input' | 'completed'): Promise<void> {
    await this.change(state => {
      state.epoch += 1; state.startedAt = undefined; state.deadline = undefined;
      state.episodeId = undefined; state.attempts = 0; state.nextAt = undefined;
      state.blocked = undefined; state.phase = 'normal'; state.lastError = undefined;
      if (reason === 'user_input') state.owner = undefined;
      // Keep the tombstones: a late duplicate failure must never run twice.
    });
  }

  async invalidate(reason: string): Promise<void> {
    await this.change(state => {
      state.epoch += 1; state.blocked = reason; state.nextAt = undefined;
      state.phase = reason === 'off' ? 'disabled' : reason === 'stop' ? 'stopped' : 'needs_attention';
    });
  }

  async enable(): Promise<void> {
    await this.change(state => {
      // Enabling changes permission, not the episode's deadline or dedup log.
      if (state.blocked === 'off') state.blocked = undefined;
      if (state.phase === 'disabled') state.phase = state.deadline && Date.now() >= state.deadline ? 'recovery_exhausted' : 'normal';
    });
  }

  async refresh(): Promise<void> { await this.change(() => {}); }
  async release(): Promise<void> { await this.change(state => { if (state.owner?.token === this.token) state.owner = undefined; }); }
}
