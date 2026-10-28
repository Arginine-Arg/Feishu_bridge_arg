import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { MixAgentsBrokerBackend } from '../../src/agent/subagents/mixagents';
import type { SubagentConfig } from '../../src/config/profile-schema';

const real = process.env.ARG_BRIDGE_REAL_MIXAGENTS_MCP === '1' ? it : it.skip;

real('creates and completes a real MixAgents App Server worker through the official MCP server', async () => {
  const server = process.env.ARG_BRIDGE_MIXAGENTS_SERVER;
  const fakeCodexSource = process.env.ARG_BRIDGE_FAKE_CODEX_FIXTURE;
  if (!fakeCodexSource) {
    throw new Error('ARG_BRIDGE_FAKE_CODEX_FIXTURE is required');
  }
  const root = await mkdtemp(join(tmpdir(), 'arg-bridge-real-mixagents-'));
  try {
    const workspace = join(root, 'workspace');
    const codexHome = join(root, 'codex-home');
    const dataDir = join(root, 'data');
    const brokerConfig = join(root, 'broker.json');
    const fakeCodex = join(root, 'fake-codex.mjs');
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(codexHome, { recursive: true }),
    ]);
    await writeFile(fakeCodex, [
      '#!/usr/bin/env node',
      `await import(${JSON.stringify(pathToFileURL(fakeCodexSource).href)});`,
      '',
    ].join('\n'), { mode: 0o700 });
    await chmod(fakeCodex, 0o700);
    await writeFile(brokerConfig, JSON.stringify({
      defaultRoute: 'fake-read',
      workspaceRoots: [workspace],
      codexBin: fakeCodex,
      dataDir,
      routes: {
        'fake-read': {
          description: 'Offline real MCP smoke route',
          provider: 'fake-provider',
          providerName: 'Fake Provider',
          model: 'fake-model',
          baseUrl: 'https://example.invalid/v1',
          envKey: 'FAKE_PROVIDER_KEY',
          tags: ['review'],
          maxAccess: 'read-only',
          reasoningEffort: 'low',
        },
      },
    }, null, 2), { mode: 0o600 });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CODEX_HOME: codexHome,
      MIXAGENTS_BROKER_CONFIG: brokerConfig,
      MIXAGENTS_BROKER_DATA_DIR: dataDir,
      MIXAGENTS_BROKER_CODEX_BIN: fakeCodex,
      MIXAGENTS_BROKER_CREDENTIALS_JSON: JSON.stringify({
        FAKE_PROVIDER_KEY: 'offline-smoke-only',
      }),
    };
    const config: SubagentConfig = {
      enabled: true,
      mode: 'broker',
      routeMode: 'manual',
      readRoute: 'fake-read',
      writeRoute: null,
      modelTools: true,
      nativeToolPolicy: 'shadow',
      toolNamespace: 'arg_bridge',
      maxConcurrentWorkers: 4,
      workerTimeoutMs: 15 * 60_000,
      sideTimeoutMs: 90_000,
      sideReasoningEffort: 'low',
      webSearch: 'auto',
      allowWriteWorkers: false,
      includeProgressSnapshot: false,
      reuse: 'scope-cwd',
      allowForkFallback: false,
      mixagents: {
        ...(server
          ? {
              mcpCommand: process.execPath,
              mcpArgs: [server],
            }
          : {}),
        credentialEnvKeys: ['MIXAGENTS_BROKER_CREDENTIALS_JSON'],
      },
    };
    const backend = new MixAgentsBrokerBackend(config, env);
    const signal = AbortSignal.timeout(90_000);
    try {
      const routes = await backend.listRoutes(signal);
      const route = routes.find(item => item.id === 'fake-read');
      expect(route).toMatchObject({
        id: 'fake-read',
        provider: 'fake-provider',
        model: 'fake-model',
        available: true,
        maxAccess: 'read-only',
      });
      const agent = await backend.createOrReuse({
        route: route!,
        task: 'report cwd',
        cwd: workspace,
        scope: 'real-mcp-smoke',
        access: 'read-only',
        signal,
      });
      expect(agent).toMatchObject({
        route: 'fake-read',
        provider: 'fake-provider',
        model: 'fake-model',
        access: 'read-only',
      });
      await expect(backend.wait(agent, signal)).resolves.toMatchObject({
        status: 'completed',
        text: `cwd:${workspace}`,
      });
      await backend.close(agent, signal);
    } finally {
      await backend.closeBackend();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
