# MixAgents subagents, model tools and `cc-switch` routing

Version 1.11.0 bundles a source-auditable MixAgents Broker fork with the
backward-compatible `events-v1` progress stream. The provider selected in
settings remains the primary backend. If an explicit external MixAgents server
omits the current generated route, Bridge can recover to the vendored Broker
before using any fallback. MixAgents is available through three separate paths
and uses automatic cc-switch provider discovery for workers:

1. the explicit `/btw` side conversation;
2. Bridge-owned dynamic tools that the parent Codex model can call without a
   user entering `/btw` first.
3. the explicit `arg-bridge native --bridge`/`--adopt` terminal path.

The main conversation always stays on the Codex provider selected by
`cc-switch`. A Broker route is a worker route and never changes the main
provider.

## Why Bridge uses App Server dynamic tools

Codex MultiAgentV2 native `spawn_agent` and `followup_task` encode ordinary
tool-call task text as `agent_message.encrypted_content`. A custom
Responses-compatible provider can successfully return HTTP 200 while its child
thread sees no user task. Rewriting the encrypted bytes or globally downgrading
to MultiAgentV1 does not fix that protocol mismatch.

Bridge therefore uses the Codex App Server host-tool contract:

- `thread/start` supplies a `arg_bridge` dynamic-tool namespace;
- the App Server sends `item/tool/call`;
- Bridge executes the call through MixAgents MCP;
- Bridge returns standard `contentItems` / `success`;
- Codex records that result as ordinary `function_call_output`, not
  `agent_message`.

For Bridge-managed new threads, Bridge also sets:

```json
{
  "features": {
    "multi_agent_v2": {
      "enabled": true,
      "disable_native_tools": true,
      "root_agent_usage_hint_text": "Use the arg_bridge namespace..."
    }
  }
}
```

The native tools are hidden rather than silently left available. A provider
that ignores the dynamic host-tool contract fails visibly; Bridge does not
fall back to the encrypted native path.

The exact Codex 0.164.0 trace is recorded in
`docs/smoke-structured-broker-e2e-0.164.0.json`.

## Parent-model Broker tools

The `arg_bridge` namespace exposes:

- `spawn_agent`: create a worker from ordinary plaintext `task`;
- `followup_task`: trigger a worker turn and return its mailbox result;
- `wait_agent`: wait for one or more logical names/agent IDs;
- `list_agents`: show logical path, Broker agent ID, worker thread ID when
  available, route, provider, model, access and status;
- `list_routes`: show non-secret route availability;
- `interrupt_agent` and `close_agent`;
- `send_message`: queue-only semantics implemented in Bridge. It stores
  plaintext locally without waking the worker; the next `followup_task` sends
  the queued text and the new task together as one ordinary MixAgents input.

`spawn_agent` and `followup_task` send their task as ordinary MixAgents input.
They never create a native Codex child thread. The logical path is stable for
the parent thread:

```text
/root/<logical-name> -> Broker agentId -> optional worker threadId
```

Worker mappings are stored under the profile's `structured/` directory and do
not contain credentials. Bridge restart can reload the mapping and call
MixAgents again by `agentId`; `agent_not_found` is surfaced without identity
guessing.

The result mailbox is pull-based through `wait_agent`. The Broker instructions
require the parent not to report delegated work complete before collecting the
relevant result. This avoids fabricating an unsolicited App Server event while
still making the result a normal function-call output to the parent model.

## Native collaboration and old threads

Bridge can deterministically shadow native collaboration only on threads it
creates with persisted dynamic tools. The thread marker is stored in
`structured/broker-threads.json`.

- A new Bridge-managed thread gets dynamic tools and native tools hidden.
- A Bridge-restarted/resumed thread is accepted only when that marker and its
  thread state are present.
- An old thread created by 1.7.x or earlier fails closed with an instruction to
  start a new conversation. It is not resumed into a state where model calls
  look successful but the child receives only `environment_context`.
- A tmux pane not created through this path is not claimed as Broker-managed.

Codex hooks can inspect, rewrite or block a native tool call, but they cannot
replace that call with a different tool and synthesize its result. They are
therefore not used as a claimed deterministic interceptor here.

Direct `codex`, including direct TUI `/btw`, remains outside this dynamic-tool
path. A future direct-TUI integration requires a trusted Codex plugin/hook that
either supplies an equivalent Broker tool surface or blocks native
collaboration fail-closed. `doctor --json` reports this boundary as
`directCodexTuiCoverage: "requires-trusted-hook"`.

