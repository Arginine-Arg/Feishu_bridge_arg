import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveCodexResumeDefaults } from '../../../src/agent/codex/provider';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('Codex resume defaults', () => {
  it('reads the active provider and model from the App Server home', async () => {
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

  it('honors the selected profile over top-level values', async () => {
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

  it('uses the built-in provider only for a readable config without model_provider', async () => {
    const home = await writeHome('model = "gpt-main"\n');

    expect(resolveCodexResumeDefaults(home)).toEqual({
      modelProvider: 'openai',
      model: 'gpt-main',
    });
  });

  it('does not guess the bridge home when the App Server home is unknown', async () => {
    // The process may have its own $CODEX_HOME; an external App Server can use
    // a different one, so undefined must mean "do not rebind".
    expect(resolveCodexResumeDefaults(undefined)).toBeUndefined();
  });

  it('does not guess openai when the config is absent or unreadable', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'codex-provider-empty-'));
    cleanups.push(() => rm(empty, { recursive: true, force: true }));
    expect(resolveCodexResumeDefaults(empty)).toBeUndefined();

    const unreadable = await writeHome('model = "m"\nmodel_provider = "custom"\n');
    await rm(join(unreadable, 'config.toml'));
    await mkdir(join(unreadable, 'config.toml'));
    expect(resolveCodexResumeDefaults(unreadable)).toBeUndefined();
  });
});

async function writeHome(config: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'codex-provider-'));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'config.toml'), config.trimStart(), 'utf8');
  return home;
}
