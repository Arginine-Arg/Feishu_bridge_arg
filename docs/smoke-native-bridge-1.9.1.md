# Bridge-managed native TUI and steering smoke (v1.9.1)

Date: 2026-10-27

Environment:

- Linux, Node v24.16.0
- Codex CLI 0.164.0
- current cc-switch provider: `default` / `deepseek-flash`
- `mixagents-broker@0.1.1`

## Protocol observation

`codex app-server generate-json-schema --experimental` for 0.164.0 showed:

- `ThreadStartParams.dynamicTools` exists;
- `ThreadResumeParams.dynamicTools` does not exist.

The implementation therefore never claims that an unmarked old thread can gain
tools through `thread/resume`.

The same schema and source review confirmed:

- `TurnSteerParams.expectedTurnId` is required;
- structured steering is a same-turn mutation, not a new turn;
- the native TUI binds Tab to its composer queue action.

## TUI smoke

Command:

```bash
node dist/cli.js native --bridge --profile codex
```

The TUI attached successfully and displayed:

```text
Bridge-managed Codex thread: 01a17999-7e9b-7ed3-b17b-bc6d47e0fbb2
OpenAI Codex (v0.164.0)
DeepSeek-Flash max
```

The marker file contained the matching `arg_bridge` namespace entry. The TUI
exited cleanly with `Ctrl-C`.

## Resume-owner smoke

The following path was repeated in a real pseudo-TTY:

1. Start a materialized Bridge thread with `--yolo`.
2. Exit the TUI with `Ctrl-C`.
3. Re-run `arg-bridge native <thread-id> --profile codex`.
4. Run the exact reconnect command printed by Codex.

Observed thread:

```text
01a179d4-6235-7b00-88be-e229f393df5f
```

Observed stable reconnect endpoint:

```text
unix:///tmp/codex-daemon-2103/cad0b0717b64437352fdb2811d11827b433307521c7694763cbba4e019e96eaf
```

Both reattachments displayed:

```text
permissions: YOLO mode
DeepSeek-Flash max
```

No `active writer` error occurred. The same App Server remained printed after
the temporary view exited, and the socket still existed.

The pre-fix reproduction selected the first profile registry entry because its
`thread/read` could read the rollout. That server did not list the thread in
`thread/loaded/list`; cold-resuming there collided with the actual writer.
The regression test now creates exactly that two-server topology and verifies
that only the writer-lock owner is selected.

Plain `codex resume <thread-id>` still reports that a live thread is open in
another app. That is an upstream local-CLI limitation: use
`arg-bridge native <thread-id>` or the printed explicit `--remote` command for
a live owner.

## Process E2E

Command:

```bash
ARG_BRIDGE_NATIVE_BRIDGE_E2E=1 \
  pnpm vitest run tests/process/native-bridge.test.ts
```

Result: `1 passed`.

The trace verified:

- new thread receives `arg_bridge.*`;
- native `collaboration.*` is absent;
- `spawn_agent` receives ordinary plaintext input;
- `wait_agent` returns the worker mailbox;
- a persisted Bridge thread can be reattached;
- the same thread cold-resumes after the test-owned owner exits;
- a legacy thread creates a new adopted thread;
- old text is injected into the new thread through `thread/inject_items`;
- the marker records `adoptedFrom`;
- only bounded user/assistant text is copied, not tool blobs or encrypted
  payloads.

No provider key appears in the trace, marker or test output.

## Steering smoke

The opt-in Codex App Server process trace blocks inside an active dynamic tool
call, sends `turn/steer` with that exact active turn ID, releases the tool, and
verifies that `MID_TURN_STEER_CHECK` appears in the later provider request.

Additional tests verified:

- a live terminal busy frame with an empty composer sends text followed by the
  native queue key and does not create another Bridge run;
- a Feishu message arriving during an active task calls the active run's steer
  path and returns an insertion acknowledgement;
- a known unavailable steer falls back to the next-turn queue;
- an uncertain steer result returns a warning and is never replayed;
- picker controls, commands, side conversations and queued FIFO remain on
  their existing paths.

## Release gate

Commands:

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm test:package
```

Result:

- `pnpm test`: 150 files passed, 1,124 tests passed, 11 opt-in tests skipped;
- `pnpm typecheck`: passed;
- `pnpm build`: passed;
- `pnpm test:package`: passed;
- opt-in native Bridge process E2E: passed;
- opt-in native TTY resume E2E: passed;
- opt-in Codex dynamic-tool plus `turn/steer` E2E: passed;
- opt-in real cc-switch three-round Broker worker: all three expected
  `ORBIT-731` responses passed.

## Not established

The cause of the first spontaneous TUI disconnect was not reproduced as a
deterministic failure in this smoke. The writer collision, invalid owner
selection and disappearing temporary route are distinct proven issues; no
inference is made that they caused the initial disconnect.
