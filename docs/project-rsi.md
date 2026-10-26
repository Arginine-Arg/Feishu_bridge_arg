# Project RSI adapter

Project RSI is an upstream project-evidence system. It is not a MixAgents
feature and is not a renamed historical Task RSI directory. arg-bridge owns the
completion gate and reviewer orchestration only; it does not copy or weaken the
upstream validator.

## Discovery and initialization

arg-bridge walks upward from the current workspace looking for:

```text
.project-rsi/config.json
```

The file is the initialization marker. If none exists, an ordinary turn is not
gated and bridge never creates one automatically. A project root explicitly
configured in `arg-bridge settings` must already:

- resolve to a canonical directory;
- not be `/`, `$HOME`, or a broad parent directory;
- contain `.project-rsi/config.json`.

The settings panel rejects an uninitialized root and tells the user to run the
upstream init flow first. Reserved profile fields may configure explicit runner
and validator entries:

```json
{
  "rsi": {
    "mode": "auto",
    "projectRoot": "/absolute/project",
    "runnerCommand": ".project-rsi/project_rsi.py",
    "runnerArgs": [],
    "validatorCommand": ".project-rsi/project_rsi.py",
    "validatorArgs": [],
    "reviewerRouteMode": "follow-cc-switch",
    "reviewerRoute": null,
    "maxRepairRounds": 2,
    "repairTimeoutMs": 600000
  }
}
```

Python `.py` entries are executed with `python3`; JavaScript entries are
executed with the current Node runtime. Neither the controller nor settings
places task text or credentials in argv.

## Trigger conditions

`rsi.mode: "auto"` runs only when a bridge-managed main turn:

- reports a persistent file/config mutation such as `fileChange` or `apply_patch`;
- or produces an explicit high-impact conclusion marker.

Casual Q&A and diagnosis with no persistent change do not create a run.

This gate is enforced on Bridge/structured turns. A direct Codex TUI is outside
that path unless the project installs a trusted Codex hook. Settings/doctor
report `nativeTerminalGate: "requires-trusted-hook"`; arg-bridge does not claim
whole-Codex coverage from a Feishu-only gate.

## Fresh evidence

The default evidence root is:

```text
.agent/rsi/runs/<runId>/
  manifest.json
  validator.json       # or receipt.json, upstream naming wins
  review.json          # written by the Bridge reviewer
```

Bridge accepts a successful run only when all of the following hold:

- `.project-rsi/config.json` belongs to the canonical project;
- the run directory name equals `manifest.runId`;
- `manifest.projectRoot` resolves to the project root;
- the manifest is newer than the current turn start;
- it carries the current thread ID or task hash;
- the validator receipt is at least as new as the manifest;
- receipt `runId` and optional manifest SHA-256 match;
- the receipt reports `passed`, `ok`, `valid`, or numeric `exitCode: 0`.

File mtime alone is insufficient. A historical `.agent/rsi` directory without a
Project RSI config is ignored, not relabeled.

If a fresh manifest exists but lacks a passing receipt, an explicitly configured
upstream validator is run. If no fresh run exists and an upstream runner is
configured, it is invoked with a temporary 0600 request file containing the
redacted task, cwd, thread ID, and task hash. A runner exit code of zero is not
enough; the resulting fresh manifest and validator receipt must pass the gate.

When the gate fails, the Bridge emits an error instead of a normal completion
event. It never fabricates a receipt, edits a validator threshold, removes a
test, or approves a proposal automatically.

## Bounded repair loop

For Bridge-managed Codex turns, validator/reviewer failure is returned to the
parent as normal user input inside the same thread:

```text
turn -> validator/reviewer -> findings -> parent repair
     -> fresh upstream run/receipt -> validator/reviewer -> completion
```

The loop is bounded by:

- `rsi.maxRepairRounds` (default `2`, maximum `10`);
- `rsi.repairTimeoutMs` (default ten minutes);
- the existing turn AbortSignal;
- the upstream runner/validator limits.

Each repair round records a prompt hash, bounded redacted findings and timing in
`<runDir>/repair-loop.json`. Reviewer identity remains in `review.json`.
When the maximum is reached, the Bridge emits a failure rather than sending a
normal success completion card.

A stale run, wrong run ID, wrong thread/task hash, stale receipt or reviewer
unavailability cannot satisfy the gate. The repair prompt explicitly forbids
fabricated receipts, weakened thresholds, test deletion and automatic proposal
approval.

## Reviewer evidence

After the validator gate passes, the configured read route gets one bounded,
read-only review of the redacted manifest/evidence. The side may not modify
files. Bridge records:

```json
{
  "route": "review-read",
  "provider": "provider-id",
  "model": "model-id",
  "access": "read-only",
  "agentId": "broker-agent-id",
  "verdict": "short verdict",
  "responseHash": "sha256",
  "response": "bounded redacted response"
}
```

Review is evidence, not authority. A failed or unavailable reviewer keeps the
gate open and enters the bounded repair/failure path; it never turns into a
silent pass. If writer and reviewer resolve to the same model, describe them as
separate sessions, not independent-model review.
