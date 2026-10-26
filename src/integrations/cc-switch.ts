import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnProcess } from '../platform/spawn';

export interface CcSwitchProvider {
  id: string;
  name: string;
  current: boolean;
}

export interface CcSwitchState {
  currentProviderCodex?: string;
  providers: CcSwitchProvider[];
  settingsPath: string;
  error?: string;
}

/**
 * Read only non-secret cc-switch metadata.
 *
 * `provider current` is deliberately never invoked: the upstream CLI prints
 * the API key in cleartext. The provider *list* is safe (id/name only) and is
 * used solely for display names.
 */
export async function readCcSwitchState(
  env: NodeJS.ProcessEnv = process.env,
  options: { timeoutMs?: number } = {},
): Promise<CcSwitchState> {
  const settingsPath = join(
    env.CC_SWITCH_HOME?.trim() || join(homedir(), '.cc-switch'),
    'settings.json',
  );
  let currentProviderCodex: string | undefined;
  let error: string | undefined;
  try {
    const parsed: unknown = JSON.parse(await readFile(settingsPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const value = (parsed as Record<string, unknown>).currentProviderCodex;
      if (typeof value === 'string' && value.trim()) currentProviderCodex = value.trim();
    }
  } catch (readError) {
    error = `无法读取 ${settingsPath}: ${errorMessage(readError)}`;
  }

  const providers = await listProviders(env, options.timeoutMs ?? 5_000)
    .catch(() => []);
  return {
    ...(currentProviderCodex ? { currentProviderCodex } : {}),
    providers: providers.map(provider => ({
      ...provider,
      current: provider.id === currentProviderCodex || provider.current,
    })),
    settingsPath,
    ...(error ? { error } : {}),
  };
}

export async function readCcSwitchCurrentProvider(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ providerId: string | null; settingsPath: string; error?: string }> {
  const settingsPath = join(
    env.CC_SWITCH_HOME?.trim() || join(homedir(), '.cc-switch'),
    'settings.json',
  );
  try {
    const parsed: unknown = JSON.parse(await readFile(settingsPath, 'utf8'));
    const value = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).currentProviderCodex
      : undefined;
    return {
      providerId: typeof value === 'string' && value.trim() ? value.trim() : null,
      settingsPath,
    };
  } catch (error) {
    return {
      providerId: null,
      settingsPath,
      error: `无法读取 ${settingsPath}: ${errorMessage(error)}`,
    };
  }
}

async function listProviders(
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<CcSwitchProvider[]> {
  const child = spawnProcess('cc-switch', ['-a', 'codex', 'provider', 'list'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on('data', chunk => stdout.push(Buffer.from(chunk)));
  child.stderr?.on('data', chunk => stderr.push(Buffer.from(chunk)));
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve(null);
    }, timeoutMs);
    timer.unref?.();
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', exitCode => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  if (code !== 0) {
    throw new Error(errorMessage(Buffer.concat(stderr).toString('utf8') || 'cc-switch provider list failed'));
  }
  return parseProviderTable(Buffer.concat(stdout).toString('utf8'));
}

/** Parse cc-switch's table without ever reading a secret column. */
export function parseProviderTable(output: string): CcSwitchProvider[] {
  const providers: CcSwitchProvider[] = [];
  for (const line of output.split('\n')) {
    if (!/[│┆]/u.test(line)) continue;
    const cells = line.split(/[│┆]/u).map(cell => cell.trim());
    if (cells.length < 4) continue;
    const marker = cells[1] ?? '';
    const id = cells[2] ?? '';
    const name = cells[3] ?? '';
    if (!id || !name) continue;
    if (/^id$/iu.test(id) || /^name$/iu.test(name) || /^[-─]+$/u.test(id)) continue;
    providers.push({ id, name, current: marker.includes('✓') });
  }
  return providers;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
