# 主开发 Session Prompt：Codex Provider Resume 修复审查

```text
你负责审查并决定是否发布一个 Codex provider 切换后的 resume 修复。

仓库：Arginine-Arg/Feishu_bridge_arg
审查分支：review/codex-provider-resume
提交：3f533e188008552846418bb933a1fac6367284fa
基线：64a89102824be648d937412f65d081dcd13b82a8（v1.6.6）
目标分支：feature/structured-backends
交接包分支：review/codex-provider-resume-package
交接包：arg-bridge-codex-provider-resume-review.tar.gz

问题：Codex 会把 provider id 固化到旧 thread。cc-switch 切换活跃 provider 后，
App Server 先解析旧 provider id，再应用当前 config.toml，导致旧会话 resume 报
`Model provider <old-id> not found`。仅改环境变量、API key 或重启进程不能修复。

方案：在 App Server initialize 时捕获 codexHome；resume 前读取当前 config.toml
中的 model/model_provider（profile 优先）；把这些值作为 thread/resume 默认参数。
调用方显式覆盖仍然优先，权限重试路径保留默认值，不重写历史消息。

请你：
1. fetch 并审阅 review/codex-provider-resume，重点检查 rpc.codexHome 捕获、配置解析、参数优先级和权限重试。
2. 运行完整 CI（至少 typecheck、unit、process、build、diff check）；如可用，再跑平台 CI 和真实 cc-switch 验收。
3. 判断是否需要移植到最新版本、是否调整回退/诊断策略、是否接受已提交的 dist/cli.js。
4. 明确给出：通过 / 需修改 / 拒绝，并列出必须修改项。
5. 只有在你明确通过后才决定版本号、release note 和发布；当前分支没有创建 PR，也没有发布 Release。

请优先检查已经记录的风险：配置不可读时回退 openai、App Server 不返回 codexHome
时的默认 home 行为、多 CODEX_HOME 场景、以及完整测试覆盖是否足够。

请把审查结论按以下格式返回：
- 结论：通过 / 需修改 / 拒绝
- 阻塞问题：无，或逐条列出文件、行号和原因
- 非阻塞建议：无，或逐条列出
- 已执行验证：命令和结果
- 是否建议发布：是 / 否
- 如果发布：建议版本号、目标分支、release note 要点
```
