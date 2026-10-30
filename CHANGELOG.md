# Changelog

## 1.13.1

- Fixes explicit `/steer` when the preferred structured transport is active by
  forwarding the selected backend's steering capability and request instead of
  exposing only stop and detach controls.
- Treats Codex `turn/steer` as a session-protocol capability rather than
  rejecting third-party Responses providers by name. The active Codex App
  Server remains authoritative and explicit RPC rejection is still reported
  without queueing or retrying the message.

## 1.13.0

- Adds `arg-bridge native --adopt <thread-id> --follow-current-provider`.
  It preserves bounded user/assistant text history while creating the new
  Bridge-managed thread under the provider, model and credential fingerprint
  currently selected by cc-switch.
- Follow-provider adoption reads the old thread only through its authoritative
  owner at an idle boundary, then starts a separate provider-specific App
  Server. It never reuses the old provider's host for the destination thread.
- Passes explicit `modelProvider` and `model` values to `thread/start` and
  verifies the returned thread identity before attaching the TUI.
- Fails closed when the cc-switch provider ID, Codex `model_provider`, model or
  credential cannot be resolved.
- Records the provider generation in `broker-threads.json`. Repeated migration
  with the same provider/model/credential generation is idempotent, while a
  provider switch creates a distinct destination without overwriting the
  previous migration.

## 1.12.0

- Ordinary messages sent during an active task now queue by default instead of
  opportunistically steering into the running turn.
- Adds explicit `/steer <text>`. It targets only the current main turn, never
  creates a second run and never stops the active goal.
- Structured Codex uses the exact active turn ID with `turn/steer`; live Codex
  uses the native empty-composer Tab-to-queue path.
- No active main turn, side conversations, attachments, quoted replies, empty
  bodies, unsupported providers and unsafe terminal states fail explicitly
  without falling back into the ordinary queue.
- `/status` reports whether steering is currently available and distinguishes
  provider, side-conversation, stopping and live-terminal restrictions.
- Reorganizes `/help` into task, session, side-conversation, diagnostics and
  local collaboration sections, with complete command descriptions.
- Hardens tmux recovery after a client disconnect: a silently dropped paste
  may retry literal keys and then one fresh bracketed paste, but only while the
  exact pre-submit ready screen remains unchanged.
- Includes the `1.11.2` in-place Broker compatibility and silently-dropped tmux
  paste recovery fixes.

## 1.11.2

- Restores `mixagents-broker@0.1.1` as an optional compatibility dependency so
  pre-1.11 processes that are still running can resolve the old
  `node_modules/mixagents-broker/dist/server.js` path across an in-place
  ArgBridge upgrade.
- New processes continue to prefer the vendored `events-v1` Broker. The npm
  package is retained only as a module-resolution shim for running processes.
- A new process with a stale profile path containing
  `node_modules/mixagents-broker/dist/server.js` now automatically redirects to
  the vendored Broker with a visible notice.
- A tmux client disconnect whose paste is acknowledged but silently dropped now
  retries once through literal terminal keys only when the exact pre-submit
  ready screen remains unchanged; normal drafts and rendered progress suppress
  the retry to avoid duplicate tasks.
- Doctor reports `vendorBroker=present|missing` and
  `legacyNpmBroker=present|missing`. On Node 20, npm correctly omits the
  legacy package because it declares Node >=22.19; the vendored Broker remains
  the supported runtime and doctor reports the engine gate explicitly.

## 1.11.1

- `sideTimeoutMs` is now a soft waiting notice instead of a hard cancellation.
  A read-only `/btw` automatically starts another wait window after
  `workerTimeoutMs`, so a long answer can still finish and return through the
  original side run without a user command.
- Added `/btw result` as a recovery path for retained timeout state after an
  old-version timeout, Bridge interruption, or other abnormal recovery. It
  resumes progress from the persisted event cursor and does not resend the task.
- An explicitly retained timeout side is not silently replaced. A new normal
  `/btw` requires `/btw result` to collect it or `/btw out` to explicitly
  interrupt/discard it.