## Stable integration surface

arg-bridge integrates with the MixAgents STDIO MCP server. It does not scan
`$CODEX_HOME/plugins/cache` and does not import private broker source paths.
ArgBridge vendors a source-auditable fork at
`vendor/mixagents-broker/plugin/mixagents-broker/dist/server.js`. The release
package includes the compiled MIT-licensed runtime plus provenance, while the
Git repository contains upstream source, tests and the change description.
An explicit non-legacy profile command or `ARG_BRIDGE_MIXAGENTS_MCP` still takes
priority.

The controller verifies the six baseline tools before use:

- `routes`
- `spawn_agent`
- `send`
- `wait_agent`
- `interrupt_agent`
- `list_agents`

The vendored Broker also advertises `mixagents/events-v1` and exposes the
optional `read_agent_events` tool. ArgBridge enables incremental progress only
when that tool is present; older servers continue with heartbeat-only waiting.
See [events-v1](./mixagents-events-v1.md) for the cursor, long-poll, buffer and
security contract.

The bundled Broker normally needs no launch command. A custom command can be
configured in `arg-bridge settings`, in the profile, with
`ARG_BRIDGE_MIXAGENTS_MCP` (a JSON descriptor), or through
`MIXAGENTS_BROKER_MCP_COMMAND`.

```json
{
  "subagents": {
    "enabled": true,
    "mode": "auto",
    "routeMode": "follow-cc-switch",
    "ccSwitchProviderId": null,
    "readRoute": null,
    "writeRoute": null,
    "modelTools": true,
    "nativeToolPolicy": "shadow",
    "toolNamespace": "arg_bridge",
    "maxConcurrentWorkers": 4,
    "workerTimeoutMs": 900000,
    "sideTimeoutMs": 90000,
    "sideReasoningEffort": "low",
    "webSearch": "auto",
    "allowWriteWorkers": false,
    "includeProgressSnapshot": true,
    "reuse": "scope-cwd",
    "allowForkFallback": false,
    "mixagents": {
      "mcpCommand": "mixagents-broker"
    }
  }
}
```

`mode`:

- `auto`: try the subagent-selected cc-switch provider and route first. A
  missing/mismatched runtime route or a known-older MCP server triggers a
  bounded runtime restart and, when needed, a retry with the bundled compatible
  Broker. Only after those recovery attempts fail does `allowForkFallback`
  permit a read-only `thread/fork` on the main Codex session's provider/model.
  The fallback receives the task as ordinary user input; it does not use native
  collaboration/`agent_message` encrypted tasks. This also works when the main
  session uses a third-party Responses provider.
- `broker`: require MixAgents. Never fall back silently.
- `fork`: use the legacy compatibility backend.
- `off`: disable `/btw` without affecting the main conversation.

Explicit `/btw --route <id>` and manual route mode never fall back.

## Automatic cc-switch provider resolution

Web search is provider capability, not a vendor special case. A provider may
declare:

```toml
[model_providers.vendor]
supports_standalone_web_search = true
```

`subagents.webSearch` supports three policies:

- `auto` (default): keep the native Responses `web_search` tool only when the
  provider declares support. If the capability is absent or false, Bridge
  disables native search and reports the reason in settings/doctor.
- `native`: force native search. Use this only after the selected provider has
  been verified to support Responses `web_search`; otherwise upstream 503 or
  timeouts remain provider errors.
- `disabled`: never send the native search tool.

Changing to a provider with declared web-search support makes the next `/btw`
and worker use search without editing generated files. Bridge never changes the
selected provider automatically and never turns a provider-specific failure
into a hardcoded global ban.

`routeMode: "follow-cc-switch"` is the default and needs no
`broker-routes.json` file. On every worker operation, Bridge reads the current
cc-switch provider from SQLite (`~/.cc-switch/cc-switch.db`, with a legacy
`settings.json` fallback), parses `settings_config.config` TOML, and resolves:

- cc-switch provider ID and display name;
- Codex-internal provider ID and model;
- base URL, `wire_api`, context/reasoning settings and provider headers;
- the known credential field and its value in memory only.

It materializes a profile-scoped Broker config under
`<profile>/structured/cc-switch/broker-<policy-hash>-<role>.json` and passes the
credential to the MixAgents child as `MIXAGENTS_BROKER_CREDENTIALS_JSON`. The
value is never written to the Broker config, profile, route map, worker mapping,
logs, doctor JSON, or argv.

