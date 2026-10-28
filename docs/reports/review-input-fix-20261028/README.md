# 5 项审核准备错误：本地修复及真实验证结果

本地源码已修复并完成新一轮隔离测试；**真实审核对象生成/读取验收仍为 0/5，尚未完成**。
原因是本次明确没有新的安装/更新授权，现有 Manager 仍运行已安装的 .2 旧实现。
原上下文中的 5 次真实公开准备核验均复现原错误，未返回可用 riskPlanId，不能将本地
校验成功、合成审核对象或隔离通过冒充真实审核对象。没有换原/候选身份绕过，也没有消费。

交接依据已完整读取：
/Users/zhengchenchen/Documents/Codex/2026-10-27/ji/outputs/EJPOH第三阶段完成及剩余事项.md。
范围仍为 test-server/yennefer，仅 EJPOH 与集团 2RWSW3WU。固定 final-input.json
SHA-256=a27ceed64856937953497af06e43e237ea74245e14de95982589b2895da26e97，
已重新核验；它是此前固定多集合读取文件，不能称为事务一致性快照，没有读取新源数据。

## 逐项根因与修复

| 集合/条数 | 已定位的实际失败层次 | 本地修复 | 原上下文真实验收 |
| --- | --- | --- | --- |
| Customer / 71 | Manager privacyRequest 将原 wire 输入送入输出脱敏器；7 个非空 password 字符串被替换，摘要改变，遂返回 ORIGINAL_BYTES_REQUIRED。保留输入并未丢失 | 入站使用独立有界 JSON/既有 import 校验；原文进入加密审核记录，页面只展示脱敏投影 | 仍为 ORIGINAL_BYTES_REQUIRED，无可用审核对象 |
| RestaurantLog / 29 | Manager 输出脱敏器遍历到第 100001 个检查节点，超过 maxNodes=100000，抛 OUTPUT_GUARD_BLOCKED；其普通 Error 无 BUSINESS_ code，被 storage HTTP 错误包装成 STORAGE_UNAVAILABLE，尚未调用 orphan_risk_prepare | 不用输出遍历预算校验入站原文；保留既有数量、文档大小、集合、JSON 深度等限制 | 仍为 STORAGE_UNAVAILABLE，无可用审核对象 |
| Res_EJPOH_Booking_Order_History / 448 | 同一输出遍历预算先失败；随后还存在原 importId 长 69 字符、普通准备校验仅接受 64 的第二阻塞 | 修复入站校验；历史原身份只在审核中按查回协议的 128 字符界限验证，候选仍受 64 字符准备界限 | 仍为 STORAGE_UNAVAILABLE，无可用审核对象 |
| Res_EJPOH_Booking_Order_Log / 176 | 具体字段为 importId，原长 65 字符；normalizeMongoImport 抛 INVALID_MONGODB_MUTATION，消息为 importId has an invalid format，被捕获为 INPUT_INVALID。不是文档/BSON 深度或字段编码错误 | 同上，只允许历史审核保留长原身份，不修改它或候选，不放宽实际新准备 | 仍为 INPUT_INVALID，无可用审核对象 |
| tag_definitions / 491 | 与 RestaurantLog 同层次的 100001/100000 输出遍历预算失败，经错误包装变成 STORAGE_UNAVAILABLE | 同上，独立入站校验；新增封闭 inputDiagnostic，避免合法的格式失败再次只给通用错误 | 仍为 STORAGE_UNAVAILABLE，无可用审核对象 |

三项存储错误不是已证实的 SQLite、密钥、磁盘或锁故障；本次没有通过修改这些保护条件排障。
private storage 在源码及已安装 runtime 中均已有 17 MiB 独立解析器，三项请求体在此范围内。
排除了早期“512 KiB 通用解析器导致”的判断。guard-numeric-diagnostic.json 是对已安装
源码的**本机诊断副本**只改预算异常以输出数值的结果，三项均 nodes=100001、maxNodes=100000，
没有修改安装文件或生产预算；它是根因诊断，不是正式测试/覆盖证据。

