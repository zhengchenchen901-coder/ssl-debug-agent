# test-server 资源池真实验收（2026-10-18）

已完成真实并发验收与缺陷修复复测；最终收尾凭据见文末。时间采用北京时间（UTC+8）；JSON/CSV 中为 UTC ISO 时间。

## 范围与版本

仅向 test-server 发送负载和写入。default 仅只读检查 Manager 任务元数据，无测试负载、数据写入或模式操作。初始 runtimeId：2.4.0:2cc232905f3ebb2c53085882cb5577817cec40c885937ff435b26831899b3859；新会话实际加载 41 个 MCP 工具。所有远端数据库和日志动作经公开结构化 MCP；最高档和冲突经认证 Dashboard 按钮操作。

## 数据与负载

仅使用 yennefer.CustomerPrivate 的 128 个新记录，前缀和 create_user/belonged_group 均为 rda-rp-20261018-01a14e14。导入前精确范围计数 0；检查了部署中的应用 schema 和真实索引（包括 group/member_code 唯一索引）。只读工具的 listCollections 仅返回名称，不公开服务器 validator；没有改动 validator，实际导入通过现有数据库验证。记录 is_deleted=true、is_marketing=false、is_marketing_opt_out=true、whatsapp_unsubscribed=true、is_synchronized=false，不引用真实分组或联系人。

批量计划仅将自有记录 remark 从 seed 改为合成文本。输入 34,591,499 字节、128 单元/128 批次，每批 1 条；利用既有 512 KiB 批次输入上限自然拆批，不提高资源上限、修改业务服务或插入延迟。实际提交 12 批后在安全边界暂停，随后全部回滚。

主日志查询选择实际列出的 2026-10-08 至 2026-10-17 共 10 个归档，以唯一不存在的测试字符串过滤，保留证据上限 1 条/256 字节。CPU requested=200m、read/process requested 各 1 MiB/s、扫描批次 64 KiB。归档单流从 16:21:16 连续到 16:27:16（含暂停），10 月 17 日归档的 startedAt 始终相同；完整解压 373,770,240 字节、42 成员、5,702 扫描批次，归档结束后停止，未打开下一文件。whole-task scan/count/evidenceComplete 均为 false；唯一已完成文件的三个标记均为 true。累计快照不重复相加。

## 验收矩阵

| 项目/预期 | 实际 | 结果 | 证据 |
|---|---|---|---|
| 新会话精确路由、版本和无冲突任务 | test-server healthy，初始无 bulk；default 无活动任务 | 通过 | preflight.json、initial-dashboard-metadata.json、default-before-upgrade.json |
| 数据写入只触及明确自有 ID | 128 条新字符串 ID；单字段计划；12 条实际修改 | 通过 | bulk-plan.json、bulk-events.json |
| 长 MongoDB 修改与长日志并行 | 两主任务重叠约 6 分钟；12 个真实提交批次，日志 5,702 批 | 通过 | resource-timeseries.csv、bulk-events.json、log-receipts-and-rollback-start.json |
| 普通请求基线和竞争阶段可用 | 主验收8个阶段72请求，加修复复测6请求，共78请求、零失败 | 通过 | ordinary-latency.json、latency-summary.json |
| 日志最高档等待 MongoDB 在途事务完成 | 首批完成后新派发停止；日志最终获得 750m | 通过 | dashboard-timeseries.json、01-log-maximum.png |
| 解除日志最高档后恢复 | 两任务再次推进，额度恢复；有采样过期导致的暂时收缩 | 通过（见限制） | 02-auto-restored.png、resource-timeseries.csv |
| MongoDB 最高档与日志降低/暂停 | MongoDB 授额最高约 750m，日志可降至 0；控制与普通读取成功 | 通过 | 03-mongo-maximum.png |
| 切换后同域仅一个最高档 | 所有捕获快照最高档数不超过 1 | 通过 | mode-events.json、resource-invariants.json |
| 刷新保留模式、旧 revision 冲突 | 刷新保留；旧按钮请求返回 TASK_REVISION_CONFLICT / 409 | 通过 | 04-stale-revision.png、05-reload-single-maximum.png |
| 第三个有界任务等待、启动、控制、隔离 | 原第三查询等待后启动；补充复测在解除最高档后达到 11,242,117 字节，暂停在 13,552,447 字节，恢复后达到 21,820,206 字节；主查询未丢失 | 通过（修复复测补齐恢复后的进度证据） | 06-three-tasks-auto.png、log-receipts-and-rollback-start.json |
| 手动模式任务暂停恢复的新 execution 交接 | MongoDB 新 taskId 继承 manual_max，旧 execution 结束；随后恢复 auto | 通过 | 07-mongo-resume-mode-handover.png、mongo-pause-resume.json |
| 自动档批量任务取消及最高档任务取消释放 | 第三查询 cancelled；第四最高档查询 cancelled，授额释放、模式自动复位 | 通过 | 08-before-cancel-maximum.png、dashboard-timeseries.json |
| 日志当前归档结束即停止 | 仅第一归档 completed，任务 stopped；下一归档无回执 | 通过 | log-receipts-and-rollback-start.json |
| 普通短诊断任务的用户取消按钮 | 该类型 capabilities=[]，没有取消操作；未伪造控制 | 不支持/未验证 | dashboard-timeseries.json |
| MongoDB 整个 128 批任务完成后全量 verifier | 本次主动在 12 批后停止并回滚 | 未验证 | bulk-plan.json、bulk-events.json |
| 人工暂停原因准确 | 资源等待时误记 MONGODB_BULK_FAILED | 发现并修复，真实复测通过 | mongo-pause-resume.json |
| 从 paused 直接 rollback | 旧 control.json 导致重新暂停并出现 LEASE_LOST；公开 resume 后恢复 | 发现并修复，真实复测通过 | rollback-lease-defect.json |

