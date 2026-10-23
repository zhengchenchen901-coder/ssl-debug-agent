# default 索引创建回执与对账修复报告（2026-10-22）

## 结果与范围

本地源码和仓库内配套 runtime 已修复，Agent 全套 410 通过 / 7 跳过、插件全套 98 通过 / 4 跳过，均为 0 失败。独立双节点 MongoDB 4.4.30 副本集分别使用驱动 3.3.4、6.21.0 完成真实验证，各 1 项通过。

本次 18 个索引的数据库完成结果沿用原官方严格核验证据；本次只读复查了相关 journal 和连接配置。16 个异常 journal 仍为 commit_failed，历史回执没有补记成功，原任务的 partial 结论保留。没有生产 DDL、业务文档写入、回滚、实例重启、插件安装/发布、Git 提交/推送，也没有改动 OD-Yennefer-BE 或向原业务会话发送消息。

官方证据：taskId `83a30427-8af0-4e9f-9d62-e5cd919ade56`；结构化 artifactId `cb711933-a61c-4c56-a0ea-8f9a80a74978`。本报告的 [evidence.json](evidence.json) 保存全部 18 项原 mutationId、planHash、intentId（原结果提供时）和本次筛选出的 16 条 journal 摘要，不含连接凭据、URI、业务前镜像或受保护上下文凭据。

## 已证实的问题与证据边界

1. **索引元数据读取继承 secondary。** 官方只读工具确认 default 的 production 分组、yenneferbak、readPreference=secondary，当前实际驱动为 3.3.4。远端驱动 list_indexes.js 将 listIndexes 标为 READ_OPERATION / EXECUTE_WITH_SELECTION。旧 mutation helper 的 MongoClient 和 listIndexes 都未指定 primary；createIndex 属于写操作。独立副本集暂停 secondary 应用复制后，创建命令已确认、primary 索引存在，而继承 secondary 的 listIndexes 缺少索引，真实复现了这条不一致路径。
2. **单次即时读取放大了上述窗口。** 旧 __commitIndex 在 await createIndex 返回后仅 listIndexes 一次；找不到名称就抛 MONGODB_INDEX_COMMIT_UNKNOWN，也没有核对同名索引的完整定义。这一错误码在该分支意味着创建 API 已返回，但随后元数据验证失败。
3. **未知状态被覆盖成失败。** 外层 __commit catch 将该异常统一写为 commit_failed，技术 journal 只留下失败状态/错误码，没有可独立重用的创建确认、原 execute intent 绑定和归属证据。prepare 中 afterIndex 已预填“预期定义”，因此它本身不能当成执行后观测或回滚所有权证明。旧状态机实际上也拒绝再次提交 commit_failed；未发现本事件自动重放的证据。
4. **恢复协议只识别终态，无法推进中间状态。** 原正式恢复可按 mutationId + planHash 获取 journal，但只有 committed / rolled_back 能让相应 intent 完成；commit_failed 即使业务索引存在仍不能闭环。原返回 remote_evidence_unavailable 同时覆盖取证失败和“取到了非终态证据”，掩盖了区别。自动重放入口原先还读取有数量上限的 mutations/list，存在旧记录被截断的额外问题；本事件没有证据证明发生了截断。
5. **新会话还有独立的上下文权限限制。** 本会话对代表 intent 执行正式 mode=inspect，返回 BUSINESS_OPERATION_DENIED，operationId 为 `8ac7bdb7-fa87-478c-a1da-b0e8c4947638`。这说明当前受保护上下文无权读取原记录，不能据此断言原记录不存在，更不能复制 capability 或修改原会话解除限制。原事件的 inspect/reconcile 输出来自原官方结果。

当前 secondary 配置、旧驱动路由与单次读取缺陷已证实，故障机制已在真实副本集复现。**16 次历史调用实际选中的节点、当时复制落后程度和其他并发 DDL 没有逐次追踪证据**，不能将每一次失败都唯一归因于 secondary 延迟。生产 MongoDB 4.2.25 未在本次实机重放；本地使用 4.4.30。4.4 的复现准备命令显式 commitQuorum=1，仅为在暂停复制时完成测试 DDL；生产 helper 不设置该选项。

## 修复实现

- mutation 客户端和索引目录读取显式 primary。创建、删除、恢复与回滚共用元数据读取逻辑。只读验证最多 3 次，间隔 100/200ms，每次设置 maxTimeMS=15000；不会重发 DDL。读取异常或不可见可有限重试，已出现的同名异定义立即停止。
- 完整比较名称、键及键顺序、unique/sparse、TTL、partial filter 和 collation；unique/sparse 的缺省与 false 归一化，避免服务器省略默认 false 引起假冲突。
- 创建改用固定 createIndexes 命令取得原始确认，指定 majority write concern 和有界 wtimeout。createIndex 的字符串返回原先丢弃了 numIndexesBefore/After 与 no-op 信息。确认回执先 fsync 保存，再验证目录。无新增索引计数或存在 no-op 标记时不授予创建/回滚归属。
- 本地 intent 在派发前原子保存一次 execution 绑定；远端回执绑定 intentId、execute operationId、mutationId、planHash、数据库、集合、动作和连接配置来源。重复 claim 不会启动第二次派发。
- 已派发后的网络中断、超时、写关注异常、验证失败归类 commit_unknown；明确的服务端拒绝保持 commit_failed。两类均不自动重放，commit/rollback 超时也不返回“可自动重试”。commit_started 无确认的崩溃状态保留待对账。
- Manager 通过内部 recover-execution 路由取得精确证据；只在原绑定、已持久化且证明实际变更的确认、primary 完整目录验证同时满足时，更新技术 journal 并完成原 intent。恢复操作不执行业务 DDL。MCP 不再提交自行拼装的 reconcile 证明，也不依赖截断列表。
- 恢复后保存真实 afterIndex，继续使用原 rollbackExpiresAt；补偿回滚同样保存确认、验证目录并支持 rollback_unknown 的精确恢复。回滚仍需原正式确认，且目标定义改变时停止。锁不会因年龄被执行/恢复入口删除。
- 完成对账时同时解除 synthetic task 的长期 pin；未知 intent 继续受保护。证据缺失、历史证据不足、元数据冲突和远端取证失败分别返回明确原因或脱敏 recoveryCode。
- 更新 database-mutations 技能，说明索引未知状态、历史证据限制和受支持恢复流程。未改 prepare 阶段的旧身份协议；其原有回归继续通过。

