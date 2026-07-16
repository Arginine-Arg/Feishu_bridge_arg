# arg-bridge

A lightweight bot that bridges Feishu / Lark messenger with your local Claude Code or Codex CLI. Run one command, scan a QR code to bind a PersonalAgent app, and talk to your local coding agent from chat.

[中文 README](./README.zh.md)

For a product walkthrough, see the [Feishu document](https://larkcommunity.feishu.cn/docx/OaRIdFIRFoLM3xxTmKwcetHqn5e).

## What it does

- Forwards Feishu / Lark messages to local Claude Code or Codex CLI. Send a DM directly, or `@bot` in a group.
- **Streaming card**: text replies and tool calls update on one Lark card in real time.
- **COT process messages**: optionally send a process message with agent progress text and tool calls, then send the final answer separately.
- **Session continuity**: each chat, topic, or document comment thread keeps its own session.
- **Persistent tmux execution**: each chat or topic runs one native Claude/Codex CLI inside tmux. Normal messages and native slash commands share that same terminal context.
- **Queueing and batching**: messages sent in quick succession are handled together; messages sent during a run are queued for the next turn, while commands like `/new`, `/cd`, `/ws use`, and `/stop` can interrupt the current task.
- **Multiple workspaces**: use `/cd` to switch the current project, and `/ws` to save and reuse common project directories.
- **Images and files**: send them to the bot directly, and the bridge downloads them locally for the agent.
- **Interactive cards**: `/help`, `/ws list`, and `/status` return cards with clickable buttons.
- **Prompt bridging**: the agent's `AskUserQuestion` / `ExitPlanMode` are auto-rendered as Lark cards with buttons — click to answer and resume the session.
- **Long-conversation resilience**: long streams roll over to a fresh card before Lark's automatic close; withdrawn/invalid cards degrade to a fresh final message, and queued-message notices are rate-limited rather than permanently silenced.

## Prerequisites

- Node.js **>= 20.12.0 and < 25**. Node 22 LTS is recommended for deployment; avoid very new non-LTS runtimes such as Node 25 on production hosts.
- At least one local agent installed and logged in:
  - Claude Code: `claude`, see https://docs.anthropic.com/en/docs/claude-code/quickstart
  - Codex CLI: `codex`, see https://developers.openai.com/codex/cli
- A Feishu / Lark **PersonalAgent** app. The first-run QR wizard can create and bind one for you.

## Install

GitHub Releases are the canonical installation source. The installer downloads the latest release tarball, verifies its SHA256 checksum, removes stale npm links and recognized legacy launchers, and installs with npm lifecycle scripts disabled:

```bash
curl -fsSL https://github.com/Arginine-Arg/Feishu_bridge_arg/releases/latest/download/install-global.sh | sh
arg-bridge --version
```

Install a pinned release or use a writable custom npm prefix when required:

```bash
curl -fsSL https://github.com/Arginine-Arg/Feishu_bridge_arg/releases/latest/download/install-global.sh -o /tmp/install-arg-bridge.sh
sh /tmp/install-arg-bridge.sh --version 0.6.16
# Example for a machine without permission to write npm's configured global prefix:
sh /tmp/install-arg-bridge.sh --prefix "$HOME/.local"
export PATH="$HOME/.local/bin:$PATH"
```

The primary command is `arg-bridge`; `lark-channel-bridge` remains as a compatibility alias. The release contains a prebuilt `dist/`, so no clone, `git pull`, local build, or guessed tarball filename is needed. Node.js >= 20.12 and < 25 is required; Node 22 LTS is recommended.

For a manual install, download both stable assets and verify them before installing:

```bash
curl -fLO https://github.com/Arginine-Arg/Feishu_bridge_arg/releases/latest/download/arg-bridge.tgz
curl -fLO https://github.com/Arginine-Arg/Feishu_bridge_arg/releases/latest/download/arg-bridge.tgz.sha256
sha256sum -c arg-bridge.tgz.sha256
npm install -g --ignore-scripts --install-links=true ./arg-bridge.tgz
```

> Developing from source: `pnpm install && pnpm build`. `npm pack` names the archive from the version in that checkout's `package.json`; use the filename it prints rather than assuming a newer version.
>
> **Migrating from upstream**: stop/unregister the old service first (`lark-channel-bridge stop && lark-channel-bridge unregister`, per profile), install this fork, then use `arg-bridge start` to register the new service. All state lives in `~/.lark-channel/` and is preserved — the same Feishu app / bot reconnects, no re-scan.

## Installation Troubleshooting

### 1. `npm pack` produced an older version

`npm pack` packages the current checkout, not the version written in the next command. For example, if its output says `arg-bridge@0.5.5` and `arg-bridge-0.5.5.tgz`, then `arg-bridge-0.5.6.tgz` does not exist and npm correctly reports `ENOENT`. A failed `git pull` leaves the checkout unchanged. Use the Release installer above to avoid coupling installation to clone state or GitHub connectivity during `git pull`.

### 2. Broken links or `EEXIST` from an earlier install

npm 11 can report a successful Git global install while linking the package to a temporary path under `.npm/_cacache/tmp/git-clone*`. Once npm removes that clone, the command is broken. Older bridge installers can also leave regular launcher files in the global `bin` directory, causing npm to stop with `EEXIST`. The Release installer automatically removes stale links and launchers it recognizes as arg-bridge. If a valid installation of another package still owns the command names, remove it explicitly before reinstalling:

```bash
npm uninstall -g arg-bridge lark-channel-bridge
hash -r
```

Configuration and sessions under `~/.lark-channel/` are not removed by npm uninstall.

### 3. Git installation fallback

Release tarballs are preferred. If a Git install is required, keep both compatibility flags and pin a tag:

```bash
npm install -g --ignore-scripts --install-links=true \
  "git+https://github.com/Arginine-Arg/Feishu_bridge_arg.git#v0.6.16"
```

`--install-links=true` prevents npm 11 from keeping a global symlink to its temporary Git clone. `--ignore-scripts` avoids dependency lifecycle failures such as `spawn /bin/sh ENOENT`; arg-bridge does not require those dependency postinstall scripts at runtime. For SSH-only access, use the same flags with `git+ssh://git@github.com/Arginine-Arg/Feishu_bridge_arg.git#v0.6.16`.

### 4. Node or npm global-prefix errors

Confirm the active shell uses a supported Node version and the intended npm installation:

```bash
node --version
npm --version
npm prefix -g
```

The installer rejects unsupported Node versions before changing the global installation. Use `--prefix "$HOME/.local"` if npm's configured global directory is not writable.

### 5. PATH and shell command cache

If installation succeeds but the shell cannot find the command, add the bin directory printed by the installer:

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
hash -r
```

### 6. Verify the install

```bash
command -v arg-bridge
arg-bridge --help
arg-bridge --version
command -v lark-channel-bridge
```

## Attribution

`arg-bridge` keeps the Feishu/Lark-to-local-agent bridge contract compatible with the original lark-channel bridge work. The Arg-specific implementation separates terminal execution from message routing: Claude/Codex run natively in tmux, while the bridge only routes input, observes output, and renders Lark cards.

## First run

```bash
arg-bridge run
```

The first run opens a QR-code wizard:

1. A QR code renders in your terminal.
2. Scan it with the Feishu / Lark app.
3. Pick or create a PersonalAgent app.
4. If prompted, choose which agent to initialize.
5. Config is written to `~/.lark-channel/config.json`.

You do not need to choose a project directory up front. The bridge creates a profile-managed default working directory; after startup, send `/cd <path>` in Feishu / Lark to switch to a real project.

If you already have a PersonalAgent app, pass `--app-id` during initialization to skip app creation. The command prompts for the App Secret.

```bash
arg-bridge run --app-id cli_xxx
# or initialize and start the background service directly
arg-bridge start --app-id cli_xxx
```

For Lark global apps, add `--tenant lark`.

## Background service

Use `run` for first-run setup and foreground debugging. After the bot can send and receive messages, stop the foreground process with `Ctrl-C`, then use an OS-managed service for background operation:

```bash
arg-bridge start
arg-bridge status
arg-bridge stop
```

Install globally before using service commands. The daemon's launchd plist / systemd unit / Windows task records the bridge CLI path; if that path comes from an npm temp cache through `npx`, the daemon can break when the cache is cleaned. `run` is fine through `npx` as a one-shot foreground process.

Service commands install a per-profile service:

```bash
arg-bridge start [--profile <name>]
arg-bridge stop [--profile <name>]
arg-bridge restart [--profile <name>]
arg-bridge status [--profile <name>]
arg-bridge unregister [--profile <name>]
```

Platform mapping:
- **macOS**: launchd user agent `ai.arg-bridge.bot.<profile>`
- **Linux**: systemd user unit `arg-bridge.bot.<profile>.service`
- **Windows**: Task Scheduler task `ArgBridge.Bot.<profile>`, launched through a `.cmd` wrapper

Daemon logs are under `~/.lark-channel/profiles/<profile>/logs/daemon/`.

### Multiple profiles: Claude and Codex

By default, the bridge starts with the currently selected profile. Use `profile use <name>` to change it. Each profile keeps its own app credentials, sessions, working directories, and logs. Create multiple profiles only when you need to connect multiple PersonalAgent apps, or run Claude and Codex as separate bots:

```bash
arg-bridge start --profile claude --agent claude
arg-bridge start --profile codex --agent codex
```

For example, to restart only the Codex bot:

```bash
arg-bridge restart --profile codex
arg-bridge status --profile codex
```

## Commands

### Host CLI

```text
arg-bridge run [--profile <name>] [--agent claude|codex] [--workspace <path>] [-c <config>]
arg-bridge migrate [--profile <name>] [--agent claude|codex]
arg-bridge ps
arg-bridge kill <id|#>
arg-bridge --help
```

`profile use <name>` changes the profile used by later default starts. Use these profile management commands when running separate Claude / Codex bots, connecting multiple PersonalAgent apps, or doing scripted deployment:

```bash
arg-bridge profile create claude --agent claude
arg-bridge profile create codex --agent codex
arg-bridge profile list
arg-bridge profile use <name>
arg-bridge profile remove <name>
arg-bridge profile remove <name> --purge --yes
arg-bridge profile export <name> [--output ./profile.json] [--force]
arg-bridge profile export <name> --include-secrets --yes
```

`profile remove` archives local state by default, including the active profile. If other profiles remain, the bridge switches to the next one; if it was the last profile, the root config is cleared so the same name can be created again. `--purge --yes` permanently deletes local state. `profile export` redacts app secrets by default; `--include-secrets --yes` includes sensitive config.

If a profile was created with the wrong agent kind, stop or unregister any matching background service first, then run `profile remove <name>` and recreate it with the intended `--agent`.

### Slash commands inside Feishu / Lark

| Command | Effect |
|---|---|
| `/new`, `/reset` | Clear the current session |
| `/cd <path>` | Switch working directory and reset the session |
| `/ws list` | List named workspaces |
| `/ws save <name>` | Save the current working directory as a named workspace |
| `/ws use <name>` | Switch to a named workspace |
| `/ws remove <name>` | Delete a named workspace |
| `/resume` | Resume compatible history for the same agent, working directory, and permission mode |
| `/status` | Show profile, agent, working directory, session, lark-cli identity, and run state |
| `/sendfile <absolute-path>` | Admin-only: reply to the current message with a regular file from the current workspace or bridge media cache, without invoking the agent |
| `/config` | Adjust presentation preferences, access settings, and lark-cli identity policy |
| `/model` | Choose the model; Codex uses its native model/reasoning picker and syncs the result to the active profile |
| `/session [status\|live\|turn]` | Inspect terminal execution. tmux/live is the default; `turn` remains a legacy compatibility fallback |
| `/invite user @name` | Allow a user to use the bot in DMs |
| `/invite admin @name` | Add an access-control admin |
| `/invite group` | Allow the current group to use the bot |
| `/invite all group` | Allow all groups the bot has joined |
| `/remove user @name`, `/remove admin @name`, `/remove group` | Remove access entries |
| `/stop` | Stop the current run, including the card stop button |
| `/timeout [N\|off\|default]` | Set or clear the current session idle watchdog |
| `/ps` | List local bridge processes |
| `/exit <id\|#>` | Stop a bridge process |
| `/reconnect` | Force a WebSocket reconnect |
| `/doctor [description]` | Run low-sensitive diagnostics |
| `/help` | Help card |

DMs do not require an @ mention. Groups and topic groups require `@bot` by default; `@all` is ignored. Cloud-doc comments in supported document types run when the bot is mentioned.

**Using the agent's own commands**: terminal execution is the default. Bridge-owned commands (`/new`, `/cd`, `/status`, …) stay in the bridge, while **unknown slash commands are forwarded verbatim to the current agent CLI** (for example `/compact`, `/fast`, `/skills`, and `/status`). Picker output is rendered as signed Lark choice cards. `/claude /command` and `/codex /command` explicitly target the active native CLI. `turn` mode is retained only as a compatibility fallback.

## Execution and routing

The terminal receives raw user text, never the bridge's XML context or formatting prompt. The Bridge Agent can optionally use an OpenAI-compatible lightweight model to classify route and presentation metadata, but its response is validated against a SHA-256 of the original input and has no field that can modify stdin.

Set all three variables to enable that optional classifier:

```bash
export ARG_BRIDGE_AGENT_ENDPOINT=https://example.invalid/v1
export ARG_BRIDGE_AGENT_MODEL=your-lightweight-model
export ARG_BRIDGE_AGENT_API_KEY=your-api-key
```

Without them, the deterministic router provides the same safe pass-through behavior.

**Interactive prompts become cards**: when the agent calls `AskUserQuestion` (pick one) or `ExitPlanMode` (approve a plan), the bridge renders it as a Lark card with buttons; click to answer and your choice resumes the session on the next turn — no hand-rolled card needed.

## Long-running tasks and stability

Long conversations / tasks are not cut off by a fixed time limit, but two behaviors are worth knowing (optimized in this fork):

- **Queued messages (looks unresponsive)**: while a run is active on the same chat/topic, a new ordinary message does **not** interrupt it — it queues for after the current run. Busy notices are limited to one per 30 seconds, so later progress checks still receive a liveness reply without spamming rapid bursts. Read-only `/status` and `/session status` checks do not discard queued work. **Send `/stop` to interrupt now.**
- **Streaming-card rollover and degradation**: Feishu/Lark automatically closes streaming cards after about 10 minutes. The bridge starts a continuation card every 8 minutes while the run is still active. If a card is withdrawn or invalidated mid-run (Feishu `230011`), the bridge keeps draining the agent and **posts the full answer as a fresh message**.

**Best practices for long tasks**: have the agent write full logs/reports to project files (`report.md`, `task.log`) and only post short progress + a final summary to Lark (cards have length limits); use `/status` for a non-destructive liveness check; use `/stop` to interrupt.

## Reply Display and COT

`/config` controls three presentation settings:

- **Message reply mode**: `message card` streams the final reply; `plain text` sends once after the run finishes.
- **Tool-call display**: controls whether tool blocks appear in the final card / markdown reply.
- **COT process message**: `off` sends only the final reply; `brief` first sends a COT message with agent progress text and tool summaries; `detailed` also includes tool args and truncated output.

When COT is enabled, the bridge splits the process view and final answer into two messages. The COT message is for tracing what the agent did; the final answer is still generated from the agent's raw text, without heuristic bridge-side filtering. If an agent emits final-answer text as ordinary stream text, that text can also appear in the COT process message.

## lark-cli identity policy

Each profile uses a profile-local lark-cli directory at `~/.lark-channel/profiles/<profile>/lark-cli`. The agent process receives `LARKSUITE_CLI_CONFIG_DIR` for that directory, so personal authorization in one profile is not shared with another profile.

The default policy is `bot-only`: lark-cli uses the app/bot identity and does not access personal resources. When a user authorizes personal resources such as calendar, mail, or drive, the current profile can switch to `user-default`, which keeps app identity available and also allows the authorized user identity. Owner/admin users can inspect or change this policy in `/config`; `/status` shows the current summary as `lark-cli: app` or `lark-cli: user-ready`.

## Working directories

Each profile may define a default working directory through `workspaces.default`. New profiles may be created with `--workspace <path>`; if omitted, the bridge creates a profile-managed default working directory.

This is a profile-field snippet. Do not replace the whole `config.json` with it; edit the matching profile's `workspaces` field.

```json
{
  "workspaces": {
    "default": "/Users/me/.lark-channel-workspaces/claude/default"
  }
}
```

The bridge checks that a selected directory exists, is a directory, and is not an overly broad location such as `/`, the home root, a system directory, or a temp root. The working directory is only the current directory for an agent run. It is not a filesystem sandbox; actual file access still depends on the local agent process and its permission mode.

## Permission modes

The recommended user-facing profile config is `permissions.defaultAccess` and `permissions.maxAccess`. New profiles default to `full` for both values so the bridge can keep local tools, authorization flows, file writes, and other agent features fully usable. To tighten a profile, set one or both values to `workspace` or `read-only`; stricter modes can limit local tool execution, login/authorization flows, file writes, and similar capabilities.

This is a profile-field snippet. Do not replace the whole `config.json` with it; edit the matching profile's `permissions` field.

```json
{
  "permissions": {
    "defaultAccess": "full",
    "maxAccess": "full"
  }
}
```

Mode mapping:

| Bridge access | Claude permission mode | Codex mode |
|---|---|---|
| `full` | `bypassPermissions` | `danger-full-access` |
| `workspace` | `acceptEdits` | `workspace-write` |
| `read-only` | `plan` | `read-only` |

The legacy `sandbox` field is still readable for old configs. After the bridge saves the profile, it migrates that setting to canonical `permissions`.

## Data directories

| Path | Content |
|---|---|
| `~/.lark-channel/config.json` | Root config with profiles and active profile |
| `~/.lark-channel/active-profile` | Last selected profile |
| `~/.lark-channel/profiles/<profile>/sessions.json` | Session state |
| `~/.lark-channel/profiles/<profile>/sessions.json.catalog.json` | Agent-aware session catalog |
| `~/.lark-channel/profiles/<profile>/workspaces.json` | Current and named workspace bindings |
| `~/.lark-channel/profiles/<profile>/secrets.enc` | Profile-local encrypted secrets |
| `~/.lark-channel/profiles/<profile>/lark-cli/` | Profile-local lark-cli directory |
| `~/.lark-channel/profiles/<profile>/media/` | Attachment cache |
| `~/.lark-channel/profiles/<profile>/logs/` | Structured run logs |
| `~/.lark-channel/registry/processes.json` | Local process registry |
| `~/.lark-channel/registry/locks/` | Profile and app locks |

Set `LARK_CHANNEL_HOME=/path/to/state` to move all local bridge state. `LARK_CHANNEL_LOG_DAYS` overrides log retention.

## Access control

**Chat access is private by default: out of the box, only *you* can use the bot in DMs and groups.** "You" = whoever created / owns the Feishu app (the person who scanned the QR to set it up). The bot figures out who the app owner is automatically from Feishu, so **solo chat use needs zero configuration** — you can DM it and `@`-mention it in any group, and everyone else's chat messages are silently ignored (no "permission denied" reply, which would only confirm the bot exists). Cloud-doc comments are document-scoped; see below.

To let other people or groups in, add them to one of three lists:

| List | Controls | Add | Remove |
|------|----------|-----|--------|
| **Allowed users** | who can DM the bot | `/invite user @them` | `/remove user @them` |
| **Allowed chats** | which groups the bot answers in (for **everyone** in them) | `/invite group` (current group) / `/invite all group` (every group the bot is in) | `/remove group` (current group) |
| **Admins** | who can change settings, and use the bot in any group | `/invite admin @them` | `/remove admin @them` |

> `/invite` and `/remove` can only be run by **you (the creator) and admins**. The `@` in the command points at the *target person* (not the bot) — the bot resolves the mention to their identity, so you never deal with raw IDs.

### Two identities that bypass everything

- **You (the creator)**: subject to no list at all — DMs, any group, every command. You **can never lock yourself out**: even if the lists get messed up, DM the bot and send `/config` to get back in. Transfer the app's ownership in the Feishu console and the bot follows the new owner automatically.
- **Admins**: can DM, run management commands like `/config`, and **bypass the allowed-chats list** — the bot answers them in any group, listed or not. Good for teammates who co-maintain the bot.

### Common setups

- **Just me** → nothing to do; this is the default.
- **Let a teammate DM the bot** → `/invite user @them`
- **Open a work group to everyone in it** → send `/invite group` inside that group
- **First-time setup, onboard every group the bot is already in** → `/invite all group` pulls them all into the list at once; trim with `/remove group` afterwards
- **Add a co-admin** → `/invite admin @them`

### Worth knowing

- Changes take effect on the **next message** — no restart needed.
- **In groups you must `@` the bot first** (DMs don't need it). That's a separate toggle (`/config` → "require @ in groups"), independent of the lists above.
- Strangers get pure silence — no reply at all. The one exception: if someone `@`-mentions the bot in a group that hasn't been opened up, the bot posts a friendly one-liner telling them an admin can run `/invite group` to enable it.
- Cloud-doc comments are document-scoped: anyone who can comment in a supported document and mention the bot can trigger a reply.

### Advanced: editing the config file directly

If you'd rather not do it inside Feishu, `/invite` and `/config` write the matching profile's `access` field in `~/.lark-channel/config.json`. Empty lists mean nobody from that list, not open access. This is a profile-field snippet; do not replace the whole `config.json` with it:

```json
{
  "schemaVersion": 2,
  "profiles": {
    "claude": {
      "agentKind": "claude",
      "access": {
        "allowedUsers": ["ou_xxxxxxxxxxxxx"],
        "allowedChats": ["oc_xxxxxxxxxxxxx"],
        "admins": ["ou_xxxxxxxxxxxxx"],
        "requireMentionInGroup": true
      }
    }
  }
}
```

`allowedUsers` / `admins` take user `open_id`s; `allowedChats` takes group `chat_id`s. The easiest way to find an ID by hand: have the person message the bot (or `@` it in the group), then check the active profile's log:

```bash
grep '"event":"enter"' ~/.lark-channel/profiles/<profile>/logs/bridge-$(date +%Y%m%d).jsonl | tail -5
```

Each line carries `chatId` (group / DM id) and `senderId` (user `open_id`). After a manual edit, **restart the bridge** or send `/reconnect` from an allowed admin context to apply it. For day-to-day tweaks `/invite` / `/config` are easier; direct edits are mainly for deployment scripts that pre-seed access.

## Cloud-doc comments

Cloud-doc comments do not need a separate workspace binding or document allowlist. In supported document comments, mention the bot and the bridge replies in the same thread. Comment runs reuse the document session key and fall back to the user home directory when no document cwd was previously recorded.

## FAQ

**The bot stays silent or the local CLI never replies.** Usually the local `claude` or `codex` CLI is not logged in, or the current session points to a working directory that no longer exists. Send `/status` to inspect; `/new` often fixes it by starting a fresh session.

**The agent subprocess looks frozen (card stuck on the last frame).** The bridge supports an idle watchdog: if the agent emits nothing for N minutes, the process is killed and the card is annotated with the auto-termination reason. Disabled by default. Enable with `/config` globally, or `/timeout 10` for the current session; `/timeout off` disables it for the session; `/timeout default` clears the session override.

**The agent says it cannot see an image I sent.** Upgrade to the latest version. Releases before 0.1.0 had a filename-dedup bug.

## Testing and CI

Local checks:

```bash
pnpm test
pnpm typecheck
pnpm build
```

`pnpm test` includes unit, integration, and process-level adapter tests. CI runs the source suite on macOS, Ubuntu, and Windows, then packs and globally installs the release tarball in isolated prefixes on Node 20, 22, and 24 with `pnpm test:package`.

## Optional telemetry

By default the bridge reports **nothing**: no metrics, no logs leave your machine, and it pulls in zero telemetry dependencies. The hook below is inert unless you opt in.

To wire up your own monitoring, point an environment variable at a module that default-exports (or exports `createAdapter`) an `AdapterFactory`:

```bash
LARK_CHANNEL_TELEMETRY_MODULE=your-telemetry-package arg-bridge start
```

That module receives every `log.*` event plus error/metric hooks and forwards them wherever you like. The interface is exported from the package root:

```ts
import type { AdapterFactory, TelemetryAdapter, TelemetryEvent } from 'arg-bridge';

const createAdapter: AdapterFactory = (meta) => ({
  emit(event) {/* ship event */},
  recordError(err, ctx) {/* ship exception */},
  recordMetric(name, value, tags) {/* ship metric */},
  flush(timeoutMs) {/* drain buffered events */},
});
export default createAdapter;
```

A missing module, a bad factory, or a throwing adapter all degrade to noop — telemetry can never stop the bridge from starting or break logging.

## License

[MIT](./LICENSE)

<img src="./assets/feedback-group-qr.png" alt="Feedback group QR code" width="360">