## 延时（服务端 durationMs）

每格为 p50 / p95 / max 毫秒；nearest-rank，小样本阶段 p95 等于 max，不表示稳定性能 SLA。MCP 总墙钟还包含客户端排队，原始样本另存；两类请求成对提交，服务端 queueMs 均为 0 或 1ms。

| 阶段 | 每类 n | 诊断 | MongoDB 只读 | 失败 |
|---|---:|---:|---:|---:|
| baseline | 5 | 2128 / 3075 / 3075 | 3010 / 5510 / 5510 | 0 |
| auto_parallel | 5 | 1671 / 3013 / 3013 | 2200 / 3505 / 3505 | 0 |
| log_manual_max | 5 | 1935 / 3738 / 3738 | 2259 / 2623 / 2623 | 0 |
| auto_restored_1 | 5 | 2714 / 5068 / 5068 | 2876 / 4070 / 4070 | 0 |
| mongo_manual_max | 5 | 1618 / 2099 / 2099 | 3039 / 3355 / 3355 | 0 |
| three_tasks_log_max | 3 | 2171 / 2250 / 2250 | 2096 / 7810 / 7810 | 0 |
| three_tasks_auto | 5 | 1472 / 3073 / 3073 | 2369 / 2573 / 2573 | 0 |
| pause_resume_auto | 3 | 2413 / 3117 / 3117 | 3397 / 3598 / 3598 | 0 |
| fixed_runtime_auto | 3 | 1053 / 2259 / 2259 | 2571 / 3596 / 3596 | 0 |

## 资源口径与限制

requested 为用户/配置请求，effective 为 Manager 实际授额，usage 才是观测用量。日志 runtime 的 cpuMs、RSS、readBytes、processedBytes 和 Worker 的 SSH transferBytes 均有记录；MongoDB 仅观测批次派发、并发、收发和业务进度，没有 mongod 独立 CPU/RSS，不能将 400m/750m 授额当实际 CPU，也没有 OS 配额。MongoDB requested CPU=400m、并发=2、RSS=256 MiB；实际派发并发随授额为 1 或 2。主日志最终 RSS 峰值 105,689,088 字节，CPU 总时间 6,733.943ms/elapsed 360,587ms（平均约18.7m，非授额）。

远端采样偶发超过 20 秒 TTL，Manager 保守收缩至零并分阶段恢复。CPU 低并不能保证探针及时；4 秒探针预算与实际控制通道延时可能相关，尚未独立证明原因。该行为没有观察到永久死锁或数据损失，但不构成吞吐性能通过；具体过期样本数和最长间隔见 resource-invariants.json。