入站复制只接受有界、无 getter/cycle/nonfinite 的 JSON，保留字段和文档顺序。文档 256 KiB、
导入 4 MiB/10000 文档/100 批等既有校验继续生效；新准备 importId 仍不超过 64 字符。
历史 128 字符选项仅为内部审核校验，不接收 MCP 调用者选项，也未改变实际 runMongoMutation
的 import_review/retire/recover 或业务入口。输出脱敏器的原有节点、字节、深度、秘密值预算均未增加。

管理员展示先跨全部文档学习敏感值，再逐文档做原有输出校验，防止秘密值跨文档回显。
复杂文档或展示预算不足时保留摘要并标注 withheldDocuments；原字节仍在加密记录中，
requestDisplay 明确 projectionIsInputProof=false。固定历史输入的本机展示可能有部分文档隐藏，
不能把这种投影当作完整原文或证明。敏感投影不参与请求摘要，不用于重建业务输入。

## Customer 原字节来源与校验链

原始保留请求来自原 import-plans/created-collection-plans 中保存的 request 或
import-requests-private.json 的既有条目，具体 JSON 位置及整文件 SHA-256 见 input-provenance.json。
不是用目标库现状、聊天、脱敏输出或新读取数据猜测重构。该证据同时区分三个身份：

1. 固定 final-input.json 的**文件字节** SHA-256 为 a27ceed...26e97。
2. 原准备脚本保存的 inputSha256，是 SHA256(JSON.stringify(original))；Customer 为
   de990ff87a87ed62bb621a247546cb845ae672dbb31a8a7f092526168866a1df。
   它不是原文件字节哈希，也不能代替受保护工具的输入校验。
3. 通过原 importPreparePayload 字段顺序产生的原 wire 摘要，Customer 为
   047df81e2639c31aeac7e02daa772dd0e8ce5d5b2c0227b78ac82b68b24c03e6，
   与原查回记录和原审核请求一致。本机新校验返回的 wire JSON 及摘要逐字一致，password 字段未删改。

5 项保留文档均与固定 final-input 中的值、字段顺序和文档顺序匹配，输入文件未写回。
上述新校验接受仅是本机维护事实，**不声称旧工具已接受原字节、不补造可信历史派发绑定**。
真实旧状态仍 unresolved/unknown；provesNotDispatched 继续 false。

## 原导入身份、原审核错误及本次公开调用

交接表中的 5 个 operationId 是**审核准备失败调用**的关联标识。更早的原导入 operationId
另有其值；本次保留原导入身份和原候选，外层本次工具调用获得新关联标识，不能混用：

| 集合 | 原导入 operationId | 原审核失败 operationId | 本次同身份审核尝试 operationId |
| --- | --- | --- | --- |
| Customer | 15d32144-7f38-446f-82bb-62931fd4eaab | 50796dc8-3713-4403-a9cc-3e257be42092 | 71fe31e8-e378-4a3f-a34b-7d071b0c19b4 |
| RestaurantLog | 8948b344-939a-4a7d-8d8c-8a82c75e401a | a3e1f978-451d-4b9c-b2ca-952f4012a81e | 88ea2242-d420-4a10-809d-a2abadc9dc86 |
| Res_EJPOH_Booking_Order_History | 539e0df0-007c-440d-8de7-b5eb2707fe8c | 32708b7e-f18d-458f-ac8b-addb2fd812d0 | 4bf0ea41-fef2-4a8c-b870-8fbba688ff95 |
| Res_EJPOH_Booking_Order_Log | b4c1f446-38ac-43bc-938e-0e65195ae2a5 | 1897d0e7-b3c2-4d41-81a8-2818c007ff69 | 8e6192c3-0c55-478e-9c3d-8685a35340a1 |
| tag_definitions | 011bf920-d034-4979-8c48-02fae58e5512 | 241357a7-a397-4ac6-9d6f-f83bccd433e8 | 56a2431b-f9ff-4dee-b9ad-17b2d8faf696 |

