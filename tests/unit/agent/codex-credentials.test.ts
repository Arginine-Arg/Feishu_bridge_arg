import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyCodexCredentialEnv,
  codexCredentialCommandPrefix,
  codexCredentialEnvironmentArgs,
  defaultCodexHome,
  isOfficialBaseUrl,
  isThirdPartyProvider,
  parseCodexConfigSummary,
  resolveCodexCredentialEnv,
} from '../../../src/agent/codex/credentials.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const thirdPartyConfig = `
model_provider = "deepseek"
preferred_auth_method = "apikey"

[model_providers.deepseek]
name = "deepseek"
base_url = "https://api.xinlab-ioz.cn/v1"
wire_api = "responses"
requires_openai_auth = false
experimental_bearer_token = "sk-config-token"
env_key = "OPENAI_API_KEY"
`;

describe('codex config summary parsing', () => {
  it('reads the active provider, base url, env key, and bearer token', () => {
    const summary = parseCodexConfigSummary(thirdPartyConfig);

    expect(summary.modelProvider).toBe('deepseek');
    expect(summary.preferredAuthMethod).toBe('apikey');
    expect(summary.providers.get('deepseek')).toEqual({
      baseUrl: 'https://api.xinlab-ioz.cn/v1',
      envKey: 'OPENAI_API_KEY',
      bearerToken: 'sk-config-token',
    });
  });

  it('ignores comments and honors the selected profile override', () => {
    const summary = parseCodexConfigSummary(`
model_provider = "openai" # default stays official
profile = "work"

[profiles.work]
model_provider = "deepseek"

[model_providers.deepseek]
base_url = "https://third-party.example.com/v1" # inline comment
`);

    expect(summary.modelProvider).toBe('deepseek');
    expect(summary.providers.get('deepseek')?.baseUrl).toBe('https://third-party.example.com/v1');
  });

  it('accepts quoted provider headers', () => {
    const summary = parseCodexConfigSummary(`
model_provider = "my-vendor"
[model_providers."my-vendor"]
base_url = "https://vendor.example.com/v1"
env_key = "MY_VENDOR_KEY"
`);

    expect(summary.providers.get('my-vendor')).toMatchObject({
      baseUrl: 'https://vendor.example.com/v1',
      envKey: 'MY_VENDOR_KEY',
    });
  });
});

describe('codex provider classification', () => {
  it('keeps official endpoints official even when the provider id is custom', () => {
    expect(isOfficialBaseUrl('https://api.openai.com/v1')).toBe(true);
    expect(isOfficialBaseUrl('https://chatgpt.com/backend-api/codex')).toBe(true);
    expect(isOfficialBaseUrl('https://api.xinlab-ioz.cn/v1')).toBe(false);
    expect(isOfficialBaseUrl('http://127.0.0.1:8080/v1')).toBe(false);
  });

  it('treats openai ids as official and custom ids as third-party', () => {
    expect(isThirdPartyProvider('openai', { baseUrl: 'https://api.openai.com/v1' })).toBe(false);
    expect(isThirdPartyProvider('openai', { baseUrl: 'https://proxy.example.com/v1' })).toBe(true);
    expect(isThirdPartyProvider('deepseek', { baseUrl: 'https://api.xinlab-ioz.cn/v1' })).toBe(true);
    expect(isThirdPartyProvider('deepseek', undefined)).toBe(true);
    expect(isThirdPartyProvider(undefined, undefined)).toBe(false);
  });
});

describe('codex credential resolution', () => {
  it('injects the configured token when the inherited env_key is empty', async () => {
    const home = await writeHome({ config: thirdPartyConfig });

    const resolution = await resolveCodexCredentialEnv(home, {
      baseEnv: { OPENAI_API_KEY: '' },
    });

    expect(resolution).toMatchObject({
      provider: 'deepseek',
      envKey: 'OPENAI_API_KEY',
      source: 'config',
      injected: true,
      missingToken: false,
    });
    expect(resolution.env.OPENAI_API_KEY).toBe('sk-config-token');
  });

  it('falls back to auth.json when the config has no bearer token', async () => {
    const home = await writeHome({
      config: `
model_provider = "deepseek"

[model_providers.deepseek]
base_url = "https://api.xinlab-ioz.cn/v1"
env_key = "OPENAI_API_KEY"
`,
      auth: { OPENAI_API_KEY: 'sk-auth-token' },
    });

    const resolution = await resolveCodexCredentialEnv(home, { baseEnv: {} });

    expect(resolution).toMatchObject({ source: 'auth', injected: true });
    expect(resolution.env.OPENAI_API_KEY).toBe('sk-auth-token');
  });

  it('restores a custom env_key declared by the provider', async () => {
    const home = await writeHome({
      config: `
