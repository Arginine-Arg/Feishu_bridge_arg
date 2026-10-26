# Credential, route and permission security

## Main provider

- Only `cc-switch` chooses the main provider.
- arg-bridge never changes the main provider as a side effect of `/btw`,
  settings, doctor, or Project RSI.
- Configured provider, running provider, and pending switch are separate states.
- A running model request is not switched mid-flight.

## Broker credentials

For Broker execution, arg-bridge does not read, print, log, export, or
synthesize provider secrets. The existing Codex main-provider credential
resolver remains scoped to Codex. Broker diagnostics report names and states
only:

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

MixAgents or its trusted helper owns credential lookup. Inline credentials in
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
- `send_message` remains unsupported until MixAgents proves queue-only
  semantics; it is never silently treated as trigger-turn.
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
  description, tags, and maximum access.

A changed fingerprint produces a visible message and replaces the old agent.
Broker `agentId` is never treated as a Codex thread ID.

## Provider switch

- `cc-switch` current ID, Codex internal provider ID, and Broker route ID are
  displayed separately.
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
