# MixAgents `events-v1`

ArgBridge 1.11 bundles an auditable fork of `mixagents-broker@0.1.1` and adds a
backward-compatible progress stream named `events-v1`.

## Capability

The Broker initialization response advertises:

```json
{
  "extensions": {
    "mixagents/events-v1": {
      "version": 1
    }
  }
}
```

It also exposes the optional MCP tool `read_agent_events`. A client must treat
the capability as optional: older Broker servers continue to use
`wait_agent` plus ArgBridge liveness heartbeats.

## Request

```json
{
  "agentId": "broker:route-runtime:thread-id",
  "cursor": 128,
  "maxEvents": 200,
  "waitMs": 5000
}
```

- `cursor` is a monotonic per-agent sequence. Only events with a larger `seq`
  are returned.
- `maxEvents` is bounded to 500.
- `waitMs` is bounded to 30 seconds and provides long polling without a new
  transport or unbounded busy-loop.

## Response

```json
{
  "events": [
    { "seq": 129, "type": "turn_started" },
    { "seq": 130, "type": "text_delta", "text": "Inspecting " },
    {
      "seq": 131,
      "type": "tool_started",
      "tool": "commandExecution",
      "itemId": "item-1"
    },
    {
      "seq": 132,
      "type": "tool_completed",
      "tool": "commandExecution",
      "itemId": "item-1"
    },
    { "seq": 133, "type": "text_delta", "text": "the receipts." },
    { "seq": 134, "type": "turn_completed", "status": "completed" }
  ],
  "nextCursor": 134,
  "eventCursor": 134,
  "status": "completed",
  "done": true,
  "cursorExpired": false,
  "droppedThrough": 0
}
```

The terminal `wait_agent` mailbox remains authoritative for final text and
errors. Progress events are advisory and cannot replace the final result.

## Buffering and recovery

Each agent keeps at most:

- 4,096 events;
- 1,000,000 characters of event text.

Old events are dropped from the front and `droppedThrough` advances. If a
client presents an older cursor, the response sets `cursorExpired=true`.
ArgBridge emits a visible notice and continues reading newer events plus the
terminal mailbox.

Event buffers live in Broker memory. After a Broker restart, persisted App
Server thread history remains recoverable through `thread/resume`, but earlier
progress events are not replayed.

## Security boundary

- Only model text deltas and item lifecycle metadata cross the progress API.
- Tool args, command strings, command output, file contents, credentials and
  provider headers are not included in tool progress events.
- ArgBridge redacts streamed and final text before emitting it to Feishu or a
  terminal view.
- A tool result is represented only by its safe item type and completion state.

## Compatibility

The extension does not change MCP JSON-RPC framing or the six-tool Broker
baseline. Clients that do not call `read_agent_events` retain the original
behavior. ArgBridge detects the tool during MCP startup and falls back to
heartbeat-only mode when it is absent.

The vendored source, upstream commit and MIT license are recorded in
`vendor/mixagents-broker/UPSTREAM.md`. This fork is not represented as an
official Utopia-V release.