model_provider = "vendor"

[model_providers.vendor]
base_url = "https://vendor.example.com/v1"
env_key = "VENDOR_API_KEY"
experimental_bearer_token = "vendor-token"
`,
    });

    const resolution = await resolveCodexCredentialEnv(home, { baseEnv: {} });

    expect(resolution.env).toEqual({ VENDOR_API_KEY: 'vendor-token' });
    expect(resolution.envKey).toBe('VENDOR_API_KEY');
  });

  it('keeps a non-empty inherited provider key', async () => {
    const home = await writeHome({ config: thirdPartyConfig });

    const resolution = await resolveCodexCredentialEnv(home, {
      baseEnv: { OPENAI_API_KEY: 'sk-inherited' },
    });

    expect(resolution).toMatchObject({ source: 'process-env', injected: false });
    expect(resolution.env.OPENAI_API_KEY).toBe('sk-inherited');
  });

  it('never touches official OpenAI providers or ChatGPT OAuth logins', async () => {
    const official = await writeHome({
      config: `
model_provider = "openai"

[model_providers.openai]
base_url = "https://api.openai.com/v1"
env_key = "OPENAI_API_KEY"
`,
      auth: { OPENAI_API_KEY: 'sk-official' },
    });
    const oauth = await writeHome({
      config: `
model_provider = "deepseek"
preferred_auth_method = "chatgpt"

[model_providers.deepseek]
base_url = "https://api.xinlab-ioz.cn/v1"
experimental_bearer_token = "sk-should-not-be-used"
`,
    });

    await expect(resolveCodexCredentialEnv(official, { baseEnv: {} })).resolves.toMatchObject({
      env: {},
      injected: false,
    });
    await expect(resolveCodexCredentialEnv(oauth, { baseEnv: {} })).resolves.toMatchObject({
      env: {},
      injected: false,
    });
  });

  it('reports a missing third-party token without failing the run', async () => {
    const home = await writeHome({
      config: `
model_provider = "deepseek"

[model_providers.deepseek]
base_url = "https://api.xinlab-ioz.cn/v1"
env_key = "OPENAI_API_KEY"
`,
    });

    const resolution = await resolveCodexCredentialEnv(home, { baseEnv: {} });

    expect(resolution).toMatchObject({ injected: false, missingToken: true });
    expect(resolution.env).toEqual({});
  });

  it('returns an empty resolution when no config exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-credentials-missing-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));

    await expect(resolveCodexCredentialEnv(dir, { baseEnv: {} })).resolves.toMatchObject({
      env: {},
      injected: false,
      missingToken: false,
    });
  });
});

describe('codex credential env helpers', () => {
  it('overrides case-insensitively when merging into a child env', () => {
    const env = applyCodexCredentialEnv(
      { env: { OPENAI_API_KEY: 'sk-new' }, injected: true, missingToken: false },
      { openai_api_key: 'sk-old', PATH: '/bin' },
    );

    expect(Object.keys(env).filter((key) => key.toLowerCase() === 'openai_api_key')).toEqual([
      'OPENAI_API_KEY',
    ]);
    expect(env.OPENAI_API_KEY).toBe('sk-new');
    expect(env.PATH).toBe('/bin');
  });

  it('renders tmux -e flags and shell-quoted command prefixes', () => {
    expect(codexCredentialEnvironmentArgs({ OPENAI_API_KEY: 'sk-123' }))
      .toEqual(['-e', 'OPENAI_API_KEY=sk-123']);
    expect(codexCredentialCommandPrefix({ OPENAI_API_KEY: "sk-a'b" }))
      .toBe("OPENAI_API_KEY='sk-a'\\''b'");
    expect(codexCredentialCommandPrefix({})).toBe('');
  });

  it('resolves CODEX_HOME relative paths against the home directory', () => {
    expect(defaultCodexHome({}, '/home/user')).toBe('/home/user/.codex');
    expect(defaultCodexHome({ CODEX_HOME: '/custom/codex' }, '/home/user')).toBe('/custom/codex');
    expect(defaultCodexHome({ CODEX_HOME: 'relative-codex' }, '/home/user'))
      .toBe('/home/user/relative-codex');
    expect(defaultCodexHome({ CODEX_HOME: '   ' }, '/home/user')).toBe('/home/user/.codex');
  });
});

async function writeHome(options: { config: string; auth?: unknown }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-credentials-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'config.toml'), options.config.trimStart(), 'utf8');
  if (options.auth !== undefined) {
    await writeFile(join(dir, 'auth.json'), `${JSON.stringify(options.auth, null, 2)}\n`, 'utf8');
  }
  return dir;
}
