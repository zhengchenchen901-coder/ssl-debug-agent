# default 沙盒配置：已完成

目标实例 default（8.209.117.139），production 分组，业务上下文 yenneferbak。已通过只读查询确认独立技术库尚无集合、账户和角色；原历史任务保留。密码由用户在 Dashboard 输入并保存，后续仅使用该最新值；不在对话、计划参数或本报告中展示密码。

用户首次提交账户配置后返回 SANDBOX_SETUP_FAILED。旧版本未保留原始数据库数字错误码，不能从旧日志唯一确定失败原因。新预检确认服务端为 MongoDB 4.2.25 复制集、业务连接配置为 secondary，生产驱动为 3.3.4。已修复账户管理命令的显式 primary 路由、直连从节点的写前拒绝及脱敏阶段诊断；专用管理连接选择 primary，业务连接读取偏好保持原样。

插件已安装 2.3.2+codex.20261015，runtimeId 为 `2.3.2:665cc164aa88e504dcf15c220947734d8e13dff1a0340fd000e83b6eb6c6597d`。Agent 258 项、插件 48 项通过；默认关闭的 2 个真实数据库集成入口及 Windows 实机安装/占用端口检查跳过。隔离诊断成功。原运行实例已通过受限重启工具恢复。

当前聊天未暴露新增账户工具，因此通过已安装插件的标准 MCP stdio 入口重新发现 tools/list 并调用 `remote_debug_prepare_sandbox_access` 准备计划；没有使用数据库脚本或直接调用私有 HTTP 数据库接口。准备仅写受保护的计划文件，不创建数据库账户。

## 账户计划

- setupId：`513c098a-a42e-4230-bcb7-ca569afeb2be`
- planHash：`ab5eb8dc8dd62f1493085140072d18e93eae8ebd7b2791410cdc3c5a33ef0ab9`
- 到期时间：2026-10-15 10:49:09（北京时间）
- 新建管理用户：`remote_debug_agent.rda_sandbox_manager_009acd5149226df1`，带本插件归属标记；只授予技术集合 find/remove。
- 新建固定管理/执行角色；给现有执行用户 root@admin 追加专用库的执行/初始化权限，保留原角色。
- 在 `/home/github/breBE/OD-Yennefer-BE-release/shared/config.json` 新增 remote_debug_manager 连接分组，原业务分组值保留。连接文件备份为 0600，更新后文件为 0600，保留属主/属组。
- 使用用户当前保存的密码，不重置其他既有账户。已有账户或角色不符合计划则停止。

完整公共计划：`default-sandbox-access-plan-2026-10-15.json`。

## 存储计划

- mutationId：`8104b40b-fc40-467e-a10b-f62d7475f20b`
- planHash：`e091c0225eb8ff7200ae5b9575c4f7c0dfbebe9c7337d5b3cf0c4a01479bcb7c`
- 新建 `remote_debug_agent.__remote_debug_bulk_receipts` 及固定 expiresAt 过期索引。
- 保持 `/var/lib/remote-debug-agent/bulk-jobs` 为 0700 并登记初始化状态；既有历史任务与旧业务库技术集合保留。
- 该初始化不会修改业务文档；初始化资源会保留，不通过普通回滚删除。

完整计划：`default-sandbox-storage-plan-2026-10-15.json`。用户已明确确认两份计划，账户配置 completed；存储初始化于北京时间 2026-10-15 10:26:39 提交为 committed。


## 执行与核验结果

- 使用用户自行保存的密码完成独立管理账户及固定角色配置；只读查询确认管理账户仅持有专用管理角色，原执行账户角色保留并追加沙盒执行角色。
- 存储归属标记、专用库技术集合以及固定 `expiresAt: 1 / expireAfterSeconds: 0` 索引均已核验；初始化确认日志目录为 0700。
- 初始化前两次校验受业务连接 secondary 读偏好和新建元数据复制延迟影响。已先只读检查实际状态，再用同一已授权 mutationId/planHash 重试，最终 committed；没有删除重建资源。
- 通过公开 MCP `remote_debug_get_sandbox` 成功读取沙盒管理状态，管理连接权限校验通过；当前占用 41,878 字节，一条旧任务仍标记 legacy 并保留。
- default 与 test-server 均 running / healthy。此次未执行新的业务批量任务、未修改业务文档。
- 账户与存储的脱敏结果及只读核验证据：`default-sandbox-setup-result-2026-10-15.json`。
