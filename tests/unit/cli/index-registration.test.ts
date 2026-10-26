import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('CLI command registration', () => {
  it('registers the documented migrate command', async () => {
    const source = await readFile(join(process.cwd(), 'src', 'cli', 'index.ts'), 'utf8');

    expect(source).toMatch(/\.command\(['"]migrate['"]\)/);
    expect(source).toContain('runMigrate');
  });

  it('registers settings, doctor, codex alias and local PoC migration entry points', async () => {
    const source = await readFile(join(process.cwd(), 'src', 'cli', 'index.ts'), 'utf8');
    expect(source).toMatch(/\.command\(['"]settings['"]\)/);
    expect(source).toMatch(/\.command\(['"]doctor['"]\)/);
    expect(source).toMatch(/\.command\(['"]codex \[thread\]['"]\)/);
    expect(source).toMatch(/\.command\(['"]migrate-local-poc['"]\)/);
    expect(source).toContain('--probe-route <id>');
  });

  it('registers app-secret options for non-interactive app bootstrap commands', async () => {
    const source = await readFile(join(process.cwd(), 'src', 'cli', 'index.ts'), 'utf8');

    const appSecretOptions = source.match(/--app-secret <secret>/g) ?? [];
    expect(appSecretOptions.length).toBeGreaterThanOrEqual(3);
  });

  it('registers Bridge-managed native and adoption options on both terminal aliases', async () => {
    const source = await readFile(join(process.cwd(), 'src', 'cli', 'index.ts'), 'utf8');
    const bridgeOptions = source.match(/--bridge/g) ?? [];
    const adoptOptions = source.match(/--adopt <thread-id>/g) ?? [];
    const yoloOptions = source.match(/\.option\('--yolo'/g) ?? [];
    const bypassOptions = source.match(/--dangerously-bypass-approvals-and-sandbox/g) ?? [];
    const sandboxOptions = source.match(/--sandbox <mode>/g) ?? [];
    const approvalOptions = source.match(/--ask-for-approval <policy>/g) ?? [];
    expect(bridgeOptions.length).toBeGreaterThanOrEqual(2);
    expect(adoptOptions.length).toBeGreaterThanOrEqual(2);
    expect(yoloOptions.length).toBeGreaterThanOrEqual(2);
    expect(bypassOptions.length).toBeGreaterThanOrEqual(4);
    expect(sandboxOptions.length).toBeGreaterThanOrEqual(2);
    expect(approvalOptions.length).toBeGreaterThanOrEqual(2);
  });
});
