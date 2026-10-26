> 后续需求已改为由独立管理员接受剩余风险；新策略不要求外部迁移回执。当前实现见 [人工风险裁决流程](../../human-risk-replacement.md)。本报告保留旧策略的历史证据。

# 历史未知意图：人工最终确认后建立替代任务

新增可审阅的风险计划、独立管理员最终确认和实际替代创建路径。原 uncertain 操作记录保持原字节；成功交接另将处置状态记为 `retired_unknown`，永久本地 hold 仍保留，唯一替代准入与原意图、输入及审计关联。历史结果始终为 unknown，没有伪造未派发或已取消证明。

**这轮只改本地源码和候选 runtime，并运行隔离夹具。没有安装、部署、真实迁移、真实人工风险批准、原意图处置、业务替代 job 或数据库/Excel 写入。**用户此次批准的是开发这个流程，不能当作批准某份真实风险计划。

## 人工流程

1. 在原 context、显式 instance/database 下 prepare 原 disposition，核对 exact originalRequest；另行审阅并批准 quarantine 的实例范围。本地隔离不等于远端永久撤销。
2. prepare_risk 输入 dispositionId/reviewHash、原 originalRequest 和候选 replacementRequest。此时只保存风险计划，不建立新 intent、远端 job 或上传。支持原第一块完整输入，拒绝从其它块猜测缺失业务输入。
3. 候选业务效果必须等于原输入：收款/会员身份、金额、更新表达式、插入文档、原批次日期、单元与操作顺序不可扩大或修改。允许刷新被更新字段的标量原值检查；身份/存在性和数组追加缺失条件不可放宽。仅 remediation_job_id/job_id 的原 job 关联可精确重绑。每份候选及封口摘要都进入审阅绑定。
4. 配置可信外部迁移方的有效签名回执，确认旧任务全路径永久阻断、旧权限撤销、连接/队列/租约清理、在途事务已终止及重启后继续阻断。公开 MCP/浏览器不接受调用者提供 proof、信任键、文件路径、actor 或 humanApproved 标记。
5. 管理员在独立工作台登录，进入“未知任务风险处置”，读取 riskPlanId。必须在同一会话中读取这份具体计划，核对目标、旧/新任务、摘要、数量、集合及未知风险，勾选确认并输入：`我接受历史结果未知的风险，并批准建立此替代任务`。服务端再调用原生系统所有者验证。Manager token、context capability、普通 MCP 或聊天中的一句确认均不能代替此步骤。拒绝、取消、过期、实例变更或验证期间计划变化均不批准。
6. 人工批准只记录批准及身份审计，不创建 job。随后公开 mode=create_replacement 使用该 riskPlanId 和批准的 reviewHash，原子登记 `retired_unknown`、唯一新 intent、准入 gate 和审计，再经现有 bulk prepare 上传精确第一块。提交前后实际 SIGKILL、并发和重启可恢复，不产生第二个替代身份。
7. 正常 prepare_bulk 上传自动绑定的空封口块（chunkIndex=1、units=[]、endOfUpload=true，其它 purpose/TTL 相同）。只有可信精确封口回执中的 planHash 才准入 execute/resume/rollback。创建和人工批准都不执行补分；业务执行仍需要现有固定计划检查与“确认执行”。

风险计划期限1小时，人工批准最多15分钟且不超过迁移回执期限。过期后重新准备并进行原生人工审阅，可续接同一替代身份，不创建第二个 job。一个原 disposition 最多建立一个替代关系。准备失败或数据冲突须报告并检查该任务，不能默默换 job；本轮没有实现跨多个替代 job 的自动改写链。

## 外部迁移回执的信任边界

新模块 `agent/mongodb-fence-authority.js` 是**核验适配器，不是远端撤权/排空实施器**。当前旧 SSH/helper 架构自身不能证明全路径受控；生产环境没有预配置可信签发方时，仍然 fail closed。签名只证明回执来自已配置权威，回执事实必须由该外部系统真实验证，不能把自签 JSON 或人工勾选当成永久阻断。

信任仅通过 Manager/PrivacyWorker 的启动环境配置：