When `ccSwitchProviderId` is `null`, the next operation follows cc-switch. When
it is set to a provider ID, workers use that provider while the main
conversation continues to follow cc-switch. A provider switch changes the route
fingerprint. Side/worker role and capability-policy changes also rotate the
fingerprint; an old worker is closed and recreated, never silently reused.

## Three different provider identifiers

Do not conflate these values:

1. `cc-switch` provider ID, read from
   `~/.cc-switch/settings.json.currentProviderCodex`.
2. Codex-internal provider ID and model from the active
   `$CODEX_HOME/config.toml`.
3. MixAgents Broker route ID.

The generated route is keyed by the **cc-switch provider ID** and includes the
config fingerprint in its route ID. A legacy route map is optional and is
acceptable only for an explicitly selected manual route:

```json
{
  "version": 1,
  "defaultReadRoute": "review-read",
  "defaultWriteRoute": "coding-write",
  "providers": {
    "halflong": {
      "readRoute": "halflong-ds-read",
      "writeRoute": "halflong-ds-write"
    }
  }
}
```

The legacy file lives at `~/.config/arg-bridge/broker-routes.json` (or below
`XDG_CONFIG_HOME`). It contains IDs only and is not created by the default
follow-cc-switch flow.

Selection order for each `/btw` or model-visible worker call:

1. explicit `/btw --route <id>`;
2. manual `subagents.readRoute` (or `writeRoute` for a write worker);
3. automatically generated route for the selected/current cc-switch provider;
4. legacy cc-switch provider-ID mapping;
5. `defaultReadRoute` (or the corresponding write fields);
6. in `mode=auto` + `follow-cc-switch`, a read-only main-provider Codex
   `thread/fork` fallback when `allowForkFallback=true`, with a visible notice.

The fallback is disabled for `mode=broker`, manual route mode and explicit
`/btw --route <id>`. Those modes continue to fail closed rather than silently
switching provider.

All values are re-read for every worker call and every settings/doctor
invocation.

### Selected-provider credential precedence

Version 1.9.4 applies the credentials resolved from the selected cc-switch
provider directly to the Broker MCP child environment. This is required because
MixAgents 0.1.1 only fills credential variables that are absent; an inherited
`OPENAI_API_KEY` from the main Codex session would otherwise win over the key
selected for `/btw` or an `arg_bridge.*` worker.

The same override applies to `/btw`, model-visible Broker tools, native Bridge
workers and RSI reviewers. Credential values remain limited to the MCP child
environment and are never written to Broker route files, worker mappings or
logs.

### Side concurrency and timeout

`/btw` is a concurrent side operation, not a second main turn. It remains
native-side marked even if a bridge route omits its `inputMode`. Conversational
side turns use `subagents.sideTimeoutMs` (default 90 seconds) and
`subagents.sideReasoningEffort` (default `low`). Explicitly authorized write
turns are treated as Codex-like workers instead: they use the longer
`subagents.workerTimeoutMs` budget and the provider's normal reasoning effort.
Model-visible workers use the same worker policy.

The side runtime also limits Codex request/stream retries so a temporarily
unavailable provider fails quickly instead of appearing to think indefinitely.
With the vendored `events-v1` Broker, Bridge forwards model text deltas and safe
tool lifecycle updates as they arrive. `wait_agent` remains authoritative for
the final text/error. With an older external Broker, Bridge falls back to a
liveness heartbeat every 15 seconds. When the side budget expires, Bridge stops
waiting and requests an interrupt; remote provider work may continue. The error
directs the user to a faster provider/route or the configured
`sideTimeoutMs`/`workerTimeoutMs` budget. The request is not replayed on the
main model. A timed-out or interrupted side is rotated on the next `/btw`
instead of receiving a new message into uncertain remote work.

## Credential ownership

For automatic Broker execution, arg-bridge reads the selected cc-switch
`settings_config` in memory, logs only the field path and a one-way fingerprint,
and places the key only in the MixAgents child environment. It never exports
the key to the interactive shell, logs, doctor JSON, worker mapping, route map,
prompt or argv. It also never runs
`cc-switch -a codex provider current`, which can print secrets. The pre-existing
Codex main-provider credential resolver remains separate.

Three credential modes exist:

- `cc-switch-auto`: the default follow mode described above. No environment
  variable or credential prompt is required.
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
  returning it to the controller; this is only an advanced fallback.
- The helper must expose a compatibility/version marker that a future
  arg-bridge probe can verify.

## `/btw` lifecycle

