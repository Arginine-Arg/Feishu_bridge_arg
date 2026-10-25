# v1.7.0 smoke report

Date: 2026-10-26 (Asia/Shanghai)

## Deterministic suite

```bash
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

Results:

- typecheck: exit 0
- full Vitest suite: exit 0; 144 files passed, 4 files skipped; 1078 tests
  passed, 6 tests skipped. The skipped tests require opt-in real CLIs/platforms.
- build: exit 0
- diff check: exit 0

The full suite includes the Feishu/Lark run-flow integration suite, live
terminal/tmux suites, cc-switch acceptance, provider resume, settings/doctor,
MixAgents MCP, Project RSI gates and local PoC migration.

## Real Codex CLI

Commands:

```bash
ARG_BRIDGE_NATIVE_PROTOCOL=1 \
  pnpm vitest run tests/process/structured-native.test.ts -t 'codex:'

ARG_BRIDGE_NATIVE_PROTOCOL=1 ARG_BRIDGE_NATIVE_PROTOCOL_TURN=1 \
  pnpm vitest run tests/process/structured-native.test.ts -t 'codex:'

ARG_BRIDGE_NATIVE_RESUME=1 \
  pnpm vitest run tests/process/structured-native.test.ts \
  -t 'resumes the same persisted thread'
```

Results:

- Codex 0.164.0 model discovery/selection: pass, no model turn.
- One real fresh text turn and shared native output: pass.
- Adapter recreation followed by resume of the same persisted thread ID: pass.
- Provider/model/access in the fresh/resume smoke: whatever the active
  `cc-switch`/Codex config selects; no credentials were printed or changed.

The first real run exposed a Codex 0.164 bootstrap issue: a newly allocated
thread has no rollout until its first turn, so opening `codex --remote resume`
immediately failed. The fix keeps a read-only structured view for new threads
and swaps it to the native TUI only after the first turn materializes the
rollout. The repeated real generation test then passed.

## Real MixAgents MCP, offline App Server

The official MixAgents Broker source was built locally and its actual
newline-JSON STDIO MCP server was used. The Broker spawned its official fake
Codex App Server fixture through a configured workspace.

```bash
cd <MIXAGENTS_SRC>/packages/broker
npm run build

cd <ARG_BRIDGE_SRC>
ARG_BRIDGE_REAL_MIXAGENTS_MCP=1 \
ARG_BRIDGE_MIXAGENTS_SERVER=<MIXAGENTS_SRC>/packages/broker/plugin/mixagents-broker/dist/server.js \
ARG_BRIDGE_FAKE_CODEX_FIXTURE=<MIXAGENTS_SRC>/packages/broker/test/fixtures/fake-codex.mjs \
pnpm vitest run tests/process/mixagents-broker-real.test.ts
```

Result: exit 0.

Observed:

- MCP contract version: `0.1.1`
- route: `fake-read`
- provider: `fake-provider`
- model: `fake-model`
- requested access: `read-only`
- agent status: `completed`
- output hash was not needed for this synthetic response; the exact bounded
  result was `cwd:<temporary-workspace>`

The fake App Server is explicit: this validates the real Broker MCP, workspace
authorization, route, App Server lifecycle and read-only request path without
claiming a paid provider round trip.

## Package installation

```bash
pnpm test:package
```

Result: exit 0. The script packed, SHA-256 verified, installed and executed
arg-bridge 1.7.0 in an isolated npm prefix.

The packed tarball was inspected for:

- declared dist/bin/docs files only;
- no cache/plugin absolute paths;
- no API-key-shaped values;
- no local workspace path;
- no generated secret or `.env` file.

## Not claimed

- No live external MixAgents provider was called because the local installation
  has no configured Broker route/credential. The actual MCP/App Server path was
  exercised with the upstream fake App Server fixture.
- `credentialMode: "mixagents-managed"` is Bridge-side complete, but the
  MixAgents trusted-helper implementation is a cross-repository dependency.
  Until it exposes a versioned compatibility probe, doctor reports
  `delegated-unverified`.
- No live production Feishu app was restarted. Feishu and terminal behavior were
  exercised through the integration/process suites; service restarts were not
  performed because doing so would terminate the user's prefixed running
  environment.
- A direct plain `codex` TUI is not wrapped. Its native `/btw` and completion
  behavior remain outside Bridge unless the project installs a trusted upstream
  hook.
- No upstream Project RSI bundle was present. The adapter and strict synthetic
  fresh/stale/hash/validator gates passed; real upstream bundle promotion must
  be supplied by its owning repository before claiming Project RSI production
  certification.
