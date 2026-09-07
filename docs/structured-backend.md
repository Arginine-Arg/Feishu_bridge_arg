# Structured backend preview

The stable v1.2.7 tag and `release-v0.6.35` branch are preserved. Development
takes place on `feature/structured-backends`; the preview package identifies
itself as `1.3.0-alpha.1`. It does not automatically change any running profile.

## Transport

The default remains `preferences.agentTransport: "terminal"` (also the behavior
when this field is omitted). To evaluate the preview, use a separate profile
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

Codex uses an owner-private Unix socket and the official App Server JSON-RPC
protocol. The native tmux TUI connects to the same endpoint and thread ID.
The view does not submit the user task a second time. The server persists
independently of the Bridge connection; thread IDs are recorded per scope and
working directory. Rejoining a running thread observes it rather than replaying
its previous prompt. No mutating RPC is automatically retried after an uncertain
timeout. Explicit new input waits for the existing observed work to finish.

Claude uses the official Agent SDK streaming-input mode with one persistent
Claude process per scope. The default `claude_code` preset and normal user/project
configuration are retained. No Bridge system/developer prompt, summarizer,
router model, or synthetic task is added. Its tmux view currently follows the
same event log read-only. Native `claude attach` targets background-agent
sessions; this preview does not start a second native Claude process against an
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
| `/btw` | gated pending native side-boundary acceptance/validation | not enabled in the structured preview |

Other slash commands are not forwarded to the model as ordinary task text when
unsupported. The stable terminal backend remains available for its full native
command surface. Cards bind their signature to the request and selected option,
not a terminal position. Slow callbacks return a receipt while completion is
checked independently. Assistant prose is not parsed into native picker cards in
this backend.

Legacy `/resume` and scope reset are intentionally blocked in the preview rather
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
(`Free tier has no quota`). Successful Claude generation remains an external
acceptance gate, not a passing test claim.

The same minimal task through native `claude -p` returned the identical 403,
so that acceptance failure is not specific to the SDK path. The Codex real-turn
probe additionally checks for the assistant's answer in the shared tmux TUI,
not merely a repeated copy of the user prompt.

Native Codex side conversations include developer instructions and a boundary
message defining inherited history as reference-only. A bare ephemeral fork is
not equivalent. The preview deliberately rejects `/btw` until that native
boundary behavior is accepted under the no-extra-prompt requirement and tested.

The preview has not replaced the stable backend or been advertised as a fully
validated migration. Windows currently retains the terminal backend for Codex;
the shared-server native-view path requires Unix sockets and tmux.

References: [Codex App Server](https://developers.openai.com/codex/app-server),
[Claude streaming input](https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode),
[Claude system prompt presets](https://platform.claude.com/docs/en/agent-sdk/modifying-system-prompts).
