import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveCodexResumeDefaults } from '../../../src/agent/codex/provider';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('Codex resume defaults', () => {
  it('uses the current provider and model regardless of a thread historical provider', async () => {
    const home = await writeHome(`
model = "gpt-current"
model_provider = "custom"

[model_providers.custom]
base_url = "https://vendor.example.com/v1"
`);

    expect(resolveCodexResumeDefaults(home)).toEqual({
      modelProvider: 'custom',
      model: 'gpt-current',
    });
  });

  it('falls back to the built-in provider when config is absent or incomplete', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codex-provider-missing-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));

    expect(resolveCodexResumeDefaults(home)).toEqual({ modelProvider: 'openai' });
  });

  it('honors the selected profile model and provider', async () => {
    const home = await writeHome(`
model = "gpt-default"
model_provider = "openai"
profile = "work"

[profiles.work]
model = "vendor-main"
model_provider = "custom"
`);

    expect(resolveCodexResumeDefaults(home)).toEqual({
      modelProvider: 'custom',
      model: 'vendor-main',
    });
  });
});

async function writeHome(config: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'codex-provider-'));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, 'config.toml'), config.trimStart(), 'utf8');
  return home;
}
