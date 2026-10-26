# Changelog

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
