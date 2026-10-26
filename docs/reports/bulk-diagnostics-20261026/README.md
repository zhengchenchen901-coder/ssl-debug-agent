# ZCIVO 批量任务详细诊断输出（本地实现，未安装）

后续更新：用户已授权并完成 `.6` 本地插件安装，当前共享运行态仍需重启 Codex 切换。以下正文保留安装前的验证状态；最新结果见 [安装报告](installation/README.md)。

本轮按用户最新要求先补齐详细输出，等待用户以后重试获得真实失败证据。观测改动已完成；ZCIVO 两次执行失败的业务根因仍 unknown，未将本地注入的故障当成真实根因。本会话没有再次查询或修改真实任务状态。

## 输出与读取

- `remote_debug_mongodb_get_bulk_job` 返回持久化的 `lastFailure`。
- `remote_debug_export_sandbox_log` 保留 `batch_failed`、`paused` 事件中的 `failure`。
- 本地审计增加 `mongodb-bulk-background` 失败事件；读取 job 的审计也保留 `lastFailure`。已补齐 audit.js 白名单及 MCP 的闭合输出契约，防止新增字段在出口再次丢失。
- 失败信息包含原生数值/结构化 code、异常类型、脱敏 message、时间、layer、phase、batchIndex、子操作 operationId、发起执行/恢复的 parentOperationId、恢复分类、outcome、必要 cause 和回执核验异常。可获得时增加 MongoDB driver/Node 版本、集合序号/操作数及限定为 helper 函数的调用位置。
- 阶段区分调度等待、dispatch、连接、回执查询、事务启动、前镜像检查、业务写入、后镜像读取、后镜像日志、回执写入、退役检查、commit。helper 在原始失败点先保存诊断，即使回包丢失也保留证据；相同 operationId 的传输层通用错误不覆盖更具体的 helper 诊断。
- 后台操作使用独立的 operationId 和截止时间，并关联发起请求；修复 dispatch 抛错跳过资源等待清理的路径。

不会输出原始 before-image、业务文档、电话号码、URI、凭据、context capability、业务引用映射或完整堆栈。源码固定消息可原样保留；常见驱动/JavaScript 消息保留安全类别，任意未识别文本只输出已脱敏的占位与指纹。此处的“详细”不代表允许导出包含隐私的原始异常。若仍不足以定位，应基于新阶段/位置/版本制定下一步受控诊断，不能凭指纹猜测原文。

`unknown` 不升级为安全失败。提交回复丢失且无法精确读取回执时仍为 `MONGODB_BULK_COMMIT_UNKNOWN` / `outcome=unknown` / `recovery=reconcile_exact_receipt`；只有当前事务提交前明确 abort 成功才记录该次尝试 `not_committed`，不推断历史任务结果。恢复后保留旧 lastFailure 作为历史诊断，不能将它误认为当前状态仍失败。

## 验证及证据

证据ID：`bulk-diagnostics-local-20261026`。详情见 [evidence.json](evidence.json)。

- 独立 Docker / network=none 的诊断、批量、sandbox、审计、MCP/隐私契约和 runtime-support 回归：72 通过，0 失败，0 跳过。
- 独立 Docker / network=none 的 HTTP 批量及异常出口定向验证：4 通过，0 失败，0 跳过。
- 一次性本地 MongoDB 4.4.30 副本集，Node22 + driver3.3.4，secondary URI 的现有真实跨集合事务/回执对账/冲突/回滚集成：1 通过。仅本地合成数据，未复现真实 ZCIVO 故障，未证明生产兼容性已全部覆盖。本次容器已停止并删除。
- 故障注入覆盖回执写入失败、隐私脱敏、job/events/audit 可读、跨 runner 同计划恢复、已提交但回执暂不可读时保持 unknown 并不重复加值、dispatch 失败清理、资源等待失败及传输异常。
- 扩展 Docker 尝试为 79 通过、1 失败：`manager API includes memory and updates it from proxied tool results` 在 server.test.js:935 得到 HTTP409，预期200。未修复或证明与本改动无关；保留失败日志，不把扩展套件称为通过。
- 本地 runtime 构建成功；源码和打包哈希在 evidence.json。没有创建 Git 提交。

TestFlow doctor 检查了本项目配置，使用工作区快照 `059bd9d34d4c75a883aa71584f71b869d1874899cfe840cb1f36b980adda5bb0` 固定实现及已有未提交改动。本项目 adapter=`node-test`，当前 TestFlow 执行仅支持 be-jest/jest-unit，并缺少匹配资产、输入/状态/断言绑定和执行隔离契约，因此没有 prepare/execute、没有测试 jobId，TestFlow 目标覆盖 unknown。上述 Docker/node:test 为单独明确标记的本地验证，不能当作 TestFlow 通过。补齐原生 node:test 适配器或正式匹配的版本化执行绑定后，才可做 TestFlow 执行验收。

未执行完整 34 单元/100 操作的合成形状与整个人工风险替代生命周期联测；用户已将本阶段调整为先补日志。既有真实集成不是这种完整形状。真实故障根因、升级后生产生效、真实提交/验证结果均未覆盖或未知。

## 使输出生效与后续分析

当前仅修改本地仓库及重新构建仓库内 runtime，保留既有 plugin.json 的版本变更、安装报告及其他任务成果。未安装/启用插件，未更新运行中的 Manager/worker，未部署或重启远端业务服务，未提交/推送/创建PR。因此直接用当前已安装版本重试，仍可能只得到旧通用错误码。

之后需单独授权更新本地已安装插件及其运行时，并核验运行时哈希及 MCP 输出契约同时更新；不得只更新前端契约或只替换后台源码。保持原配置、受保护 context、SQLite/意图记录、bulkRoot、原计划/回执、定向退役记录和 lineage 不变，不创建替代 job，不重传不同输入，不清锁或保护，不从安装过程自动执行任务。仓库生成 runtimeId 为 `2.4.0:40ba35f35da267d1293d79ae028382f2e671419a3b9aa4821a185323d8d689e1`。

在用户以后明确发起真实恢复时，仅针对同一 `default / yenneferbak`、jobId=`432f9201-2933-4c77-afe1-675c9446a497`、planHash=`b68c679dc01a6429f4d96e5fb78efbe95f19a14798f225ee8d86b64201df8eec`，先读取当时状态/租约/精确回执，再按既有正式恢复流程操作。保留原历史 unknown、原任务退役及保护边界。若失败，保存新 lastFailure、关联事件和审计，先分析 phase/code/cause/调用位置，不连续盲目重试。
