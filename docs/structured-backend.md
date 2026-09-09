# Structured backend (v1.5.7)

Version 1.5.7 provides an opt-in structured-first backend with native fallback. The v1.2.7
tag remains available for rollback. It does not automatically change any running
profile or migrate an existing terminal session. The previously validated
1.4.0 implementation is retained with the limitations below.

## Transport

The default remains `preferences.agentTransport: "terminal"` (also the behavior
when this field is omitted). To evaluate the structured backend, use a separate profile
with:

```json
{
  "preferences": {
    "agentTransport": "structured",
    "structuredNativeView": true
  }
}
```

This snippet belongs inside that profile, not at the root configuration level.
Do not switch a profile containing a running legacy session: legacy TUI threads
are not silently imported into a new server. Existing stable terminals remain
accessible using their original profile and tmux attachment.

For Codex, the profile's `full` access is carried through as App Server
`sandbox: "danger-full-access"` and `approvalPolicy: "never"` on thread
creation/resume, and as `sandboxPolicy: { type: "dangerFullAccess" }` on each
turn. The native tmux TUI receives the matching
`--dangerously-bypass-approvals-and-sandbox` flag, so the terminal and Feishu
controls use the same YOLO permission. Lower profile modes remain explicit and
are never widened.

Codex uses an owner-private Unix socket and the official App Server JSON-RPC
protocol. The native tmux TUI connects to the same endpoint and thread ID.
The view does not submit the user task a second time. The server persists
independently of the Bridge connection; thread IDs are recorded per scope and
working directory. Rejoining a running thread observes it rather than replaying
its previous prompt. No mutating RPC is automatically retried after an uncertain
timeout. Explicit new input waits for the existing observed work to finish.

### Dynamic tmux panes

In v1.5.7, `/tmux bind` never migrates a running native writer. It binds the
selected pane and prefers structured transport when a shared endpoint is
available. Ordinary Codex and Claude processes are attached through live
transport. A shared endpoint's submission failure is not retried through live.

To create a shared Codex in your existing shell, run `clash on` if needed, then:

```sh
arg-bridge native 019f8e13-6f7a-7403-8742-06688b2adf05 --profile codex
```

Omit the ID for a new native conversation using live fallback (older servers
cannot share an empty, unmaterialized thread). With an existing ID, the command
uses structured transport. This command inherits the current environment and
returns to the same shell when Codex exits. Bind that pane from Feishu with
`/tmux list` and `/tmux bind <number>`. Manual resume through the same command is
detected on the next message. The binding follows the exact pane, not another
pane selected elsewhere in the tmux session. A plain `codex resume` remains
usable through live fallback. Claude's native entry uses `--profile claude` and
the optional Claude session ID, and retains native live transport.

An empty shell is not automatically overwritten: run the native command there
when ready. Proxy environment changes cannot modify an already-running server.
Use the intended proxy environment before first starting its server. Shared
thread context does not imply that idle terminal-originated output is always
pushed unsolicited to Feishu; the Bridge relay forwards its active requests.

Claude uses the official Agent SDK streaming-input mode with one persistent
Claude process per scope. The default `claude_code` preset and normal user/project
configuration are retained. No Bridge system/developer prompt, summarizer,
router model, or synthetic task is added. Its tmux view currently follows the
same event log read-only. Native `claude attach` targets background-agent
sessions; this backend does not start a second native Claude process against an
SDK session just to create a terminal view. The public SDK `/bridge` export is
for Claude remote-service transport, not a verified local attach replacement.

## Implemented control surface

| Operation | Codex | Claude |
| --- | --- | --- |
| Text and images | `turn/start` with structured content | SDK streaming user message |
| Incremental answer | `item/agentMessage/delta` | SDK partial messages |
| Completion | `turn/completed` | SDK `result`, with error status preserved |
| Approvals | request ID + selected decision; waits for server resolution | `canUseTool` permission response |
| `/model` | model and effort choices; thread settings update | SDK model list and `setModel` |
| `/skills` | skill list and explicit skill input on the next message | command list and selected skill on the next message |
| `/status` | thread metadata and Bridge diagnostics | SDK session/model/phase and Bridge diagnostics |
| `/goal` | native get/set/pause/resume/clear, with goal relay spanning turns | unsupported; no imitation goal loop |
| `/stop` | pause active goal and interrupt the exact turn | SDK interrupt |
| `/btw` | ephemeral fork with native side boundary; text submitted only after preparation | unsupported in the structured backend |

Other slash commands are not forwarded to the model as ordinary task text when
unsupported. The stable terminal backend remains available for its full native
command surface. Cards bind their signature to the request and selected option,
not a terminal position. Slow callbacks return a receipt while completion is
checked independently. Assistant prose is not parsed into native picker cards in
this backend.

When a signed approval arrives after the Bridge relay has disconnected, a
control-only observer reconnects before answering so subsequent output is still
forwarded. It does not replay the task. Codex control recovery requires the
original server and loaded thread; a stale choice cannot launch a replacement
task. Goal and resumed-approval output uses the normal streaming relay.

