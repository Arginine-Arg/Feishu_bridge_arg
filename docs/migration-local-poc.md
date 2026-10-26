# Migrating direct `dist` / local PoC state

Version 1.7.0 replaces direct installed-package edits with TypeScript source
integration. Existing local PoCs must be audited before use.

```bash
arg-bridge migrate-local-poc --profile codex --dry-run --json
arg-bridge migrate-local-poc --profile codex --apply
```

Dry-run is the default when neither flag is supplied.

## What is recognized

The command recognizes:

- package files carrying a local-PoC management marker, when a unique original
  backup (`*.orig`, `*.original`, `*.arg-bridge-original`, or `*.bak`) exists;
- `structured/subagent-sides.json` in the known pre-version wrapper shape or
  version 1 shape missing `routeFingerprint`.

For a 1.6.7 package, the published clean `dist/cli.js` SHA-256 is known. A file
that has neither the known clean checksum nor a management marker is reported as
an unknown conflict and preserved.

## What apply does

Apply is two-phase:

1. classify every candidate and stop before writing if any conflict exists;
2. back up root config and side map, restore only a uniquely identified original
   file, upgrade side-map fingerprints, then write an idempotency marker under
   `.arg-bridge/migrations/local-poc-v1.json`.

Rollback commands and backup paths are printed in the report. The command never
inventories or edits arbitrary plugin-cache paths.

## Unsupported edits

If a patched `dist` file has no original backup or known clean hash, reinstall
the published release:

```bash
curl -fsSL https://github.com/Arginine-Arg/Feishu_bridge_arg/releases/latest/download/install-global.sh | sh
```

Do not run `pkill` for App Servers. Restart only the affected profile:

```bash
arg-bridge restart --profile codex
```

The new release retains old profiles, thread state, and recognized side-agent
state. Re-running apply after a successful migration is a no-op.

## v1.8 Broker-tool migration

v1.8 adds:

```text
structured/broker-threads.json
structured/broker-workers-<thread-hash>.json
```

The first file records which threads were created with persisted dynamic tools.
The second stores secret-free logical worker mappings. Existing 1.7.x threads
do not have the marker and fail closed on resume because Bridge cannot inject
dynamic tools into those already-created App Server threads. Start a new
Bridge-managed conversation after upgrading.

Do not copy a worker mapping to a different parent thread or replace a route
fingerprint by hand. On rollback to v1.7.2, stop the profile first; v1.7.2
ignores the new files. Keep them if you plan to reinstall v1.8.0.
