# 本地插件安装验证（2026-10-23）

用户明确授权更新本地插件后，通过既有 CLI 执行 `codex plugin add remote-debug-agent@remote-debug-local --json`，安装并启用 `2.4.0+codex.20261023`。

- 安装路径：`/Users/zhengchenchen/.codex/plugins/cache/remote-debug-local/remote-debug-agent/2.4.0+codex.20261023`。
- 旧插件备份：`/Users/zhengchenchen/.codex/plugins/backups/remote-debug-index-update-20261023-srb1xwmk`，没有备份或导出受保护上下文 capability。
- 安装目录的 22 个 runtime 文件全部通过 manifest SHA-256 校验，MCP 包装层、business-storage 与数据库技能与仓库一致。
- 新版已安装 MCP 实际完成 initialize、tools/list、get_capabilities 和 list_instances；版本为 `2.4.0+codex.20261023`，公开工具 50 个，包含 recover_operation。环境检查通过。
- 安装相关回归：14 项通过，0 失败；涵盖 runtime 解析、bundled Worker、prepare/execute 对账恢复。
- 升级前两个实例均无活动任务。Manager 已切换到 `2.4.0:26e3b2d2128ffdd0e579921cc384ad35588d68082e555c07be0fb23c91f44214`，PID `33467`。
- 旧 Manager 退出后，原先运行的 default / test-server 本地 Worker 均为 stopped。通过新版已安装插件公开 MCP 的受限 restart_instance 工具分别恢复一次，最终均为 running / healthy，当前无活动任务。没有重启远端主机或业务服务。
- Codex 配置、实例配置、config.env 与 HTTP 凭据文件四项哈希均与升级前一致；未改业务数据库、未重放历史索引、未触碰原 intent。16 项历史回执仍未决。
- 本次只更新版本标记和配套 runtime manifest，未执行 Git 提交或推送。

已有聊天可能仍持有旧 MCP 包装层；新会话会加载新安装版本。本次通过新安装路径启动的独立 MCP 握手验证不等于当前聊天的工具注入已经刷新。

证据：`installation-mcp.json`、`installation-state.json`、`installation-checks.tap`。原修复的全套和真实副本集回归结果见同目录 README.md。
