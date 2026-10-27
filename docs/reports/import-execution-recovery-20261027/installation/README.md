# 本地插件已更新，现有配置保留

2026-10-27（Asia/Shanghai）。用户明确授权“更新本地插件，保留现有配置”。通过既有本地 marketplace 正式执行 `codex plugin add remote-debug-agent@remote-debug-local --json`，安装并保持启用 `2.4.0+codex.20261027.3`。

安装路径：`/Users/zhengchenchen/.codex/plugins/cache/remote-debug-local/remote-debug-agent/2.4.0+codex.20261027.3`。

95个安装文件与仓库一致，26个runtime清单哈希全部一致。runtimeId仍为已验证的 `2.4.0:925bf7f1718686c6de1a5975485ac91a4ddbd35164824db514445ee4d704c85f`。对上一轮被测快照的584个文件逐一复核，仅plugin.json及生成的runtime-manifest.json发行元数据变化，没有修改可执行业务逻辑。因此沿用前轮TestFlow pilot 1/1、regression 31/31、补充原生401/401及真实Mongo 4.2.24/4.4.30各1/1证据，没有重复运行或冒称新的业务验收。原1306目标unknown保留。

安装版 launch.cjs --check 的 platform、node、manifest、artifacts、config、storage、private-storage 七项全部pass。实际从新安装目录启动的独立MCP initialize返回 `.3`，tools/list为52项，包含新增的 `remote_debug_mongodb_prepare_collection`。只调用本地只读的capabilities及list_instances，没有附加真实业务context或调用Mongo业务工具。

Codex config.toml、插件 config.env、实例 instances.json 三项的字节哈希、长度及权限均与更新前一致。保留性核验对HTTP凭据文件、管理员账户文件及业务保护目录只比较stat元数据；MCP握手沿用插件正常的本机HTTP认证，没有导出或复制凭据、账户内容或业务上下文。安装器清理了旧缓存；更新前备份的10个旧版本、760个程序文件已全部恢复并逐文件核验，供旧聊天继续使用。没有复制业务上下文、凭据、SQLite、任务计划或回执。

**安装完成不代表当前后台已切换。** 当前Manager PID11441仍加载旧runtime `2.4.0:11ac560dec7bef1fc01e6c3ef3e160d342cb28a46dae7d1c138df1568584e3c6`。default/test-server Worker仍分别为PID11964/PID27857，更新前后均running/healthy。独立握手使用受支持的显式本地URL，没有自动替换Manager或刷新健康Worker。需要重启Codex，并使用新聊天，让MCP及本地后台统一加载 `.3`；此次握手不能冒认当前聊天的工具注入已刷新。

未触碰真实导入、历史意图或业务数据库；没有远端部署、真实集合创建、导入重试、execute、rollback、风险批准、Git提交/推送/PR。用户在本次请求前已存在的基线提交 `d6707ddc8858d49f1071d1a92a96ef3d93de8a3e` 保留。

TestFlow仅固定本轮发行元数据工作区：snapshotId `c2c16fc17cbb5823452d1106e55e9ad050fbb34ca600b20f86656f55acbdb7b0`，captureVerified=true。此freeze、文件哈希、环境检查及MCP握手均为安装核验，不是新业务测试通过。

详细证据：本目录 install.json、integrity.json、preservation.json、runtime-state.json、environment-check.json、before/after-handshake.json及testflow-freeze.json。程序备份、安装脚本和原始记录保存在 `/Users/zhengchenchen/Documents/Codex/2026-10-27/ssl-debug-agent-import-execution-install`，未复制受保护业务数据。
