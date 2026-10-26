# MixAgents subagents, model tools and `cc-switch` routing

Version 1.8.0 makes MixAgents available through two separate paths:

1. the explicit `/btw` side conversation;
2. Bridge-owned dynamic tools that the parent Codex model can call without a
   user entering `/btw` first.

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
- `send_message`: queue-only semantics. The current MixAgents MCP `send`
  surface does not prove queue-only behavior, so this tool fails explicitly
  instead of being treated as `followup_task`.

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
The public `mixagents-broker` npm package is an optional dependency. When it was
installed successfully, arg-bridge resolves its stable
`dist/server.js` package entry automatically with the current Node runtime.
An explicit profile command or `ARG_BRIDGE_MIXAGENTS_MCP` still takes priority.
On an unsupported Node runtime, the optional package can be skipped and the
explicit command/fallback diagnostics remain available.

The controller verifies all six tools before use:

- `routes`
- `spawn_agent`
- `send`
- `wait_agent`
- `interrupt_agent`
- `list_agents`

The published package normally needs no launch command. A custom command can be
configured in `arg-bridge settings`, in the profile, with
`ARG_BRIDGE_MIXAGENTS_MCP` (a JSON descriptor), or through
`MIXAGENTS_BROKER_MCP_COMMAND`.

```json
{
  "subagents": {
    "enabled": true,
    "mode": "auto",
    "routeMode": "follow-cc-switch",
    "readRoute": null,
    "writeRoute": null,
    "modelTools": true,
    "nativeToolPolicy": "shadow",
    "toolNamespace": "arg_bridge",
    "maxConcurrentWorkers": 4,
    "workerTimeoutMs": 900000,
    "allowWriteWorkers": false,
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
  "defaultWriteRoute": "coding-write",
  "providers": {
    "halflong": {
      "readRoute": "halflong-ds-read",
      "writeRoute": "halflong-ds-write"
    }
  }
}
```

The file lives at `~/.config/arg-bridge/broker-routes.json` (or below
`XDG_CONFIG_HOME`). It contains no base URL, token, or credential material.

Selection order for each `/btw` or model-visible worker call:

1. explicit `/btw --route <id>`;
2. manual `subagents.readRoute` (or `writeRoute` for a write worker);
3. cc-switch provider-ID read-route mapping;
4. `defaultReadRoute` (or the corresponding write fields);
5. auto-only fork fallback, with a visible notice.

All values are re-read for every worker call and every settings/doctor
invocation.
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
`/btw` remains read-only regardless of these settings.

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
3. choose a cc-switch account, a Broker route for that account, and whether the
   mapping follows cc-switch or is fixed;
4. choose who supplies Broker credentials; the normal choice is an environment
   variable already injected by the Bridge launcher;
5. decide whether Project RSI should check initialized projects, then confirm a
   plain-language summary.

Advanced concurrency, native-tool shadowing, write workers, custom MCP command,
progress snapshot and RSI repair-round settings are hidden behind an explicit
`advanced` prompt.

When follow mode is selected, settings writes only the safe mapping:

```json
{
  "providers": {
    "cc-switch-provider-id": { "readRoute": "broker-route-id" }
  }
}
```

It does not switch the active main provider.

For the public MixAgents 0.1.1 package, credentials are supplied as the
`MIXAGENTS_BROKER_CREDENTIALS_JSON` environment object from the Bridge launcher
or secret manager. The settings panel records only the variable name and checks
presence; it never reads or displays the value. `mixagents-managed` remains an
explicitly unverified integration point because the current public package does
not resolve cc-switch secrets itself.

Settings and plain doctor are non-paid, non-mutating diagnostics. They:

- show route ID/provider/model/access/availability/revision;
- show missing environment-variable names only;
- show read and write route wiring separately;
- show Broker dynamic tools, native shadow policy, concurrency and timeouts;
- mark workspace-write routes as excluded from `/btw` and gated per task;
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
`codex` keeps its native `/btw`. Bridge MixAgents routing applies to its
structured/Feishu path. A MixAgents Codex plugin provides its own stable
integration for direct Codex sessions when installed by the user.
