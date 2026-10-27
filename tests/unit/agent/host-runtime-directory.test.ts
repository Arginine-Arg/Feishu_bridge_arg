import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexHostRuntimeDirectory } from '../../../src/agent/structured/host-registry';

const unixIt = process.platform === 'win32' ? it.skip : it;

describe('Codex App Server runtime directory', () => {
  unixIt('uses the stable XDG runtime root instead of a disposable TMPDIR', () => {
    const directory = codexHostRuntimeDirectory(
      '/home/test/.lark-channel/profiles/codex',
      'native-bridge:codex:/workspace',
      '/workspace',
      {
        uid: 2106,
        env: {
          TMPDIR: '/run/user/2106/mihomo-tmp',
          XDG_RUNTIME_DIR: '/run/user/2106',
        },
      },
    );

    expect(directory).toMatch(/^\/run\/user\/2106\/ab-2106-[a-f0-9]{20}$/u);
    expect(directory).not.toContain('mihomo-tmp');
  });

  unixIt('falls back to XDG state and finally the user state directory', () => {
    const state = codexHostRuntimeDirectory('/profile', 'scope', '/workspace', {
      uid: 7,
      env: { XDG_STATE_HOME: '/state' },
    });
    expect(state).toMatch(/^\/state\/ab-7-[a-f0-9]{20}$/u);

    const fallback = codexHostRuntimeDirectory('/profile', 'scope', '/workspace', {
      uid: 7,
      env: { TMPDIR: '/disposable' },
    });
    expect(fallback).toMatch(
      new RegExp(`^${escapeRegex(join(homedir(), '.local', 'state'))}/ab-7-[a-f0-9]{20}$`, 'u'),
    );
    expect(fallback).not.toContain('/disposable');
  });

  unixIt('keeps the Unix socket path below the platform limit', () => {
    const directory = codexHostRuntimeDirectory(
      '/profile',
      'scope',
      '/workspace',
      {
        uid: 7,
        env: { XDG_RUNTIME_DIR: `/${'very-long-runtime-segment/'.repeat(8)}` },
      },
    );
    expect(directory).toMatch(/^\/tmp\/ab-7-[a-f0-9]{20}$/u);
    expect(Buffer.byteLength(join(directory, 'server.sock'))).toBeLessThanOrEqual(100);
  });
});

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
