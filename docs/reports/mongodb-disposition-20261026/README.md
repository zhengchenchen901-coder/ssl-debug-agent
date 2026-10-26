> 本报告记录第一轮仅本地隔离的实现。后续人工风险处置与替代创建实现见 [新增报告](../mongodb-risk-replacement-20261026/README.md)；本报告中的“没有成功分支”不再描述最新源码。真实执行端迁移仍未实施。

# MongoDB 未知意图的审阅、隔离与替代拒绝门禁

本地补丁提供公开 MCP `remote_debug_mongodb_disposition`，实现可审阅、持久化、原子并发安全的**本地隔离**及替代准入拒绝。它没有实现可证明覆盖旧执行端的永久取消，也没有任何替代准入成功分支。本案历史证据缺口没有因此消失；不能把此交付理解为补分已经可以继续。

## 为什么不返回 cancelled

当前 Worker 经 SSH 发送独立 helper 的源码。旧进程、队列及已经序列化的旧脚本不执行新增的撤销检查；新增一个版本字段、文件 tombstone、暂停或新 helper 的自报能力，都不能证明旧执行路径已被强制封闭。原 legacy 记录还缺失可信绑定的原 operation/chunk/plan 及历史派发材料。此次开发没有足够依据实现安全的历史未执行证明或永久撤销确认。

因此当前实现始终保留 `remoteFenceConfirmed=false`、`historicalOutcome=unknown`、`replacementAllowed=false`。`admit_replacement` 的实际结果只能为 `admission=blocked`，并持久保存独立拒绝审计。它不生成新 job、准入 ticket 或“已取消”终态，没有风险接管或隐藏强制清除参数。

## 已实现契约

| mode | 输入及作用 | 结果 |
| --- | --- | --- |
| prepare | 显式 instanceId/database，原 context 中的 intentId、精确 originalRequest；只核对本地原记录 | 生成 dispositionId/reviewHash、24小时审阅期限、原记录指纹、绑定和具体缺口；不做远端调用 |
| inspect | 同 context/target 的 dispositionId | 读取原处置审计状态，不重新扫描旧日志 |
| quarantine | 精确 dispositionId/reviewHash，单独确认 `确认隔离原意图` | 在一个 `BEGIN IMMEDIATE` 中保存独立处置状态、永久 pin 的实例准入 hold 与审计；原 uncertain 记录完全不改 |
| admit_replacement | 精确 dispositionId/reviewHash | 幂等保存拒绝审计；不调用 worker、不派发、不上传、不执行、不准入 |

绑定包括原 contextId、验证过的 target scope、instance/database、intent、重新计算的原请求 digest、原记录中已经存在的 operationId、job/chunk/hash/plan 身份。缺失字段返回 null 及 `original_*_unbound`，不会从聊天中的 ID、诊断日志、缺失 job 或调用者 proof 补造。精确请求经过旧 prepare 字段顺序及 typed opaque 引用恢复，再以原 keyed identity 核对；有 credential 脱敏丢字节或 REDACTED 占位符时拒绝审阅。

quarantine 的审阅范围明确为 `instance_all_mongodb_write_admissions`：它会阻断新版 Manager 对该实例的全部新 MongoDB 写入准入，包括不同 context、数据库、job、普通 mutation/import、bulk execute/resume/rollback，以及远端 sandbox cleanup。范围宽于单个 job，必须单独审阅；开发授权或原业务补分授权都不等于隔离整实例的授权。本轮只对临时夹具执行此流程。

检查覆盖两个本地边界：保护存储创建新意图及 claim/result/reconcile；Manager 代理向 worker 的新派发。存储的迟到结果检查与状态更新位于同一 SQLite 写事务中，不能在隔离生效后解除原保护。未知的新 MongoDB 路由默认拒绝；查询、job 查询和精确证据读取仍可进行。读取正证据不自动清除隔离。没有公开解除 hold 的接口。

这不是对运行中的旧 Manager/Worker、旧 SSH helper、已排队调用、租约或业务事务的全路径 fencing，也不拦截不属于结构化 MongoDB 协议的其它服务器入口。源码/打包 Manager 夹具特意演示了“已越过边界的旧请求在 quarantine 后仍完成”，随后替代准入依然拒绝。不能据本地持久 hold 宣称全路径阻断已完成。

## 安装、迁移与运维条件

此次只重建仓库中的 runtime 以验证 source/bundled 一致性，未复制到安装缓存、替换正在使用的包、重启实例、发布或部署。安装版仍是用户给定的版本；仓库 runtime hash 只表示候选构建，不表示实际安装生效。后续安装需另获授权，保留原加密存储及受保护 context；只通过 `REMOTE_DEBUG_PRIVACY_CONTEXT_FILE` 挂接其路径，不读取 capability/key/opaque 映射。

存储沿用既有 encrypted SQLite records schema，新增 disposition/disposition_hold 类型和永久 pin 的审计，不手改旧行、journal 或锁，不删除原记录。未来若应用真实 quarantine，不能降级到不认识 hold 的旧 Manager，也不能换一个存储目录绕过它。当前实例级本地 hold 没有解除通道；未来解除必须由正式迁移实现并保留本次审计。

若要真正允许安全替代，仍需另行实现和验收：

