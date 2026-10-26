# ZCIVO 原历史 bulk 意图：正式入口与实际恢复结果

**原意图仍为 uncertain，现存 Manager/worker 材料不足以安全解除保护。** 本次已经实现、测试并安装正式历史入口，使用原受保护上下文和原输入实际处理了原 intent；没有只验证新请求。处理前后原保护记录的 keyed 指纹完全一致。

## 原意图的实际证据

| 项目 | 实际结果 |
| --- | --- |
| 原 intent | `f16dbcb7a1990113e38051e1aeb9d3fca9f46af4dcd5c7ae2f1ba8b3ec4e5b6d` |
| 原上下文 | `2d216fb3-3f02-48fc-bd05-e05026c4179d`，通过既有 protected-context 文件挂接；没有复制或输出 capability |
| 目标 | default / yenneferbak |
| 原 job / chunk | `37265270-8912-48c0-8c4d-2947a1cc6e41` / 0 |
| 原请求身份 | `requestMatched=true`：保护存储重新计算 keyed intent，确认原归档输入匹配原 intent |
| 原 MCP / worker 日志 | 找到同一 operation `babbe8ae-55d5-411a-9cee-2e92430c864c` 的开始、失败及 worker 校验拒绝记录 |
| 可信派发绑定 | 没有保留将该派发与原 intent、原始请求摘要关联的受信任回执；文本日志只有请求概览 |
| 精确远端证据读取 | `MONGODB_BULK_JOB_NOT_FOUND`，本次 operation `4d0b762b-6efb-43b2-a2cb-8780e7974fa1` |
| 最终状态 | `uncertain / legacy=true`，`historical_dispatch_evidence_required` |
| 原记录指纹 | 前后均为 `e74a375835b2d709f91efc58655c624448e06ce1f00737de179776be8b32f029` |

本次精确远端读取发生于北京时间 2026-10-26 12:17:28。它只查询同一 job/chunk 的技术文件，没有上传、准备或执行补偿。

原 default worker 的 `audit.jsonl` 第 2404 行保留 10:21:28 的 `MONGODB_BULK_FIELD_REJECTED`，layer=mongodb-bulk、phase=validation。MCP 的 `mcp-error.log` 第 12889、12890 行保留开始/失败记录，包含原 job/chunk/数量概览及同一 operationId。正式入口完整扫描了有界文件快照，两份扫描的 complete 均为 true。

这些日志足以佐证当时发生了校验拒绝，但不足以补造派发证明：旧 worker 审计白名单丢弃 jobId/chunkIndex，未持久化 intentId、请求摘要或显式未派发证明；MCP 也没有持久化这些保护绑定。旧保护记录只有 keyed 请求身份，缺少 prepare/dispatch ticket。原进程的 activity 只是内存环形缓冲，之前的进程退出后不能从现有持久材料重建。

**没有把“job 不存在”解释成“没有派发”。** 它仅说明本次没有读到完整的精确 chunk/manifest/plan 正证据。普通日志不能升级为正式回执，因此现有材料无法安全完成这个原意图的恢复闭环。

完整、脱敏的实际工具回执与远端审计增量：[original-intent-evidence.json](original-intent-evidence.json)。源归档文件 SHA-256 为 `6bc587f95035f17770443b168d6e27442500ef8b172df838a67fd92195610e28`；没有修改归档或 Excel，没有解码不透明引用，它们由原上下文的既有结构化机制恢复类型。

## 正式历史入口

扩展现有 `remote_debug_mongodb_recover_operation`，新增 `mode=historical`。继续显式指定 instanceId、database、原 intentId：

1. 不传 originalRequest 时，仅检查原 legacy bulk 记录、读取固定路径中的有界历史诊断，并返回保护记录指纹。它不上传，也不创建新的意图。
2. 传 originalRequest 时，将它视为**待核对的候选输入**。MCP 按旧 prepare 的线缆字段顺序重建参数，并只在原 business surfaces 中恢复 opaque 引用；Manager/保护存储核验原 keyed intent 身份。
3. 请求匹配且原始字节可验证时，Manager 只调用 worker 的内部 recover-prepare，核对原 job、chunkIndex、chunkHash、封口标志和精确封口 plan。只有完整正证据才能在原 intent 下正式记录 complete 及审计事件；仍然只是准备回执，不代表业务执行。
4. 错实例/数据库/请求/摘要、脱敏占位符或丢失的原始字节、缺文件、错 chunk/plan、未完成封口、普通日志和调用者自行提供的 result/notDispatched，均不能解除保护。证据不足时不写入原 operation 保护记录。

历史成功恢复保留原 intent/job/identity，不补造 bulkPrepare ticket，不创建替代 job。重复查询和重复恢复不重复上传或执行；内部 identity/result 动作不对调用者开放，结果和审计在同一 SQLite 事务内提交，提交失败保持原保护。

日志读取限 64 MiB / 200000 行，拒绝链接、不安全权限和超限文件；损坏行、尾部未完成记录、变化中的文件被报告为不完整/未知。输出只包含诊断元数据和每行哈希，不返回原日志文本。行哈希采用 UTF-8 行内容，不含换行符；不是日志签名，也不会被用作历史派发授权。

