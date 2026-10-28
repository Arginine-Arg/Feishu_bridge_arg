# Vendored MixAgents Broker

This directory contains a small, auditable fork of the MixAgents Broker used by
ArgBridge when `follow-cc-switch` generates a Broker runtime.

Upstream:

- Repository: <https://github.com/Utopia-V/mixagents>
- Package path: `packages/broker`
- Upstream npm version: `mixagents-broker@0.1.1`
- Upstream commit: `09509e52bbd764fffd24c8591fb44476f770a2b9`
- License: MIT, copyright Utopia-V

ArgBridge changes:

- Add bounded per-agent progress events with monotonic sequence numbers.
- Expose `read_agent_events` over MCP with cursor pagination and long polling.
- Forward Codex App Server text deltas and safe tool lifecycle metadata.
- Preserve the terminal `wait_agent` mailbox as the authoritative completion
  result.
- Keep older Broker clients and servers interoperable.
- Target the same Node.js range as ArgBridge (`>=20.12 <27`) because the
  vendored runtime uses only ES2022 and Node core APIs covered by that range.

The source-only delta is recorded in
`vendor/mixagents-broker/patches/events-v1-source.patch`.

The released ArgBridge package contains only the compiled plugin dist, its MIT
license, and this provenance file. Source and tests remain in the ArgBridge Git
repository and CI rebuilds the dist deterministically before packaging.

This vendored fork is not an official Utopia-V release and must not be
represented as upstream support until the changes are merged or separately
published by that project.