1. 由执行端外部强制实施的统一、持久执行边界，覆盖所有旧凭据/入口、上传、派发、执行、重放、队列、lease、进程和重启；确认所有旧路径被撤销或迁移，不能依靠旧进程自觉检查新文件。
2. 与原 context/instance/database/intent/digest/operation/job/chunk/plan 精确绑定的可信 fence/drain 确认；缺失身份需正式迁移绑定材料，不能由调用者填写成可信身份。
3. 对可能已经开始的事务做结果收敛，保存可信原事务/批次回执。只有余额/流水核对不能证明原请求未派发；历史未知继续保持未知。本版本不接受管理员风险处置。
4. 在上述事实成立后，另行实现原子、可恢复、幂等的终态及替代准入交接；重新准备并审阅原业务范围，不把新 job 当作绕过。

这些条件是**未实现/未验收的后续能力**，并非用户只需设置一个开关或提交一段 attestation JSON 就能满足。当前没有远端 fence 的成功路径，没有可信事务证据导入/采纳或替代 job 创建路径。

## 本案与业务边界

此次未挂接或读取真实 protected context 文件，未调用 default/test-server 的任何远端工具，未重跑历史扫描或恢复，未处置原 intent、隔离实例、风险接管或创建替代业务任务，未修改业务数据库或 Excel。报告引用的原 uncertain 状态来自交接材料，本轮没有宣称实时复核其指纹。本次实际补分 0 笔 0 分；此前配置修改已经发生，不将本轮无写入扩大为“数据库从未修改”。

原授权仍限定33笔、33人、2097分及36个原获得批次，排除额外52笔4488分及已兑换80分，不能按新日期重置有效期。本补丁不消费这些真实业务数据。

## 验证记录

详见同目录 verification.json。原生测试使用临时 encrypted store、loopback MCP/Manager、独立 source/bundled 进程、模拟 worker/事务及真实进程 SIGKILL，不连接真实业务数据库。TestFlow 快照/静态分析与原生测试分别记录；不能称为 TestFlow E2E 通过。

保留的早期失败：系统 login shell 命中 Node14，首条原生测试命令因不支持 --test 未执行；之后固定 Node22.23.3，未修改全局 Node 设置。新 Manager 夹具初次漏配 registry 要求的 MongoDB 配置路径，随后曾使用不存在的 sandbox/access/configure 测试路由；补齐隔离夹具契约、改为实际 execute 路由后继续验证。审查发现并修正了结果门禁检查位于事务外的竞争窗口；没有放宽业务安全断言。

最终原生回归使用 Node 22.23.3：Agent **499通过、0失败、14跳过**；插件 **136通过、0失败、5跳过**；合计 **635通过、0失败、19跳过**，新增26项回归。跳过明细和完整本地 TAP 的 SHA-256 均保存在 verification.json。另保留了一次元数据测试的失败：测试把只属于 binding 的 requestDigest 放在顶层，闭合输出契约正确将其丢弃；修正测试以核对真实嵌套契约后，最终完整插件回归通过。没有放宽身份、执行或准入断言。

TestFlow 最终输入：

- snapshotId / workflowId：`1b6fe810fb54e479729098bf3d5f72135770bdd01c316f5428f31689a0922a8c`
- flowId：`af20fdbb-506e-4c07-a080-5d2c27f8d384`
- P1：`0fb0f15e-8d93-422d-9fa6-dab1c748bf21`
- scope：`ba1fe00c0b01ad24fa1f666dd055ab4d341e1afda7fd8eb9171db7c1c247da33`
- P2：`8f40420a-bc6a-45f9-a035-34a6490404cc`
- P3：`3a4ee36b-0281-488c-91d3-4925a223dfe5`

固定输入核验成功，已用安装版 storage.readJson 读取完整分片证据；17个变更源码/测试/runtime文件与最终快照逐字节哈希一致。此后的变动仅为交付报告/verification.json，不混入旧执行证据。P1有177个变化符号、3060个影响符号，包含生成runtime；这些不是覆盖证明。保留 unresolved-call、ambiguous-symbol-identity、cgb-not-configured、non-source-impact-unknown、broad-impact 诊断。P2首次预算200小于335个两端函数而拒绝，显式提高至400后生成335函数的图，没有删掉目标来掩盖预算失败。

P3为有界候选计划：3800目标、7条候选路径、659测试资产、0个确认关联/导入执行证据、3685个未规划目标、3800个静态未覆盖目标、7条未绑定路径，executable=false。这些计数属于TestFlow静态规划/关联，不否定原生断言结果，也不能将原生通过反向冒充该图的块/分支/路径覆盖。

**TestFlow执行阻塞：** 安装版执行器只支持be-jest/jest-unit，本项目为node:test；没有project.execution的不可变依赖镜像/隔离配置、版本化执行绑定及相应用例/断言关联。仓库外配置中的node-test只是项目标签，doctor ready不代表有此执行适配器。未调用prepare/execute，没有任何prepare或execute jobId；需先正式增加node:test执行适配器，或新增真正版本化且可审查的jest-unit资产、配置、绑定及隔离依赖契约，然后新建计划准备执行。未借用真实数据库、私有配置或部署作为替代验收。

已覆盖的是本地夹具中的身份、审计事务、并发、崩溃、重启、迟到结果拒绝、旧请求仍可完成时拒绝替代、输入/权限边界和源码/打包路由；未覆盖/未执行真实MongoDB事务、真实实例旧进程/队列/租约的永久阻断及部署生效。完整块、分支、有序路径覆盖和本案真实历史结果均保持未知。候选runtime：`2.4.0:60cdea40e0630ab4432cb31e253ffb5731732585640469b8132f778a57da51ca`，不是已安装版本声明。
