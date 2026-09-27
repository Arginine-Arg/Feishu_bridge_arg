import { spawn } from 'node:child_process';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as connectSocket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fingerprintCredentialEnv,
  hostHasActiveClients,
  processAlive,
  recordHost,
  terminateProfileHosts,
} from '../../../src/agent/structured/host-registry.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('App Server reclaim safety', () => {
  it('keeps a server that still has a connected client and reclaims it once idle', async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'host-in-use-profile-'));
    const runtimeDir = await mkdtemp(join(tmpdir(), 'host-in-use-runtime-'));
    cleanups.push(async () => {
      await rm(profileDir, { recursive: true, force: true });
      await rm(runtimeDir, { recursive: true, force: true });
    });
    const socketPath = join(runtimeDir, 'server.sock');
    // Stand-in for the App Server: a detached process owning the socket so the
    // process-group signal can be verified too.
    const child = spawn(
      process.execPath,
      ['-e', `require('node:net').createServer().listen(${JSON.stringify(socketPath)}); setInterval(() => {}, 1000);`],
      { detached: true, stdio: 'ignore' },
    );
    cleanups.push(async () => {
      try { process.kill(-(child.pid!), 'SIGKILL'); } catch { /* already gone */ }
    });
    await waitForFile(socketPath, 5_000);

    const client = connectSocket(socketPath);
    await new Promise<void>((resolve, reject) => {
      client.once('connect', () => resolve());
      client.once('error', reject);
    });

    await recordHost(profileDir, {
      directory: runtimeDir,
      pid: child.pid!,
      startedAt: Date.now(),
      binary: 'codex',
      fingerprint: {
        credentials: fingerprintCredentialEnv({ OPENAI_API_KEY: 'sk-x' }),
        networkMode: 'inherit',
      },
    });

    // A native TUI (`--remote`) holds exactly such a connection.
    expect(hostHasActiveClients(runtimeDir)).toBe(true);
    const firstPass = await terminateProfileHosts(profileDir);
    expect(firstPass).toEqual({ terminated: 0, inUse: 1 });
    expect(processAlive(child.pid!)).toBe(true);

    client.destroy();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const secondPass = await terminateProfileHosts(profileDir);
    expect(secondPass.terminated).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(processAlive(child.pid!)).toBe(false);
  }, 30_000);
});

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await lstat(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`socket did not appear: ${path}`);
}
