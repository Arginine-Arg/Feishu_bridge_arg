# Changelog

## 1.9.2

- Fixed `/btw` when `follow-cc-switch` resolves a provider but MixAgents does
  not return the generated runtime route. Bridge now keeps the settings-selected
  provider as the primary path, restarts the MCP runtime, and retries with the
  bundled `mixagents-broker@0.1.1` entrypoint when an older or stale external
  runtime ignores the generated configuration.
- Added a final safety fallback in eligible `mode=auto` profiles: only after
  the selected MixAgents provider cannot be recovered does `/btw` use a
  read-only Codex `thread/fork` on the main session's provider/model when
  `allowForkFallback=true`.
- The fallback delivers the task as ordinary input, not as native
  collaboration `agent_message`/`encrypted_content`, so it remains compatible
  with third-party Responses providers.
- Manual routes, explicit `/btw --route <id>` and `mode=broker` continue to
  fail closed without changing provider.

## 1.9.1

- Added mid-turn Feishu/terminal steering. A normal message sent while a
  Bridge-managed Codex task is active now enters the current turn through
  `turn/steer` on the structured backend, or through Codex's native
  Tab-to-queue composer on a live terminal.
- Mid-turn input is serialized per scope, preserves FIFO when an earlier
  message could not be steered, and explicitly reports an uncertain outcome
  without automatically replaying a possible accepted message.
- Unsupported or unavailable steering falls back to the existing post-turn
  queue; `/stop`, `/goal`, `/btw`, picker controls, side conversations,
  attachments and quoted batches retain their dedicated routing.

- Added `arg-bridge native --bridge` for a native Codex TUI whose parent thread
  owns the `arg_bridge.*` dynamic-tool namespace and a persistent Bridge tool
  host for the lifetime of the TUI.
- Added `arg-bridge native --adopt <thread-id>` for legacy sessions. Codex 0.164
  `thread/resume` does not accept `dynamicTools`, so adoption starts a new
  Bridge-managed thread and injects bounded, redacted user/assistant text from
  the old thread. Both IDs are printed; no JSONL or encrypted payload is
  rewritten.
- Added attach support for existing Bridge-marked threads, thread marker
  persistence with `adoptedFrom`, malformed-marker fail-closed behavior, and
  real App Server regression coverage for new, attach, and migration paths.
- Added writer-owner discovery for `arg-bridge native`: a live thread reconnects
  to the App Server that owns Codex's writer lock, while a cold thread resumes
  from persisted history. Reading a rollout from another host is no longer
  treated as ownership.
- Fixed active-writer failures caused by selecting a registry host that could
  read the thread but did not own its loaded runtime. Unknown or ambiguous
  ownership now fails closed instead of starting another writer.
- Native and structured reattachment preserve the provider/model recorded by
  the thread. A later cc-switch selection no longer silently moves a reconnected
  conversation to a different route.
- Kept the backend socket alive after TUI exit and made Codex's printed
  reconnect command target the resolved owner rather than a transient router.
- Unified `--yolo`, `--dangerously-bypass-approvals-and-sandbox`, `--sandbox`
  and `--ask-for-approval` parsing. New sessions apply the selected policy;
  resumed sessions inherit the thread's frozen permissions.

## 1.8.1

- Added a complete cc-switch Codex provider resolver for SQLite and legacy JSON
  layouts, including provider ID/name, Codex provider/model, base URL, wire API,
  headers, model parameters and the credential field path.
- `follow-cc-switch` now generates a profile-scoped MixAgents route and passes
  the credential only in the MCP child environment. Manual
  `broker-routes.json` and `MIXAGENTS_BROKER_CREDENTIALS_JSON` are no longer
  required for the normal flow.
- Provider switches now change the generated route fingerprint; stale workers
  are closed and recreated on the next spawn/followup. Third-party providers
  fail closed instead of using native fork/collaboration fallback.
- `send_message` now implements persistent Bridge-local queue-only semantics;
  the next `followup_task` delivers queued plaintext and the new task together.
