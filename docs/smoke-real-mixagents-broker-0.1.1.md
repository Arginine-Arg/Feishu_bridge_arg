# Real MixAgents Broker MCP smoke

Date: 2026-10-26

## Package

- npm package: `mixagents-broker@0.1.1`
- tarball SHA-1 reported by npm: `ed064cbfc59848293b830fa2d5319f5f462296ef`
- stable entry used by arg-bridge: `mixagents-broker/dist/server.js`
- Node runtime: v24.16.0

The package was downloaded into an isolated temporary directory with
`npm pack mixagents-broker@0.1.1`. arg-bridge did not scan a Codex plugin cache.

## Command

```bash
ARG_BRIDGE_REAL_MIXAGENTS_MCP=1 \
ARG_BRIDGE_FAKE_CODEX_FIXTURE=/tmp/.../repo/packages/broker/test/fixtures/fake-codex.mjs \
pnpm vitest run tests/process/mixagents-broker-real.test.ts
```

Result: `1 passed`. No `ARG_BRIDGE_MIXAGENTS_SERVER` override was supplied;
the optional dependency resolver selected `mixagents-broker/dist/server.js`.

## Verified worker

- MCP contract: `routes`, `spawn_agent`, `send`, `wait_agent`,
  `interrupt_agent`, `list_agents`
- route: `fake-read`
- provider: `fake-provider`
- model: `fake-model`
- access: `read-only`
- task: `report cwd`
- result: `cwd:<isolated workspace>`

The worker-side Codex App Server was the MixAgents repository's deterministic
`fake-codex.mjs`; this checks the real Broker MCP protocol and lifecycle without
calling a paid model provider. A paid/provider probe remains a separate,
explicit action. No credential value appears in this report.
