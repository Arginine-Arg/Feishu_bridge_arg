# >>> arg-bridge: codex provider wrapper (v2.1) >>>
# 目的：bridge 之外自己开的 codex 也能在第三方 provider 下正常工作。
#
# 1) 第三方 provider：从 config.toml 取 experimental_bearer_token，取不到再回退 auth.json，
#    并把本机回环代理临时摘掉（国内中转站走本地 clash 端口通常不通）。
# 2) 官方 provider：完全不干预，clash 代理和 auth 保持不变。
# 3) 共享 App Server daemon（codex 0.155+ 的 ^codex agents 后台）带着空环境在跑时，
#    停掉它，让 codex 用当前环境重新拉起。判定只认三件事同时成立：属主是当前用户、
#    命令行同时含 codex / app-server / code-mode-host，并且它的环境确实读到了空
#    OPENAI_API_KEY。env 读不到（别人的会话/权限不足）一律不动。
#
# 只影响交互式 shell 里手敲的 codex；arg-bridge 拉起 codex 走直接 spawn，
# 不经过 shell 函数，因此两者互不干扰。

codex() {
    local cfg="$HOME/.codex/config.toml"
    local auth="$HOME/.codex/auth.json"
    local provider="" token="" k
    local proxy_keys=(http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY)
    local key_before="${OPENAI_API_KEY-}" key_had=0
    [ -n "${OPENAI_API_KEY+x}" ] && key_had=1
    local -A proxy_saved=()

    [ -f "$cfg" ] && provider=$(grep -oP '^\s*model_provider\s*=\s*"\K[^"]+' "$cfg" 2>/dev/null | head -1)

    if [ -n "$provider" ] && [ "$provider" != "openai" ]; then
        [ -f "$cfg" ] && token=$(grep -oP '^\s*experimental_bearer_token\s*=\s*"\K[^"]+' "$cfg" 2>/dev/null | head -1)
        if [ -z "$token" ] && [ -f "$auth" ]; then
            token=$(grep -oP '"OPENAI_API_KEY"\s*:\s*"\K[^"]+' "$auth" 2>/dev/null | head -1)
            [ -z "$token" ] && token=$(grep -oP '"sk-[^"]{10,}"' "$auth" 2>/dev/null | head -1 | tr -d '"')
        fi

        for k in "${proxy_keys[@]}"; do
            [ -n "${!k+x}" ] && proxy_saved[$k]="${!k}"
        done
        unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY

        if [ -n "$token" ]; then
            export OPENAI_API_KEY="$token"
        elif [ -z "$key_before" ]; then
            printf 'codex wrapper: 未找到第三方 provider 的 token，请检查 %s 或 %s\n' "$cfg" "$auth" >&2
        fi

        # 只清理「自己所有 + 确认 key 为空」的共享 daemon。
        local dpid dkey dreason
        while IFS=$'\t' read -r dpid dkey dreason; do
            [ -z "$dpid" ] && continue
            [ "$dreason" = "empty" ] || continue
            printf 'codex wrapper: 共享 App Server 缺少凭据（PID %s），正在停掉它；codex 会按当前配置重新拉起\n' "$dpid" >&2
            kill -TERM "$dpid" 2>/dev/null
        done < <(__codex_shared_daemons)
    fi

    command codex "$@"
    local ret=$?

    if [ "$key_had" = "1" ]; then export OPENAI_API_KEY="$key_before"; else unset OPENAI_API_KEY; fi
    for k in "${!proxy_saved[@]}"; do export "$k=${proxy_saved[$k]}"; done
    return $ret
}

# codex-daemon-status：只读检查当前用户的共享 daemon
codex-daemon-status() {
    local key dpid dkey dreason found=0
    key=$(grep -oP '^\s*experimental_bearer_token\s*=\s*"\K[^"]+' "$HOME/.codex/config.toml" 2>/dev/null | head -1)
    while IFS=$'\t' read -r dpid dkey dreason; do
        [ -z "$dpid" ] && continue
        found=1
        if [ "$dreason" = "empty" ]; then
            printf 'PID %s: 缺少 OPENAI_API_KEY（会被 wrapper 清理）\n' "$dpid"
        elif [ -n "$key" ] && [ "${dkey#OPENAI_API_KEY=}" = "$key" ]; then
            printf 'PID %s: key 与当前 config 一致\n' "$dpid"
        else
            printf 'PID %s: %s（与当前 config 不一致，但不为空，wrapper 不动它）\n' "$dpid" "${dkey:-OPENAI_API_KEY=<未设置>}"
        fi
    done < <(__codex_shared_daemons)
    if [ "$found" = 0 ]; then echo "没有属于当前用户的共享 App Server daemon"; fi
    return 0
}

# codex-daemon-reset：显式停掉当前用户的共享 daemon 并清理残留 socket
codex-daemon-reset() {
    local dpid dkey dreason any=0
    while IFS=$'\t' read -r dpid dkey dreason; do
        [ -z "$dpid" ] && continue
        any=1
        kill -TERM "$dpid" 2>/dev/null && echo "已停止共享 daemon PID $dpid（$dreason）"
    done < <(__codex_shared_daemons)
    rm -f "$HOME/.codex/app-server-control/app-server-control.sock"
    [ "$any" = 0 ] && echo "没有属于当前用户的共享 daemon"
    echo "已清理共享 App Server 状态；下次运行 codex 会按当前 provider 重新拉起。"
}

# 内部：列出属于当前用户的共享 daemon，输出
#   "pid<TAB>OPENAI_API_KEY=<值><TAB>reason"
# reason: empty（确认 env 为空）/ keyed（env 有 key）/ unreadable（env 读不到，不处理）
__codex_shared_daemons() {
    node -e '
const fs = require("node:fs");
const uid = process.getuid ? process.getuid() : -1;
const self = String(process.ppid);
const rows = [];
for (const pid of fs.readdirSync("/proc")) {
  if (!/^[0-9]+$/.test(pid)) continue;
  if (pid === self) continue;
  if (uid >= 0) {
    try { if (fs.statSync("/proc/" + pid).uid !== uid) continue; } catch { continue; }
  }
  let cmd = "";
  try { cmd = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").replace(/\0/g, " ").trim(); }
  catch { continue; }
  if (!cmd) continue;
  if (!cmd.includes("codex") || !cmd.includes("app-server")) continue;
  if (!/code.?mode.?host/.test(cmd)) continue;
  let raw = null;
  try { raw = fs.readFileSync("/proc/" + pid + "/environ", "utf8"); } catch { raw = null; }
  if (raw === null) {
    rows.push(pid + "\tOPENAI_API_KEY=\tunreadable");
    continue;
  }
  const found = raw.split("\0").find((value) => value.startsWith("OPENAI_API_KEY="));
  const key = found && found !== "OPENAI_API_KEY=" ? found : "";
  rows.push(pid + "\t" + (key || "OPENAI_API_KEY=") + "\t" + (key ? "keyed" : "empty"));
}
process.stdout.write(rows.join("\n") + (rows.length ? "\n" : ""));
' 2>/dev/null || true
}
# <<< arg-bridge: codex provider wrapper (v2.1) <<<