- `REMOTE_DEBUG_EXECUTOR_TRUST_FILE`：安装所有者预置的绝对路径；文件版本1、boundaryType=externally-enforced-legacy-retirement-v1、issuer及Ed25519公钥。
- `REMOTE_DEBUG_EXECUTOR_RECEIPT_DIRECTORY`：所有者控制的目录；按 `<riskPlanId>.json` 读取。公开接口不能写入这些文件或选择其它路径。

文件必须为安全本地常规单链接文件、无链接路径、0600或更严，目录由当前安装用户或root控制且不可被组/其它用户写入。Windows目前缺少该信任文件边界的原生ACL核验，因此新风险准入明确不支持Windows，保持拒绝；原有非风险能力不受此特定限制。

回执文件为 `{version:1,payload,signature}`。签名为Ed25519，对UTF-8 `JSON.stringify(payload)`字节签名，使用标准base64。payload包含 issuer、唯一receiptId、riskPlanId、challengeDigest、issuedAt/validUntil（毫秒，最多1小时且不得未来签发）、protection=permanent、historicalOutcome=unknown、inFlightTransactions=terminal、restartSafe=true、legacyCredentialsRevoked=true、oldSessionsDrained=true、oldQueuesDrained=true，以及完整coverage：dispatch、upload、execute、resume、replay、old_processes、queues、leases、restart、authenticated_sessions、inflight_transactions、legacy_credentials。

challengeDigest 是 inspect_risk 返回 fenceChallenge 的 SHA-256 JSON 字节摘要。challenge包含原context/instance/database/intent/digest/已保存operation及job/chunk/plan身份、目标scope摘要、候选job、输入/封口/业务效果摘要。缺失历史身份仍为null并显式展示，不能填成猜测值。原请求必须先通过原keyed identity和字节核验。

权威签发前必须在服务端实际关闭所有旧执行绕行入口，处理旧已认证连接、旧队列、租约和在途事务，并保证永久拒绝原job及重启后持续有效。必须约束已经发出的旧helper，不能依赖它主动读取新文件；改配置、换密码、暂停或写tombstone不直接满足要求。本项目未提供该外部迁移实施器或签发服务，也没有为本案产生真实回执。部署该能力、接入可信签发方及迁移旧权限，需要另行明确的运维授权和现场验收。

每次审批、创建、后续受保护写入准入都重新核验回执。回执替换、签名错、跨计划/跨目标、覆盖不全、旧连接未排空、事务仍在途、过期或权限不安全均阻断。签发方若错误认证了事实，密码学校验无法识别；因此不能把测试中的模拟签发方作为生产阻断证据。

## 原子性与授权边界

人工批准及其审计在一个事务内保存；创建交接在另一个事务中同时保存原未知处置、替代 intent/gate、唯一关系与创建审计，通过批准审计ID精确关联。不会跨人工等待持有数据库事务，也不会先建任务后补批准。远端上传位于交接事务之后，经已有精确ticket协议派发。回包丢失只核对同一 intent/chunk，不重建其它job。旧任务的 claims、结果、resume/replay、普通mutation等旁路仍被本地hold拒绝；只豁免已批准的两个精确上传输入及接受的同一 sealed planHash。其它实例/上下文不能借此获得准入。

管理员必须有独立账号并经过真实原生系统所有者验证。读审阅缓存限5分钟，审批时再次核验签名、原记录指纹、实例配置与会话。传入额外字段、无先前同会话审阅、错误语句、验证取消/并发、登出或目标变化均拒绝。浏览器不保存token到localStorage/sessionStorage，页面仅展示控制身份和范围摘要，不输出原始业务前镜像、映射、上下文能力或信任键。

## 验证与未覆盖

详见 verification.json（最终生成）。原生测试和真实浏览器均只使用临时加密存储、loopback Manager/MCP、模拟MongoDB/worker、临时签名权威和模拟原生验证；不得当作真实远端永久阻断、真实管理员弹窗或真实业务事务已验收。最终回归、TestFlow固定快照、阻塞及证据ID将在同目录记录。


## 最终验收结果

证据ID：`mongodb-risk-replacement-20261026-local-v1`。结构化结果见 [verification.json](verification.json)。

| 验证 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: |
| Agent完整原生回归 | 533 | 0 | 14 |
| 插件完整原生回归 | 138 | 0 | 5 |
| 合计 | 671 | 0 | 19 |

