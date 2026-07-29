import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureBundledCodexSkill } from '../../../src/agent/bundled-skill.js';

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('bundled Codex skills', () => {
  it('installs the bridge-owned artifact delivery skill into the active Codex home', async () => {
    const home = await mkdtemp(join(tmpdir(), 'arg-bridge-codex-home-'));
    cleanups.push(home);

    await ensureBundledCodexSkill(home);

    const installed = await readFile(join(home, 'skills', 'arg-bridge-sendfile', 'SKILL.md'), 'utf8');
    expect(installed).toContain('arg-bridge sendfile');
    expect(installed).toContain('relative to the agent\'s current working directory');
  });
});
