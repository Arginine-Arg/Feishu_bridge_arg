import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { resolveSubagents } from '../../src/agent/subagents/registry';
import { DEFAULT_SUBAGENT_CONFIG } from '../../src/config/profile-schema';
import { parseCodexConfigSummary } from '../../src/agent/codex/credentials';

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
