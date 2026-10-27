# MongoDB import uncertain 预防与恢复：本地交付

日期：2026-10-27（Asia/Shanghai）。在上一会话未提交改动上继续修复；现有 import/bulk 人工风险审核、原意图保护与历史 unknown 语义保留。候选 runtime 已在仓库内重建，未安装、启用或部署。未提交、推送、创建/合并 PR、发布，未刷新真实 worker；未调用真实 test-server、批准真实风险、建立真实替代任务或修改原始意图。

上一会话登记的 22 个工件已逐个核验 SHA-256，全部匹配。本轮验证使用合成夹具；没有读取真实业务 documents 或复原不完整的原始输入。

## 修复后的行为

1. **配置生效检查分两次进行。** WorkerManager 保存实际启动输入的内部指纹，覆盖传给 worker 的实例/worker 配置、Mongo 白名单、SSH 信任等设置；不向外公布该指纹。新 import 在 claim 前检查 Manager 当前配置与 worker 启动配置，不一致时尚未 claim 就能原子关闭尝试。异步 claim 之后，在实际传输前同步再检查一次，覆盖并发配置变更。返回 `WORKER_CONFIGURATION_STALE` / Manager 的明确 `not_dispatched` 事实，不依据错误文本解除保护。已准入的运行中请求不被打断；它的回包丢失不会因后来的配置更新而变成“未执行”。更新接口与 runtime 显示配置是否需要显式 refresh；不自动重启健康 worker，refresh 失败保持拒绝准入。

2. **未 claim 尝试可以证明并关闭。** `recover_operation/reconcile` 对新 import 信封的未派发观察，必须在 SQLite 同一写事务内重新核对当前 attempt、状态和 dispatched 位，才标记 `rejected_before_dispatch` / `unclaimed_attempt_fence`。关闭先赢，迟到 claim 被拒绝；claim 先赢，仍为 uncertain。关闭回包丢失、重启和并发恢复都不会重新打开旧尝试。相同输入可在相同 intent 下递增 attempt；普通 import 与人工替代 import 都固定留存完整关闭信封。旧 attempt 的派发请求在入口直接拒绝，不能给新 attempt 写入诊断字段；旧回执也不能更新新 attempt。已对账记录清除旧 reconciliation 提示。

3. **远端控制写入更严格。** 每个 import 定向关闭/lineage 文件原子写入后，除既有文件及所在目录 fsync，还同步 journal root 及其父目录，再逐文件读取并核对精确值。部分 I/O 异常保留已经写成的关闭/关联；相同 handoff 可补齐，竞争替代身份仍被拒绝。SIGKILL 遗留锁保持安全停止，下面明确列出此恢复缺口；没有按锁龄删除锁或删除历史控制记录。

主要接入点为 `agent/worker-manager.js`、`agent/privacy-service.js`、`agent/privacy-store.js`、`agent/mongodb-import-risk.js`、`agent/mongodb-import-control-runtime.js` 和 Manager 路由。项目内 database-mutations 技能已补充说明；安装缓存未修改。

## 实际验证

| 验证 | 最终实际结果 | 范围与替身 |
| --- | --- | --- |
| TestFlow 工作区快照 | 固定并核对源码字节成功 | 未创建 Git 提交 |
| TestFlow 正式 Jest 单测 | 代表性试跑 1/1；另行完整回归 4/4，0 失败、0 跳过 | 真实 prepare/execute/evidence，精确锁文件、不可变镜像、network=none；单测，不冒认 API E2E |
| 补充原生回归 | 31 文件，372 通过，0 失败、0 跳过 | 从最终快照在独立 Node 22 容器执行；不计作 TestFlow 原生测试执行 |
| 新增故障/竞态回归 | import 安全 11 项、远端控制 9 项均通过 | 独立 SQLite 进程竞态；6 个新本机事务 SIGKILL 边界；真实文件系统 I/O 注入及 3 个远端 helper SIGKILL 窗口 |
| 真实隔离 MongoDB | 1 通过 | MongoDB 4.4.30、driver 6.20.0，内部网络且无发布端口；2 批次/3 条合成文档，反序回滚后 0 条 |
| import/bulk 浏览器 | 两条均通过 | 真实 Chrome 和独立管理员 HTTP；OS owner 验证/终端为替身，0 业务写入、0 替代任务建立 |
| 候选 runtime | 清单哈希全部一致 | 仅仓库内构建，无安装/启用 |

针对性断言包括：Manager 新白名单/worker 旧配置、启动过程中配置变化、claim 后并发配置变化、运行中请求不被自动终止、refresh 启动失败、传输已开始后丢失回包仍未知；未 claim 原子关闭、跨进程 claim/关闭竞争、关闭回包丢失、进程重启、过期 attempt 不改写新记录、已 claim 且缺少回执不能重派。保留了 bulk 风险审核、唯一替代身份、原任务定向关闭、精确回执、逐批确认、幂等与回滚回归。

MongoDB 集成核验了原批次回执读取、旧 import/批次关闭、准备回包丢失后的精确恢复、人工批准不写业务库、重复 commit 不重复插入及回滚。身份替身不能证明真实系统所有者验证；VM Mongo 替身不能证明真实拓扑/驱动行为，后者只由上述独立 MongoDB 集成支持。全部本轮测试容器、网络均已清理，证据和固定镜像保留。

早期扩展原生运行曾失败：两项测试依赖从 agent 目录启动，已修正外部 runner；内存代理测试在 Linux 默认触发不受支持的原生钥匙串，已在该测试中显式注入隔离密钥，原 200/响应断言及生产 Linux 拒绝门禁保留。早期 Jest 试跑也发现过期 attempt 响应断言与 Jest/host structuredClone 的 realm 边界；最终断言验证入口拒绝及新记录不变，并在模拟 JSON 传输边界规范化合成输入。早期失败日志单独保留，未混入最终通过计数。

