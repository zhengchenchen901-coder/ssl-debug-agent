# MongoDB bulk 字段校验与准备意图恢复：本地修复记录

日期：2026-10-26。交付为未提交的源码、重新生成的仓库 runtime、技能说明与回归测试。没有修改已安装插件缓存，没有提交、推送、PR、发布、部署、定时任务或生产工具调用。

开始时工作区干净，HEAD 为 `0596e6a9ab73906ac2c61f05631472c4521fccd5`。仓库和上级目录没有额外 AGENTS.md，遵循本会话提供的规则。已读取安装版 TestFlow 0.2.0 技能及 Remote Debug Agent 2.4.0+codex.20261023.2 的 database-mutations 技能与 bulk 参考。

## 原因与实际修复

1. `agent/mongodb-bulk.js` 的旧 FIELD_PATTERN 只允许具名路径，`integrals.0.value` 在 normalizeUpdate 就被拒绝；expected 使用相同限制。普通 mutation 支持数组不意味着旧 bulk 支持；bulk 旧说明明确 V1 不支持数组编辑。此次补齐的是一个有明确约束的 bulk 子集，不是直接取消正则限制。
2. MCP 为 bulk prepare 建立 uncertain 意图后，走普通 HTTP 转发；只有成功响应才调用 outcome。校验错误没有类似普通 mutation prepare 的 Manager 内部持久化结果通道。worker 的 bulk 同步校验也没有发出 `dispatchState=not_dispatched` 证明。
3. recover/reconcile 对没有普通 prepare ticket 的记录走 fallback；首块上传尚无 planHash，无法查询精确终态，最后直接返回 `legacy_evidence_required`。旧 legacy 布尔值只识别普通 prepare，故 bulk 同时出现 legacy=false。这不是“job 不存在便可重试”的证据。

新 bulk prepare 经 Manager 内部通道处理。SQLite 保存原 intent 绑定、原始请求 digest、attempt、操作 ID、派发占位、规范化 chunk 身份、结果和审计事件。脱敏请求看起来相同但原始 digest 不同会拒绝，不会拿旧回执充当新内容的成功。

| 实际证据 | 本地状态与行为 |
| --- | --- |
| Manager 同步预检拒绝，或 worker 明确证明还未调用 SSH | rejected_before_dispatch；相同输入可在同一 intent 下增加 attempt 重试 |
| intent 已建立，尚未 claim | 原子 fence 为 rejected_before_dispatch；晚到的旧 claim 被拒绝 |
| worker 成功且 job/chunk/hash 精确一致 | complete；缓存准备回执；不代表执行或加分 |
| 成功响应身份不匹配 | 不向 MCP 交付成功；保留 uncertain，可取精确证据恢复 |
| 响应丢失，存在精确 chunk/manifest；封口还须精确完整 plan | 经内部 recoverUpload 检查后 complete，不重新上传、不重建计划、不执行 |
| claim 后断连、缺文件、hash/封口不匹配、prepare_failed/未确认封口 | uncertain，bulk_prepare_evidence_required，继续阻止重放 |
| 历史 bulk envelope 没有 bulk prepare identity | legacy=true，bulk_prepare_identity_required；不接受调用者提供的“证明” |

内部结果写入动作不暴露给 MCP，普通 outcome/reconcile 不能自行终结 bulk prepare。恢复只使用受认证 Manager/worker 通道取得的证据。恢复正证据会核验 chunk 内容哈希、manifest 中的该块、封口标志，以及封口 plan 的完整性及 chunks 绑定。prepare 成功回执补齐封口 chunkIndex/chunkHash。

## 数组安全契约

