#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import readline from 'node:readline';

const statePath = process.env.FAKE_MIXAGENTS_STATE;
if (!statePath) throw new Error('FAKE_MIXAGENTS_STATE is required');
await mkdir(dirname(statePath), { recursive: true });

const generatedBrokerConfigPath = process.env.MIXAGENTS_BROKER_CONFIG;
let generatedBrokerConfig;
if (generatedBrokerConfigPath) {
  generatedBrokerConfig = JSON.parse(await readFile(generatedBrokerConfigPath, 'utf8'));
}
let credentialNames = [];
let credentialFingerprints = {};
try {
  const credentials = JSON.parse(process.env.MIXAGENTS_BROKER_CREDENTIALS_JSON ?? '{}');
  credentialNames = Object.keys(credentials);
  credentialFingerprints = Object.fromEntries(
    credentialNames
      .filter(name => typeof process.env[name] === 'string' && process.env[name])
      .map(name => [
        name,
        createHash('sha256').update(process.env[name]).digest('hex').slice(0, 16),
      ]),
  );
} catch {
  credentialNames = [];
  credentialFingerprints = {};
}

let state = {
  calls: [],
  agents: {},
  nextAgent: 1,
  nextTurn: 1,
  processStarts: 0,
  routes: [
    {
      id: 'read-a',
      description: 'Read route A',
      provider: 'provider-a',
      model: 'model-a',
      tags: ['review'],
      available: true,
      missingEnvironment: [],
      maxAccess: 'read-only',
      backend: 'app_server',
      selectionReason: 'test',
      default: true,
    },
    {
      id: 'write-b',
      description: 'Write route B',
      provider: 'provider-b',
      model: 'model-b',
      tags: ['coding'],
      available: !process.env.FAKE_ROUTE_B_MISSING,
      missingEnvironment: process.env.FAKE_ROUTE_B_MISSING
        ? [process.env.FAKE_ROUTE_B_MISSING]
        : [],
      maxAccess: 'workspace-write',
      backend: 'app_server',
      selectionReason: 'test',
      default: false,
    },
  ],
};
try {
  state = { ...state, ...JSON.parse(await readFile(statePath, 'utf8')) };
} catch {
  // First run.
}
state.processStarts = Number(state.processStarts ?? 0) + 1;
const omitGeneratedOnce =
  process.env.FAKE_MIXAGENTS_OMIT_GENERATED_ROUTE_ONCE === '1' &&
  state.processStarts === 1;
if (
  generatedBrokerConfig?.routes &&
  process.env.FAKE_MIXAGENTS_OMIT_GENERATED_ROUTE !== '1' &&
  !omitGeneratedOnce
) {
  state.routes = Object.entries(generatedBrokerConfig.routes).map(([id, route]) => ({
    id,
    description: route.description ?? id,
    provider: route.provider,
    model: route.model,
    tags: route.tags ?? [],
    available: !route.envKey || credentialNames.includes(route.envKey),
    missingEnvironment: route.envKey && !credentialNames.includes(route.envKey)
      ? [route.envKey]
      : [],
    maxAccess: route.maxAccess ?? 'read-only',
    backend: 'app_server',
    selectionReason: 'generated test route',
    default: generatedBrokerConfig.defaultRoute === id,
  }));
}
state.lastCredentialProvider = process.env.MIXAGENTS_CREDENTIAL_PROVIDER ?? null;
state.lastCredentialSource = process.env.MIXAGENTS_CREDENTIAL_SOURCE ?? null;
state.brokerConfigPath = generatedBrokerConfigPath ?? null;
state.credentialNames = credentialNames;
state.credentialFingerprints = credentialFingerprints;
state.proxyEnvironmentNames = Object.keys(process.env)
  .filter(name => /^(?:http|https|all)_proxy$/iu.test(name) && process.env[name])
  .sort();

const pending = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value });
}

function tool(id, value, isError = false) {
  result(id, {
    ...(isError ? { isError: true } : {}),
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  });
}

async function persist() {
  const temporary = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, statePath);
}

function agentPayload(agent, status = agent.status) {
  return {
    agentId: agent.agentId,
    route: agent.route,
    provider: agent.provider,
    model: agent.model,
    backend: 'app_server',
    status,
    ...(status === 'completed' ? { output: agent.lastMessage } : {}),
    ...(status === 'failed' ? { error: 'fake failure' } : {}),
  };
}

async function handleTool(name, args, id) {
  const delayMs = Number(process.env.FAKE_MIXAGENTS_DELAY_MS ?? 0);
  if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
  state.calls.push({ tool: name, arguments: args });
  if (name === 'routes') {
    await persist();
    return tool(id, { routes: state.routes });
  }
  if (name === 'spawn_agent') {
    if (!args || typeof args.route !== 'string' || !state.routes.some(route => route.id === args.route)) {
      await persist();
      return tool(id, { code: 'route_not_found', message: `route ${args?.route} not found` }, true);
    }
    if (args.access !== 'read-only') {
      await persist();
      return tool(id, { code: 'access_denied', message: 'write requires explicit test authorization' }, true);
    }
    const route = state.routes.find(item => item.id === args.route);
    const agentId = `agent-${state.nextAgent++}`;
    const agent = {
      agentId,
      route: route.id,
      provider: route.provider,
      model: route.model,
      status: 'running',
      cwd: args.cwd,
      task: args.task,
      access: args.access,
      lastMessage: `result:${args.task}`,
    };
    state.agents[agentId] = agent;
    await persist();
    return tool(id, agentPayload(agent));
  }
  if (name === 'list_agents') {
    await persist();
    return tool(id, {
      agents: Object.values(state.agents).map(agent => agentPayload(agent)),
    });
  }
  const agentId = args?.agentId ?? args?.agentIds?.[0];
  const agent = agentId ? state.agents[agentId] : undefined;
  if (!agent) {
    await persist();
    return tool(id, { code: 'agent_not_found', message: `agent ${agentId} not found` }, true);
  }
  if (name === 'send') {
    agent.status = 'running';
    agent.lastMessage = `followup:${args.message}`;
    await persist();
    return tool(id, agentPayload(agent));
  }
  if (name === 'interrupt_agent') {
    agent.status = 'interrupted';
    await persist();
    return tool(id, agentPayload(agent));
  }
  if (name === 'wait_agent') {
    agent.status = 'completed';
    await persist();
    return tool(id, {
      timedOut: false,
      agents: [agentPayload(agent)],
    });
  }
  return tool(id, { code: 'unknown_tool', message: name }, true);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    result(request.id, {
      protocolVersion: '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: {
        name: 'fake-mixagents-broker',
        version: process.env.FAKE_MIXAGENTS_SERVER_VERSION ?? '0.1.1-test',
      },
    });
    return;
  }
  if (request.method === 'notifications/initialized') return;
  if (request.method === 'tools/list') {
    result(request.id, {
      tools: [
        'routes',
        'spawn_agent',
        'send',
        'wait_agent',
        'interrupt_agent',
        'list_agents',
      ]
        .filter(name => name !== process.env.FAKE_MIXAGENTS_OMIT_TOOL)
        .map(name => ({ name, inputSchema: { type: 'object' } })),
    });
    return;
  }
  if (request.method === 'tools/call') {
    const id = request.id;
    void handleTool(request.params.name, request.params.arguments, id).catch(error => {
      tool(id, { code: 'fixture_error', message: error.message }, true);
    });
    return;
  }
  if (request.method === 'notifications/cancelled') {
    pending.get(request.params.requestId)?.();
  }
});
