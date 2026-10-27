# Import 集合前置条件、错误诊断与执行恢复：本地交付

日期：2026-10-27（Asia/Shanghai）。代码、测试、技能说明、候选 runtime 和本报告留在本地工作区；没有提交、推送、PR、安装、发布、部署或刷新真实 worker。原有发行版本元数据改动保留，候选 runtime 的内容身份另列。

## 修复结果

- Import prepare 检查远端服务器握手、sessions、事务拓扑和现有普通集合；集合 UUID 进入 planHash。执行/回滚在事务读之前及取得读锁之后复核 UUID，拒绝缺集合、view/capped/time-series、同名重建和历史无 UUID 计划。客户端/驱动版本不充当服务器版本。
- 保护协议的只读 preflight 失败返回精确 `prepare_rejected` / `preflight_rejected` 终态回执。相同输入可以保留完整证据后预留下一准备 attempt；缺回执仍 unknown。partial 接续保留。
- 新增公开结构化 `remote_debug_mongodb_prepare_collection`：一个白名单内普通空集合，无业务索引、无 options，prepare/execute 都核验已认证主体的可见 createCollection 权限，执行需要独立的精确 mutationId/planHash 和 `确认执行`。同名对象不收养；无提交回执不重派。集合初始化明确 `retained_non_rollbackable`，从不自动 drop，即使当前为空也不能删除后来业务数据。
- 新保护执行 ticket v2 固定 intentId、operationId、mutationId、planHash、attempt，远端回执另绑定目标、连接来源、模式及真实确认。只有提交前未开始事务，或精确事务的正向 abort/NoSuchTransaction 回执，才形成 safe_terminal；随后明确同输入调用才能预留同意图下一 attempt。原本机信封、审计和远端 manifest 完整归档。重复旧 attempt、迟到 claim/结果、身份不符和缺证据继续保护。
- `abortTransaction()` 返回可能吞错，不能充当证明。仅消费命令监控中精确 session/transaction 的成功提交/abort（无 write concern 错误）或提交前的服务器 NoSuchTransaction=251。回执只保存固定类别、session/transaction 摘要和请求编号。commit 已发出、abort 未确认、回滚未知分别保留 unknown；SIGKILL 遗留锁不按年龄回收。
- 公开 protected-storage `outcome` 也不信任调用方成功对象；Manager 使用精确远端 reconcile 回执完成本机保护，不用列表、当前0条、错误文本、锁龄或 commit_retryable 字符串放行。
- helper → Worker → Manager → MCP/审计保留封闭的错误类别/阶段、有界数值码、已知文件系统码、服务器 wire version 和远端驱动版本；不输出任意 errmsg、异常堆栈、业务文档或凭据。
- 最终结果 references.mutationId 复用真实 mutationId 安全契约，接受合法的 `import-` 加64hex；路径、空白和任意文本仍拒绝。

主要代码：`agent/mongodb-mutations.js`、`mongodb-import-control-runtime.js`、`privacy-store.js`、`privacy-service.js`，以及插件的 `business-storage.js`、`mutation-diagnostic.js`、MCP/输出契约。完整设计及边界见 [human-risk-replacement.md](../../human-risk-replacement.md)。

## 实际版本复现与根因范围

两个可丢弃、内部网络、无宿主端口的真实 Mongo 副本集启用 keyFile/authorization，使用合成 readWrite/read 账户；执行驱动均为 mongodb 6.20.0，Node 22.23.3。

| 实际服务器 | 握手 maxWireVersion | 旧式缺集合事务的独立复现 | 修复后集成 |
| --- | --- | --- | --- |
| MongoDB 4.2.24 | 8 | 服务器数值码263，未取得成功提交 | 1/1通过 |
| MongoDB 4.4.30 | 9 | 可以隐式创建并提交 | 1/1通过 |

集成测试验证显式建集合权限/确认、空集合回执、真实只读身份写入拒绝13、真实唯一键拒绝11000、精确安全终止回执、同意图下一 attempt、幂等、回滚至0以及集合禁止 drop 回滚。每个集成使用2条虚构业务记录；测试种子索引只用于制造唯一键拒绝，集合已由独立建集合计划创建，不是建集合绕过。

这证明缺集合的事务行为存在服务器版本边界，不能把本机客户端版本、缺集合或当前0条当成真实故障的唯一根因。真实 test-server 的底层数值码、服务器版本/FCV、权限和迟到事务结果本轮均未重新探测。

