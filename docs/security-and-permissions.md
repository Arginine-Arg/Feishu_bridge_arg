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
