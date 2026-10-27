import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  BrokerToolController,
} from '../../src/agent/subagents/broker-tools';
import { redactSecrets } from '../../src/agent/subagents/mcp-client';
import { resolveSubagents } from '../../src/agent/subagents/registry';
import { materializeCcSwitchBrokerRuntime } from '../../src/integrations/cc-switch-provider';
import {
  DEFAULT_SUBAGENT_CONFIG,
  type SubagentConfig,
} from '../../src/config/profile-schema';

const real = process.env.ARG_BRIDGE_REAL_CC_SWITCH_E2E === '1' ? it : it.skip;

real('uses the current cc-switch provider for a real three-round Broker worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arg-bridge-real-cc-switch-'));
  const cwd = process.cwd();
  const stateDir = join(root, 'structured');
  const codexHome = process.env.CODEX_HOME ?? join(process.env.HOME ?? root, '.codex');
  const env = { ...process.env };
  const config: SubagentConfig = {
    ...DEFAULT_SUBAGENT_CONFIG,
    mode: 'broker',
    routeMode: 'follow-cc-switch',
    ccSwitchProviderId: null,
    allowForkFallback: false,
    modelTools: true,
  };
  const signal = AbortSignal.timeout(600_000);
  const sideResolution = await resolveSubagents({
    subagents: config,
    env,
    cwd,
    stateDir,
    codexHome,
    ...(process.env.ARG_BRIDGE_CODEX_BIN?.trim()
      ? { codexBin: process.env.ARG_BRIDGE_CODEX_BIN.trim() }
      : {}),
    signal,
  });
  try {
    expect(sideResolution.kind, sideResolution.error).toBe('mixagents');
    expect(sideResolution.route).toMatchObject({
      source: 'cc-switch',
      provider: expect.any(String),
      model: expect.any(String),
    });
    expect(sideResolution.error).toBeUndefined();
  } finally {
    await sideResolution.backend?.closeBackend?.();
  }
  const controller = new BrokerToolController({
    threadId: 'real-cc-switch-thread',
    cwd,
    scope: 'real-cc-switch-e2e',
    stateFile: join(stateDir, 'broker-workers.json'),
    env,
    getConfig: async () => config,
    runtimeResolver: async () => {
      const generated = await materializeCcSwitchBrokerRuntime({
        env,
        cwd,
        codexHome,
        codexBin: process.env.ARG_BRIDGE_CODEX_BIN?.trim() || 'codex',
        stateDir,
      });
      return {
        brokerConfigPath: generated.brokerConfigPath,
        credentials: generated.credentials,
        fingerprint: generated.fingerprint,
        route: generated.route,
      };
    },
  });
  try {
    const spawned = await controller.call('spawn_agent', {
      name: 'orbit',
      task: '记住 ORBIT-731，只回复 ROUND=1 ACK=ORBIT-731',
    }, signal);
    expect(spawned.success, spawned.text).toBe(true);
    const round1 = await controller.call('wait_agent', {
      logical_names: ['orbit'],
      timeout_ms: 180_000,
    }, signal);
    expect(round1.success, round1.text).toBe(true);
    const round1Text = String(JSON.parse(round1.text).agents[0].text);
    expect(round1Text).toContain('ROUND=1 ACK=ORBIT-731');

    const followup = await controller.call('followup_task', {
      logical_name: 'orbit',
      task: '回忆第 1 轮标记，只回复 ROUND=2 RECALL=<标记>',
    }, signal);
    expect(followup.success, followup.text).toBe(true);
    expect(followup.text).toContain('ROUND=2 RECALL=ORBIT-731');

    const queued = await controller.call('send_message', {
      logical_name: 'orbit',
      message: '第 3 轮状态：ORBIT-731',
    }, signal);
    expect(queued.success, queued.text).toBe(true);
    const round3 = await controller.call('followup_task', {
      logical_name: 'orbit',
      task: '返回第 3 轮状态及历史标记，只回复 ROUND=3 RECALL=<标记>',
    }, signal);
    expect(round3.success, round3.text).toBe(true);
    expect(round3.text).toContain('ROUND=3 RECALL=ORBIT-731');
    expect(JSON.stringify(controller.projection())).not.toMatch(
      /(?:api[_-]?key|secret|bearer)\s*[:=]\s*[^\s",}]+/iu,
    );
    const route = controller.projection()[0]?.route;
    process.stdout.write(`${JSON.stringify({
      route,
      round1: redactSecrets(round1Text),
      round2: redactSecrets(String(JSON.parse(followup.text).mailbox)),
      round3: redactSecrets(String(JSON.parse(round3.text).mailbox)),
      expected: [
        'ROUND=1 ACK=ORBIT-731',
        'ROUND=2 RECALL=ORBIT-731',
        'ROUND=3 RECALL=ORBIT-731',
      ],
    }, null, 2)}\n`);
  } finally {
    await controller.close();
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}, 650_000);
