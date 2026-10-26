# cc-switch provider auto-resolution smoke (v1.8.1)

Date: 2026-10-27

Environment:

- Linux, Node v24.16.0
- Codex v0.164.0
- `mixagents-broker@0.1.1`
- cc-switch SQLite at `~/.cc-switch/cc-switch.db`
- current provider: `default` (`lixin`)
- Codex internal provider/model: `deepseek` / `deepseek-flash`

No manual `broker-routes.json` or `MIXAGENTS_BROKER_CREDENTIALS_JSON` was used
for the automatic route.

## Resolution

`arg-bridge settings --profile codex --json` resolved the provider without
printing a secret:

- route: `ccswitch-default-44d01bb4f8`
- endpoint host: `api.xinlab-ioz.cn`
- wire API: `responses`
- credential field: `settings_config.auth.OPENAI_API_KEY`
- credential status: `PRESENT`
- credential fingerprint: only a 16-character SHA-256 prefix was emitted
- generated Broker config:
  `<profile>/structured/cc-switch/broker-44d01bb4f836be1d.json`

`arg-bridge doctor --json` correctly kept `brokerWired=false` until a new
Bridge-managed thread marker existed. It did not infer wiring from configuration
alone.

## Real worker

Command:

```bash
ARG_BRIDGE_REAL_CC_SWITCH_E2E=1 \
  pnpm vitest run tests/process/cc-switch-real-three-round.test.ts
```

Result: `1 passed`.

The worker received plaintext input and produced:

```text
ROUND=1 ACK=ORBIT-731
ROUND=2 RECALL=ORBIT-731
ROUND=3 RECALL=ORBIT-731
```

Round 3 used `send_message` queue-only delivery followed by `followup_task`;
it did not trigger a worker turn until the followup.

## Provider switch

Switching cc-switch from `default` to `halflong_ds` produced a new route:

- `ccswitch-halflong_ds-6236936733`
- model: `deepseek-v4.1-flash`
- host: `api.halfapi.asia`
- credential field: `settings_config.auth.OPENAI_API_KEY`
- status: `PRESENT`

An explicit probe reached the new endpoint and returned HTTP 401
`Invalid token`. Doctor classified it as `auth`, did not retry, did not replay,
and did not fall back. The cc-switch provider was restored to `default`
afterwards.

## Broker/native namespace

The following opt-in tests passed:

```bash
ARG_BRIDGE_BROKER_E2E=1 \
  pnpm vitest run tests/process/structured-broker-e2e.test.ts

ARG_BRIDGE_NATIVE_DYNAMIC_TOOLS=1 \
  pnpm vitest run tests/process/codex-dynamic-broker-tools.test.ts
```

They verify that a new Bridge-managed Codex thread exposes `arg_bridge.*`,
does not expose native `collaboration.*`/`multi_agent_v1`, persists
`broker-threads.json`, sends ordinary plaintext worker input, receives a
`function_call_output` mailbox, and does not use
`agent_message.encrypted_content`.

## Secret scan

The real test checked persisted worker projections and did not match
credential-shaped values. Doctor, settings snapshots and generated Broker
configuration contain only field names, paths, status, and one-way fingerprints.
