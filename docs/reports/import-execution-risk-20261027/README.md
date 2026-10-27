# Import 执行结果未知：独立人工风险接受，本地交付

2026-10-27（Asia/Shanghai）。源码、UI、结构化 MCP、固定 helper、技能说明及可复用测试已完成并保留为本地未提交改动。另有从最终快照生成、核验的候选插件；未安装、发布或加载到真实 Manager/Worker，未操作真实业务数据库、审批或任务。现有用户发行元数据及 installation 目录保留。

## 授权结果

新增 `human-execution-risk-v1`，独立于原 `human-risk-acceptance-v2` 准备审核。它可以审查缺少历史机器终态回执的旧 `.2` 执行记录，不要求反复批准准备计划，也不补造 v2 回执。

| 路径 | 实际授权及证据 |
| --- | --- |
| 机器证据恢复 | 原有精确远端回执核验；人工陈述、当前0条、列表、commit_retryable 和锁龄都不是证明 |
| 独立人工执行风险批准 | 只接受本次未知及迟到/重复/部分成功风险，授权一个受约束接续计划；原 unknown 和审计保留 |
| 单独业务确认 | 对新 mutationId / 不可变 planHash 使用正常“确认执行”，取得新 v2 提交回执后才可报告子批次 committed |

公开 `remote_debug_mongodb_disposition` 增加三个模式：`prepare_execution_risk`、`inspect_execution_risk`、`continue_execution`。最终风险批准仅在独立工作台“执行结果未知（独立批准）”，经新一次原生系统身份验证及精确风险语句完成。MCP、聊天、Manager/context token、调用方 proof、旧准备审核和旧确认语句均不能批准。

## 身份、计划及持久边界

审核绑定原保护 context/目标、实例/库/集合、执行 intent/operation、真实保留的 attempt（旧格式未知序号保持 null）、mutationId/planHash、原始准备和唯一替代谱系、原批次精确摘要、文档/字段顺序及 EJSON 类型、当前集合 UUID/连接来源及到期时间。原执行已知事实和缺失证据在管理员页面显示；完整文档只在受保护存储及独立管理员页面读取，公开 MCP 返回摘要。

旧计划缺 UUID 时不修改旧 hash。固定 helper 只读复核当前集合/事务前置条件并生成显式新计划，文档及批次参数保持原样。批准后接续仍在**同一 importId、同一唯一替代谱系**内，仅预留一个确定的子 mutation；不是第二替代导入。旧不可变计划、保护记录及所有历史 attempt 保留。其它批次、旧回滚和全实例权限不会因此放开。

消费批准先写 FULL/WAL SQLite，再持久写原批次的远端关闭/接续预留，最后发布新子计划。重启、丢回包和并发只恢复这一份明确预留；两个远端 SIGKILL 窗口验证了有正向预留后可恢复完全相同的子计划，且不删除遗留锁。批准/接续本身不执行业务事务。子计划继续要求 v2 execution ticket、UUID复核、已有文档拒绝、精确提交回执及有所有权的冲突保护回滚。

迟到机器观测作为独立审计显示。若获得原执行的精确已确认提交回执，会关闭接续准入，页面和 inspect 明确显示该事实；原 unknown 历史和人工批准记录仍保留。固定 helper 也在子事务准入及提交前检查原计划。历史已派发旧进程仍可能在检查间提交，这一剩余风险不能被描述为已撤销全部执行器。

## 最终快照的实际验证

