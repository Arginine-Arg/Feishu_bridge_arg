# MixAgents subagents and `cc-switch` routing

Version 1.7.0 makes `/btw` backend-selectable. The main conversation always
stays on the Codex provider selected by `cc-switch`; `/btw` can use an
independent MixAgents Broker agent or the legacy Codex `thread/fork` path.

## Stable integration surface

arg-bridge integrates with the MixAgents STDIO MCP server. It does not scan
`$CODEX_HOME/plugins/cache` and does not import private broker source paths.
The controller verifies all six tools before use:

- `routes`
- `spawn_agent`
- `send`
- `wait_agent`
- `interrupt_agent`
- `list_agents`

Configure the launch command in `arg-bridge settings`, in the profile, or with
`ARG_BRIDGE_MIXAGENTS_MCP` (a JSON descriptor). A published executable name may
also be supplied through `MIXAGENTS_BROKER_MCP_COMMAND`.

```json
{
  "subagents": {
    "enabled": true,
    "mode": "auto",
    "routeMode": "follow-cc-switch",
    "readRoute": null,
    "writeRoute": null,
    "includeProgressSnapshot": true,
    "reuse": "scope-cwd",
    "allowForkFallback": true,
    "mixagents": {
      "mcpCommand": "mixagents-broker",
      "mcpArgs": ["mcp"],
      "credentialMode": "mixagents-managed",
      "credentialProvider": "opaque-provider-reference"
    }
  }
}
```

`mode`:

- `auto`: try MixAgents; if it cannot start, the protocol is incompatible, or
  no usable route exists, report the reason and use Codex fork when
  `allowForkFallback` is true.
- `broker`: require MixAgents. Never fall back silently.
- `fork`: use the legacy compatibility backend.
- `off`: disable `/btw` without affecting the main conversation.

Explicit `/btw --route <id>` and manual route mode never fall back.

## Three different provider identifiers

Do not conflate these values:

1. `cc-switch` provider ID, read from
   `~/.cc-switch/settings.json.currentProviderCodex`.
2. Codex-internal provider ID and model from the active
   `$CODEX_HOME/config.toml`.
3. MixAgents Broker route ID.

The route map is keyed by the **cc-switch provider ID**:

```json
{
  "version": 1,
  "defaultReadRoute": "review-read",
  "providers": {
    "halflong": { "readRoute": "halflong-ds-read" }
  }
}
```

The file lives at `~/.config/arg-bridge/broker-routes.json` (or below
`XDG_CONFIG_HOME`). It contains no base URL, token, or credential material.

Selection order for each `/btw`:

1. explicit `/btw --route <id>`;
2. manual `subagents.readRoute`;
3. cc-switch provider-ID read-route mapping;
4. `defaultReadRoute`;
5. auto-only fork fallback, with a visible notice.

All values are re-read for every `/btw` and every settings/doctor invocation.
No route decision is cached until process restart.

## Credential ownership

For Broker execution, arg-bridge never reads, logs, exports, or places a
provider key in argv. It also never runs
`cc-switch -a codex provider current`, which can print secrets. The pre-existing
Codex main-provider credential resolver is separate and is not reused as a
Broker credential source.

Two credential modes exist:

- `inherit-env`: the MixAgents MCP server receives an already-injected parent
  environment. arg-bridge checks only the declared variable names and reports
  `PRESENT`/`MISSING` by name.
- `mixagents-managed`: arg-bridge passes only
  `MIXAGENTS_CREDENTIAL_PROVIDER=<opaque-ref>` and
  `MIXAGENTS_CREDENTIAL_SOURCE=cc-switch` to the MCP child. MixAgents or its
  trusted credential helper must resolve the `cc-switch` entry. Until that
  external capability is versioned and verified, doctor reports
  `delegated-unverified`; arg-bridge does not claim one-click credential reuse.

The cross-repository dependency is therefore explicit:

- MixAgents must publish a stable helper/protocol that accepts an opaque
  provider reference and resolves the active `cc-switch` credential without
  returning it to the controller.
- The helper must expose a compatibility/version marker that a future
  arg-bridge probe can verify.

## `/btw` lifecycle

The default access is always `read-only`. A larger main-session sandbox never
upgrades `/btw`. `workspace-write` requires exact per-task and per-workspace
authorization and is not currently offered by the `/btw` UX.

First `/btw <text>`:

1. Reload the latest profile, `cc-switch` metadata, route map, and Broker routes.
2. Build a bounded progress snapshot containing thread ID, cwd, goal, last user
   request, last assistant output, and last tool status.
3. Redact secrets and cap the snapshot at 2400 characters.
4. Spawn a MixAgents agent with `access: "read-only"`.
5. Save agent ID, policy-free route identity, provider, model, scope, cwd, and
   route fingerprint in `structured/subagent-sides.json`.
6. Wait for the first turn using an AbortSignal.

Later `/btw`:

- Reuse the same agent only when scope, cwd, route fingerprint, and read-only
  access are unchanged.
- A route ID, provider, model, backend, revision, route metadata, or workspace
  change produces a visible notice, interrupts/closes the old agent, and creates
  a new one. If MixAgents supplies `targetFingerprint`, it is included too;
  endpoint hashes rather than endpoint secrets are accepted.
- `agent_not_found` is visible and causes a new agent; the old agent ID is never
  passed to Codex `thread/resume`.

`/btw out` interrupts and removes only the side mapping. `/stop`, `/model`,
`/goal`, and `/compact` remain main-scoped. Cancellation uses a valid signal for
route listing, creation, wait, send, and side interruption; a cancelled request
also receives a best-effort cleanup interrupt. Late RPC responses are ignored
after the pending request is removed.

Codex fork fallback remains an explicit compatibility path. Broker `agentId`
and Codex `threadId` are different namespaces and must never be interchanged.

## Provider switching boundary

`settings` reports configured and running identities separately:

- configured cc-switch provider ID;
- configured Codex provider ID/model;
- each live App Server's recorded cc-switch/Codex identity;
- `in-sync`, `pending-next-turn`, `not-running`, or `unknown`.

`cc-switch` changes are not injected into an active model request. A host with
an active client is preserved until the safe boundary. On resume, the bridge
reads the thread. If it is idle and its provider/model differs from current
`config.toml`, the current provider/model is applied to that resume request.
Even when the historical provider still exists, the idle thread is moved to the
new configured provider. If the thread has an active turn, switching is
deferred and logged. If the thread snapshot is unavailable, the bridge preserves
the previous deterministic behavior: no guess unless the server proves the old
provider missing.

## Settings and doctor

```bash
arg-bridge settings --profile codex
arg-bridge settings --profile codex --json
arg-bridge doctor --profile codex --json
arg-bridge doctor --profile codex --json --probe-route review-read
```

Settings and plain doctor are non-paid, non-mutating diagnostics. They:

- show route ID/provider/model/access/availability/revision;
- show missing environment-variable names only;
- mark workspace-write routes as excluded from `/btw`;
- show MixAgents launch/tool-contract/credential/generation status separately;
- show configured versus running main providers;
- show Project RSI initialization and validator state.

`--probe-route` is an explicit paid generation check. It sends one fixed
read-only task, never installs anything, never retries, and never forks. HTTP
401/402/429, timeout, transport-unknown, and provider failures remain failures.

## Direct Codex

`arg-bridge codex [thread]` is an alias for `arg-bridge native [thread]`.
Installation never replaces the executable managed by `@openai/codex`, and plain
`codex` keeps its native `/btw`. Bridge MixAgents routing applies to its
structured/Feishu path. A MixAgents Codex plugin provides its own stable
integration for direct Codex sessions when installed by the user.