- 数字段只接受规范的 0–99999；拒绝位置运算符、前导零、负数、过大索引、原型键。
- 每个被编辑的现有数组元素必须在 expected 中有未被本操作修改的直接身份字段：id、_id 或 *_id，值为非空字符串、整数、ObjectId 或 Long。嵌套数组逐层要求身份。
- 每个改动路径仍须明确原值/存在性；拒绝重叠更新路径及重叠 expected 路径。普通值条件不能代替元素身份。
- 尾部追加仅支持 `$set` 一个带稳定 _id（或 id）的完整对象，expected 指定该精确路径不存在。运行时必须恰好等于真实数组长度，且追加身份不能已存在。
- 真实前镜像及事务内再次检查非数组、空洞、越界和追加身份；完整文档前镜像比较继续拒绝准备后的并发修改。现有数组整元素替换/删除、标量数组追加不在新增契约内。
- 业务幂等标记、独立流水插入仍需留在同一 unit。此能力不修复业务有效期算法，也不证明当前后端已实现逐批到期。

现场输入只在内存中用于形状复现；不透明引用被替换为夹具字符串，没有解码或当作原始 ID。旧 HEAD 的 normalizer 返回 MONGODB_BULK_FIELD_REJECTED，新 normalizer 接受同形状的 34 units / 100 operations / 33 笔 / 2097 分。这个结果只证明字段/输入契约，不验证生产 BSON 映射、前镜像或业务审批。

## 验证结果和边界

详见 [verification.json](verification.json)，其中保存日志 SHA-256、19 个改动源码/测试/runtime/技能文件的哈希、26 个 runtime 文件哈希核验，以及 TestFlow/隔离资源证据。

| 验证 | 实际结果 |
| --- | --- |
| Agent 原生 node:test，包目录 npm test | 479 项：465 通过、0 失败、14 跳过 |
| 插件原生 node:test，包目录 npm test | 116 项：111 通过、0 失败、5 跳过 |
| 补充 Docker 隔离副本集，原生 node:test | 1 项通过、0 失败、0 跳过 |
| runtime 构建与哈希 | 已构建；manifest 的 26 个文件哈希全部核验 |
| TestFlow | doctor、工作区 freeze、P1 影响分析完成；未执行测试 |

新增/增强的断言覆盖校验拒绝持久化与同 intent 重试、claim 前中断与晚到 claim、claim 后缺证据、Manager/MCP 与 worker 两层响应丢失、原 chunk 与封口精确恢复、初始错误回执不得显示成功、错 hash/封口/partial seal、重复上传/封口、同 job 不同内容、旧/新协议区分、公共伪造结果拒绝、SQLite 结果事务失败、脱敏身份碰撞、数组路径/身份/原值/嵌套/空洞/越界/重复元素及并发冲突。source MCP + source/bundled Manager + source/bundled PrivacyStore 都有回归。

隔离副本集使用 MongoDB 4.4.30、驱动 3.3.4、Node 22.23.3，固定本机已有镜像 ID；独立 internal 网络，无宿主端口，无生产配置/凭据挂载，仓库只读挂载。真实事务检查了数字数组增量+尾部追加+跨集合插入、commit 响应丢失后的回执恢复、重复执行不重复加分、回滚恢复原数组、并发追加导致整个 unit 拒绝，且兄弟写入不残留。容器、网络、依赖卷清理回执均成功。它是原生补充验证，不是 TestFlow 执行，也不是 exact-lock 项目依赖重现。

未执行/未知：原生套件的 Windows、Keychain、超大日志、其他需显式环境变量的 MongoDB 集成，以及默认端口被占用的启动用例共 19 项跳过；真实 SSH 断连到 Mongo helper 的链路未对新 bulk 协议做物理断网试验，故障注入是在本地受控 dispatch 边界完成；完整块/分支/有序路径覆盖未知。没有安装生效、生产业务或 UI 验收。

保留失败尝试：初次从仓库根目录合并跑两个包时，两个既有测试因其包目录约定失败；MCP smoke 夹具因缺少新的 bulk 策略/身份回执失败，补齐夹具后从各自包目录完整重跑通过。另做过约 570 KiB 重复文本的合成容量探测，被现有 OUTPUT_GUARD_BLOCKED 时间预算拒绝（source/bundled 两次，另一次 source 诊断）；该容量未验收。最终 Manager 协议回归使用正常有界文档，未放宽 guard 或业务断言来通过容量探测。原始失败日志仍留在本机外部证据目录。

