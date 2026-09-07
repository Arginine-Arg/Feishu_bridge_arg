# Transport review and release acceptance

## Reproduced failures

On installed Codex 0.153.2, in an isolated tmux server and empty workspace:

1. Open `/model` using a native bracketed paste and Enter.
2. Paste the literal `3` with `tmux paste-buffer -p`. The model picker stays unchanged.
3. Send the literal `3` with `tmux send-keys -l`. The reasoning picker opens immediately.

The previous transport treated both actions as pasted text. Codex's non-searchable
list view handles shortcuts as key events and ignores paste events. The previous
fake agent accepted any chunk containing a number, including bracketed paste,
so those passing tests did not establish compatibility with real Codex.

The lifecycle detector also let a recommendation below a Working/Waiting row
override that row. Codex displays its composer during active work. This could
release the relay before the final answer, although the terminal kept working.
The new contract test holds that exact surface for eight seconds, beyond the
old idle/settlement interval, then requires the final answer to be delivered.

## Changes

- Input frames explicitly distinguish `text` and `keys`. Text uses tmux native
  paste; picker keys use literal key injection. A numeric model choice does not
  add Enter; an explicit approval choice plus Enter stays a single frame.
- Failed paste operations no longer fall through to another text delivery.
- Newly launched managed Codex TUIs use `disable_paste_burst=true`, a Codex
  configuration escape hatch for deliberate programmatic input. Existing bound
  terminals keep their configuration; bracketed paste and exact-draft recovery
  still apply there. Updating the package alone does not change an existing CLI's
  launch configuration.
- Active Working/Waiting evidence wins over a composer suggestion. A native
  Worked divider after a retained busy row permits completion. Recommendation
  text alone does not make a session busy.
- Current picker snapshots win over older history carrying Main/Side footers.
- Control requests are serialized in arrival order. New run/lifecycle transitions
  invalidate waiting control operations; a later click does not cancel an earlier
  click just because it arrived quickly.
- Slow card control checks return an immediate receipt and report later failure
  in chat. The receipt does not claim that a choice has already reached Codex.
- Explicit topic identity is retained when routing controls.

## Architecture assessment

Tmux is useful for preserving the exact CLI session and allowing manual attach.
It is a weak source of semantic state: rendered screens do not provide a request
ID, accepted-input acknowledgement, approval ID, or turn-completed event. More
regular expressions and fixed sleeps cannot remove that uncertainty.

The official [Codex App Server](https://developers.openai.com/codex/app-server)
provides JSON-RPC input, approval requests and `turn/completed` notifications.
For an integration owning its sessions, that is the preferable long-term backend:
route by thread/turn/item IDs, persist delivery cursors, and render cards from
approval schemas rather than terminal text. Keep terminal rendering as an optional
view instead of using it as the source of truth.

Generated schemas from the installed CLI additionally expose goal APIs and
ephemeral thread forks. Thread resume documents rejoining a running thread.
These are promising for retaining tmux access through a shared daemon, but they
are version-dependent. This patch does not silently migrate live research goals
or replace native side conversations with a separately resumed worker. A migration
must first verify shared-server ownership, pending approval replay, in-flight goal
rejoin, ephemeral side context, independent stop, and reconnect deduplication.

## Verification commands

```sh
pnpm test
pnpm typecheck
pnpm build
pnpm test:package
ARG_BRIDGE_TEST_NATIVE_CODEX=1 pnpm vitest run tests/process/native-codex-picker.test.ts
```

The opt-in test uses the installed Codex TUI and tmux, opens the model menu,
selects a model, verifies the reasoning menu, then goes back. It makes no model
request. CI also runs a fake TUI that actually distinguishes Paste from Key
events; an ordinary fake process that accepts every character is insufficient.

These tests verify the transport and mocked Feishu callback boundary, not a
real Feishu client click. Real chat delivery still depends on the deployed
profile, callback subscription, credentials, and connection.