### 状态流转

`planned → commit_started → dispatching receipt → acknowledged receipt → primary verified → committed`

派发后无法确认或复核失败：`commit_unknown`；恢复只执行 `原回执核对 + primary 目录读取`，成功后保存真实 afterIndex 并进入 committed。无执行确认或归属未知则保持未决，不回到 planned。回滚对称使用 rollback_started / rollback_unknown / rolled_back。

## 回归结果

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| Agent 全套，Node 22.23.3 | 417 项；410 通过，7 跳过，0 失败 | [agent-tests.tap](agent-tests.tap) |
| 插件全套，含 source/bundled Manager、MCP/Manager 重启 | 102 项；98 通过，4 跳过，0 失败 | [plugin-tests.tap](plugin-tests.tap) |
| 真实双节点 MongoDB 4.4.30 + 驱动 3.3.4 | 1 通过 | [replica-driver-3.3.4.tap](replica-driver-3.3.4.tap) |
| 同上 + 驱动 6.21.0 | 1 通过 | [replica-driver-6.21.0.tap](replica-driver-6.21.0.tap) |
| 本地 runtime 生成 | 成功；未安装/发布 | [runtime-build.txt](runtime-build.txt) |
| git diff --check | 通过 | 最终本地检查 |

新增回归覆盖即时不可见后可见、读取断连后可见、持续不可见后的精确恢复、真实服务端拒绝分类、DDL 后连接中断/超时、同名异键/键序/unique/sparse/partial/TTL、提交前出现既有同名索引、并发 same-spec no-op、历史 journal 无执行确认、缺 journal/旧锁、原 intent/op/planHash 不匹配、execute 幂等、MCP 重启及回滚验证丢失恢复。真实副本集验证包含 primary/secondary 分歧、真实命令确认、恢复后 execute 不重复创建、原证据补偿回滚。

全套跳过项包括 Windows 专用验证、macOS Keychain 实机入口、已占用 4343 端口、显式启用的大日志和其他真实数据库集成入口；本次索引真实集成默认也跳过，但已按上述两种驱动分别显式执行。测试只使用新建本地容器及临时 journal；本次容器已清理，既有容器未操作。

复现入口：使用专用、可丢弃、启用 enableTestCommands 的双节点 loopback 副本集，设置 RDA_INDEX_TEST_URI 和 RDA_INDEX_TEST_DRIVER 后运行 `node --test agent/test/mongodb-index-replica-set.test.js`。该测试会暂停该副本集 secondary 的复制并创建/删除唯一测试数据库，不能连接任何现有业务实例。普通回归运行 agent/ 与 plugins/remote-debug-agent/ 各自的 npm test。

## 16 项历史回执与后续路径

本次官方只读 journal 复查 operationId `40700953-4df3-464f-90c3-f71e49a1a717`，与原 18 项 mutationId/planHash 精确筛选后，异常 16 项全部仍是 commit_failed。**本次闭环 0/16；这 16 项继续视为 uncertain。** 原索引存在与原提交回执是否可信是两个分别记录的事实。

受支持的步骤是：在具备原受保护上下文的会话/配置中，用同一 default、yenneferbak、原 intentId 调用正式 inspect/reconcile。上下文只能通过既有合法 attachment 恢复，不向对话导出凭据。以后独立授权安装修复版本后，新执行记录有确认回执时可通过上述流程自动闭环；这次没有安装，也没有对线上历史记录运行新代码。

对于这 16 项旧记录，旧 createIndex API 没有持久化原始 no-op/创建归属确认，新代码不能补造。正式流程应返回 legacy_execution_evidence_required 并继续保护 intent。现有协议没有“仅凭目录存在就强制完成”或“导入任意人工证明”的入口；如果找不到与原操作绑定的可信执行证据，受支持的结果就是保持 uncertain、保留官方业务状态核验与未决报告，供后续人工审计。将来如需引入额外审计证明，必须先设计单独受审查的结构化协议，不能手改 journal、清锁、换 mutation 或替代建索引来绕过。

原 rollbackTtl=7 天仅表示请求窗口；本次验证的是隔离测试中新回执链路的补偿回滚，没有验证这 16 项的生产回滚归属，更没有验证“7 天后自动回滚”。