- Added fixed-provider selection in settings and a non-jargon five-step flow:
  choose follow-current or a specific cc-switch provider, with no route or key
  entry.
- Doctor now separates cc-switch provider details, generated route identity,
  thread markers, live identified App Server hosts and actual Broker wiring;
  missing/mismatched runtime state cannot be reported as wired.
- Added SQLite/legacy resolver, provider-switch, route augmentation, queue
  persistence, runtime-binding, native-shadow and real three-round
  cc-switch/MixAgents regression coverage.

## 1.8.0

- Added Bridge-owned App Server dynamic tools for model-initiated cross-provider
  subagents: spawn, followup, wait, list, routes, interrupt and close.
- New Bridge-managed Codex threads enable MultiAgentV2 host-tool mode and hide
  native collaboration, preventing task text from entering unsupported
  `agent_message.encrypted_content` paths.
- Worker tasks now use ordinary plaintext MixAgents MCP input, with persistent
  logical-path/agent/thread mappings, route fingerprint checks, concurrency
  limits, timeouts, cancellation, idempotency and result mailboxes.
- Added the public `mixagents-broker` npm package as an optional dependency and
  resolve its stable package entry without scanning Codex plugin caches.
- Wired read and write Broker routes independently. Workspace-write remains
  opt-in and requires exact per-task/per-workspace authorization.
- Added bounded Project RSI validator-findings repair rounds with fresh-run
  revalidation and auditable `repair-loop.json` evidence.
- Expanded settings and doctor output with native-shadow status, bypass risk,
  write-route wiring, worker-probe status, direct-TUI hook limitations and RSI
  feedback-loop configuration.
- Replaced the settings field dump with a guided five-step flow that reads
  cc-switch account metadata, presents Broker routes as provider/model choices,
  explains credential ownership without exposing values, and hides advanced
  controls behind an explicit prompt.
- Added Codex 0.164.0 protocol, process and full StructuredAdapter-to-fake-MCP
  end-to-end traces.

## 1.7.2

- Completed macOS canonical-path handling for App Server sockets. Where
  `/proc/net/unix` is unavailable, automatic replacement/recovery is
  conservatively deferred instead of guessing or killing an ambiguous process.
- Made Unix-socket process tests platform-scoped without weakening their Linux
  and macOS assertions.
- Reworked Windows path-sensitive tests around canonical temp paths and
  unreadable-config fixtures.
- Kept Project RSI initialization, validator and latest-run status assertions
  active across platforms.

## 1.7.1

- Fixed macOS canonical paths for Project RSI evidence and Codex daemon socket
  symlinks.
- Added macOS Unix-socket client detection through `lsof` so App Server
  replacement remains safe without Linux `/proc`.
- Kept Unix-socket-specific process tests skipped on Windows, where the
  structured backend is explicitly unsupported, while preserving their Linux
  and macOS assertions.
- Made Windows path expectations use the host path implementation.

## 1.7.0

- Added optional MixAgents MCP subagent backend for read-only `/btw`, with
  explicit Codex fork fallback.
- Added dynamic `cc-switch` provider-ID route mapping and a versioned,
  secret-free `broker-routes.json`.
- Added `arg-bridge settings`, `arg-bridge doctor --json`, and explicit
  `--probe-route` paid generation diagnostics.
- Added configured/running provider identity separation and safe
  provider/model switching at idle Codex resume boundaries.
- Added Project RSI discovery, upstream runner/validator integration,
  project/thread/task-bound fresh evidence, reviewer evidence, and completion
  gating.
- Added side-agent persistence, route fingerprints, strict abort signals,
  agent-not-found recreation, and read-only enforcement.
- Added `arg-bridge codex` alias, `migrate-local-poc`, security documentation,
  migration/rollback guidance, and release/smoke documentation.

## 1.6.7

- Rebinds a resumed Codex thread only after a missing historical provider.

See `docs/releases/` for release-specific notes.