## 正式测试接入与覆盖边界

新增根目录 verification 专用 package/lock，以及 `verification/` 中真正的 Jest 用例、ESM 转换器、接入说明和绑定生成器。转换器仅生成带 source map 的 CommonJS，测试直接调用真实模块与 SQLite；没有在 Jest 中套跑 node:test，没有伪造执行适配器、测试结果或覆盖回执。绑定来自 TestFlow 固定资产的实际 assetId、文件哈希、输入/状态范围和断言 ID。新依赖镜像由 TestFlow build_dependencies 固定 root package/lock 构建，禁用安装脚本，最终 prepare 核验 exact-lock 相等。

**正式四用例通过不表示严格目标覆盖通过。** 本计划严格目标共 **1000** 个：已覆盖 0、已证明未覆盖 0、unknown **1000**；unknown 原因为 `source-coverage-missing`。范围外变化 **361** 项另行保留，排除入口 225 个；图为 partial-static 且有预算截断，未采集有序 trace。补充行为断言通过不能代替 AST/CFG/分支或操作完成证明。

依赖准备还有一项工具副作用：TestFlow build_dependencies 清理临时基础标签后，上轮无标签基础镜像 `sha256:3bfae9f7f179bc0b7e5433f0ae9eb211544eeeae34d5312352e05603cd3c659d` 不再能按原 ID 引用。本轮已从上轮保存的固定 Dockerfile/锁文件重建带名的原生回归镜像，实际新 ID 登记在 evidence.json；没有使用 prune。上轮 22 个文件工件的哈希匹配与旧镜像仍可用是不同事实。该临时标签清理行为应由 TestFlow 后续修正。

准确外部依赖已核实，安装缓存与实际 MCP 运行代码对应文件字节一致：

- TestFlow `dist/execution/execute.js:174` 硬编码只采集 `src/` 目标。本项目的 `agent/`、`plugins/` 虽属于接受的 unit.testRoots，却被该过滤器排除。需在插件中按验证过的源码根目录补齐采集，并重新核验 source map 与目标映射；本任务未修改插件或搬移源码制造覆盖。
- TestFlow `dist/execution/prepare.js:27` 仍只接受 be-jest/jest-unit。要把现有 372 项原生测试纳入正式 TestFlow，还需要插件原生 node:test 资产/用例、执行、断言、逐例报告、覆盖映射和隔离契约支持。本轮四项 Jest 正式结果与 372 项补充原生结果分别报告。

## 未闭合窗口与未执行项

- 成功 claim 后，如果在持久化明确未派发事实前崩溃，或传输/准备结果丢失且没有精确正向回执，仍保持 uncertain；不凭文件缺失、没有回包、锁龄或错误文本推定未执行。历史 legacy intent 仍保留原保护；人工接受风险不证明历史未执行。
- 远端 helper 在持有全局排他锁时被 SIGKILL，锁保留；相同请求的重试返回 `MONGODB_MUTATION_BUSY`，旧文件不变。尚无受支持的、核验进程生存身份并原子 fencing 的锁恢复协议；本轮没有删除锁或用“进程可能已死”解除它。I/O 异常可同身份补齐，与进程死亡后的锁阻塞是不同结论。
- 真实断电/内核崩溃的持久性未实证；旧 helper 和历史在途 MongoDB 事务能否迟到提交仍 unknown。配置检查只管新准入，不召回这些任务。
- 未执行真实 test-server 处置/批准/替代建立/业务迁移；未修改 `b7643b5f56c5641666a470dc5ae98e780f57d49b333349c32bbba072acaa13a2`；未验证部署生效、真实 OS owner 弹窗、其它 OS 平台或全仓库全部测试。

## 证据身份

最终 snapshotId：`80361fce479fecc1eac21f8a83b147b09b835c0a91bd7ef9008c2eec20313668`。

源码 contentHash：`18c0f9456ce67e87f8c343eacd0aeff7eff08402a687894c4c7b532a6728953f`。

候选 runtime：`2.4.0:11ac560dec7bef1fc01e6c3ef3e160d342cb28a46dae7d1c138df1568584e3c6`。

TestFlow 试跑执行 job：`fbf7eb12-b4a9-469b-9c72-9b2e8785aacb`；完整回归执行 job：`639e4712-2b9e-4e58-8653-2b68e4a1b342`；完整回归 run：`b2c71909-2ba7-4ef3-9cce-38542e09ec63`。精确 prepare job/run、scope、图与计划身份见 `final-testflow-stages.json` 及各阶段 JSON。

完整回归 evidenceHash：`128f8873204a82418b2404140e6b982443116a239026bf0b9fef3f943f58d977`；job reportHash：`067935fa3356a46ae073aeed2d4d98878146c12d511e61abef811e80d7c73b9e`。

仓库内 `evidence.json` 登记报告、原始 TAP、TestFlow evidence、绑定和阶段回执的 SHA-256。外部证据根为 `/Users/zhengchenchen/Documents/Codex/2026-10-27/ssl-debug-agent-import-safety`，包含隔离执行脚本、旧失败尝试、镜像构建回执、截图及 `.testflow` 固定输入、阶段和归一化证据。原始覆盖正文的保留状态以工具 `rawAvailability` 为准。报告与证据副本在执行后生成；最终已核对所有冻结文件与本地源文件字节一致，不把后加报告伪装为已测试源码。
