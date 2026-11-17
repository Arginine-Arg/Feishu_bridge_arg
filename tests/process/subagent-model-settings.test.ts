import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { resolveSubagents } from '../../src/agent/subagents/registry';
import { DEFAULT_SUBAGENT_CONFIG } from '../../src/config/profile-schema';
import { parseCodexConfigSummary } from '../../src/agent/codex/credentials';
import { createServer } from 'node:http';
import { collectSubagentDiagnostics } from '../../src/agent/subagents/diagnostics';

it('passes provider model/effort settings through the real bundled Broker to its Codex child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arg-bridge-model-settings-'));
  try {
    const workspace = join(root, 'workspace');
    const ccHome = join(root, 'cc-switch');
    await Promise.all([mkdir(workspace), mkdir(ccHome)]);
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
    await writeFile(join(ccHome, 'settings.json'), JSON.stringify({
      currentProviderCodex: 'local',
      providers: { codex: [{
        id: 'local', name: 'Local fixture',
        settings_config: {
          auth: { OPENAI_API_KEY: 'offline-only' },
          config: 'model = "default-v1"\nmodel_provider = "test"\nmodel_reasoning_effort = "high"\n[model_providers.test]\nbase_url = "https://example.invalid/v1"\n',
        },
      }] },
    }));
    const env = { ...process.env, CC_SWITCH_HOME: ccHome };
    let previousFingerprint: string | undefined;
    for (const [model, effort] of [['selected-v2', 'medium'], ['selected-v3', 'xhigh']] as const) {
      const runtime = await resolveSubagents({
        subagents: {
          ...DEFAULT_SUBAGENT_CONFIG,
          mode: 'broker',
          allowForkFallback: false,
          providerOverrides: { local: { model, reasoningEffort: effort } },
        },
        env, cwd: workspace, stateDir: join(root, 'state'), codexBin: binary,
        signal: AbortSignal.timeout(30_000),
      });
      try {
        expect(runtime.kind).toBe('mixagents');
        expect(runtime.route?.model).toBe(model);
        expect(runtime.route?.targetFingerprint).not.toBe(previousFingerprint);
        previousFingerprint = runtime.route?.targetFingerprint;
        const signal = AbortSignal.timeout(30_000);
        const agent = await runtime.backend!.createOrReuse({
          route: runtime.route!, task: 'model selection smoke', cwd: workspace,
          scope: 'model-settings', access: 'read-only', signal,
        });
        expect(agent.model).toBe(model);
        expect((await runtime.backend!.wait(agent, signal)).status).toBe('completed');
        const received = JSON.parse(await readFile(audit, 'utf8'));
        expect(parseCodexConfigSummary(received.config)).toMatchObject({ model, modelReasoningEffort: effort });
        expect(received.args).toContain(`model_reasoning_effort="${effort}"`);
        await runtime.backend!.close(agent, signal);
      } finally {
        await runtime.backend?.closeBackend?.();
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);

it('uses the same backup provider and model for side, writable worker and reviewer dispatches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arg-bridge-unified-models-'));
  const server = createServer((req, res) => {
    if (req.url === '/primary/models') { res.writeHead(503); res.end(); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'selected-v2' }, { id: 'default-v1' }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const workspace = join(root, 'workspace');
    const ccHome = join(root, 'cc-switch');
    await Promise.all([mkdir(workspace), mkdir(ccHome)]);
    const audit = join(root, 'child-config.json');
    const fixture = fileURLToPath(new URL('../../vendor/mixagents-broker/test/fixtures/fake-codex.mjs', import.meta.url));
    const launcher = join(root, 'codex.mjs');
    await writeFile(launcher, [
      '#!/usr/bin/env node',
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      `writeFileSync(${JSON.stringify(audit)}, readFileSync(join(process.env.CODEX_HOME, 'config.toml'), 'utf8'));`,
      `await import(${JSON.stringify(pathToFileURL(fixture).href)});`,
    ].join('\n'), { mode: 0o700 });
    let binary = launcher;
    if (process.platform === 'win32') {
      binary = join(root, 'codex.cmd');
      await writeFile(binary, `@echo off\r\n"${process.execPath}" "${launcher}" %*\r\n`);
    }
    const settings = JSON.stringify({ currentProviderCodex: 'primary', providers: { codex:
      ['primary', 'backup'].map(id => ({ id, name: id, settings_config: {
        auth: { OPENAI_API_KEY: 'offline-only' },
        config: `model="default-v1"\nmodel_provider="test"\nmodel_reasoning_effort="high"\n[model_providers.test]\nbase_url="http://127.0.0.1:${port}/${id}"\n`,
      } })),
    } });
    await writeFile(join(ccHome, 'settings.json'), settings);
    const config = {
      ...DEFAULT_SUBAGENT_CONFIG, mode: 'broker' as const, allowForkFallback: false,
      ccSwitchProviderId: 'primary', writeRoute: 'stale-write-route',
      providerPriority: [
        { providerId: 'primary', models: ['default-v1'] },
        { providerId: 'backup', models: ['selected-v2', 'default-v1'] },
      ],
      providerOverrides: { backup: { model: 'stale-model', reasoningEffort: 'medium' as const } },
    };
    const options = { env: { ...process.env, CC_SWITCH_HOME: ccHome }, cwd: workspace,
      stateDir: join(root, 'state'), codexBin: binary };
    for (const [role, access] of [
      ['side', 'read-only'], ['worker', 'workspace-write'], ['reviewer', 'read-only'],
    ] as const) {
      const signal = AbortSignal.timeout(30_000);
      const runtime = await resolveSubagents({ ...options, subagents: config, runtimeRole: role, access, signal });
      try {
        expect(runtime.kind).toBe('mixagents');
        expect(runtime.route).toMatchObject({ ccSwitchProviderId: 'backup', model: 'selected-v2' });
        const input = { route: runtime.route!, task: 'unified models', cwd: workspace, scope: role, access, signal };
        if (access === 'workspace-write') {
          await expect(runtime.backend!.createOrReuse(input)).rejects.toMatchObject({ code: 'write-not-authorized' });
        }
        const agent = await runtime.backend!.createOrReuse({ ...input,
          ...(access === 'workspace-write' ? { writeAuthorization: { workspace, task: input.task } } : {}),
        });
        expect((await runtime.backend!.wait(agent, signal)).status).toBe('completed');
        expect(parseCodexConfigSummary(await readFile(audit, 'utf8')))
          .toMatchObject({ model: 'selected-v2', modelReasoningEffort: 'medium' });
        await runtime.backend!.close(agent, signal);
      } finally { await runtime.backend?.closeBackend?.(); }
    }
    const diagnostics = await collectSubagentDiagnostics({ ...options, config });
    expect(diagnostics.readRoutes.find(route => route.id === diagnostics.selectedRoute.id))
      .toMatchObject({ model: 'selected-v2', available: true });
    expect(diagnostics.selectedWriteRoute.id).toBe(diagnostics.selectedRoute.id);
    expect(await readFile(join(ccHome, 'settings.json'), 'utf8')).toBe(settings);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