| 验证 | 实际结果 | 边界 |
| --- | --- | --- |
| TestFlow 独立 pilot | 1通过，0失败；7例被筛选 | 新独立任务取得完整可读取证据；其余两个文件不属于 pilot |
| TestFlow 完整 regression | 39通过，0失败、0跳过；3文件全执行 | jest-unit、network-none；不冒称 BE API 或页面测试 |
| 补充原生隔离回归 | 419通过，0失败、0跳过；36文件 | 同一最终快照，使用本次候选 bundle；包含新公开 MCP→Manager→经认证 Worker HTTP→固定 helper→SQLite→工作台链路 |
| 真实 MongoDB 集成 | 4.2.24、4.4.30各1通过 | 授权副本集、driver 6.20.0；同配置真实唯一键拒绝、独立批准替身、子事务提交/幂等/回滚、原未知保留 |
| 真实浏览器 | 通过 | 精确审核内容、旧语句拒绝、审批、无业务写入、刷新后重新登录读取；原生身份/SSH/Mongo为明确替身 |
| 故障窗口 | SQLite SIGKILL 4、远端 SIGKILL 2及子 manifest I/O故障通过 | 实际进程/临时文件；不代表断电持久性 |
| 候选程序 | 26个清单哈希一致 | 只生成和测试，未安装或加载 |

两个真实 Mongo 集成均使用新建内部 Docker 网络、无宿主端口、可丢弃数据库与合成账户；容器和网络清理均成功。每次验证2条虚构文档，不读取真实11条业务资料。旧格式场景为合成旧信封，不声称复制或运行过真实旧 `.2` 业务状态。

TestFlow 最终严格目标 **1634：covered=0、notCovered=0、unknown=1634**。原因：source-coverage-missing=1625、source-reference-missing=9；mappedFiles=0，missingFiles=11。已安装采集器的非 src 路径限制保留，没有移动源码或修改插件缓存。图 partial-static/truncated，51个未展开变化目标；11项范围外变化（9个原 installation JSON、绑定生成器、Mongo夹具启动器）和109个排除入口另列。用例通过不证明复杂操作完成、有序路径或逐 matcher 完成。前轮1306个 unknown 没有被算作本轮覆盖。

## 证据身份

- 最终 snapshotId / workflowId：`32eb85db36499eae2d55f4b807a2f91e03e6077983287f3399078666a3581bc0`
- source contentHash：`fd02838338d9d4e03d776427456890403a7aebec42029830ad0b6fc78907c9f9`；621个冻结文件逐一核验一致。
- 基线：`d6707ddc8858d49f1071d1a92a96ef3d93de8a3e`（会话开始已存在）。
- 候选 runtimeId：`2.4.0:fdef92d75b30857ce31fc6fe4a24148e7eaaa988fc4515bc5acaa01bf1859053`
- analyze：`0a692f8c-4197-4e19-9369-a0bb01a6c62e`；graph：`ee66e903-9dec-4abf-8f2c-6a417de635b1`；plan：`37165e91-0dc7-407d-8596-15eedd2c43f3`。
- 干净 pilot prepare job：`051300a9-aafd-4416-858b-eac5d579fccd`；execute job：`7c9a2488-6be6-4ade-b983-93dbf863e4c6`。
- regression prepare job：`ec38650d-06e9-4a2f-94ed-0cdf6e8570f6`；execute job：`44f57300-d912-4617-b809-c938f79557f5`。
- regression reportHash：`28bcaf6166cfeb360076c7c6db79e5af5849ef85ebee6a7e83fbd4d395e359e5`。

本目录 `evidence.json` 保存结果、绑定身份、限制及产物哈希。外部完整证据根：`/Users/zhengchenchen/Documents/Codex/2026-10-27/ssl-debug-agent-execution-risk`，包括 TestFlow 固定输入和结果、原生 TAP、真实 Mongo 回执、浏览器截图及 `final-candidate/plugin`。工具管理的 raw 仍受插件保留策略约束；报告及核验摘要单独交付。报告文件在执行后新增，不冒认属于被测快照。

## 已保留的失败观察

