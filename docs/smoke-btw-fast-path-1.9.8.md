# arg-bridge 1.9.8 `/btw` smoke

Date: 2026-10-28

## Environment

- Host: `worker02`
- Codex: `0.164.0`
- MixAgents Broker: `0.1.1`
- cc-switch provider: `hallong_ds`
- Codex provider/model: `custom / deepseek-v4.1-flash`
- Access: `read-only`
- Web Search declaration: absent, so `webSearch=auto` resolved to `disabled`

## Real consecutive `/btw`

Command:

```bash
CC_SWITCH_HOME="$CC_SWITCH_HOME" \
CODEX_HOME="$CODEX_HOME" \
ARG_BRIDGE_REAL_CC_SWITCH_E2E=1 \
ARG_BRIDGE_REAL_CC_SWITCH_PROVIDER_ID=hallong_ds \
ARG_BRIDGE_CODEX_BIN="$CODEX_BIN" \
vitest run tests/process/cc-switch-real-three-round.test.ts \
  -t "consecutive /btw"
```

Exit code: `0`

```text
first:  ROUND=1 ACK=ORBIT-731
second: ROUND=2 RECALL=ORBIT-731
route:  ccswitch-hallong_ds-a9dbadc001
```

## Fast failure

A real Codex 0.164 process was pointed at a local endpoint returning HTTP 503.
The side provider overrides limited request and stream retries.

```text
exitCode=1
requests=4
elapsedMs=1318
```

This verifies that a provider outage no longer expands into dozens of hidden
retries and an apparently indefinite `/btw`.

## Doctor

`arg-bridge doctor --profile codex --json` exited `0` and reported:

```text
sideTimeoutMs=90000
sideReasoningEffort=low
webSearch.mode=auto
webSearch.providerSupported=null
webSearch.effective=disabled
selectedRoute=ccswitch-hallong_ds-a9dbadc001
```

The reason explicitly instructs the user to select a provider declaring
`supports_standalone_web_search=true`, or to force `native` only after
verification.

## Redaction

The release archive was checked against all Codex provider secrets present in
the local cc-switch database:

```text
checkedSecrets=7
exactSecretHits=0
workspaceAbsolutePathHits=0
```

No credential value, complete credential JSON, or local workspace path was
present in the package.