## 修复与收尾

修复涉及 agent/mongodb-bulk.js（人工暂停保留 pause_requested，包括已响应暂停的 helper 释放租约与派发清理竞态；真正事务冲突仍保留原错误）、agent/mongodb-bulk-runtime.js（新 lease 同步重置 control.json），并新增三条先失败后通过的回归。最终完整 Agent：316 项，312通过、4跳过；插件：68项，66通过、2跳过。证据：local-regression-final.tap、plugin-regression-final.tap。

最终缓存 runtimeId 为 2.4.0:965a2a43236214113c7faa246d06cd1bf13793777895c2504f91656820dfe6f0，19 个文件哈希已核验（installed-final-runtime.json）。每次替换前均已确认旧作业终态、测试导入回滚、所有自有记录为零、两个实例无活动任务；插件自动替换 Manager 后使用 restart-instance 公开 MCP 恢复两本地 Worker。default 未执行负载、数据库请求或资源模式变更；由于 Manager 更新曾短暂停止本地 Worker，已恢复为原先 running/healthy。

最终真实复测：资源等待时暂停得到 pause_requested；Dashboard 在 inFlight=true、并发2、已提交2/4批时发送暂停，安全结束在途批次后状态 paused、已提交4/4批、activeBatchIndexes=[]，原因仍为 pause_requested。随后直接启动 rollback，未发送额外 resume。首轮修复已真实完成2/2批直接回滚；最终4批已直接回滚完成，期间没有额外resume；状态为rolled_back。具体 jobId/planHash/导入回滚凭据在 fixed-runtime-core.json、fixed-first-cleanup.json、final-runtime-pause-regression.json。

原 bulk 已回滚 12/12 批，128 条 seed 已回滚，所有权范围计数为0（initial-cleanup.json）；首轮修复复测也已回滚2/2批、清除6条seed（fixed-first-cleanup.json）。最终4条复测记录已完成4/4批回滚并回滚导入；138个精确ID和三个所有权标记范围的剩余计数均为0（final-cleanup.json）。技术 receipts/journals 至少保留到 rollbackExpiresAt 加 24 小时；不做强制文件清理、不删除旧技术集合。最终状态另补。


## 最终结论与留存

主要调度边界通过；发现的两类问题（人工暂停原因含等待/派发清理两个分支、paused直接rollback的旧控制状态）已修复并真实复测。未宣称128批全任务后的全量verifier已验证，也未宣称无取消能力的普通短诊断支持取消。

截至2026-10-18 16:49:41（北京时间），两个实例均running/healthy、活动/排队操作为0，default任务列表仍为空。三个bulk作业均rolled_back，导入记录138条全部还原，所有自建日志任务均stopped或cancelled，最高档实际所有者为0。

补充取消证据：最高档查询在扫描46,567,939字节、获配250m且实际CPU有采样时点击取消，最终cancelled，resourceMode=auto、resourceState=released、CPU/read/process/SSH/并发额度全为0（maximum-cancel-before.json、maximum-cancel-after.json、15-maximum-cancel-released.png）。终态budget.mode仍保留最后一次授额标签manual_max；当前模式以顶层resourceMode=auto为准，额度确为零。

全部时间序列共821个含bulk任务的快照；最多同时1个最高档、bulk授额合计最大750m；66个快照的采样过期，最长采样年龄38724ms。该抖动会保守暂停和缓慢恢复，需作为后续性能优化观察项。

技术sandbox数据、receipts和journals按合法保留期留存，未强制删除。主作业回滚期至2026-10-19 16:20:59，最终复测作业至2026-10-19 16:43:30；最早清理分别还需再加24小时。远端业务测试记录剩余0。

证据索引：原始任务数据dashboard-original-runtime.json、完整数据dashboard-timeseries.json、resource-timeseries.csv、ordinary-latency.json/.csv、逐文件回执log-receipts-and-rollback-start.json、三轮清理final-cleanup.json、最终回归final-runtime-pause-regression.json、技术事件bulk-events.json和final-job-events.json、版本installed-final-runtime.json、截图01—15。
