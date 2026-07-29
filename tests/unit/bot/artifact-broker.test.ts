import { connect } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactBroker } from '../../../src/bot/artifact-broker.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('ArtifactBroker', () => {
  it('delivers only a run-authorized workspace-relative regular file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'artifact-broker-'));
    const workspace = join(root, 'workspace');
    await writeFile(join(root, 'placeholder'), 'x');
    await mkdir(workspace);
    await writeFile(join(workspace, 'report.txt'), 'done');
    const send = vi.fn(async () => ({ messageId: 'om-file' }));
    const broker = new ArtifactBroker(join(root, 'broker.sock'), { send } as never, async () => true);
    await broker.start();
    cleanups.push(async () => {
      await broker.close();
      await rm(root, { recursive: true, force: true });
    });
    const grant = broker.issue({
      scope: 'chat-1',
      chatId: 'oc-1',
      replyTo: 'om-1',
      allowedRoots: [workspace],
      maxFileBytes: 1024,
    });

    await expect(request(grant.socketPath, { token: grant.token, path: 'report.txt' })).resolves.toMatchObject({ ok: true });
    expect(send).toHaveBeenCalledWith(
      'oc-1',
      { file: { source: join(workspace, 'report.txt'), fileName: 'report.txt' } },
      { replyTo: 'om-1' },
    );
    await expect(request(grant.socketPath, { token: grant.token, path: '../placeholder' })).resolves.toMatchObject({ ok: false });
  });

  it('keeps a live scope token stable while refreshing its delivery target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'artifact-broker-live-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    await writeFile(join(workspace, 'report.txt'), 'done');
    const send = vi.fn(async () => ({ messageId: 'om-file' }));
    const broker = new ArtifactBroker(join(root, 'broker.sock'), { send } as never, async () => true);
    await broker.start();
    cleanups.push(async () => {
      await broker.close();
      await rm(root, { recursive: true, force: true });
    });

    const first = broker.issue({
      scope: 'chat-live',
      chatId: 'oc-1',
      replyTo: 'om-first',
      allowedRoots: [workspace],
      maxFileBytes: 1024,
      persistent: true,
    });
    const second = broker.issue({
      scope: 'chat-live',
      chatId: 'oc-1',
      replyTo: 'om-second',
      allowedRoots: [],
      maxFileBytes: 1024,
      persistent: true,
    });

    expect(second).toEqual(first);
    expect(broker.activate(second.token, [workspace])).toBe(true);
    await expect(request(second.socketPath, { token: first.token, path: 'report.txt' })).resolves.toMatchObject({ ok: true });
    expect(send).toHaveBeenCalledWith(
      'oc-1',
      { file: { source: join(workspace, 'report.txt'), fileName: 'report.txt' } },
      { replyTo: 'om-second' },
    );
  });

  it('restores a live terminal capability after the bridge process restarts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'artifact-broker-restart-'));
    const workspace = join(root, 'workspace');
    const socketPath = join(root, 'broker.sock');
    const statePath = join(root, 'artifact-grants.json');
    await mkdir(workspace);
    await writeFile(join(workspace, 'report.txt'), 'done');
    const firstSend = vi.fn(async () => ({ messageId: 'om-file' }));
    const first = new ArtifactBroker(socketPath, { send: firstSend } as never, async () => true, statePath);
    await first.start();
    const grant = first.issue({
      scope: 'chat-live',
      chatId: 'oc-1',
      replyTo: 'om-before-restart',
      allowedRoots: [],
      maxFileBytes: 1024,
      persistent: true,
    });
    expect(first.activate(grant.token, [workspace])).toBe(true);
    await first.close();

    const secondSend = vi.fn(async () => ({ messageId: 'om-file' }));
    const second = new ArtifactBroker(socketPath, { send: secondSend } as never, async () => true, statePath);
    await second.start();
    cleanups.push(async () => {
      await second.close();
      await rm(root, { recursive: true, force: true });
    });

    await expect(request(socketPath, {
      token: grant.token,
      path: 'report.txt',
      caption: '实验结果',
    })).resolves.toMatchObject({ ok: true });
    expect(secondSend).toHaveBeenNthCalledWith(
      1,
      'oc-1',
      { file: { source: join(workspace, 'report.txt'), fileName: 'report.txt' } },
      { replyTo: 'om-before-restart' },
    );
    expect(secondSend).toHaveBeenNthCalledWith(
      2,
      'oc-1',
      { markdown: '实验结果' },
      { replyTo: 'om-before-restart' },
    );
  });
});

function request(socketPath: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let data = '';
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on('data', (chunk: string) => {
      data += chunk;
      if (!data.includes('\n')) return;
      socket.end();
      resolve(JSON.parse(data.slice(0, data.indexOf('\n'))) as Record<string, unknown>);
    });
  });
}