Legacy `/resume` and scope reset are intentionally blocked in the structured backend rather
than acknowledging a reset while continuing the old protocol thread. Use a new
profile/scope for evaluation. Workspace changes use distinct persisted thread
and host identities. Claude's SDK subprocess currently belongs to the Bridge
process: shutting down that profile closes the SDK process; its session history
remains available, but this is not yet a durable native-daemon attach workflow.

## Validation and remaining gates

Run deterministic protocol tests with `pnpm test`; real local CLIs are opt-in:

```sh
ARG_BRIDGE_NATIVE_PROTOCOL=1 pnpm vitest run tests/process/structured-native.test.ts
ARG_BRIDGE_NATIVE_PROTOCOL=1 ARG_BRIDGE_NATIVE_PROTOCOL_TURN=1 pnpm vitest run tests/process/structured-native.test.ts
```

The first command initializes both CLIs and queries models without a model turn.
The second additionally sends one minimal text task per tool. It consumes normal
model usage for that test task, not an extra routing/summarization request.

On 2026-09-07, Codex 0.153.2 passed initialization, a real text round trip, and
native shared-server tmux display. Claude Code 2.1.220 passed initialization and
model discovery; the configured service rejected real generation with HTTP 403
(`Free tier has no quota`). At that stage successful Claude generation had not
passed; the subsequent explicitly selected DeepSeek validation is recorded below.

The same minimal task through native `claude -p` returned the identical 403,
so that acceptance failure is not specific to the SDK path. The Codex real-turn
probe additionally checks for the assistant's answer in the shared tmux TUI,
not merely a repeated copy of the user prompt.

After the user updated `/home/wanghaoran/.claude/settings.json` on 2026-09-07,
Claude initialization and model selection passed again. Generation did not
finish within the SDK probe's 120-second deadline; an independent native
`claude -p` probe also produced no result before its 55-second deadline.
The configured endpoint's unauthenticated root returned HTTP 200, which confirms
basic reachability but not successful authenticated generation. This is not
reported as a passing Claude round trip; no credentials were printed or changed.
An additional minimal authenticated `/v1/messages` request using the configured
model returned HTTP 403 with `error.type: permission_error` in 89 ms. This shows
the generation endpoint rejected that request, but does not identify whether
the cause is credential scope, model access, quota, or another service policy.

The user subsequently selected `deepseek-v4-flash` via `https://api.xinlab-ioz.cn`.
Inspection found Haiku mapped to that model but `ANTHROPIC_MODEL` still naming
`claude-fable-5[1m]`; the earlier configured-model rejection is not evidence that
DeepSeek is unavailable. With the native SDK `model` option explicitly set to
`deepseek-v4-flash`, real generation passed. A second probe verified two sequential
turns on the same session ID, exact follow-up output, normal completion, empty
input state afterward, and the assistant's final text in the read-only tmux view.
No global credentials or settings were changed; no Sonnet generation was tested.

```sh
ARG_BRIDGE_NATIVE_PROTOCOL=1 ARG_BRIDGE_NATIVE_PROTOCOL_TURN=1 \
ARG_BRIDGE_NATIVE_FOLLOWUP=1 ARG_BRIDGE_NATIVE_MODEL=deepseek-v4-flash \
pnpm vitest run tests/process/structured-native.test.ts -t 'claude:'
```

Set the intended model explicitly in the structured profile, or reconcile native
Claude model configuration before relying on defaults. Alias mappings alone do
not remove a conflicting explicit model setting.

Native Codex side conversations include developer instructions and a boundary
message defining inherited history as reference-only. The user approved retaining
these native strings on 2026-09-07. The adapter preserves the effective existing
developer policy and appends the verbatim native side policy, then injects the
native boundary without starting a model turn. A bare ephemeral fork is not
equivalent. Ephemeral threads do not support goals; the server rejects combining
`ephemeral` with `deferGoalContinuation`. No goal mutation is sent to the parent.

`/btw` without text prepares side without a generation; `/btw text` submits only
after preparation. `/btw out` interrupts and unsubscribes only the child ID.
Its tmux view is currently read-only, avoiding an extra native subscription that
could keep the ephemeral thread alive after exit. The main view remains native.
Side state is currently connection-local: Bridge restart does not promise side
recovery. Real Codex entry, answer, exit and subsequent main status have passed;
this remains opt-in, not an automatic terminal-backend replacement.

A separate real Codex test started a native goal that ran `sleep 25`, submitted
a side question while that goal was active, exited side, and observed the main
goal finish normally (not interrupted). Run it explicitly with:

```sh
ARG_BRIDGE_NATIVE_GOAL_SIDE=1 pnpm vitest run tests/process/structured-side-goal.test.ts
```

This release does not claim full command parity or automatic session migration.
Windows currently retains the terminal backend for Codex;
the shared-server native-view path requires Unix sockets and tmux.

References: [Codex App Server](https://developers.openai.com/codex/app-server),
[Claude streaming input](https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode),
[Claude system prompt presets](https://platform.claude.com/docs/en/agent-sdk/modifying-system-prompts).
