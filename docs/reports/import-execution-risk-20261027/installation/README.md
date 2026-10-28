# 本地插件更新完成：2.4.0+codex.20261027.4

2026-10-27（Asia/Shanghai）。用户授权“更新本地插件”后，通过既有本地 marketplace 的 `codex plugin add remote-debug-agent@remote-debug-local --json` 正式安装并保持启用 `.4`。发行元数据和生成的 runtime 改动留在本地，没有 Git 提交、推送或发布。

安装目录：`/Users/zhengchenchen/.codex/plugins/cache/remote-debug-local/remote-debug-agent/2.4.0+codex.20261027.4`。

runtimeId：`2.4.0:fdef92d75b30857ce31fc6fe4a24148e7eaaa988fc4515bc5acaa01bf1859053`。采用本次已验证候选的相同可执行文件，仅更新发行元数据。96个安装文件与仓库一致，26个runtime清单哈希一致。独立从安装目录启动的 MCP initialize 返回 `.4`，tools/list为52项，disposition包含 prepare_execution_risk、inspect_execution_risk、continue_execution 三个模式。launch --check 的全部8项通过。

保留性核验确认 Codex config.toml、插件 config.env、instances.json 的字节哈希、长度和权限均未变化；HTTP凭据、管理员账户和业务保护目录只比较stat元数据，未导出内容或复制业务上下文。安装器清理旧缓存后，11个旧版本、855个程序文件全部恢复并逐文件核验，供既有聊天继续使用。没有备份数据库、密钥或凭据到程序备份。

**安装不等于后台已加载新能力。** 当前Manager PID29676仍运行旧runtime `2.4.0:925bf7f1718686c6de1a5975485ac91a4ddbd35164824db514445ee4d704c85f`，与更新前一致。只读现场返回 test-server Worker PID31110 running/healthy、default stopped。本轮没有替换Manager、刷新Worker、挂接真实业务context或调用任何Mongo业务工具。要让后续聊天和后台加载新版本，应先结束活跃操作，再重启Codex并打开新聊天；届时仍需核对Manager/目标Worker实际runtime，不能只凭客户端版本判定已生效。

安装核验仅调用本地只读 capabilities/list_instances；没有真实风险批准、任务创建、execute、rollback或远端部署。沿用本次业务候选的 TestFlow pilot 1/1、regression 39/39、补充原生419/419、Mongo4.2/4.4各1/1及浏览器证据；1634严格目标unknown保留，没有把安装检查冒充新业务测试。

TestFlow为发行工作区固定snapshotId `8f8eb9ba8f71e4fc40d09478ab746f76ed5defa2cdcd714fdaa0b741c518133c`，captureVerified=true。对原621个被测文件核验，变化仅限发行manifest及已验证候选的生成runtime，业务源文件不变。此freeze不表示新业务测试通过。

本目录保存安装、完整性、保留性、环境及只读握手摘要。程序备份和原始记录在 `/Users/zhengchenchen/Documents/Codex/2026-10-27/ssl-debug-agent-execution-risk-install`。开发及真实任务接续边界见上级报告；安装后仍须独立工作台审批和新计划的单独业务确认。
