# 业务敏感字段引用替换：第一阶段验收

日期：2026-10-20（Asia/Shanghai）。实现和测试均在本地仓库完成。

## 实现范围

- MongoDB 业务文档中的 `_id`、`id/ids`、`key/keys`、UUID/UID/GUID 别名，以及驼峰、下划线和短横线形式的 ID/key 后缀字段，返回随机 `rda_ref_v1_…` 引用。
- 同一 MCP 进程、实例目标和数据库中的相同值复用引用；字符串、数字、BSON/EJSON 及复合 ID 的字段顺序得到保留。
- 查询、单条/批量文档写入、事务、导入和批量任务在进入原校验逻辑前还原引用。索引定义及插件控制 ID、计划哈希、确认短语继续使用原协议。
- 变更预览中的 affectedIds、批量计划 sampleIds 和验证 differences 使用引用；常见聚合重命名/派生表达式跟踪敏感字段来源。
- 引用跨进程、跨实例、跨数据库、目标配置变化、未知引用、文本拼接或放入 BSON 标签/shell 参数时，在转发业务请求前拒绝。
- 真实值只存于受容量限制的 MCP 进程内存。无映射导出工具，不写实例 operational memory；错误/诊断/灵活文本中的已知长字符串副本继续屏蔽。
- 同时修复原有 native EJSON 默认宽松模式损失 Long 精度、重复解码原生 ObjectId 改变查询类型的问题，更新内置 Agent runtime 和 manifest。

第一阶段不包含磁盘映射加密、多个 MCP 进程共享映射或重启恢复。MCP 重启后须重新查询获得引用。凭据沿用不可还原的 `[REDACTED]`，不生成可执行引用。自由文本未知字段、任意编码及任意聚合表达式不构成完整隐私识别保证；常规短业务值只按字段策略替换，文本副本匹配以至少六字符为限。

## 隔离方式

真实数据库验证使用单独启动的 Docker `mongo:4.4.30` 单节点副本集，仅绑定 `127.0.0.1` 的临时端口。数据库、回滚目录、任务目录和本地 MCP 数据目录均为本次测试独有。测试不加载现有实例注册表，不使用 SSH，不连接线上或 test-server。

MCP 通过独立的带本地认证的回环 HTTP 测试服务调用仓库中的真实 `runMongoQuery`、`runMongoMutation`、`runMongoBulk` 和生成的 Node helper；仅把远端固定 config/driver 路径翻译到隔离本地文件。生产路径限制、影响范围、计划/哈希和确认校验均保留。

历史数据测试读取 `docs/reports/resource-acceptance-20261018/bulk-plan.json` 的已有验收计划，验证其 128 个批次样例 ID 全部引用化；原文件不修改，原任务不重新执行。

## 验证结果

| 检查 | 结果 | 证据 |
|---|---|---|
| 插件完整回归 | 85 通过，0 失败，4 跳过 | [plugin-tests.tap](plugin-tests.tap) |
| Agent 完整回归 | 353 通过，0 失败，5 跳过 | [agent-tests.tap](agent-tests.tap) |
| 隐私和 MCP 边界专项 | 30 通过，0 失败 | [privacy-focused.tap](privacy-focused.tap) |
| 真实隔离 MongoDB 全链路 | 1 通过，0 失败 | [mongodb-e2e.tap](mongodb-e2e.tap) |

跳过项来自 Windows 专属检查、已被占用的默认 4343 端口、需显式启用的大日志测试和已有可选数据库集成测试。本次新增的真实 MongoDB 隔离验证单独执行并通过。

真实数据库全链路覆盖：ObjectId/Long 查询引用往返、复合 ID 字段顺序、写入准备/确认拒绝/提交/回滚、跨集合事务、导入、索引、批量计划生成/执行完成、读取已完成任务后复用样例 ID 引用继续写入及回滚。最终业务值恢复；MCP wire、stderr 和输出预览不含被保护的测试原值。

沙箱专项额外覆盖提交回复丢失后的同批次重试，确认增量不重复执行；原值恢复后才计算规范化 chunkHash，对替换值计算的错误哈希仍被原校验拒绝。

## 复现

Node.js 使用 22.23.3，满足仓库要求。分别在 `plugins/remote-debug-agent` 和 `agent` 目录执行：

```sh
node --test --test-concurrency=1 'test/*.test.js'
```

在独占、可删除的本地 MongoDB 副本集中设置环境变量后，在仓库根目录执行：

```sh
RDA_PRIVACY_TEST_URI='mongodb://127.0.0.1:<临时端口>/?directConnection=true&replicaSet=rdaPrivacy' \
RDA_PRIVACY_TEST_DRIVER='<本地 mongodb driver 绝对路径>' \
node --test plugins/remote-debug-agent/test/business-privacy-mongo.e2e.mjs
```

测试文件拒绝非回环 URI。测试自行删除唯一数据库及本地文件；验收后停止并删除本次创建的临时 MongoDB 容器。
