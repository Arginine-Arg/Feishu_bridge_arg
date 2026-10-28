# Credential, route and permission security

## Main provider

- Only `cc-switch` chooses the main provider.
- arg-bridge never changes the main provider as a side effect of `/btw`,
  settings, doctor, or Project RSI.
- Configured provider, running provider, and pending switch are separate states.
- A running model request is not switched mid-flight.

## Broker credentials

For automatic Broker execution, arg-bridge reads the selected cc-switch
`settings_config` only in memory, puts the key only in the MixAgents child
environment, and reports only names/state plus a one-way fingerprint. It does
not print, log, export, synthesize, or put the key in argv. The existing Codex
main-provider credential resolver remains scoped to Codex. Broker diagnostics
report names and states only:

```text
PRESENT
MISSING
delegated-unverified
```

Bridge-managed mode passes exactly one opaque reference:

```text
MIXAGENTS_CREDENTIAL_PROVIDER=<provider-ref>
MIXAGENTS_CREDENTIAL_SOURCE=cc-switch
```

For the default auto mode, Bridge resolves the selected cc-switch entry and
passes the credential only to the MCP child. In the optional managed mode,
MixAgents or its trusted helper owns that lookup. Inline credentials in
MixAgents argv are rejected during profile normalization. Credential files must
be mode `0600` and their directories `0700`.

Never run:

```text
cc-switch -a codex provider current
```

It can print the full API key. The only allowlisted provider command is the
non-secret table:

```text
cc-switch -a codex provider list
```

## Provider capabilities and web search

Native Responses `web_search` is a provider capability, not a Bridge
permission. `subagents.webSearch=auto` keeps it only when the selected provider
declares `supports_standalone_web_search=true`. `native` is an explicit user
override for a verified provider; `disabled` always removes the native tool.

Unsupported or unknown capability never changes provider, credentials, route or
model automatically. If web access is required, the user must select a provider
that declares support. Doctor reports the declared and effective states.
`/btw` remains read-only and uses a separate fast timeout; web-search policy
cannot upgrade workspace or sandbox access.

## `/btw` permissions

- Every `/btw` requests `read-only`.
- The main profile's sandbox does not upgrade side access.
- `workspace-write` requires an exact task and exact canonical workspace
  authorization at the call site.
- Broker must authorize the canonical `cwd` through configured
  `workspaceRoots`; Bridge declines interactive MCP elicitation.
- `workspaceRoots` must never contain `/`, `$HOME`, a disk root, or an
  unnecessarily broad parent.

## Parent-model Broker tools

- New Bridge-managed Codex threads set `disable_native_tools=true`; Broker
  dynamic tools are the deterministic delegation surface.
- Read-only model workers may use the parent workspace or one of its
  subdirectories; tool arguments cannot expand reads to an unrelated path.
- The dynamic tool call runs in Bridge, but worker credentials remain in the
  MixAgents child. They are not copied into dynamic-tool arguments, worker
  mapping, rollout output, doctor JSON or Feishu cards.
- Persistent worker mappings contain logical path, Broker agent ID, optional
  worker thread ID, route fingerprint, provider/model IDs, access and workspace.
  They contain no API key or credential JSON.
- `send_message` is Bridge-local queue-only. It never wakes the worker; the next
  `followup_task` delivers the queued plaintext and new task together.
- Result text is redacted and bounded before persistence/display.
- Rate/cost/concurrency are limited by `maxConcurrentWorkers`,
  `workerTimeoutMs`, and the parent turn/abort signals.

## Workspace-write workers

`allowWriteWorkers=false` is the default. Enabling it does not grant broad
write access:

1. the profile must select a write-capable Broker route;
2. the call must name a canonical, non-root workspace;
3. the user must issue the parent-turn directive
   `arg-bridge-write --workspace /canonical/path --task <exact task>`;
4. the worker task must exactly equal the directive task;
5. the route itself must still allow `workspace-write`.

The directive is consumed outside the model prompt. A model cannot self-grant
write access by forging fields inside `spawn_agent` or `followup_task`.
`/btw` always remains read-only.

## Native collaboration boundary

On old threads without the persisted dynamic-tool marker, Bridge fails closed
rather than claiming that native call interception exists. Codex hooks can
block or rewrite a native call, but they cannot replace it with a Broker call
and synthesize the result. Direct Codex TUI coverage therefore remains
`requires-trusted-hook`; doctor does not report it as covered.

## Route identity

The side-agent reuse key includes:

- stable scope;
- canonical cwd;
- route fingerprint derived from route ID, provider, model, backend, revision,
  target fingerprint, description, tags, and maximum access. Generated
  cc-switch target fingerprints include role, effective web-search policy and
  side reasoning configuration.

A changed fingerprint produces a visible message and replaces the old agent.
Broker `agentId` is never treated as a Codex thread ID.

## Provider switch

- `cc-switch` current ID, Codex internal provider ID, and generated/legacy Broker
  route ID are displayed separately.
- Idle Codex threads are rebound to current provider/model.
- Active threads keep their running provider until the safe boundary.
- The App Server fingerprint is not used to kill a host with active clients;
  replacement is deferred.

## Logs and reports

Settings, doctor JSON, errors, and smoke reports contain:

- route/provider/model/access;
- missing environment-variable names;
- file paths needed for operation;
- validator verdict/hash.

They do not contain API keys, credential JSON values, authorization headers, or
full provider responses. MCP stderr and reviewer response text are redacted and
bounded before display or persistence.

## Service restarts

Commands restart only the named profile service. Bridge does not `pkill` global
App Servers and does not terminate unrelated tmux sessions. Existing active
Codex/TUI clients keep their running App Server until a safe replacement point.