原 importId、既有 replacementImportId、原 requestDigest、准备响应及读取缺口逐项见
real-review-verification.json；候选 ID 是原失败请求已有的值，没有新造替代身份。
沿用原 context 87281bfb-b6f9-46a0-8a55-11ef57869d9e，通过宿主支持的环境附件启动已安装 MCP，
未读取/输出 capability 或密钥，也未直接打开真实 SQLite。公开工具仅有 5 次 prepare_orphan_risk、
8 次 inspect_orphan_risk（四项既有 consumed 对象各前后一次）、2 次原 Google intent 的 inspect。
5 个失败返回均无 riskPlanId，无法进一步 inspect，不能猜测 ID，也不能断言记录不存在。

四项既有对象 SensitivityLog、WhatsappStatistics、Res_EJPOH_Coupon_Package、Res_EJPOH_Dish
前后均 consumed，原 reviewHash、approvalAuditId、consumptionAuditId 均未变化；没有重复消费。
Google intent 5388d193402ef9f9826a47837aae7f57d51e91168d9025a565350458108e5354
前后 inspect 均 uncertain，历史结果继续 unknown。原唯一替代/子接续谱系、回执及锁未手工修改。
没有任何真实 consume/prepare_import/execute/rollback，也未修改源或目标业务数据。

## 本次隔离验收与证据

| 验证 | 实际结果 | 证明范围 |
| --- | --- | --- |
| TestFlow pilot | 1/1，通过；按模式排除 8 例 | 新的敏感业务字段完整保存/展示脱敏用例 |
| TestFlow 完整回归 | 6 文件，71/71，通过，0 失败/跳过/模式排除 | 62 原回归 + 9 新审核输入/安全边界用例；完整重跑，不拼接 pilot 成功 |
| network-none 原生补充 | 61/61，通过 | 真实 MCP/Manager HTTP/privacy Worker，5 种合成输入创建与读取；源码/打包旧回归及输出守卫 |
| 本机真实浏览器 + 可丢弃工作台 | 通过，0 pageerror | 新展示状态/页面、独立审核交互；OS 身份弹窗为替身，未派发业务 |
| 5 项保留真实输入的纯本机校验 | 5/5，wire/文档值及顺序不变 | 仅新校验器，未接触真实保护存储，不是实际审核对象 |
| 原上下文真实审核准备/读取 | 0/5 可用 | 上述 5 次公开工具实际复现错误，等待修复加载 |

TestFlow 使用不可变镜像 f285f1a29f9bff2da01186c7c0bc190ac0050d0a66dc8769915331a813098e9b，
exact-lock=true、network-none/no-services。6 文件均 fixedInputVerified=true、
executionSourceUnchanged=true、workspaceStateUnchanged=true、cleanup=completed；sourceUnchanged=null
不当作工作区未变的替代证明。原生补充使用固定镜像
61a0b3c3fa5e261a6600fc549814dffa70f96936374435151bb3765c7aa423dc、私有 tmpfs、只读源码挂载。
所有隔离用例使用合成数据；真实输入不进入版本化测试资产或容器。

- 最终 snapshot/workflow：b01ce478dc6cd0eac8215e4813d5ea549648796e97ea6b557c3fdd17641008ff。
- base：c02acfd8fc26e19480a00825c2b998edd53ed898；target contentHash：e6439fd9e1b826902777dc66971bd68e47ba426366430a3bd5d3745a46e9bd1b。
- analyze：4b30555b-5fd5-49f4-b690-6ebc38039aea；scope：7d33849317b9d87855d42c9143a0ce9419cdb9d42c4fae9deb8443f7b6f7afe6。
- graph：b39ce04d-5a54-47b3-a7a8-4effa119a40a；plan：3a80405d-6e91-40e8-bb48-a6f3ef1f80c7。
- pilot prepare：86311b00-ddf8-4632-8f8e-c3e43322dfea；execution job：ba50aeb8-dc02-455e-8146-fb27741aca00。
- regression prepare：aab18de8-a8c1-4210-b4c3-28ac25f02740；execution job：103a04f8-fa80-4f6a-afb5-81f38e8b2aa4。
- regression flowId：49340217-97fd-46af-a07c-f8a3999b061f；reportHash：0a1e38f2c6f230eef983451c2c20a50e312e8d3b5b4b9e5b8500e0ba70f86fbe。
- 新增 9 例文件 runId：e0ab4f58-cddd-4311-8548-bff98bf9341d；evidenceHash：7eb30ffaea88208c8f6058a8f154900ac4a1f13ddc2749b010ca911e2294fc61。