The default access is `read-only`. A larger main-session sandbox never upgrades
`/btw`. A single task may use explicit write access:

```text
/btw --write --workspace /canonical/project <task>
```

This requires `allowWriteWorkers=true`, a compatible write route, and a
canonical workspace equal to or below the current project. The next `/btw`
without the flags returns to read-only and replaces the write-capable agent.

First `/btw <text>`:

1. Reload the latest profile, cc-switch provider/credentials, and Broker routes.
2. Build a bounded progress snapshot containing thread ID, cwd, goal, last user
   request, last assistant output, and last tool status.
3. Redact secrets and cap the snapshot at 2400 characters.
4. Spawn a MixAgents agent with `access: "read-only"`.
5. Save agent ID, policy-free route identity, provider, model, scope, cwd, and
   route fingerprint in `structured/subagent-sides.json`.
6. Wait for the first turn using an AbortSignal and either `sideTimeoutMs`
   (read-only) or `workerTimeoutMs` (explicit write).

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

## Workspace-write authorization

Model-visible workers default to read-only even when the main thread has a
larger sandbox.

`workspace-write` is possible only when all of these are true:

1. `subagents.allowWriteWorkers=true`;
2. a real write route is selected or supplied;
3. the canonical workspace is not `/` or another broad root;
4. the user starts the parent turn with:

   ```text
   arg-bridge-write --workspace /absolute/canonical/path --task <exact task text>
   ```

5. the worker task exactly matches the user-authorized task text.

Missing or mismatched authorization fails before `spawn_agent` reaches MCP.
The authorization directive is stripped before the parent model sees the task;
model-controlled dynamic-tool arguments cannot self-grant write access.
For `/btw`, the equivalent grant is the explicit
`--write --workspace <canonical-path>` pair. A write worker is revalidated
before every reused turn and is closed when the next `/btw` requests read-only.

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

`arg-bridge settings` is a guided five-step flow:

1. read and display the active cc-switch account, all safe provider IDs/names,
   the active Codex model and current runtime status;
2. choose whether unavailable Broker execution may use local Codex fork;
3. choose **follow current provider** or one fixed cc-switch provider; no route
   ID or credential entry is required;
4. Bridge shows that it will resolve the provider key automatically;
5. decide whether Project RSI should check initialized projects, then confirm a
   plain-language summary.

Advanced concurrency, native-tool shadowing, write workers, custom MCP command,
progress snapshot and RSI repair-round settings are hidden behind an explicit
`advanced` prompt.

When follow mode is selected, settings writes only the provider preference:

```json
{
  "ccSwitchProviderId": null
}
```

It does not switch the active main provider.

For public MixAgents 0.1.1, Bridge supplies the automatically resolved
credential object directly to the MCP child. Manual
`MIXAGENTS_BROKER_CREDENTIALS_JSON` remains an advanced fallback; it is not
needed for follow mode. The settings panel never reads, displays or writes the
value. `mixagents-managed` remains an explicitly unverified integration point.

Settings and plain doctor are non-paid, non-mutating diagnostics. They:

- show route ID/provider/model/access/availability/revision;
- show missing environment-variable names only;
- show read and write route wiring separately;
- show Broker dynamic tools, native shadow policy, concurrency and timeouts;
- mark workspace-write routes as available to explicit `/btw --write` tasks and
  gated by the exact workspace/task authorization;
- show MixAgents launch/tool-contract/credential/generation status separately;
- show configured versus running main providers;
- show Project RSI initialization, validator, reviewer requirement and bounded
  repair-loop state;
- show whether native collaboration can bypass Broker and whether direct TUI
  still requires a trusted hook.

`--probe-route` is an explicit paid generation check. It sends one fixed
read-only task, never installs anything, never retries, and never forks. HTTP
401/402/429, timeout, transport-unknown, and provider failures remain failures.

## Direct Codex

`arg-bridge codex [thread]` is an alias for `arg-bridge native [thread]`.
Installation never replaces the executable managed by `@openai/codex`, and plain
`codex` keeps its native `/btw`.

Use `arg-bridge native --bridge` for a new Bridge-managed terminal TUI, and
`arg-bridge native --adopt <thread-id>` for a bounded, safe history migration to
a new Bridge-managed thread. Ordinary `arg-bridge native` remains vanilla Codex.
The migration is necessary because Codex 0.164 `thread/resume` has no
`dynamicTools` parameter. See [Bridge-managed native TUI](./native-bridge.md).