本轮新增36项原生回归，另有一次真实Chromium/HTTP页面验证通过。覆盖精确原意图及候选绑定、不扩大业务效果/原批次日期、复合会员ID内job_id禁止重绑、可信迁移回执签名及完整性失败、人工会话/同源/原生确认、取消/登出/原值或回执变化、真实SIGKILL提交前后、并发唯一替代、失去上传回包后同意图恢复、续批仍用同一身份、正常封口后planHash绑定，以及源码/打包Manager的公开MCP完整链路。创建和批准均未在夹具里执行补分。

页面夹具截图和原始TAP日志位于本机 `/Users/zhengchenchen/Documents/Codex/2026-10-26/ssl-debug-agent-risk-replacement/`，具体路径及SHA-256在verification.json。原生系统所有者弹窗、签发权威、远端MongoDB/worker均是明确的测试替身；真实浏览器与独立管理员HTTP不是替身。截图中“已核验”的回执是夹具签发的，不是本案证据。

19项跳过的具体标题已保存，主要为真实MongoDB集成、平台/Keychain条件、超大日志及本机默认端口已被使用的用例。没有为补测而操作真实default/test-server数据库。保留早期失败：管理员夹具的固定时钟早于真实actor时间，首次一项审批被安全拒绝，改为真实时钟后完整通过；首条浏览器命令的相对脚本路径错误，未运行浏览器或远端操作，改正后通过。完成第一轮670项回归后，代码复核进一步禁止复合身份里的job字段重绑，补入针对性断言并重建runtime，最终完整671项回归再次通过，没有放宽安全断言。

TestFlow已使用仓库外配置固定最终未提交工作区，没有创建Git提交：

- snapshotId/workflowId：`af3420f9d546f049c4b76866ebc0957678c7f2211c37f2166e5fa279c6b9a684`
- flowId：`934b767b-72d7-4027-9ed7-779fb815f1f7`
- P1：`1dfb7dd2-f51f-454b-876f-f113428ad597`
- scope：`306907f1e70113bd8bc814cb8570d880f465ac1e4ea152dbf7f819012318780a`
- P2：`07fe1cd1-f7c3-4f0f-9571-5a0dc8b4e89a`
- P3：`3585815a-a5e0-42e9-a145-baeb397db7ab`

fixedInputVerified=true；已用安装版storage.readJson核验完整分片产物，并逐字节比较34个变更源码/测试/runtime/技能文件与最终快照。随后只追加交付报告及verification.json。P1的532个变化符号、4431个影响符号包含生成runtime；P2生成886个两端函数及69240个块，仍为partial-static。保留未解析调用、身份歧义、未配置CGB、非源码未知及广泛影响诊断。

P3是有界候选：13934个目标、8条候选路径、683个资产、0个确认关联/导入执行证据、13692个未规划目标、13934个静态未覆盖目标、8条未绑定路径，executable=false。其静态关联计数不代替或否定原生断言结果，也不能据原生通过宣称完整块/分支/有序路径覆盖。

**TestFlow执行未进行：**安装版执行器只接受be-jest/jest-unit，本项目是node:test，且没有版本化执行绑定、确认关联和project.execution不可变依赖镜像/隔离契约。没有prepare/execute jobId，没有Docker E2E通过结论。需要正式补齐node:test适配器，或真实版本化jest-unit资产及其绑定、断言、依赖和隔离配置后，重新固定版本并执行。

候选runtime为 `2.4.0:42785d14f3e328fca822145024b85997c2032451e7d9e18b18115c94c02b1742`。安装目录仍为原 `2.4.0:e515098eb54c66b785b0de2a7a1fe1afa9f64192bf00fc85b69832d326c93dca`，三项关键runtime哈希匹配原manifest；未替换正在使用的包。

## 本案剩余条件

本轮没有为本案生成或批准真实风险计划，没有签发真实迁移回执。原业务仍限定33笔、33人、2097分及36个原获得批次，排除额外52笔4488分和已兑换80分。真实历史派发/事务结果仍未知，13:21的业务只读核对不能冒充历史执行回执。

运维接续仍须另行授权安装候选、部署并验收外部强制执行边界/可信签发方、实际撤销旧入口和处理在途事务，随后挂接原受保护context文件路径、准备精确候选并由有权管理员最终确认。签名适配器不会实施迁移，也不能保证当前旧环境已经可建立替代任务。若无法证明旧路径受控，人工确认也不能越过该条件。
