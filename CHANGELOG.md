# Changelog

## 1.7.2

- Completed macOS App Server client detection and draining-orphan cleanup using
  `lsof`, including symlinked socket paths.
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
