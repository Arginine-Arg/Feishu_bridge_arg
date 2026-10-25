# Changelog

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

