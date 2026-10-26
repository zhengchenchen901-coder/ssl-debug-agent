# 本地插件更新（2026-10-26）

本轮用户明确要求“更新本地插件”。通过既有 `codex plugin add remote-debug-agent@remote-debug-local --json` 安装并启用 `2.4.0+codex.20261026`，不涉及远端发布或部署。

- 安装目录：`/Users/zhengchenchen/.codex/plugins/cache/remote-debug-local/remote-debug-agent/2.4.0+codex.20261026`。
- runtime：`2.4.0:27a5a96d6dc629a2621999040db40b289967e1dedc1ac1f2131625df39fd185f`，与前轮已验证修复的 runtime 一致；本轮只调整插件版本号和对应 manifest 的 pluginVersion。
- 已安装包当前环境检查的 7 项均 pass；26 个 runtime 文件哈希与 manifest 一致；MCP、保护存储、prepare 协议和数据库技能等 8 个包装层/说明文件与源码字节一致。
- 新安装目录的独立 MCP 实际完成 initialize、tools/list、get_capabilities、list_instances。握手版本正确，工具 50 个，包含 recover_operation。
- 更新前两个本地 Worker 都健康，活动操作、队列和资源任务均为 0。安装后 Desktop 自动将 Manager 从 PID 63991 切换到 PID 64244，新 Manager runtime 与修复一致；两个本地 Worker 进入 stopped。
- 按 restart-instance 技能先读取公开权威生命周期策略，再通过新安装 MCP 对 default、test-server 各恢复一次。最终 default PID 64578、test-server PID 64581，均 running/healthy；活动操作、队列和任务仍为 0。没有重启远端主机或业务服务。
- config.env、HTTP 凭据文件、实例配置和 Codex config.toml 四项哈希与升级前一致。没有接触原 MongoDB intent，没有 execute_bulk 或其他业务数据库写入，也没有 Git 提交/推送/PR。

CLI 安装时清理了旧版本缓存。旧运行包从 Git `0596e6a` 重建，26 个 runtime 文件均与更新前已验证的旧 manifest 哈希一致，备份在 `/Users/zhengchenchen/.codex/plugins/backups/remote-debug-before-bulk-update-20261026/plugins/remote-debug-agent`；未复制受保护上下文或凭据。

全局 marketplace/list 被既有 ponytail-local Windows 路径配置阻塞；精确安装 remote-debug-local 成功，没有更改该无关配置。

当前聊天或其他既有聊天仍可能保留旧 MCP 进程和技能路径；请重新加载聊天或新建聊天以确保使用新包装层。独立新 MCP 的握手成功不代表所有旧聊天的工具注入已经刷新。

这是安装后的环境、完整性和 MCP 实际连通性核验，没有新跑 TestFlow E2E，也没有把安装成功提升为生产业务恢复通过。原历史 intent 仍须按主报告的证据要求处理，不能因升级完成便重放补偿。前轮 TestFlow 快照/原生测试证据保留其原固定输入；本轮版本元数据变化由本安装回执另行记录。

结构化证据：[installation.json](installation.json)。原始本地检查脚本和回执位于 `ssl-debug-output/mongodb-bulk-recovery-20261026/install/`。