最终快照首次 pilot 在用例前因 Docker 内存采样 `-- / --` 返回 docker-memory-format-unknown，0例执行，清理完成；同一 job `8c93dd61-6528-4cbe-b01c-91fc98f7ac13` resume 后实际1例通过。其 evidence 汇总又遇到工具内部 `normalized` TypeError（diagnosticId `45c89d29-e329-4d0c-a1f9-ed480c028128`）。没有修改 TestFlow/cache、删锁、放松断言或把阻塞算通过；另建同一固定输入的独立 pilot，取得上表完整证据。完整 regression 独立执行39例并可核验证据。

早期合成夹具的 initialize/传输 undefined 属性比较、真实文件父目录同步、浏览器 reload 后重新登录预期已修正；首次真实 Mongo 夹具尝试切换 uriKey 被现有 MONGODB_MUTATION_POLICY_CHANGED 拒绝，未运行目标场景，改为同配置真实唯一键拒绝后重跑；一次最终原生包装脚本因重复依赖软链接在测试前退出，正确隔离物化后419例通过。相关失败日志保留，不合并为最终通过证据。

## 使用边界及未验证项

- 独立审核最多128 KiB文档 JSON；本轮未读取真实11条的完整输入或验证其大小。超过范围应明确停住，不能私自拆分单一事务承诺。
- 审核/子计划请求及回滚窗口固定15分钟，工作台本次读取窗口5分钟。未消费的过期审核须显式生成保留旧版本的新审核；消费后不得静默改 hash、UUID或换子任务。
- 本次只支持一个子接续。子执行再未知、消费后事实/UUID漂移、远端正向预留前到期/存储损坏或不可恢复锁均保持保护，不自动再派发、换 importId 或清锁。本次不实现已消费后再更换子批次的风险授权。
- 未验证真实原生 OS 弹窗、真实 SSH/远端部署、真实历史在途进程、断电、跨平台、全部数据库版本/FCV/分片矩阵、真实网络及 write concern 故障、完整仓库测试、业务 API或真实11条落地。
- 当前本地候选尚未安装或加载；本报告不说明真实实例已具备新能力，也不说明真实导入成功。

## 真实任务之后如何受支持地接续

本轮没有调用任何真实审批、prepare/create、execute、rollback或迁移。真实背景只采用用户给定16:50记录：空集合已显式创建；旧导入执行仍uncertain；当时原11个_id为0不证明历史未执行。

在另行授权安装/加载新版本后，应恢复**原保护上下文**，使用公开结构化工具，保持 `test-server / yennefer / Group_2RWSW3WU_Google_Record`：

1. 调用 disposition，`mode=prepare_execution_risk`，绑定执行 intentId `5388d193402ef9f9826a47837aae7f57d51e91168d9025a565350458108e5354`，以及原准备替代 riskPlanId `33d598460ba2a017f241a0d4f849b24174e4e906fb27941a0374efc43cd55aa5`。返回的是**新的执行审核 riskPlanId**，不能拿旧准备审核冒充。
2. 在独立管理员工作台选择执行阶段，读取该新审核；核对原 operation `4fe40c1f-eb26-446e-ace8-9cd148218711`、原 mutation/hash、旧 attempt缺口、固定11条/字段/类型/顺序、当前已创建集合的UUID、期限及迟到/重复/部分成功风险；重新原生身份验证并输入新风险语句。旧准备批准无需重复作为执行风险授权。
3. 用新执行审核的 riskPlanId/reviewHash 调用 `mode=continue_execution`。只建立同一 `ejpoh-20261027-group-google-retry-v1` 内的唯一子计划；旧 mutation/hash 和 unknown 不变，没有第二替代 importId。
4. 单独展示并确认返回的新 mutationId/planHash及11条单事务范围，再按正常结构化 execute。只有新精确回执允许报告子批次 committed；之后按精确文档核验内容、类型和顺序。新未知停止并 inspect/reconcile 同一执行，不能自动重派。

此流程不 drop 已保留集合、不回滚无所有权的历史导入、不清理其它任务，也不能承诺历史迟到事务已被撤销。
