# Import 未知结果的人工重试审核：本地交付

日期：2026-10-27（Asia/Shanghai）。实现已完成，改动保留本地，候选 runtime 已同步构建；未安装、发布、部署、提交、推送或创建 PR。未读取真实导入 documents 文件，未触碰 test-server 的原意图、管理员批准、替代任务或业务数据。

## 行为与审计边界

- 公开 disposition 接受严格的 import/bulk 联合输入。Import 使用原 `/mongodb/imports/prepare` 路由及原上下文核验 keyed JSON 身份；历史信封缺少 importId 元数据也不能绕过精确原输入验证，不伪装 bulk。
- Import 候选只可更换 importId；实例、数据库、集合、文档内容/顺序/BSON 字段顺序、batchSize、purpose 与 rollbackTtlMs 精确绑定。原/新确定性批次 mutationId、文档数和请求摘要共同纳入审核。
- Manager 使用固定只读 helper 审查原批次 manifest/planHash/状态，并保留来源、时间、缺失/冲突/不可用等事实。原始输入加密保存，原 uncertain 记录、恢复证据和引用 pin 保留。人工接受风险始终不等于证明未执行。
- 独立管理员工作台显示 importId、文档数、批次身份、回执观测和未知风险；沿用同一会话审阅、确认短语与每次新执行的原生系统所有者验证。Manager token、MCP、actor/proof 和聊天确认不能批准。
- 批准只关闭原 import/已绑定原批次的后续准入。建立时先写入并读取验证持久化的 import 定向关闭/lineage 控制，再在 SQLite 事务中建立唯一替代意图和 gate。普通 Manager 代理不暴露控制路由；重复、并发、到期复审和丢失回包沿用同一身份。
- Import 使用原生批次 prepare/journal，planHash 绑定 riskLineage，不需要 bulk 封口。缺少精确终态回执的已派发尝试保持 uncertain，禁止重派。同步预检确证未派发可按同意图重试；完整 prepare_partial 回执允许先归档前缀证据，再使用相同输入/意图继续下一 attempt。
- 人工批准不执行业务写入。每批仍需既有确认及精确 mutationId/planHash；保留幂等、已有文档拒绝、事务未知结果保护及回滚冲突检查。原批次被拒绝的后续调用不会重写其历史 journal。新版 helper 在工作入口和事务提交前检查定向关闭，不声称召回历史旧 helper/在途事务。

主要实现：`agent/mongodb-import-risk.js`、`agent/mongodb-import-control-runtime.js`；接入点包括 privacy-service/store、MongoDB mutations/disposition/risk、MCP 输入/隐私解析/闭合输出契约及工作台。既有 bulk 首块、守卫等价、封口和执行门禁保留。设计详见 `docs/human-risk-replacement.md`；项目内 database-mutations 技能同步说明 import 流程，未修改安装缓存。

## 执行结果

| 验证 | 实际结果 | 边界 |
| --- | --- | --- |
| 固定未提交工作区 | TestFlow freeze 与逐文件哈希核验成功 | 只固定源码，不表示测试通过 |
| 隔离 Node 22 容器回归 | 292 通过，0 失败、0 跳过 | 26 个显式选择的源码/打包、import/bulk、隐私、恢复及工作台测试文件；网络为 none；补充原生测试 |
| 新增 import 测试 | 18 个专属状态/恢复/安全夹具 + 2 个公开 MCP/源码及打包 Manager 链路通过 | 包含 4 个真实 SIGKILL SQLite 事务边界；原生身份对话框为测试替身 |
| 真实 MongoDB 集成 | 1 通过 | 内部 Docker 网络，无端口发布；MongoDB 4.4.30、Node 22.23.3、mongodb 6.20.0，两个批次、3 条虚构文档 |
| Import/bulk 浏览器 | 两条真实 Chrome + 独立工作台 HTTP 流程通过 | 系统身份验证为测试替身，审批未建立业务任务或写入；截图在外部证据目录 |
| 候选 runtime | 清单所列文件哈希全部一致 | 仅本地构建，未安装或启用 |
| TestFlow prepare/execute | 未执行，明确阻塞 | 项目为 node:test，已安装执行器只接受 be-jest/jest-unit，且缺少兼容资产/输入/状态/断言绑定与执行契约 |

真实 MongoDB 用例验证了：既有原批次回执读取、旧任务关闭、替代准备回包丢失后的精确对账、人工批准后数据库仍为空、逐批确认、重复 commit 不重复插入、反序回滚至 0 条，以及原本机 uncertain 记录保持不变。本次所有测试容器和内部网络均已清理，镜像与证据保留。

首次真实集成尝试使用 mongodb 3.3.4，因其 BSON 缺少 EJSON，被既有 `MONGODB_IMPORT_BSON_REQUIRED` 门禁拒绝。该失败证据保留；随后使用具备 EJSON 的驱动完成独立集成，未放宽门禁。前期定向调试曾发现回执元数据顺序和技术字段参与摘要的问题，已修正并在最终固定版本完整复验。

## 覆盖与剩余缺口

已通过行为断言：精确身份/范围/顺序校验、类型引用恢复、无审批/跨会话/伪造凭证拒绝、原生验证取消、原/新身份保留、原任务定向关闭、唯一关联、审批到期及复审、终态 partial 接续、回执缺失/篡改/目标不符保持未知、回包丢失与重启、四个本机事务崩溃边界、源码/打包公开链路、幂等和逐批回滚；既有 bulk 相关选择集与浏览器流程通过。

未执行或未验证：真实 test-server 审核/替代建立/导入；真实操作系统身份弹窗；真实 SSH/旧 worker 的在途行为；其它平台；全部仓库测试；远端控制文件写入中断的每个窗口。旧 helper/已派发事务能否迟到提交仍为 unknown，不由人工接受风险消除。实例上的实际驱动/EJSON 条件未重新探测。

TestFlow 准备/执行及 AST/CFG/分支/有序路径覆盖均为 unknown；未采集覆盖率，不用文件通过代替目标覆盖。补齐正式 node:test 执行适配器或经审查的兼容接入、版本化绑定、不可变依赖镜像与隔离契约后，需重新 freeze/prepare/execute。静态诊断与本报告中的补充测试都不能表述为 TestFlow 验收通过。

## 证据

最终 snapshotId：`7bbad0227f029556eb239e792b684e9b8798aab6c33a52c1e98326b23c272f43`。

冻结源码 contentHash：`9caf08d4ec6b426086f5f8017988e28d5aee98aec1229e1b9985ecbe3689daf3`。

外部证据根：`/Users/zhengchenchen/Documents/Codex/2026-10-27/ssl-debug-agent-import-risk`。运行脚本、镜像 ID、原始回归/集成输出、首次失败、截图、TestFlow 原始快照与核验结果保存在该目录。仓库中收录 `evidence.json`、固定/阻塞回执和最终测试日志，均为合成夹具证据，不包含真实业务文档或凭据。最终报告文件是在测试后新增，未混入所测试的源码快照；已核验全部冻结文件与本地源文件一致。