## TestFlow 证据与缺口

独立外部配置位于 `ssl-debug-output/mongodb-bulk-recovery-20261026/workspace.json`，没有使用默认 OD-Yennefer-BE 项目冒充本插件。

- snapshotId / workflowId：`d997148c3ff00069e4543c22a15378bd0f0649f585069505f157ea67827c035f`
- P1 runId：`b3f817a8-8630-4225-aeb5-7a7af5130be6`
- flowId：`1f87bc10-2c44-4d38-9f83-b0341140d8e7`
- 固定输入核验成功，无测试用 Git 提交；报告是在源码冻结之后补充的，未改变固定源码。

已用安装版 storage.readJson 核验完整 change-set、impact 分片和 manifest。P1 是 partial-static：196 个变化符号、3823 个受影响符号、12058 条诊断；含生成 runtime 及调用不确定性，不能将这些数量作为测试覆盖分母。诊断保留 non-source-impact-unknown、unresolved-call、ambiguous-symbol-identity、cgb-not-configured、broad-impact。

本项目的测试是 node:test；当前 TestFlow 执行能力为 be-jest / jest-unit，没有登记本项目可执行适配器、版本化 Jest 资产/配置、执行绑定、生命周期/断言及本项目依赖镜像契约。没有伪造绑定，也没有调用 prepare/execute、产生测试 jobId 或声称 TestFlow 测试通过。补齐上述条件后才能做 TestFlow 执行和覆盖验收。

## 原生产意图的恢复步骤与尚未闭环项

本会话未对生产发出 inspect/reconcile，更未调用 execute_bulk。原 year 配置 1/1 已完成、原 33 笔未补、新增 52 笔未授权等信息沿用用户现场说明；没有重复执行 year 配置，也没有改变 Excel、白名单、远端业务服务或存储初始化资源。

原 intent：`f16dbcb7a1990113e38051e1aeb9d3fca9f46af4dcd5c7ae2f1ba8b3ec4e5b6d`。
原 job：`37265270-8912-48c0-8c4d-2947a1cc6e41`。
原失败 operation：`babbe8ae-55d5-411a-9cee-2e92430c864c`。

1. 原会话保留原 protected context，通过结构化 recover_operation，显式 instanceId=default、database=yenneferbak、上述 intentId，先 inspect。不能新建 job 或改变原参数以避开此意图。
2. 本次改动未安装。以后在另行获准并核验本地插件升级后，同一个上下文可再用该结构化工具 mode=reconcile；它不会执行补偿或初始化存储。
3. 对此次旧 envelope，预期缺少 bulkPrepare/bulkChunk 绑定。修复后的恢复会明确返回历史身份缺失，而不会假称非 legacy 或推导“没有派发”。当前补丁不提供凭聊天错误、外部 JSON 或仅凭 job 不存在导入旧证明的接口。
4. 原意图要闭环，还需从原受信任 Manager/worker 审计取得能精确绑定 context、intent、原始请求 digest 与 operation 的未派发证明，或等价的精确远端 chunk/plan 证据，并提供受审计的正式历史恢复/迁移能力。旧记录若根本未保留这种绑定，现有结构化工具无法安全补造；应继续保留 uncertain，停止补分。不得手改 SQLite/journal/锁、导入伪造 ticket、重建 job 或绕过工具。
5. 只有恢复闭环且原会话再次核对不可变的 33 笔输入、原清理标记、余额与批次例外后，才可能继续原授权流程。本修复不代表现在可以补分，也不扩大到新增 52 笔。

所以：新的可证明预检拒绝和丢响应路径已修复并验证；原历史生产意图没有在本会话解除，缺证据历史迁移仍是明确阻塞。

`FINAL_RESULT_INSTANCE_NOT_FOUND` 对应独立 final-result 路由的 registry.getInternal 检查，在结果发布前发生。未发现它与本次 bulk 意图状态机共享恢复分支的证据；未扩展修改该功能。
