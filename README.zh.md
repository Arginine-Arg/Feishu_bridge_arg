# arg-bridge

把飞书 / Lark 消息和本地 Claude Code 或 Codex CLI 打通的轻量 bot。用一条命令启动，扫码绑定 PersonalAgent 应用，然后在飞书里和本机编程助手对话，让它读图、处理文件、改代码。

[English README](./README.md)

关于能实现的效果，详情可以阅读[飞书文档](https://larkcommunity.feishu.cn/docx/OaRIdFIRFoLM3xxTmKwcetHqn5e)

## 主要功能

- 在飞书私聊直接发消息，或在群里 `@bot`，把任务转给本机 Claude Code / Codex CLI。
- **流式卡片**：文本回复和工具调用实时更新在同一张卡片上。
- **COT 过程消息**：可选先发一条过程消息展示 agent 的阶段性文本和工具调用，再单独发送最终答案。
- **会话延续**：每个聊天、话题或文档评论有自己的会话，不会互相串。
- **常驻 tmux 执行**：每个 chat/topic 在 tmux 中运行一个原生 Claude/Codex CLI；普通消息和原生斜杠命令共享同一终端上下文。
- **排队与消息合并**：短时间连续发送的消息会合并处理；任务运行中收到的普通消息会排队到下一轮，`/new`、`/cd`、`/ws use`、`/stop` 这类命令可以中断当前任务。
- **多工作空间**：用 `/cd` 切换当前项目，用 `/ws` 保存和复用常用项目目录。
- **图片 / 文件**：直接发给 bot，bridge 下载到本地后交给本机 agent 处理。
- **卡片按钮**：`/help`、`/ws list`、`/status` 返回可点击的交互卡片。
- **交互提问桥接**：agent 的 `AskUserQuestion` / `ExitPlanMode` 会自动渲染成带按钮的飞书卡片，点击即可回答并续上会话。
- **长对话稳定性**：长流会在飞书自动关闭前续接到新卡片；卡片被撤回/失效时自动补发最终消息，忙时回执按时间限频而不是整轮静默。

## 前置条件

- Node.js **>= 20.12.0 且 < 25**。部署推荐 Node 22 LTS；生产机器不建议使用 Node 25 这类过新的非 LTS 版本。
- 本机至少安装并登录一个 agent：
  - Claude Code：`claude`，安装说明：https://docs.anthropic.com/en/docs/claude-code/quickstart
  - Codex CLI：`codex`，安装说明：https://developers.openai.com/codex/cli
- 一个飞书 / Lark PersonalAgent 应用。首次启动的扫码向导可以帮你创建并绑定。

## 安装

GitHub Release 是正式安装源。安装器会下载最新版本 tarball、校验 SHA256、清理失败安装留下的 npm 失效软链和可识别的旧版启动文件，并在禁用 npm lifecycle 脚本后完成全局安装：

```bash
curl -fsSL https://github.com/Arginine-Arg/Feishu_bridge_arg/releases/latest/download/install-global.sh | sh
arg-bridge --version
```

需要锁定版本或 npm 默认全局目录不可写时，可以这样安装：

```bash
curl -fsSL https://github.com/Arginine-Arg/Feishu_bridge_arg/releases/latest/download/install-global.sh -o /tmp/install-arg-bridge.sh
sh /tmp/install-arg-bridge.sh --version 0.6.12
# 无权写入 npm 默认全局目录时：
sh /tmp/install-arg-bridge.sh --prefix "$HOME/.local"
export PATH="$HOME/.local/bin:$PATH"
```

主命令是 `arg-bridge`，迁移期仍保留 `lark-channel-bridge` 兼容别名。Release 已包含预构建的 `dist/`，不再需要 clone、`git pull`、本地构建或手工猜 tarball 文件名。要求 Node.js >= 20.12 且 < 25，部署推荐 Node 22 LTS。

也可以手工下载稳定资产并校验后安装：

```bash
curl -fLO https://github.com/Arginine-Arg/Feishu_bridge_arg/releases/latest/download/arg-bridge.tgz
curl -fLO https://github.com/Arginine-Arg/Feishu_bridge_arg/releases/latest/download/arg-bridge.tgz.sha256
sha256sum -c arg-bridge.tgz.sha256
npm install -g --ignore-scripts --install-links=true ./arg-bridge.tgz
```

> 从源码开发：`pnpm install && pnpm build`。`npm pack` 会根据当前 checkout 的 `package.json` 版本生成文件名，必须使用它实际打印的文件名，不能假设本地已经是更新版本。
>
> **从原版迁移**:先用旧命令停止并注销旧服务：`lark-channel-bridge stop && lark-channel-bridge unregister`(每个 profile 都要),再按上面装本 fork,然后用 `arg-bridge start` 注册新后台服务。所有状态在 `~/.lark-channel/`,原样保留——同一个飞书 app、同一个 bot 自动重连,无需重新扫码。

## 安装排障

### 1. `npm pack` 生成了旧版本

`npm pack` 打包的是当前 checkout，不会读取下一条安装命令里写的版本。例如输出是 `arg-bridge@0.5.5` 和 `arg-bridge-0.5.5.tgz` 时，本地就没有 `arg-bridge-0.5.6.tgz`，随后安装这个不存在的文件必然得到 `ENOENT`。`git pull` 失败后源码不会自动更新。使用上面的 Release 安装器即可解除安装过程对 clone 状态和 `git pull` 网络的依赖。

### 2. 旧安装留下坏链或触发 `EEXIST`

npm 11 可能把 Git 全局安装链接到 `.npm/_cacache/tmp/git-clone*` 临时目录，并在安装结束后删掉该目录，表现为安装成功但命令随后失效。更早的 bridge 安装器也可能在全局 `bin` 目录留下普通启动文件，导致 npm 以 `EEXIST` 停止。Release 安装器会自动清理失效软链以及可识别为 arg-bridge 的旧启动文件。如果仍有另一个有效包占用命令名，再明确卸载旧包：

```bash
npm uninstall -g arg-bridge lark-channel-bridge
hash -r
```

npm 卸载不会删除 `~/.lark-channel/` 下的配置和会话。

### 3. 必须从 Git 安装时

优先使用 Release tarball。确实需要 Git 安装时，必须同时保留两个兼容参数并锁定 tag：

```bash
npm install -g --ignore-scripts --install-links=true \
  "git+https://github.com/Arginine-Arg/Feishu_bridge_arg.git#v0.6.12"
```

`--install-links=true` 防止 npm 11 把全局包保留为临时 Git clone 的软链；`--ignore-scripts` 避免依赖 lifecycle 出现 `spawn /bin/sh ENOENT`，arg-bridge 运行时不依赖这些依赖包的 postinstall。只能走 SSH 时，保留相同参数并使用 `git+ssh://git@github.com/Arginine-Arg/Feishu_bridge_arg.git#v0.6.12`。

### 4. Node 或 npm 全局目录错误

先确认当前 shell 调用的是预期 Node/npm：

```bash
node --version
npm --version
npm prefix -g
```

安装器会在修改全局安装前拒绝不支持的 Node 版本。npm 默认全局目录不可写时，使用 `--prefix "$HOME/.local"`。

### 5. PATH 和 shell 缓存

安装成功但 shell 找不到命令时，把安装器打印的 bin 目录加入 `PATH`：

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
hash -r
```

### 6. 验证安装

```bash
command -v arg-bridge
arg-bridge --help
arg-bridge --version
command -v lark-channel-bridge
```

## 来源说明

`arg-bridge` 保持与原 lark-channel bridge 的飞书/Lark 到本地 agent 桥接契约兼容，并将终端执行与消息路由拆分：Claude/Codex 在 tmux 中原生运行，bridge 只负责输入路由、输出观察和飞书卡片渲染。

## 首次启动

```bash
arg-bridge run
```

第一次运行会进入扫码向导：

1. 终端渲染二维码。
2. 用飞书 App 扫码。
3. 选择或创建 PersonalAgent 应用。
4. 如果终端提示，选择本次要初始化的 agent。
5. 成功后配置写入 `~/.lark-channel/config.json`。

没有指定项目目录也可以启动。bridge 会创建一个 profile 托管的默认工作目录；启动后在飞书里发送 `/cd <path>` 切到实际项目。

如果已经有 PersonalAgent app，可以在初始化时传 `--app-id` 跳过创建应用流程；命令会提示输入 App Secret。

```bash
arg-bridge run --app-id cli_xxx
# 或直接初始化并启动后台服务
arg-bridge start --app-id cli_xxx
```

Lark 国际版应用可加 `--tenant lark`。

## 后台运行

`run` 适合首次配置和前台调试。确认 bot 能正常收发消息后，先用 `Ctrl-C` 停掉前台进程，再用系统服务常驻后台：

```bash
arg-bridge start
arg-bridge status
arg-bridge stop
```

服务层命令必须先全局安装，不能直接用 `npx`。daemon 的 launchd plist / systemd unit / Windows 任务会记录 bridge CLI 的路径；如果这个路径来自 npm 临时缓存，缓存清掉后 daemon 就起不来。`run` 用 `npx` 单次启动没问题。

服务层命令按 profile 注册，每个 profile 有独立服务：

```bash
arg-bridge start [--profile <name>]
arg-bridge stop [--profile <name>]
arg-bridge restart [--profile <name>]
arg-bridge status [--profile <name>]
arg-bridge unregister [--profile <name>]
```

平台映射：
- **macOS**：launchd 用户代理 `ai.arg-bridge.bot.<profile>`
- **Linux**：systemd 用户单元 `arg-bridge.bot.<profile>.service`
- **Windows**：Task Scheduler 任务 `ArgBridge.Bot.<profile>`，launcher 是 `.cmd`

daemon 日志在 `~/.lark-channel/profiles/<profile>/logs/daemon/`。

### 多 profile：分别运行 Claude 和 Codex

默认情况下，bridge 使用当前激活的 profile；可以通过 `profile use <name>` 切换。每个 profile 会维护独立的应用凭据、会话、工作目录和日志。只有在需要同时连接多个 PersonalAgent 应用，或分别运行 Claude 和 Codex 时，才需要创建多个 profile：

```bash
arg-bridge start --profile claude --agent claude
arg-bridge start --profile codex --agent codex
```

例如只重启 Codex bot：

```bash
arg-bridge restart --profile codex
arg-bridge status --profile codex
```

## 命令速查

### 宿主 CLI

```text
arg-bridge run [--profile <name>] [--agent claude|codex] [--workspace <path>] [-c <config>]
arg-bridge migrate [--profile <name>] [--agent claude|codex]
arg-bridge ps
arg-bridge kill <id|#>
arg-bridge --help
```

`profile use <name>` 会切换后续默认启动使用的 profile。需要同时跑 Claude / Codex 两个 bot、连接多套 PersonalAgent 应用，或做脚本化部署时，再使用这些 profile 管理命令：

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

`profile remove` 默认归档本地状态，也可以删除当前激活的 profile。若还剩其他 profile，会自动切到下一个；若这是最后一个 profile，会清空 root config，之后可以用同名重新创建。只有加 `--purge --yes` 才会永久删除。`profile export` 默认脱敏 app secret；只有加 `--include-secrets --yes` 才会导出敏感配置。

如果某个 profile 被建成了错误的 agent 类型，先 `stop` 或 `unregister --profile <name>` 清理对应后台服务，再 `profile remove <name>`，然后用正确的 `--agent` 重新创建。

### 飞书内斜杠命令

| 命令 | 作用 |
|---|---|
| `/new`, `/reset` | 清空当前会话 |
| `/cd <path>` | 切换工作目录并重置会话 |
| `/ws list` | 列出命名工作空间 |
| `/ws save <name>` | 把当前工作目录保存为命名工作空间 |
| `/ws use <name>` | 切换到命名工作空间 |
| `/ws remove <name>` | 删除命名工作空间 |
| `/resume` | 恢复同 agent、工作目录、权限模式兼容的历史会话 |
| `/status` | 查看 profile、agent、工作目录、会话、lark-cli 身份和运行状态 |
| `/config` | 调整展示偏好、访问控制和 lark-cli 身份策略 |
| `/model` | 选择模型；Codex 直接使用 CLI 原生模型/reasoning 选项，并把结果同步到当前 profile |
| `/session [status\|live\|turn]` | 查看终端执行状态。tmux/live 为默认模式；`turn` 仅作为兼容回退 |
| `/invite user @某人` | 允许用户私聊使用 bot |
| `/invite admin @某人` | 添加访问控制管理员 |
| `/invite group` | 允许当前群使用 bot |
| `/invite all group` | 允许 bot 所在的所有群使用 |
| `/remove user @某人`, `/remove admin @某人`, `/remove group` | 移除访问控制条目 |
| `/stop` | 停止当前 run，也可点卡片停止按钮 |
| `/timeout [N\|off\|default]` | 设置或清除当前会话的 idle watchdog |
| `/ps` | 列出本机 bridge 进程 |
| `/exit <id\|#>` | 停止指定 bridge 进程 |
| `/reconnect` | 强制 WebSocket 重连 |
| `/doctor [描述]` | 执行低敏诊断 |
| `/help` | 帮助卡片 |

私聊不需要 @。群和话题群默认必须 `@bot`；`@all` 会被忽略。支持的云文档评论里 @bot 就会触发回复。

**直接使用 agent 自有命令**：终端执行已是默认行为。`/new`、`/cd`、`/status` 等 bridge 自己的命令仍由 bridge 处理，**未被 bridge 识别的斜杠命令会原样转发给当前 agent CLI**，包括 `/compact`、`/fast`、`/skills`、`/status`；选择器输出会变成带签名的飞书选择卡片。也可以显式写 `/claude /命令` 或 `/codex /命令`。`turn` 模式只保留给兼容回退。

## 执行与路由

tmux 只接收原始用户文本，不接收 bridge 的 XML 上下文或排版提示。Bridge Agent 可选调用 OpenAI 兼容的轻量模型，只生成路由和展示元数据；其输出会校验原始输入的 SHA-256，且没有改写 stdin 的字段。

同时设置以下三个变量可启用该可选分类器：

```bash
export ARG_BRIDGE_AGENT_ENDPOINT=https://example.invalid/v1
export ARG_BRIDGE_AGENT_MODEL=your-lightweight-model
export ARG_BRIDGE_AGENT_API_KEY=your-api-key
```

未设置时使用确定性的安全直通路由。

**交互式提问自动变卡片**：agent 调用 `AskUserQuestion`（多选一）或 `ExitPlanMode`（计划确认）时，bridge 会把它渲染成带按钮的飞书卡片；点按钮即可回答，你的选择会作为下一轮跟进消息续上会话。无需 agent 自己拼卡片。

## 长任务与稳定性

长对话 / 长任务不会因为"跑太久"被固定时限掐断,但有两种表现要知道(本 fork 已针对性优化):

- **消息排队(看起来没反应)**:同一个 chat / 话题已经有任务在跑时,你新发的普通消息**不会打断它,会排队**到当前任务结束后处理。忙时提示按 30 秒限频,所以稍后再次询问仍会收到存活回执,短时间连发又不会刷屏。只读的 `/status` 和 `/session status` 不会再清空已排队消息。**要立刻打断,发 `/stop`。**
- **流式卡片续接与失效降级**:飞书/Lark 会在约 10 分钟后自动关闭流式卡片。任务仍在运行时,bridge 每 8 分钟新建一张续接卡片；如果卡片被撤回或失效(飞书 `230011 withdrawn`),bridge 仍会继续消费 agent 输出,并**把完整答案作为一条全新消息补发**。

**长任务最佳实践**:

- 让 agent 把完整日志 / 报告写进项目文件(如 `report.md`、`task.log`),飞书里只发短进度和最终摘要——飞书卡片有长度上限,大量 stdout 塞进卡片会拖累稳定性。
- 想确认存活状态可发送 `/status`,它不会破坏排队中的普通消息。
- 打断当前任务用 `/stop`;其余新消息大概率只是排队。

## 回复展示与 COT

`/config` 可以调整三类展示选项：

- **消息回复方式**：`消息卡片` 流式更新最终回复；`纯文本` 在 run 完成后一次性发送。
- **工具调用显示**：控制最终回复卡片 / markdown 中是否展示工具块。
- **COT 过程消息**：`关闭` 只发送最终回复；`简略` 先用 COT 消息展示 agent 的过程文本和工具摘要；`详细` 还会展示工具参数和截断后的输出。

开启 COT 后，bridge 会把过程消息和最终答案拆成两条消息。过程消息用于追踪 agent 做了什么；最终答案仍由 agent 原始文本生成，bridge 不做启发式过滤。若 agent 把最终答案也作为普通流式文本输出，COT 过程消息中可能会出现对应片段。

## lark-cli 身份策略

每个 profile 都使用当前 profile 的 lark-cli 目录：`~/.lark-channel/profiles/<profile>/lark-cli`。agent 子进程会收到指向这个目录的 `LARKSUITE_CLI_CONFIG_DIR`，所以一个 profile 里的个人授权不会共享给另一个 profile。

默认策略是 `bot-only`：lark-cli 使用应用 / bot 身份，不访问个人资源。当用户为了日历、邮箱、云盘等个人资源完成授权后，当前 profile 可以切到 `user-default`，保留应用身份，同时允许已授权的用户身份。owner/admin 可以在 `/config` 查看或切换这个策略；`/status` 会用 `lark-cli: app` 或 `lark-cli: user-ready` 展示当前摘要。

## 工作目录

每个 profile 都可以有一个默认工作目录：`workspaces.default`。新建 profile 时可以传 `--workspace <path>` 作为初始目录；没传时 bridge 会创建一个 profile 托管的默认工作目录。

下面只是 profile 里的字段片段，不要整段覆盖 `config.json`；请改对应 profile 下的 `workspaces` 字段。

```json
{
  "workspaces": {
    "default": "/Users/me/.lark-channel-workspaces/claude/default"
  }
}
```

bridge 会检查所选目录存在、是目录，并且不是 `/`、Home 根、系统目录或临时目录根这类范围过大的位置。工作目录只是 agent run 的当前目录，不是文件系统 sandbox；agent 实际能访问哪些文件仍取决于本机 agent 进程及其权限模式。

## 权限模式

推荐给用户配置的是 `permissions.defaultAccess` 和 `permissions.maxAccess`。新 profile 默认两项都是 `full`，以保持 bridge 的本地工具、授权流程、文件写入等能力完整可用。如需收紧权限，可以改成 `workspace` 或 `read-only`；收紧后本地工具执行、登录 / 授权流程、文件写入等能力可能受限。

下面只是 profile 里的字段片段，不要整段覆盖 `config.json`；请改对应 profile 下的 `permissions` 字段。

```json
{
  "permissions": {
    "defaultAccess": "full",
    "maxAccess": "full"
  }
}
```

模式映射：

| Bridge access | Claude permission mode | Codex mode |
|---|---|---|
| `full` | `bypassPermissions` | `danger-full-access` |
| `workspace` | `acceptEdits` | `workspace-write` |
| `read-only` | `plan` | `read-only` |

旧版 `sandbox` 字段仍可读取。bridge 保存 profile 后，会把该设置迁移为 canonical `permissions`。

## 数据目录

| 路径 | 内容 |
|---|---|
| `~/.lark-channel/config.json` | root config，包含 profiles 和 active profile |
| `~/.lark-channel/active-profile` | 最近选择的 profile |
| `~/.lark-channel/profiles/<profile>/sessions.json` | 会话状态 |
| `~/.lark-channel/profiles/<profile>/sessions.json.catalog.json` | agent-aware 会话索引 |
| `~/.lark-channel/profiles/<profile>/workspaces.json` | 当前和命名工作空间绑定 |
| `~/.lark-channel/profiles/<profile>/secrets.enc` | profile 本地加密 secret |
| `~/.lark-channel/profiles/<profile>/lark-cli/` | 当前 profile 的 lark-cli 目录 |
| `~/.lark-channel/profiles/<profile>/media/` | 附件缓存 |
| `~/.lark-channel/profiles/<profile>/logs/` | 结构化运行日志 |
| `~/.lark-channel/registry/processes.json` | 本机进程注册表 |
| `~/.lark-channel/registry/locks/` | profile lock 和 app lock |

设置 `LARK_CHANNEL_HOME=/path/to/state` 可以迁移整棵本地状态目录。`LARK_CHANNEL_LOG_DAYS` 可以调整日志保留天数。

## 访问控制

**聊天访问默认是私有的：开箱即用时，只有"你"能在私聊和群聊里用这个 bot。** 这里的"你" = 创建 / 拥有这个飞书应用的人（也就是扫码把 bot 建起来的那位）。bot 会自动从飞书查出谁是应用 owner，所以**一个人用聊天入口完全不用配置**——你私聊它、在任意群里 @它都正常工作，其他人的聊天消息会被静默忽略（bot 不会回"你没权限"，免得暴露自己的存在）。云文档评论按文档权限生效，见下文。

想让别的同事或某些群也能用，就把他们加进下面三类名单：

| 名单 | 控制谁 | 加入 | 移除 |
|------|--------|------|------|
| **允许私聊的用户** | 谁可以私聊 bot | `/invite user @某人` | `/remove user @某人` |
| **响应的群** | bot 在哪些群里对**群内所有人**响应 | `/invite group`（当前群）/ `/invite all group`（bot 所在的全部群） | `/remove group`（当前群） |
| **管理员** | 谁能改设置、并能在任意群用 bot | `/invite admin @某人` | `/remove admin @某人` |

> `/invite`、`/remove` 这些命令只有**你（创建者）和管理员**能发。命令里 @ 的是**对方**（不是 @ bot），bot 会自动把 @ 解析成对应的人，你不用手动去找 ID。

### 两种"畅通无阻"的身份

- **你（创建者）**：不受任何名单限制——私聊、任意群、所有命令都能用，而且**永远锁不死自己**：哪怕名单配乱了，回到 bot 私聊发 `/config` 总能进来。在飞书后台把应用 owner 转给别人后，bot 也会自动跟着切换。
- **管理员**：能私聊、能用 `/config` 等管理命令，而且**不受"响应的群"名单限制**——无论群在不在名单里，bot 都会回他们。适合给一起维护 bot 的同事。

### 几种常见配置

- **只给自己用** → 什么都不用做，默认就是。
- **让某个同事能私聊 bot** → `/invite user @他`
- **让某个工作群里所有人都能用** → 在那个群里发 `/invite group`
- **第一次配，想把 bot 已经在的群一次性全开放** → 发 `/invite all group` 一键拉取 bot 所在的全部群加入名单，之后再用 `/remove group` 删掉不想要的
- **再拉个人一起当管理员** → `/invite admin @他`

### 还需要知道的

- 改完**下一条消息**就生效，不用重启。
- **群里默认要先 @bot 才会回**（私聊不用 @）。这是另一个独立开关（`/config` →"群里需要 @ bot"），和上面的名单是两回事。
- 陌生人发消息一律静默丢弃，不会有任何回复。唯一的例外：有人在一个还没开放的群里 @bot，bot 会回一句友好提示，告诉他可以让管理员发 `/invite group` 开放这个群。
- 云文档评论按文档权限生效：能在支持的文档里评论并 @bot 的人可以触发回复。

### 高级：直接改配置文件

不想在飞书里点的话，`/invite`、`/config` 背后写的是 `~/.lark-channel/config.json` 中对应 profile 的 `access` 字段。空白名单表示这个名单没人，不表示所有人都能用。下面只是 profile 里的字段片段，不要整段覆盖 `config.json`：

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

`allowedUsers` / `admins` 填用户 `open_id`，`allowedChats` 填群 `chat_id`。手动找 ID 最简单的办法：让对方给 bot 发条消息（群里就 @ 它一下），然后看当前 profile 的日志：

```bash
grep '"event":"enter"' ~/.lark-channel/profiles/<profile>/logs/bridge-$(date +%Y%m%d).jsonl | tail -5
```

每行都带 `chatId`（群 / 私聊 ID）和 `senderId`（用户 `open_id`）。手改完后**重启 bridge**，或在允许的 admin 上下文里发 `/reconnect` 让它生效。日常调整还是 `/invite` / `/config` 更省事，直接改文件主要用于部署脚本预填。

## 云文档评论

云文档评论不再需要单独绑定工作目录或维护文档白名单。支持的文档评论里 @bot 后，bridge 会在同一个评论线程里回复。评论运行复用文档级 session key；没有记录过文档 cwd 时回退到用户 home 目录。

## 常见问题

**bot 没反应 / agent 不回复**：通常是本机 `claude` 或 `codex` CLI 没登录，或者当前会话指向了不存在的工作目录。发 `/status` 看当前状态；`/new` 重开会话往往就好。

**agent 子进程假死（卡片停在最后一帧不动）**：支持 idle 探活。agent 一段时间没输出就会被 SIGTERM kill，卡片末尾会标出自动终止原因。默认关闭。开启方式：`/config` 设全局值（分钟），或 `/timeout 10` 只对当前会话生效；`/timeout off` 关掉当前会话的探活；`/timeout default` 清掉会话覆盖，回退到全局设置。

**图片发过去 agent 说看不到**：升级到最新版，0.1.0 之前的版本有文件名去重 bug。

## 测试与 CI

本地检查：

```bash
pnpm test
pnpm typecheck
pnpm build
```

`pnpm test` 包含 unit、integration 和 process-level adapter 测试。CI 会在 macOS、Ubuntu、Windows 上运行源码测试，并在 Node 20、22、24 下通过 `pnpm test:package` 把 release tarball 安装到隔离全局目录，验证真实安装结果。

## 可选：遥测（Telemetry）

默认情况下 bridge **不上报任何数据**：没有指标、没有日志离开你的机器，也不引入任何遥测依赖。下面这个钩子在你主动开启前完全是空操作。

想接自己的监控时，用环境变量指向一个 default export（或导出 `createAdapter`）`AdapterFactory` 的模块：

```bash
LARK_CHANNEL_TELEMETRY_MODULE=your-telemetry-package arg-bridge start
```

该模块会收到每一条 `log.*` 事件，以及错误 / 指标钩子，转发到任何你想要的地方。接口从包根导出：

```ts
import type { AdapterFactory, TelemetryAdapter, TelemetryEvent } from 'arg-bridge';

const createAdapter: AdapterFactory = (meta) => ({
  emit(event) {/* 上报事件 */},
  recordError(err, ctx) {/* 上报异常 */},
  recordMetric(name, value, tags) {/* 上报指标 */},
  flush(timeoutMs) {/* 冲刷缓冲事件 */},
});
export default createAdapter;
```

模块不存在、工厂函数不合法、或者 adapter 抛错，都会降级为空操作——遥测永远不会阻止 bridge 启动，也不会打断日志。

## 许可

[MIT](./LICENSE)

<img src="./assets/feedback-group-qr.png" alt="飞书反馈群二维码" width="360">