同时修正 MCP 公布的 expected 路径 schema，使它和既有 bulk normalizer 的安全数字索引契约一致；没有放宽业务执行、前镜像或原值检查。

## 实现与验证

源码主要位于 `agent/mongodb-bulk-history.js`、`agent/privacy-service.js`、`agent/privacy-store.js`、`agent/server.js` 以及插件的 MCP、privacy/storage、输出契约与 prepare 协议。已有安装版本元数据和报告改动均保留；没有创建 Git 提交、推送或 PR。

最终原生回归（Node 22.23.3，从各包目录运行 npm test）：

| 套件 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: |
| Agent | 479 | 0 | 14 |
| 插件 | 130 | 0 | 5 |
| 合计 | 609 | 0 | 19 |

新增历史测试使用旧协议真实创建的 encrypted-store envelope，没有修改既有保护行来模拟恢复。覆盖原 chunk/封口、原 intent 不变、Manager/PrivacyStore 重启后的缓存恢复、同 job/intent 改内容、错作用域、错回执、缺证据且指纹不变、普通/伪装日志不升级为证据、原始 credential 字节丢失及 REDACTED 碰撞、公共伪造结果拒绝、结果事务失败、typed opaque 引用、链接/权限/读取预算与残缺日志。source MCP + 实际 source/bundled Manager 路由和 source/bundled PrivacyStore 都已验证。旧 prepare/execute 回归也包含在完整套件内。

保留失败尝试：新增 Manager 测试最初误以为 MCP 日志不存在，但 MCP 会创建启动日志，已改为断言日志可读且历史候选为 0；smoke schema helper 最初把新增的可选 originalRequest 判为必填，已修正可选列表并增加历史 enum、必填集合和数字路径断言。最终完整套件均通过，没有更改业务断言来隐藏失败。

未执行/未知：19 项平台或环境条件用例跳过，包括 Windows、Keychain、显式真实 MongoDB 集成及特大日志；本轮没有新跑真实 MongoDB 业务事务，也没有宣称原业务余额/补偿流水已验收。历史正证据路径的远端固定 helper 在隔离 VM/文件/数据库夹具中验证，原 ZCIVO 缺证据路径则已在实际 default worker 上核验。文件扫描途中发生增长/替换等分支没有逐分支覆盖证明；完整块、分支和有序路径覆盖仍未知。

## TestFlow

已读取安装版技能，使用仓库外独立项目配置完成 doctor、未提交工作区 freeze 和最终 P1 分析，没有为了测试创建提交。

- snapshotId / workflowId：`e02c3db0837a8816cb0ed9a426f2f6b127b4143c49b4510e50043813c56f262c`
- P1 runId：`fd4ce435-e7be-4ade-b245-d7a796856e85`
- flowId：`1fbf0cc7-502d-4416-80a8-d7882c22fae4`
- fixedInputVerified=true，partial-static；已通过安装版 storage.readJson 核验完整 change-set、impact 分片和 manifest。

P1 的 720 个变化符号、5690 个受影响符号包含生成 runtime，不能当作执行覆盖分母。保留 unresolved-call、ambiguous-symbol-identity、cgb-not-configured、non-source-impact-unknown、broad-impact 诊断。

本项目仍是 node:test，没有登记可执行的 TestFlow node:test 适配器或版本化 jest-unit 资产/配置、执行绑定、生命周期/断言及项目依赖镜像契约。没有伪造绑定或改用部署验收，没有 prepare/execute jobId。上述原生测试和实际原意图调用均为补充证据，**不是 TestFlow E2E 通过**。

## 本地安装及交付边界

正式入口最终安装为 `2.4.0+codex.20261026.2`，runtime `2.4.0:e515098eb54c66b785b0de2a7a1fe1afa9f64192bf00fc85b69832d326c93dca`。已核验安装目录 26 个 runtime 文件哈希及包装层/技能与源码一致。为补齐脱敏字节边界，最终版本在首个历史补丁之后再次核验原 intent，结论及原记录指纹均未变化。

本地 Manager 运行于 PID 68707；default、test-server 均 running/healthy，无活动操作或排队。每次本地升级前均检查无活动工作，升级后通过公开的受限 restart_instance 恢复停止的本地 Worker，没有重启远端业务服务。config.env、HTTP 凭据、实例配置和 Codex config.toml 四项哈希均与处理前一致。旧运行包备份不含受保护上下文或凭据；CLI 自动清理旧缓存时，通过已核验的 Git 源码和既有版本元数据保存可回退的运行包。

本次只安装本地插件代码，未发布远端版本，未执行积分补回、原 year 配置、存储初始化、业务有效期修改或新增 52 笔处理。没有手改 SQLite/journal/锁，没有伪造原始回执或运行替代 job，也没有给其他聊天发送消息。

结构化交付：[verification.json](verification.json)。原 intent 目前必须继续保护；现有证据无法证明它可安全重放，不能仅因插件升级或这次历史诊断成功就继续补分。
