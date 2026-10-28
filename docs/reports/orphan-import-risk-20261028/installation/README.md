# 本地插件更新完成：2.4.0+codex.20261028.2

用户授权“更新插件”后，通过既有 remote-debug-local marketplace 正式安装并保持启用
2.4.0+codex.20261028.2。安装目录：
/Users/zhengchenchen/.codex/plugins/cache/remote-debug-local/remote-debug-agent/2.4.0+codex.20261028.2。

100 个安装文件与仓库完全一致，26 项 runtime SHA-256 核验通过；runtimeId 为
2.4.0:dd6590b6d124997ae5c99a03061d7eee9d20ba0110643e4e91f0a9d9dc920497。
安装版 launch --check 的 7 项检查全部 pass，使用一次性目录及空连接配置。
独立 launch stdio initialize 返回 .2，tools/list 为 53 项，包含 prepare_orphan_risk、
inspect_orphan_risk、consume_orphan_risk；握手使用显式空闲地址禁用 Manager 预热，
仅 initialize/tools/list，没有附加真实保护 context 或调用真实业务工具。

安装包实际 MCP、source/bundled Manager 和 installed privacy Worker 的隔离测试 2/2 通过。
只读挂载原 TestFlow 源码快照及新安装目录，network none、私有 tmpfs，使用合成 Mongo/SSH
和原生身份验证替身、独立临时账户及 SQLite。测试覆盖独立管理员/native 验证、取消/伪造拒绝、
单次准备、Manager 内部回执伪造拒绝、独立业务确认及回滚、原 unresolved/unknown 保持。
适配仅替换固定导入/安装目录和 MCP pluginRoot，原断言未变；来源哈希见 installed-test-adapter.json。
这不是对真实九项的操作，也不是新的 TestFlow 回归证据。

更新前已核验 307 个源码/runtime/测试文件与上一轮通过的 TestFlow 快照完全相同。
本轮只修改 plugin.json.version 及 runtime-manifest.json.pluginVersion 发行元数据，
可执行内容无变化；沿用 TestFlow job 3b8ab78c-7ba5-4a70-9023-a66023817495 的 62/62，
及上级报告原生 45/45、浏览器证据。2149 个严格源码目标仍 unknown，没有升级覆盖结论。
本轮发行快照由 TestFlow freeze 固定：
9be2ec245581b8501cd9fb944671e6048edfb9121a41b9f97899624c27d00487，
target contentHash=a216589afad60df349e06487481d57d8bfb1f55e56719026a0e2aed94c92fc41。
冻结、安装/哈希、启动检查与握手均不冒充业务测试通过。

Codex config.toml、config.env、instances.json 的字节哈希、长度和权限均未变；HTTP 凭据、
管理员账户和业务保护目录仅比较 stat 元数据，不导出凭据或复制业务上下文。
安装器清理旧缓存后，13 个旧版本、1048 个程序文件已从预备份恢复并逐文件核验，
供既有进程/聊天继续使用。程序备份不包含数据库、私密回执、密钥或上下文。

Codex CLI 起初因另一条 ponytail-local 指向不存在的 Windows 路径而无法列举插件源；
本轮命令只用临时 -c source 参数让其读取可用的本地 manifest，实际目标仍为 remote-debug-local。
该参数没有持久化，也没有修改或移除其他插件源。保存配置核验一致。

安装完成不等于当前聊天或后台已加载新能力。本轮没有重启既有 Manager/Worker，
现有运行进程的新版加载尚未验证；请重启 Codex 并打开新聊天后核对实际能力。
**真实 test-server/yennefer 的 9 项继续暂缓，聊天确认和插件更新都不构成风险批准或重派授权。**
没有真实 prepare/approve/consume/execute/rollback、远端部署、Git 提交或推送。

本目录为安装与保留性证据；环境启动报告及程序备份等完整本机材料位于：
/Users/zhengchenchen/Documents/Codex/2026-10-28/ssl-debug-agent-orphan-risk-install。
