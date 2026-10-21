# 业务敏感数据保护：第二阶段验收

日期：2026-10-21（Asia/Shanghai）。全部业务测试使用本机隔离环境；未调用线上、test-server 或历史远端任务。

## 实施结果

- 新增统一私有持久化服务：Manager 现有 HTTP 认证 + 上下文 capability + 当前目标校验，专用 Worker 封装 `node:sqlite`。没有新增 SQL、映射枚举、解析原值或密钥导出 MCP 工具。
- SQLite schema v1 保存加密上下文、引用、任务关联、操作意图、恢复状态、输出交付及脱敏事件。采用 WAL、`synchronous=FULL`、5 秒 busy timeout、短事务与有界队列。
- 真实值在进入数据库/WAL 前逐条 AES-256-GCM 加密；随机 nonce、完整认证标签、key version、上下文/目标/类型 AAD 和独立 HMAC 去重索引。反向索引与密文对应关系也会验证，不能通过调换索引重定向引用。
- 主密钥使用 macOS Keychain，未落入普通配置、argv、数据库或日志。Keychain 不可用、错误密钥、损坏记录均安全失败；Windows/Linux 尚无生产凭据适配器，保护数据的 MongoDB 调用拒绝持久化。
- MCP 通过本机 0600 附着文件恢复上下文，支持多个进程共享及 Manager 重启后使用原引用。默认上下文隔离；知道 context ID 不足以访问映射。不猜测 Codex chat ID。
- 映射、任务关联和加密输出交付记录先在同一事务提交，再发布引用。活动任务及未决意图 pin 住引用；终态后按回滚窗口保留；清理单次有界。
- 远端调用前提交输入映射、pin 和操作意图，成功回执后记账。结果不确定时读取原远端 job/日志及租约状态；只有同 ID、同 planHash、对应终态才能完成对账。其余保持未决，不自动重放。原有批次事务、receipt、计划哈希、确认、白名单和有效期继续生效。
- 保留第一阶段全部 BSON/EJSON 类型和复合 ID 字段顺序；补上未见过的业务值可能从驱动异常进入 HTTP/活动事件的出口，保留错误码并省略原始异常正文。
- 更新 MongoDB、database-mutations Skill 及批量任务参考文档。构建新增 `privacy-worker.cjs`，manifest 纳入哈希；固定 esbuild 工作目录，保证从仓库根目录和 `agent/` 构建得到相同产物。

初始 `git status --short` 为空，第一阶段源码和报告已经存在。没有 reset、覆盖第一阶段实现、发布或合并；本阶段改动保留在当前工作区。

## 验收证据

| 检查 | 结果 | 证据 |
|---|---|---|
| 插件完整回归 | 87 通过，0 失败，4 跳过 | [plugin-tests.tap](plugin-tests.tap) |
| Agent 完整回归 | 367 通过，0 失败，6 跳过 | [agent-tests.tap](agent-tests.tap) |
| 隐私/恢复专项，含真实 Keychain | 29 通过，0 失败，0 跳过 | [privacy-focused.tap](privacy-focused.tap) |
| 新建真实 MongoDB 副本集全链路 | 1 通过，0 失败 | [mongodb-e2e.tap](mongodb-e2e.tap) |
| 隔离 MCP diagnose | 退出 0；initialize、tools/list、自检通过 | [diagnose.txt](diagnose.txt) |
| 两个 Skill 校验 | 均通过 | [skill-validation.txt](skill-validation.txt) |
| 根目录/agent 目录分别构建 | runtime ID 一致，21 个产物哈希通过 | [根目录构建](runtime-build.txt)、[agent 目录构建](runtime-build-from-agent.txt) |

完整回归的跳过项是 Windows 平台专属项、已被占用的默认 4343 端口、需显式启用的大日志和额外数据库集成项，以及默认不启用的真实 Keychain 测试。Keychain 已在专项中通过显式启用执行；本次真实 MongoDB 验收独立执行，未跳过。

首次并行回归中，一个已有 fallback 端口测试在读取预设下一端口时出现临时 `fetch failed`；单项复查及串行完整重跑均通过。未修改生产启动/端口回退逻辑。真实 Keychain 测试创建独有条目并在结束时删除；没有修改用户原有密钥条目。Skill 校验的 PyYAML 安装在临时 venv，没有改全局 Python 或 Node 配置。

