import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { StructuredAdapter } from '../../src/agent/structured/adapter';
import { CodexStructuredSession } from '../../src/agent/structured/codex';
import type { RpcClient } from '../../src/agent/structured/rpc';
import { StructuredView } from '../../src/agent/structured/view';
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
import type { AgentEvent, AgentRun } from '../../src/agent/types';

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
    ccSwitchProviderId: process.env.ARG_BRIDGE_REAL_CC_SWITCH_PROVIDER_ID?.trim() || null,
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
        ...(config.ccSwitchProviderId
          ? { providerId: config.ccSwitchProviderId }
          : {}),
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

real('routes consecutive /btw turns through the selected real cc-switch provider', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arg-bridge-real-cc-switch-btw-'));
  const cwd = process.cwd();
  const profileDir = join(root, 'profile');
  const stateDir = join(profileDir, 'structured');
  const codexHome = process.env.CODEX_HOME ?? join(process.env.HOME ?? root, '.codex');
  const env = { ...process.env };
  const providerId = process.env.ARG_BRIDGE_REAL_CC_SWITCH_PROVIDER_ID?.trim() || null;
  const config: SubagentConfig = {
    ...DEFAULT_SUBAGENT_CONFIG,
    mode: 'broker',
    routeMode: 'follow-cc-switch',
    ccSwitchProviderId: providerId,
    allowForkFallback: false,
    modelTools: true,
  };
  const adapter = new StructuredAdapter({
    kind: 'codex',
    binary: process.env.ARG_BRIDGE_CODEX_BIN?.trim() || 'codex',
    profileDir,
    codexHome,
    env,
    subagents: config,
  });
  const rpc = new EventEmitter() as EventEmitter & {
    request: () => Promise<Record<string, never>>;
    close: () => void;
  };
  rpc.request = async () => ({});
  rpc.close = () => {};
  const main = new CodexStructuredSession('real-btw-main', '', rpc as unknown as RpcClient);
  Reflect.get(adapter, 'sessions').set('real-btw-scope', {
    main,
    cwd,
    view: new StructuredView(profileDir, 'real-btw-main'),
  });
  try {
    const first = await drainSide(adapter.runSide({
      runId: 'real-btw-1',
      scopeId: 'real-btw-scope',
      cwd,
      prompt: '/btw 记住 ORBIT-731，只回复 ROUND=1 ACK=ORBIT-731',
      liveInputMode: 'side',
    }));
    expect(first.filter(event => event.type === 'error')).toEqual([]);
    const firstText = textOf(first);
    expect(firstText).toContain('ROUND=1 ACK=ORBIT-731');

    const second = await drainSide(adapter.runSide({
      runId: 'real-btw-2',
      scopeId: 'real-btw-scope',
      cwd,
      prompt: '/btw 回忆第 1 轮标记，只回复 ROUND=2 RECALL=<标记>',
      liveInputMode: 'side',
    }));
    expect(second.filter(event => event.type === 'error')).toEqual([]);
    const secondText = textOf(second);
    expect(secondText).toContain('ROUND=2 RECALL=ORBIT-731');
    process.stdout.write(`${JSON.stringify({
      first: firstText.match(/ROUND=1 ACK=ORBIT-731/u)?.[0],
      second: secondText.match(/ROUND=2 RECALL=ORBIT-731/u)?.[0],
      route: firstText.match(/route=([^ ]+)/u)?.[1],
    }, null, 2)}\n`);
  } finally {
    await drainSide(adapter.runSide({
      runId: 'real-btw-out',
      scopeId: 'real-btw-scope',
      cwd,
      prompt: '/btw out',
      liveInputMode: 'side-exit',
    })).catch(() => []);
    await main.close();
    await adapter.shutdown();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 400_000);

async function drainSide(run: AgentRun): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run.events) events.push(event);
  return events;
}

function textOf(events: AgentEvent[]): string {
  return events.flatMap(event => event.type === 'text' ? [event.delta] : []).join('');
}
