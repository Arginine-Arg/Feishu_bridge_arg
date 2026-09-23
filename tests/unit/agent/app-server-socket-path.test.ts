import { createServer, type Server } from 'node:net';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAppServerSocketPath } from '../../../src/agent/structured/adapter.js';

const cleanups: Array<() => Promise<void>> = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('App Server socket path resolution', () => {
  it('accepts a plain socket in an owner-private directory', async () => {
    const directory = await privateDir();
    const socket = join(directory, 'server.sock');
    await listen(socket);

    await expect(resolveAppServerSocketPath(socket)).resolves.toBe(socket);
  });

  it('follows the codex daemon symlink to the real owner-only socket', async () => {
    // Mirrors the real layout: /tmp/codex-daemon-<uid>/<hash> plus a symlink
    // from the runtime directory that `codex app-server` reports as its endpoint.
    const runtime = await privateDir();
    const daemon = await privateDir();
    const target = join(daemon, 'control-socket');
    await listen(target);
    const link = join(runtime, 'server.sock');
    await symlink(target, link);

    await expect(resolveAppServerSocketPath(link)).resolves.toBe(target);
  });

  it('rejects a symlink that points at a regular file', async () => {
    const runtime = await privateDir();
    const target = join(runtime, 'not-a-socket');
    await writeFile(target, 'plain file\n');
    const link = join(runtime, 'server.sock');
    await symlink(target, link);

    await expect(resolveAppServerSocketPath(link)).rejects.toThrow(/socket 不安全/u);
  });

  it('rejects a socket inside a group-writable directory', async () => {
    const loose = join(await mkdtemp(join(tmpdir(), 'socket-loose-')), 'shared');
    cleanups.push(() => rm(join(loose, '..'), { recursive: true, force: true }));
    await mkdir(loose, { recursive: true, mode: 0o777 });
    await chmod(loose, 0o777);
    const socket = join(loose, 'server.sock');
    await listen(socket);

    await expect(resolveAppServerSocketPath(socket)).rejects.toThrow(/socket 不安全/u);
  });

  it('rejects relative paths, empty paths, and missing sockets', async () => {
    await expect(resolveAppServerSocketPath('relative/server.sock')).rejects.toThrow(/不安全/u);
    await expect(resolveAppServerSocketPath('')).rejects.toThrow(/不安全/u);
    const directory = await privateDir();
    await expect(resolveAppServerSocketPath(join(directory, 'missing.sock'))).rejects.toThrow();
  });
});

async function privateDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'socket-path-'));
  await chmod(directory, 0o700);
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function listen(path: string): Promise<void> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => resolve());
  });
}