官方事务条件说明：[MongoDB transactions](https://www.mongodb.com/docs/manual/core/transactions/)。本机保留页面读取结果；上述两个版本的行为结论以实际隔离数据库和固定测试源码为证据。驱动6.20.0 `lib/sessions.js` 的 abort 吞错分支也在固定依赖镜像中直接复核，不能用 API Promise 成功代替服务器回执。

## 最终执行结果

| 验证 | 实际结果 | 证明边界 |
| --- | --- | --- |
| TestFlow freeze | 已固定并逐文件复核 | 未提交源码；不表示测试通过 |
| TestFlow Jest pilot | 1通过，0失败，另26例被筛选 | 代表性精确恢复用例；另一文件未入pilot |
| TestFlow Jest regression | 31通过，0失败、0跳过，2个文件全部执行 | unit / network-none，无真实 Mongo/SSH/系统身份弹窗 |
| 隔离补充原生回归 | 401通过，0失败、0跳过，34个文件 | 同一最终快照；不冒称TestFlow执行 |
| 真实 Mongo 集成 | 4.2.24、4.4.30各1通过 | 同一最终快照、真实文件、驱动和授权副本集；资源清理全部成功 |
| SQLite/远端 SIGKILL | 新增本机4个、远端4个窗口通过 | 真实进程死亡/临时文件；数据库事务部分为明确替身 |
| 候选 runtime | 清单所有文件哈希一致 | 只构建，未安装或启用 |
| 历史浏览器证据 | 6个产物SHA-256核验一致 | 沿用前轮结果，不冒称最终快照浏览器重测；系统验证为替身 |

补充原生集涵盖 human-risk-acceptance-v2 独立工作台/原生验证替身、原任务定向关闭、唯一替代、业务效果/文档/BSON字段顺序、partial、逐批确认、幂等、回滚冲突及bulk。源码和候选打包 Manager 的公开 MCP 用例额外验证数值诊断、精确执行恢复和下一 attempt。

TestFlow 最终严格目标1306：covered=0、notCovered=0、unknown=1306。原因：source-coverage-missing=1294、source-reference-missing=12；mappedFiles=0、missingFiles=17。已安装执行器的非src采集过滤未修，未改缓存、搬移源码或虚构计数。图 partial-static/truncated，84个未展开变化目标和119个排除入口保留；当前scope工具报告范围外变化0。前轮报告的1000个unknown、范围外361项属于原快照/范围，原材料保留，不能并入或被本轮替换为覆盖通过。有序路径、逐matcher完成、复杂操作完成仍unknown。

## 证据身份

- snapshotId / workflowId：`60550c46eaf623ff88719b5d1b8c99c9f5f417c5b68e447eedfcfa6a9e304ece`
- source contentHash：`7e44cf535140f5ef9c13450f961e2c8a130568ec6d3a6c80a3e4a6ecca6951b3`
- 基线：`3490a7905779d23195ecefacdb3fffec79af0635`（会话开始时已存在）
- 候选 runtimeId：`2.4.0:925bf7f1718686c6de1a5975485ac91a4ddbd35164824db514445ee4d704c85f`
- analyze：`82d035bd-d4c2-4806-91c9-33d6c983a592`；graph：`21116467-f624-4156-961e-59adc52bee61`；plan：`49d3fb46-1d0f-49fd-b46f-a34c82b55489`
- pilot prepare job：`ea3d1248-fc60-4403-9d84-732a339b1c2d`；execute job：`3ea67021-edfb-4689-92be-1af71d77a095`
- regression prepare job：`001b85d4-f08f-488b-847c-9ac7b24b2509`；prepare run：`c63edc6c-e283-4787-858f-ef92051cd936`；execute job：`7bb9685c-ba13-4156-bed6-5b0567cdc8d6`
- regression reportHash：`e7fb09ca6c5e7b8d98663760ebd0480a21b207cfbfaaa1e3433ae81f6035ebf3`

外部原始证据根：`/Users/zhengchenchen/Documents/Codex/2026-10-27/ssl-debug-agent-import-execution`。本目录附可审阅的结果、绑定、源码核验和证据摘要；外部保留TestFlow完整分片、固定源码、合成日志及复现脚本。报告是在执行后新增，不混入被测快照；冻结文件逐一哈希一致。工具管理的raw材料受自身保留策略影响，交付副本的结果/哈希不依赖将来的raw永久可用性。

## 失败观察与未执行项

早期补充回归保留实际失败日志：native-initial为392/401（原错误码/文本断言与封闭诊断契约不符）；native-second为400/401（preflight新增客户端改变了旧fixture的close计数注入点）；native-third/fourth为399/401（发现Manager公共错误序列化丢失diagnostic，已修复并保持原断言）。partial故障注入改为第一批manifest已持久化的业务边界，未放宽partial断言。无回执的旧重试测试改用显式新ticket；另有专门旧记录拒绝用例。首次本机Jest尝试因根node_modules缺失未执行，改用现有不可变隔离镜像；无额外安装依赖。早期Mongo权限夹具未启用authorization，不能证明权限拒绝，正式版本已启用；部分早期试跑日志被后续试跑覆盖，不冒认仍有原始失败字节。首次静态graph预算300不足，按实际527提高600；保留truncated/unknown，不将静态成功说成测试通过。最后固定输入的所有实际选择均通过。

未执行/未证明：真实业务集合创建、风险批准、替代、execute/重试/rollback或worker刷新；真实SSH、原生OS弹窗和真实历史在途事务；其它驱动/服务器组合、sharded/存储引擎/FCV全矩阵、真实网络与write concern故障注入、断电持久性、跨平台、全部仓库测试、有序CFG路径及每个并发调度。网络/write concern/吞错和身份错配分支有合成测试，不冒认真实网络故障注入。

握手只是必要条件，不能证明所有FCV、分片和权限条件；后续运行错误继续按精确回执保护。执行锁进程死亡后的可信liveness/fencing恢复未实现，保持安全停止。真实旧任务和失败替代批次均没有补造v2证据、改SQLite、清锁或换任务；其unknown/uncertain历史仍受保护。即使以后补齐集合，也不能据本次修复解除既有真实执行保护或直接重试。