- Timeout diagnostics and `/status` now show side status and cursor explicitly.

## 1.11.0

- Vendors a source-auditable MixAgents Broker 0.1.1 fork under
  `vendor/mixagents-broker`, including upstream commit provenance and the MIT
  license. Release package size increases by only the compiled Broker dist.
- Adds the backward-compatible `mixagents/events-v1` capability and
  `read_agent_events` MCP tool with cursor pagination and long polling.
- `/btw` now streams text deltas and safe tool lifecycle updates while keeping
  `wait_agent` final output/error authoritative.
- Event buffers are bounded and report cursor expiry explicitly. Tool command
  text, command output, file contents and credentials never enter progress
  events.
- Older MixAgents Broker servers continue to work with heartbeat-only progress.
  The npm optional dependency is removed because the vendored build is now the
  stable bundled runtime.

## 1.10.1

- Recognizes the legacy `arg-bridge-mixagents-mcp` wrapper as a generated
  cc-switch runtime wrapper. Generated routes now launch the bundled Broker
  directly instead of probing the incompatible wrapper and showing a fallback
  warning on every `/btw`.
- Emits a visible liveness heartbeat every 15 seconds while waiting for a
  MixAgents side mailbox. The Broker MCP currently exposes only terminal
  mailbox results, not token deltas.
- Timeout and interrupted side turns are no longer implicitly reused. The next
  `/btw` closes the uncertain agent and creates a clean side instead of steering
  a new message into work that may still be running remotely.
- Timeout text now distinguishes Bridge stopping its wait and requesting an
  interrupt from the provider actually stopping all remote work.

## 1.10.0

- `/btw` now supports explicit one-task workspace-write authorization:
  `/btw --write --workspace <canonical-project> <task>`. Both the profile's
  write-worker setting and a compatible write route are required.
- Write permission never persists across side tasks. A later `/btw` without
  `--write --workspace` closes the write-capable worker and returns to
  read-only. Missing, unrelated or broad workspaces fail closed.
- The side worker prompt and lifecycle now distinguish read-only review from an
  explicitly authorized write task instead of always calling itself read-only.
- Explicit write turns use the normal `workerTimeoutMs` budget and provider
  reasoning settings; the 90-second low-reasoning fast path remains specific to
  read-only conversational `/btw` turns.
- `/btw` keeps the Codex-like tools available inside read-only mode and adds the
  same explicit per-task write path for cases that need file changes.
- Replacing an expired Bridge relay for the same terminal command now detaches
  it without killing the managed tmux session, so the next turn reconnects to
  the existing conversation.

## 1.9.9

- Agent timeouts now render as actionable errors with the real timeout message.
  They are no longer mapped to the conversational idle watchdog, which made a
  bounded `/btw` timeout appear as `0 分钟无响应`.
- Generated cc-switch runtimes now recognize `.js`, `.mjs`, `.cjs` and
  node-launched `mixagents-broker-mcp` wrappers, starting the bundled Broker
  directly instead of probing an obsolete external process first.

## 1.9.8

- Replaced the blanket `thirdParty -> web_search disabled` workaround with a
  provider-capability policy. `subagents.webSearch=auto` honors
  `supports_standalone_web_search`; `native` explicitly force-enables native
  search; `disabled` is an explicit user choice. Settings and doctor report the
  provider declaration, effective state and reason.
- Added a dedicated fast `/btw` runtime policy. Conversational side turns use
  `sideTimeoutMs` (90 seconds by default), `sideReasoningEffort=low`, and
  bounded Codex request/stream retries. Automatic workers keep
  `workerTimeoutMs` and the provider's normal reasoning configuration.
- A timed-out side now interrupts its worker and returns an actionable
  provider/route or timeout-budget message. The request is never replayed on
  the main model.
- Side/worker/reviewer runtime fingerprints include policy, so a route or
  provider switch closes an incompatible old agent instead of silently reusing
  it.

