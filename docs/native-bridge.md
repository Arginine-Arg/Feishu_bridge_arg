# Bridge-managed native TUI

Version 1.9.1 adds an explicit Bridge-managed native path without changing the
meaning of ordinary `arg-bridge native`.

## Commands

```bash
# New Bridge-managed Codex thread with arg_bridge.* dynamic tools
arg-bridge native --bridge --profile codex

# Same command with the legacy YOLO alias
arg-bridge native --bridge --yolo --profile codex

# Equivalent explicit long form
arg-bridge native --bridge \
  --dangerously-bypass-approvals-and-sandbox --profile codex

# Attach to an existing thread that already has a Bridge marker
arg-bridge native --bridge <thread-id> --profile codex

# Safely migrate an old thread into a new Bridge-managed thread
arg-bridge native --adopt <old-thread-id>
```

`--adopt` is an explicit migration, not an in-place history rewrite. It:

1. reads the old thread at an idle boundary;
2. starts a new Codex thread with `arg_bridge.*` dynamic tools;
3. injects a bounded text-only handoff from the old user/assistant messages;
4. verifies Broker route preflight;
5. writes the Bridge thread marker and attaches the TUI.

The command prints both IDs:

```text
Bridge-managed migration: <old-thread-id> -> <new-thread-id>
```

## Why the ID changes

The Codex 0.164 App Server protocol has `dynamicTools` in
`ThreadStartParams`, but not in `ThreadResumeParams`. Therefore an old thread
created without dynamic tools cannot safely gain them by `thread/resume`.
Editing JSONL or writing a marker would make the UI claim a tool host exists
when the App Server never registered one.

The migration deliberately copies only:

- user text;
- assistant text;

It does not copy:

- encrypted agent-message payloads;
- reasoning;
- tool arguments or tool output blobs;
- images or local file paths.

The source and destination are capped at 12,000 text characters and secret
patterns are redacted.

## Dynamic tools

The Bridge parent thread receives a custom namespace:

```text
arg_bridge.spawn_agent
arg_bridge.followup_task
arg_bridge.wait_agent
arg_bridge.send_message
arg_bridge.list_agents
arg_bridge.list_routes
arg_bridge.interrupt_agent
arg_bridge.close_agent
```

These are App Server host-tool calls, not Codex's native `collaboration.*`
tools. The Bridge process receives `item/tool/call` while the TUI is open,
executes MixAgents Broker calls with ordinary plaintext tasks, and returns a
normal `function_call_output`.

New threads also receive one non-user developer item saying that the Bridge
session is initialized. This materializes the Codex rollout so the remote TUI
can resume the new thread; it does not send a user prompt or make a model
request.

The TUI process and Bridge tool host must remain alive together. If the host
exits before the TUI, later dynamic calls fail explicitly; Bridge does not
pretend that a native child call succeeded.

## Resume and writer ownership

Codex holds an operating-system lock at:

```text
$CODEX_HOME/thread-writer-locks/<thread-id>.lock
```

while the thread runtime is loaded. The lock may outlive the TUI by the idle
unload interval (`thread_unload_delay_secs`, 30 minutes by default). A held
writer lock therefore means "a runtime owns this thread"; it does not by itself
mean that a model turn is active.

On Linux, `arg-bridge native <thread-id>` resolves `/proc/locks` to the actual
writer PID, maps that process family to its Unix App Server socket, and confirms
ownership with `thread/loaded/list`. It never treats successful `thread/read`
as ownership proof: any App Server sharing the same `CODEX_HOME` can read the
persisted rollout.

The result is deterministic:

| State | Action |
| --- | --- |
| The original writer is alive | Attach that exact backend; do not start a competing writer |
| The writer has exited | Use the normal Bridge App Server and cold-resume the persisted thread |
| The lock owner exists but its socket is unknown or does not list the thread | Fail closed with the owner PID and no mutation |
| Multiple live owners report the thread | Fail closed as ambiguous ownership |

Both live-owner attachment and cold reattachment preserve the provider/model
recorded in the thread. A later cc-switch selection affects newly created work;
it does not silently change the route of the reconnected conversation. An
explicit caller override still wins, while a missing historical provider is
reported rather than replaced automatically.

The printed reconnect command points at the resolved App Server socket, not at
a temporary side router. If the short path was a symlink, Codex may print the
canonical target under `/tmp/codex-daemon-<uid>/`; that target remains valid for
the lifetime of the owning daemon.

`thread/unsubscribe` releases this client's subscription without interrupting
the turn. Bridge never deletes writer-lock files and never kills an owner merely
to make resume succeed. Closing a TUI is a detach/exit of that frontend; a
running turn continues in the owner. Use Codex's own stop/interrupt command when
the intent is to stop work.

Plain local `codex resume <id>` cannot adopt a thread already owned by another
App Server; Codex reports it as open in another app and offers a fork. Use
`arg-bridge native <id>` or the printed `codex --remote <resolved-socket>
resume <id>` command to reconnect to the existing writer.

## Thread markers

Bridge writes:

```text
<profile>/structured/broker-threads.json
```

with:

```json
{
  "version": 1,
  "threads": {
    "<thread-id>": {
      "version": 1,
      "namespace": "arg_bridge",
      "createdAt": 1234567890,
      "adoptedFrom": "<old-thread-id>"
    }
  }
}
```

Old unmarked threads fail closed. A malformed marker file is never silently
replaced.

## Settings and credentials

No extra route or credential setup is needed when `settings` uses
`follow-cc-switch`. Each worker operation resolves the current cc-switch
provider, generated route, endpoint and credential.

`--bridge` requires Broker model tools to be enabled and a successful
`list_routes` preflight. A missing MixAgents installation, route or credential
stops the launcher with an actionable error.
