import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { buildModelCatalog } from '../../src/agent/model-catalog';
import { resolveSubagents } from '../../src/agent/subagents/registry';
import { DEFAULT_SUBAGENT_CONFIG } from '../../src/config/profile-schema';
import { readMagpieGateway } from '../../src/integrations/magpie-provider';

const gateway = await readMagpieGateway().catch(() => undefined);

it.skipIf(!gateway)('uses a real Magpie routing group for a Broker worker', async () => {
  const catalog = await buildModelCatalog('codex');
  const router = catalog.options.find(option => option.source === 'magpie-router');
  expect(router, 'Magpie has no routing group configured').toBeDefined();

  const root = await mkdtemp(join(tmpdir(), 'arg-bridge-magpie-real-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const audit = join(root, 'child-config.json');
    const fixture = fileURLToPath(new URL('../../vendor/mixagents-broker/test/fixtures/fake-codex.mjs', import.meta.url));
    const launcher = join(root, 'codex.mjs');
    await writeFile(launcher, [
      '#!/usr/bin/env node',
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      `writeFileSync(${JSON.stringify(audit)}, JSON.stringify({ config: readFileSync(join(process.env.CODEX_HOME, 'config.toml'), 'utf8'), args: process.argv.slice(2) }));`,
      `await import(${JSON.stringify(pathToFileURL(fixture).href)});`,
    ].join('\n'), { mode: 0o700 });
    let binary = launcher;
    if (process.platform === 'win32') {
      binary = join(root, 'codex.cmd');
      await writeFile(binary, `@echo off\r\n"${process.execPath}" "${launcher}" %*\r\n`);
    }
    const runtime = await resolveSubagents({
      subagents: {
        ...DEFAULT_SUBAGENT_CONFIG,
        mode: 'broker',
        routeMode: 'follow-magpie',
        allowForkFallback: false,
        providerPriority: [{ providerId: 'group', models: [router!.value] }],
      },
      env: process.env,
      cwd: workspace,
      stateDir: join(root, 'state'),
      codexBin: binary,
      signal: AbortSignal.timeout(30_000),
    });
    try {
      expect(runtime.kind).toBe('mixagents');
      expect(runtime.route).toMatchObject({
        source: 'magpie',
        provider: 'magpie',
        model: router!.value,
      });
      const signal = AbortSignal.timeout(30_000);
      const agent = await runtime.backend!.createOrReuse({
        route: runtime.route!,
        task: 'magpie router smoke',
        cwd: workspace,
        scope: 'magpie-router',
        access: 'read-only',
        signal,
      });
      expect((await runtime.backend!.wait(agent, signal)).status).toBe('completed');
      const received = JSON.parse(await readFile(audit, 'utf8'));
      expect(received.config).toContain(`model = "${router!.value}"`);
      expect(received.config).toContain(gateway!.baseUrl);
      expect(received.config).toContain('env_key = "MAGPIE_API_KEY"');
      await runtime.backend!.close(agent, signal);
    } finally {
      await runtime.backend?.closeBackend?.();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
