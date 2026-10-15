# Dashboard 密码字段恢复

重启后的检查发现运行包回退至 2.2.1。原因是前次 `plugin add` 只通过单次 `-c` 覆盖安装源；持久配置仍为 Git main，而该 Git 版本没有沙盒密码字段。

已备份 Codex 配置和旧插件到 `/Users/zhengchenchen/.codex/plugins/backups/remote-debug-source-fix-20261015`，将唯一的 `marketplaces.remote-debug-local` 配置块改为本地源码 `/Users/zhengchenchen/od-projects/ssl-debug-agent`，其余配置保留。连续不带覆盖参数的 `codex plugin add remote-debug-agent@remote-debug-local --json` 均确认安装 2.3.0+codex.20261014。

为当前仍绑定旧路径的 MCP 进程保留一个带说明文件的 2.3.0 兼容副本，避免需要再次重启才能读取新版 Manager；插件正式缓存仍为 2.3.0，下一次应用启动从持久本地安装源选择正式版本。兼容路径不能使用整个目录软链接：Node 会解析真实入口路径，入口判断会导致 Manager 在监听前退出，因此使用普通文件副本。

另修复隐藏缓存目录中的 Dashboard 首页 404：固定文件使用 `sendFile("dashboard.html", { root: publicDir })`，避免绝对路径中的 `.codex` 被 Express 当作隐藏文件拒绝。加入隐藏插件目录的预编译包首页回归测试。

验证：Agent 249 通过、2 个未启用的真实数据库集成入口跳过；插件 48 通过、Windows 实机安装及占用中的默认端口测试跳过。安装包 SHA-256 匹配；实际 Manager runtimeId 与安装包一致，为 `2.3.0:83dca5cb2b6edc0f30d07649866320ef290830f2fad2c5c8562078f962f04bae`。

通过已有 MCP 读取实例列表，确认 default/test-server 均为已停止状态。本轮未启动实例或修改远端数据库。实际打开 `http://127.0.0.1:4343/`，解锁后进入 test-server 的编辑表单，确认“沙盒管理账户密码（仅当前实例）”可见，位于“沙盒管理连接配置名”下方。没有填写、保存或修改任何密码。