## 1.9.7

- Kept the third-party Codex wrapper regression enabled where `node:sqlite` is
  available and skipped it on Node 20, which does not provide that built-in
  module. This removes Node 20/macOS and Node 20/Ubuntu CI failures without
  changing the 1.9.6 runtime fix.

## 1.9.6

- Fixed repeated `/btw` follow-ups failing with `already has an active writer`.
  A changed route is still validated on every request, but an unchanged side
  agent uses the Broker backend that owns its live worker. The temporary
  verification backend is closed, and an `agent_not_found` recovery keeps the
  replacement backend alive long enough to recreate the worker.
- Generated cc-switch runtimes now bypass legacy
  `mixagents-broker-mcp`/`mixagents-broker` wrappers and start the bundled
  compatible Broker directly. This removes the repeated runtime-recovery
  message without changing the selected provider, model or credential.
- Third-party Broker workers now launch Codex with
  `web_search = "disabled"`. Codex 0.164 otherwise sends a native
  `web_search` tool even for custom Responses providers; halfapi rejected
  those requests as 503/timeout while the same model and key succeeded with
  ordinary Codex tool definitions.
- Native `/model`, `/compact` and similar commands are injected directly into
  the active live Codex terminal, matching Codex composer behavior instead of
  waiting for the current task to finish. Adapters without active-command
  injection retain the queue-only fallback.
- Added regressions for same-route backend reuse, `agent_not_found` recreation,
  old wrapper selection and direct native-command injection.

## 1.9.5

- Fixed `/btw` coexistence with an active main run. The side marker is now
  preserved as the final authority if a bridge route omits `inputMode`, so
  `/btw` cannot regress into a competing main run and report
  `run-already-active`.
- Broker side turns now use `subagents.workerTimeoutMs` instead of the generic
  conversational idle watchdog. A provider request that is legitimately silent
  no longer appears as an immediate `0 分钟无响应` termination.
- Native slash commands sent while a live task is running are queued for the
  next idle boundary instead of cancelling the active task.
- Third-party structured Responses providers no longer use `turn/steer`; user
  messages queue for the next turn, avoiding provider-specific interruption
  behavior. Official providers retain native steering.
- Added regressions for main-plus-side concurrency, side worker timeout
  propagation, and non-cancelling command/message intake.

## 1.9.4

- Fixed selected-provider credential precedence for both `/btw` and
  model-visible `arg_bridge.*` subagent tools. An inherited main-session
  `OPENAI_API_KEY` could win inside MixAgents 0.1.1 because that runtime only
  filled missing credential variables; Bridge now explicitly applies the
  credentials resolved from the selected cc-switch provider to the Broker MCP
  child environment.
- Added regression coverage that starts with a deliberately wrong inherited
  key and verifies the Broker process receives the selected provider key for
  both the `/btw` resolver and BrokerToolController paths.
- Added a real three-round `halflong_ds` acceptance with the normal main key
  still present in the parent environment. The worker retained
  `ORBIT-731` across all three turns.

## 1.9.3

- Fixed `arg-bridge native <thread-id>` falsely reporting multiple owners when
  writer-lock, tmux and saved-binding metadata named the same Unix socket
  through different symlinked paths.
- Moved Codex App Server runtime sockets from disposable `TMPDIR` locations
  such as `/run/user/<uid>/mihomo-tmp` to stable XDG runtime/state directories,
  with a short-path fallback for the Unix socket length limit.
- Added persistent reconnect guidance:
  `arg-bridge native --bridge <thread-id> --profile <name>`. Raw
  `codex --remote unix://...` remains valid only while that specific App Server
  socket exists.
- `--adopt` is now idempotent. A repeated migration of the same source thread
  reuses the newest existing Bridge marker instead of creating another thread.
- The running Bridge daemon now reloads `broker-threads.json` on a marker miss,
  so a thread created by `arg-bridge native --adopt` can be bound immediately
  without restarting the daemon.

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
