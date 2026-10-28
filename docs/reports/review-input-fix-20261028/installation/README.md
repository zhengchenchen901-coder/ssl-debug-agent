# 插件已更新并加载，5 项真实审核准备/读取完成

已安装并保持启用 **2.4.0+codex.20261028.3**。本轮用户授权“更新插件”，完成了此前因没有加载授权而阻塞的真实审核验收。

新 Manager PID **94821**，runtimeId `2.4.0:a703f5d11670e5fcba09091ca9ac1f2bce243390d6294a154a49a20099bb9a6a`；test-server 本地 Worker PID **95521**，running/healthy，default 保持 stopped。

5 项合计 **1215 条**，通过新版已安装 MCP 在原保护上下文逐项 prepare_orphan_risk 并 inspect_orphan_risk，全部返回 awaiting_human、humanApproved=false、unresolved/unknown、provesNotDispatched=false。审核准备不等于导入准备；本轮没有任何批准、consume 或业务写入。

|集合|条数|真实 riskPlanId|准备调用 operationId|读取调用 operationId|
|---|---:|---|---|---|
|Customer|71|efe475b9d23cfbe87994633db6b3aa85e3ba9f8eada9b634d399a23dcc4d8fd2|451292e8-074f-4df7-8e7f-ab5caa1a5300|82d35fe0-4fc2-4270-8912-54fc7012e5eb|
|RestaurantLog|29|2a6d94c16b1a6fd97d0dc7e5f54259b14a489ee4324bf6e2e644ca376763d1c3|b68ac3da-cea2-461d-8839-27972aaa1cf9|c0f5e6a6-301b-4923-a16e-ab67ce7a6b91|
|Res_EJPOH_Booking_Order_History|448|e081e127b4c67d511fd08115368dd3c88be40a8c5a9f75dae084ff16dccf8b81|f0cac78c-a513-435c-b785-ba09c5a61a33|bf787e32-3d52-4e5b-957b-8f50df18ee14|
|Res_EJPOH_Booking_Order_Log|176|cde15c3d25a3ae4fe110ad4990d5046af4ad32549a62e92854dab911c4aae915|6c54d0e2-1686-498f-89ce-31b425f8a0cb|40c71b68-2408-4cc4-b1d7-525bbeecbc65|
|tag_definitions|491|b4d82c5d4119ead2a6876f5b8298f2c85e8a0e862fa2720f145a53dce9a9e97a|a6785f0e-cdc0-4660-b960-f9c5957c0fc7|78d460cf-988d-4e3c-b648-9a4f0451fc54|

每项 reviewHash、原导入 operationId/importId/requestDigest、原候选、后续批次身份、状态与到期时间见 review-call-evidence.json；原响应见 real-review-verification.json。审核截止为 **2026-10-28 15:23:06–15:23:07（Asia/Shanghai）**，到期只能沿同身份重新审阅，不能继承旧批准或换候选。

## 身份及保护核验

沿用 context `87281bfb-b6f9-46a0-8a55-11ef57869d9e`，宿主环境挂接原 context 文件；没有读取/导出 capability、密钥或手工打开真实 SQLite。固定 final-input SHA-256 及原保留请求/协议摘要按上级报告逐项核验，原/候选数据和顺序未改；候选 ID 和 reviewMemo 均使用原失败请求已有值。

四项既有审核 SensitivityLog、WhatsappStatistics、Res_EJPOH_Coupon_Package、Res_EJPOH_Dish 前后均 consumed，reviewHash、approvalAuditId、consumptionAuditId 均未变化，未再次消费。Google 原 intent `5388d193402ef9f9826a47837aae7f57d51e91168d9025a565350458108e5354` 前后 inspect 均 uncertain，历史仍 unknown；未重派、清锁或回滚。700 条既有提交、664 条已准备暂缓以及身份冲突/跨餐厅边界没有改变。

成功响应未直接携带外层工具 operationId，因此用已脱敏 MCP 生命周期日志按**确切进程 PID 95520 + JSON-RPC requestId**匹配开始/完成事件，再与保存的调用顺序、成功响应及原绑定交叉核验。review-call-evidence.json 保存关联来源、原响应哈希和逐调用标识，不包含文档或凭据。

## 安装、加载与验证

102 个安装文件与仓库一致，26 项 runtime SHA-256 通过；安装入口的 7 项环境检查全部 pass。安装版实际 MCP + bundled Manager + bundled privacy Worker 的 network-none 容器测试 **1/1 通过**，其中逐项创建、重读 5 种合成形状并核验保密/未知保护。适配仅替换固定导入与安装目录，断言未变，不将它冒充 TestFlow 或真实业务数据证据。

312 个源码/runtime/测试文件与上一轮 TestFlow 通过快照一致；本轮仅调整 plugin.json.version 与 runtime-manifest.json.pluginVersion，未改变可执行内容。沿用 TestFlow job `103a04f8-fa80-4f6a-afb5-81f38e8b2aa4` 的 **71/71**、原生 **61/61**及浏览器结果；862 严格目标仍 unknown，未升级覆盖结论。发行输入由 TestFlow freeze 固定为 `99d37deef1459ced2aae708f61621c630f911440f646a335312100c7013bcc53`，target contentHash `4835c2783a78580436e8d232c1c7a6fab468a0d8c4275b3e14738ba40cb0df85`。

加载前核验 test-server 的 active、activeBusiness、activeControl、activeBackground、activeBulk、queued 均为 0。使用新安装 MCP 的正常 runtime 检测/启动流程替换旧 Manager；旧 runtime 由正常生命周期退出，没有绕过保护手工清理任务。新 Manager 加载后 test-server 为 stopped，按 restart-instance 技能先核验公开 capabilities 的生命周期策略和实例列表，再调用受限 restart 工具 **1 次**恢复。该动作仅恢复本地 SSH Worker，没有重启远端业务服务。随后公开列表返回 running/healthy，最终受管操作与队列均为 0。

安装器清理旧缓存前已只备份程序文件；14 个旧版本、1146 个文件全部恢复并逐文件核验，以保留既有聊天引用。config.toml、config.env、instances.json 的字节哈希/大小/权限未变；HTTP 凭据及管理员账户仅核验 stat 元数据且未变。保护目录保持原 inode 和权限；正常 Manager/SQLite 生命周期及受支持的新审核写入可能改变目录时间，不能把时间变化误当手工保护修改。

## 当前边界

本维护任务的安装、实际加载、5 项真实审核准备/读取已完成；下一步若用户选择接受风险，仍必须在独立管理员工作台登录、读取具体计划并完成新的原生系统身份验证。聊天和本报告都不批准风险；实际 consume、逐批业务执行或回滚仍需各自授权。本轮没有这些动作，也没有提交、推送、创建 PR 或远端发布/部署。

当前聊天的既有宿主工具绑定没有强制重建；本次证明来自新安装目录实际启动的独立 MCP 和真实 Manager/Worker。后续新聊天可加载新版工具，不能以旧会话工具表替代上述实际版本核验。

完整本机证据与程序备份：`/Users/zhengchenchen/Documents/Codex/2026-10-28/ssl-debug-agent-review-fix-install`。本目录保存安装、状态、保留性、调用标识和测试副本。

最终维护报告和验证摘要已保存到本地 test-server 最终交付物模块，taskId
`f7cb5f2e-6e7e-4e4f-909d-33ae7536fc24`，并已通过 get_final_result 重新读取核验。
这是维护任务的完成报告，不是人工风险批准或等待审批计划的发布；未增加业务授权。
