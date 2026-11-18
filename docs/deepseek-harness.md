# DeepSeek Harness

DeepSeek Harness runs as a structured Bridge profile. Bridge uses the official
`dsh` process over ACP and the same Feishu reply, permission card, and side
session handling as its other structured profiles.

## Migrate a Codex profile

Install the tested official Harness build with Node.js 24.9 or newer.

```sh
npm install -g @deepseek-ai/dsh@0.2.2-rc.1
arg-bridge profile create-dsh dsh --from codex
arg-bridge settings --profile dsh
```

The new profile copies the workspace, Feishu app, access policy, reply
preferences, and MixAgents routing. Codex thread history and Codex-specific
model and service settings stay in the Codex profile. A Feishu app can have
one Bridge bot connected at a time. When ready to switch that app to DSH,
stop the Codex profile and then start the DSH profile.

```sh
arg-bridge stop --profile codex
arg-bridge start --profile dsh
```

## Accounts, models, and controls

cc-switch currently has no DSH app type. Bridge reads the current account
from its existing Codex provider catalog, including an API Key, endpoint,
and model. Switch accounts with `cc-switch -a codex use <provider-id>` or pin
the DSH main conversation to a provider in Bridge settings. A pinned DSH
provider lets the two profiles use different accounts. For endpoints with
multiple protocols, settings can select Responses, Chat Completions, or
Anthropic Messages. ChatGPT OAuth-only accounts require a separate API Key.

- `/model` fetches the selected provider's model catalog and lists the
  available models. `/model <id>` selects a model for that chat and provider.
- `/status` reports the current session. `/stop` cancels the active turn.
  Approval cards and `/answer` resolve individual tool requests.
- For Codex structured sessions, `/recover status` shows the provider state.
  `/recover continue` is the manual Esc then continue operation. It refuses
  to act while an approval or tool is active and verifies the interrupted turn
  before sending the new input.
- `/new` starts a new session. In a private chat, `/resume` lists the sessions
  previously used by that chat in the current workspace.
- `/btw`, `/btw result`, and `/btw out` use the existing MixAgents routes and
  priorities. DSH has its own native subagent tools and can also call Bridge
  MixAgents tools over MCP. Under a DSH profile, routes generated from
  cc-switch run their workers directly in DeepSeek Harness. Existing manual
  Broker routes keep their configured backend. To select DSH in a manual
  route, add `"dsh": {"binary": "dsh", "api": "openai-responses"}`
  and reference the route's credential with `envKey`. The API value can
  also be `openai-completions` or `anthropic-messages`.

Linux DSH workers require a working `bwrap` (Bubblewrap). macOS workers use
`sandbox-exec`. On Windows, use read-only DSH worker routes. Linux and macOS
workers can write within the authorized project and their own private state
and temporary directories. A completed or interrupted worker keeps its DSH
session and can accept a follow-up when idle. If the Broker process exits
mid-turn, send an explicit follow-up to resume the same worker.

Open a Bridge terminal client from the same workspace by running
`arg-bridge native <session-id> --profile dsh`. It reads the selected provider
again on each turn and resumes the same DSH session. The profile has its own
DSH data directory by default. An optional absolute `dsh.home` can point a
profile at a Harness installation that already owns the desired session.

DSH allows a single session writer. Bridge closes the ACP session after each
turn to release its lock before another client resumes. A live owner must
close the session before another client can write. ACP in the tested build
delivers committed assistant messages, tool events, and approvals. It has
no shared live terminal, active-turn steering, or slash-command protocol for
Harness-native `/goal` and `/compact`. Provider retries run inside Harness.