| 要求 | 验证方式与结论 |
|---|---|
| 跨 MCP / Manager 恢复 | 两个真实 MCP 子进程共享受保护附着文件；实际源码及内置 Manager 均经 SIGKILL 后重启，原引用还原成功 |
| 上下文 / 目标隔离 | 不同 capability、只有 context ID、不同数据库、修改 profile/host/origin、未知引用及非法参数位置全部拒绝；业务请求未被转发 |
| 篡改 / 错误密钥 / 无密钥 | 密文位翻转、有效密文调换、反向索引调换、错误主密钥、已有数据库缺失 Keychain 项均安全失败 |
| 无原值 / 密钥泄漏 | 对 SQLite/WAL/SHM、事件/错误、MCP wire、stderr 和预览扫描测试原值与密钥；新错误出口另覆盖未被缓存见过的业务值 |
| 同值并发去重 | 24 个并发提交仅产生一个映射；另一个 MCP 的同值响应复用已提交引用 |
| 映射提交崩溃边界 | 子进程在 COMMIT 前/后实际 SIGKILL；恢复后分别不存在/完整存在映射、任务链接及交付记录 |
| 远端提交后本地未记账 | 源码及内置 Manager 在模拟远端提交后 SIGKILL；不充分证据保持未决，只读查原日志，不重复提交 |
| 真实批量丢失回执 | MongoDB 完成批量后丢弃 HTTP 回复，重启 MCP/存储 Worker；按同 jobId/planHash 的终态对账；execute 转发计数仍为 1，业务增量仍为 1 |
| 任务 pin / 过期 / 清理 | 可控时钟跨越 30 天验证活动任务保留、普通映射失效、终态回滚保留期及每次最多指定行数的清理 |
| BSON 与回归 | 持久化后恢复 Long/ObjectId/Decimal/Date/Binary/Timestamp/Regex/MinKey/MaxKey 等及字段顺序；真实查询、写入、事务、导入、索引、批量、回滚通过 |

历史 `resource-acceptance-20261018/bulk-plan.json` 仅由已有测试只读复用，128 个样例 ID 引用化通过；没有重新执行历史任务。

## 隔离与清理

使用 Node 22.23.3 的绝对路径，未修改默认 shell Node。MongoDB 使用本机已有 `mongo:4.4.30` 镜像和 `mongodb` 6.21.0 驱动，新建 disposable 单节点副本集，仅绑定随机 `127.0.0.1` 端口。数据库、技术 receipt 数据库、任务目录、回滚目录、Manager/MCP 用户目录均独有。

测试结束后删除唯一业务/技术数据库及临时目录，停止并自动删除本次 MongoDB 容器。一次失败测试遗留的 fake Agent 也已按其确切 PID/目录清理。没有终止已有生产/已安装插件进程。

## 更新状态与边界

| 层次 | 状态 |
|---|---|
| 仓库源码、Skill、文档 | 已更新，未提交 |
| 仓库内置 runtime / manifest | 已构建并验收；`2.4.0:799ffc56e1eb4ba867c7d9729d9f345d388e58bbb719c5ed17e9092d51f54683` |
| Codex 已安装插件缓存 | 未更新；当前 `2.4.0+codex.20261020` 缓存没有第二阶段存储模块，第一阶段隐私模块也尚未同步 |
| 当前已安装插件的运行进程 | 未替换、未重启；没有宣称第二阶段已在现有聊天生效 |

源码、缓存文件哈希和只读进程快照见 [deployment-status.json](deployment-status.json)；产物摘要见 [artifact-manifest.json](artifact-manifest.json)。

恢复要求宿主在本机配置 `REMOTE_DEBUG_PRIVACY_CONTEXT_FILE` 并保留原 Manager origin、目标/profile/数据库和 Keychain。实际电脑整机重启未执行；验收覆盖持久文件、真实 Keychain、多进程退出及 SIGKILL 后恢复。WAL/FULL 提供 SQLite 的可靠提交语义，本报告不声称测试了真实断电或磁盘硬件故障。

未决任务会持续 pin；对账不能证明终态时不能自动继续写入。大型日志、实例注册表、operational memory、旧审计和远端回滚文件保持原机制。未知自由文本、任意编码和未识别字段的通用隐私识别仍非本阶段保证。密钥轮换、跨机器迁移及 Windows/Linux 原生凭据适配器未实现。

恢复配置、保留周期与故障处理详见 [存储与恢复文档](../../business-privacy-storage.md)。

## 复现

在 `agent/` 和 `plugins/remote-debug-agent/` 分别使用 Node 22.23.3 执行 `node --test --test-concurrency=1 'test/*.test.js'`。真实 Keychain 专项另加 `RDA_PRIVACY_KEYCHAIN_TEST=1`。

真实数据库测试必须先新建可删除的回环 MongoDB 副本集，设置 `RDA_PRIVACY_TEST_URI='mongodb://127.0.0.1:<随机端口>/?directConnection=true&replicaSet=rdaPrivacy'` 和独立本地 `RDA_PRIVACY_TEST_DRIVER`，再执行 `node --test plugins/remote-debug-agent/test/business-privacy-mongo.e2e.mjs`；测试拒绝非回环 URI。不要将配置改为线上或 test-server。
