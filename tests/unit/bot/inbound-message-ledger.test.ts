import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InboundMessageLedger } from '../../../src/bot/inbound-message-ledger';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('InboundMessageLedger', () => {
  it('claims an inbound message exactly once across a process restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arg-bridge-inbound-ledger-'));
    const path = join(dir, 'inbound-message-ledger.json');
    cleanups.push(() => rm(dir, { recursive: true, force: true }));

    const first = new InboundMessageLedger(path, { now: () => 1_000 });
    await first.load();
    expect(await first.claim('om_once')).toBe(true);

    const raw = JSON.parse(await readFile(path, 'utf8')) as { version: number; entries: Record<string, number> };
    expect(raw).toEqual({ version: 1, entries: { om_once: 1_000 } });

    const restarted = new InboundMessageLedger(path, { now: () => 1_100 });
    await restarted.load();
    expect(await restarted.claim('om_once')).toBe(false);
    expect(await restarted.claim('om_new')).toBe(true);
  });

  it('is race-safe for simultaneous delivery of the same websocket event', async () => {
    const ledger = new InboundMessageLedger();
    const claims = await Promise.all(Array.from({ length: 12 }, () => ledger.claim('om_replayed')));

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(ledger.size()).toBe(1);
  });

  it('expires old ids and bounds retained state', async () => {
    let now = 0;
    const ledger = new InboundMessageLedger(undefined, {
      now: () => now,
      retentionMs: 100,
      maxEntries: 2,
    });
    await ledger.claim('om_old');
    now = 50;
    await ledger.claim('om_mid');
    now = 75;
    await ledger.claim('om_new');
    expect(ledger.size()).toBe(2);

    now = 101;
    expect(await ledger.claim('om_old')).toBe(true);
    expect(ledger.size()).toBeLessThanOrEqual(2);
  });
});