verified-results.json 来自实际 MCP evidence 返回的各文件 execution-result 与哈希；冻结、绑定、
原生结果、浏览器截图及真实响应同目录。完整工具证据、原始开发失败日志和私有诊断在：
/Users/zhengchenchen/Documents/Codex/2026-10-28/ssl-debug-agent-review-errors。
报告在测试结束后新增，不混入被测快照；工具 raw 证据受自身保留策略影响，不保证永久可用。

## 覆盖结论及未执行项

已执行断言覆盖：原文中的敏感字段及跨文档副本保护、加密存储、精确摘要和顺序、正常输出预算
保持、复杂展示降级、长历史身份与普通新准备隔离、重复准备读取同一对象、非法 JSON/大小/数量/
重复 ID/元数据拒绝、封闭输入诊断、普通准入、独立管理员/系统验证边界、旧 consumed 及未知重派保护。

严格源码目标：862，明确 covered=0、notCovered=0、unknown=862，原因 source-coverage-missing。
按类型为修改块 759、条件结果 86、入口 7、未展开变化 10；不能称为全部分支/路径或操作完成覆盖。
完整 A/B 仍保留，scope 为 7 入口、14 变化函数、45 相关函数；90 范围外变化及 28 未选入口不删除。
图 truncated=false、partial-static；候选搜索受预算限制，未采集有序 trace。

未完成：真实 5 项可用审核对象及读取、修复的本机加载、真实 OS 弹窗、真实 Mongo/SSH 下的
本修复业务执行/回滚、所有仓库测试/跨平台矩阵。原报告 700 已提交、664 已准备暂缓、会员身份冲突、
跨餐厅和其余暂缓数据保持原边界，本轮不核准或导入其中任何数据。

开发试跑有两项实际失败，日志保留：新合成 491 条用例沿用小夹具 batchSize=2，触发既有 100 批上限；
改为该合成场景显式 2000，未改真实数据批次。首版大 HTTP 合成夹具本身超过既有 business-privacy
100000 节点上限，缩为仍超过原输出预算但合法的合成形状，未放宽该保护。新增跨文档秘密值测试、
仅历史审核分支及保护 Worker 依赖拆分后重新 freeze/计划；旧 prepare 仅预检，未执行也未借用为通过。
最终 TestFlow pilot/完整回归均无失败尝试。

## 剩余阻塞与下一步授权边界

本次明确要求“不将本次交接解释为新的安装/更新授权”。因此只修改本地源码与候选 runtime，
没有改已安装缓存、重启 Manager/Worker、提交/推送/PR、发布或远端部署。
现有 Manager PID 82501 的 runtimeId 仍为已安装
2.4.0:dd6590b6d124997ae5c99a03061d7eee9d20ba0110643e4e91f0a9d9dc920497。
即使源码修复通过，也不能声称这个旧进程已经执行新校验器。

要完成真实 5 项验收，需要用户**另行授权更新并加载本机插件/Manager 修复**；应先核对在途任务，
按新的发行身份安装并核验实际加载，再用本报告已有原 context、原导入 operationId/importId、
原 requestDigest、既有候选和同一 memo 调用 prepare_orphan_risk，读取其返回的同一 riskPlanId。
必须逐项记录新调用标识、绑定、状态及 inspect/read 证据；任何冲突继续停止，不能换身份。
该加载授权仍不包括风险批准、consume、业务导入或回滚。本轮没有自动请求或执行这些业务动作。
