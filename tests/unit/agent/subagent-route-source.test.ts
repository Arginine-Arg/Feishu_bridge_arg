import { describe, expect, it } from 'vitest';
import { selectSubagentRoute } from '../../../src/agent/subagents/registry';
import { DEFAULT_SUBAGENT_CONFIG, type SubagentConfig } from '../../../src/config/profile-schema';
import type { SubagentRoute } from '../../../src/agent/subagents/types';

const ccSwitch = {
  currentProviderCodex: 'cc-current',
  providers: [{ id: 'cc-current', name: 'CC current', current: true }],
  settingsPath: '/tmp/cc-switch/settings.json',
};

function route(overrides: Partial<SubagentRoute>): SubagentRoute {
  return {
    id: 'route',
    description: 'route',
    provider: 'magpie',
    model: 'relay-a/gpt-6',
    maxAccess: 'workspace-write',
    available: true,
    missingEnvironment: [],
    tags: [],
    backend: 'mixagents',
    ...overrides,
  };
}

function config(overrides: Partial<SubagentConfig>): SubagentConfig {
  return { ...DEFAULT_SUBAGENT_CONFIG, mode: 'broker', ...overrides };
}

describe('subagent route source isolation', () => {
  it('never selects a cc-switch route in follow-magpie mode', () => {
    const selection = selectSubagentRoute({
      config: config({ routeMode: 'follow-magpie' }),
      ccSwitch,
      routeMap: undefined,
      routes: [
        route({ id: 'cc', source: 'cc-switch', ccSwitchProviderId: 'cc-current' }),
        route({ id: 'mp', source: 'magpie', ccSwitchProviderId: 'relay-a' }),
      ],
    });
    expect(selection.route?.id).toBe('mp');
  });

  it('never selects a magpie route in follow-cc-switch mode', () => {
    const selection = selectSubagentRoute({
      config: config({ routeMode: 'follow-cc-switch' }),
      ccSwitch,
      routeMap: undefined,
      routes: [
        route({ id: 'cc', source: 'cc-switch', ccSwitchProviderId: 'cc-current' }),
        route({ id: 'mp', source: 'magpie', ccSwitchProviderId: 'relay-a' }),
      ],
    });
    expect(selection.route?.id).toBe('cc');
  });

  it('honours the magpie priority order', () => {
    const selection = selectSubagentRoute({
      config: config({
        routeMode: 'follow-magpie',
        magpieProviderId: 'relay-a',
        providerPriority: [
          { providerId: 'relay-b', models: ['relay-b/claude-sonnet'] },
          { providerId: 'relay-a', models: ['relay-a/gpt-6'] },
        ],
      }),
      ccSwitch,
      routeMap: undefined,
      routes: [
        route({ id: 'a', source: 'magpie', ccSwitchProviderId: 'relay-a', model: 'relay-a/gpt-6' }),
        route({ id: 'b', source: 'magpie', ccSwitchProviderId: 'relay-b', model: 'relay-b/claude-sonnet' }),
      ],
    });
    expect(selection.route?.id).toBe('b');
  });
});
