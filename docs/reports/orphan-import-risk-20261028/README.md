# 无 intentId、缺历史回执：本地实现与隔离验收

已实现独立 `human-orphan-import-risk-v1`，包含公开 MCP 准备/读取/一次消费、
独立管理员工作台、每次新的原生身份验证、加密且 pin 的固定审批及消费审计。
精确绑定原 operationId/importId、有序输入摘要、实例/数据库/集合、完整文档及顺序、
批次边界和唯一后续准备。候选仅更换 importId，实际写入/回滚仍逐批单独确认。
旧状态持续 unresolved/unknown，provesNotDispatched=false，不创建原 intent 或历史回执。
普通原/候选准备入口关闭，不能由聊天、Manager token 或伪造内部回执参数绕过。
消费与新 intent 原子登记后最多发出一次准备；重启、并发、丢回包或登记后崩溃不自动重派。

改动保留本地，已生成候选 bundled runtime（26 个产物哈希核验一致）；进入任务前已有的
plugin.json 改动保持原字节，既有 runtime 先备份后按当前源码构建。没有安装、启用、
提交、推送、部署、真实管理员批准或业务数据处置。**真实 test-server/yennefer 的 9 项
继续暂缓；开发验收及聊天都不是重派授权。** 使用说明见 ../../orphan-import-risk.md。

## 实际测试结果

| 验证 | 实际结果 | 边界 |
| --- | --- | --- |
| TestFlow pilot | 1/1 通过，模式排除 9 例 | 正常一次准备、独立写入/回滚确认 |
| TestFlow 完整回归 | 5 文件、62/62 通过，0 失败/跳过/模式排除 | 4 原 import safety、27 execution、8 execution risk、13 readonly recovery、10 orphan risk |
| network-none 原生补充 | 45/45 通过，0 失败/跳过 | 新公开 MCP + source/bundled Manager，及既有 import/execution risk、管理员审核回归 |
| 浏览器补充 | 真实 Chrome + 独立工作台 HTTP 通过，0 pageerror | 读取精确范围、错误短语禁止、native 验证调用、批准后 0 准备派发/业务写入 |

正式 TestFlow 使用工作区快照与不可变依赖镜像，exact-lock=true，network-none/no-services；
5 个成功文件均核验 fixedInputVerified=true、executionSourceUnchanged=true、
workspaceStateUnchanged=true、cleanup=completed。sourceUnchanged=null 不解释为工作区未变。
上述完整回归独立重跑 pilot 用例，没有拼接 pilot 成功记录。

补充原生测试使用固定镜像 sha256:61a0b3c3fa5e261a6600fc549814dffa70f96936374435151bb3765c7aa423dc，
在只读源码挂载、私有 tmpfs 工作区中运行 node --test，网络 none，仅监听夹具 loopback。
浏览器补充在本机可丢弃独立工作台及新 browser context 中运行；不属于 TestFlow unit 页面证据。
Mongo/SSH 与原生系统弹窗均为明确替身，真实本机管理员弹窗和真实服务器结果未验证。

## 证据身份

- snapshot/workflow：44116c4f30c40ffb1687d458021ea15bd1f3e5adee08ea52b7a475222ec12694
- base：7304e68efe3bb9a59497a0bd6c62e76018d7d1b3；target contentHash：91b19d689243dd0ffc6e8982321b273fc59a77e095aaa0c06ef1bdfeda665e2a
- analyze：78255404-304c-41f2-8cb1-3ff32eba755e；scope：be97a73280916769a9820c51ab8dab48a8c95f96048431cdd7e505c27964d143
- graph：fd41b9f2-7a21-4eeb-a802-afca3ebf5d7d；plan：7be2a3ec-58f4-4a73-a4df-a28dda631be0
- pilot prepare：8cd85077-4f7f-4afd-a6a4-4dbccdf71a63；execution job：fa496548-661c-4cdc-a841-4d3912289da6
- regression prepare：52872208-9265-4636-a1f8-d6886cd1b76d；execution job：3b8ab78c-7ba5-4a70-9023-a66023817495
- regression reportHash：8f1d64388f6c276361704a2a052a8f50b83bdd5c2293cd13a25d634684ae7320
- regression flowId：744923f1-8bf4-465c-b7ad-6fa08a630c9f；pilot flowId：7438fac6-52f4-463c-bb3a-40dbee96dfc6
- 新 orphan 文件执行 run：7e08b047-9e8c-4a36-b777-e97db790a6d5；evidenceHash：59ed6e0aa8ef5a45f53bab7d69ce61c8008a1b7d088dacc5a6c3446e71f7ec9f

verified-results.json 是从 MCP 重新核验的各文件 execution-result 提取的结果、源码核验及清理事实，
含各文件 runId/evidenceHash。bindings.json 固定实际 P3 资产及断言范围；testflow-freeze.json 为输入身份。
完整 TestFlow 正文及原始失败日志在本机外部证据目录：
/Users/zhengchenchen/Documents/Codex/2026-10-28/ssl-debug-agent-orphan-risk。
本报告和交付副本在测试完成后新增，不混入被测工作区快照。工具 raw 材料有独立保留策略，
本次核验成功不保证将来永久保留；没有用单纯哈希字符串代替实际 evidence 读取。

## 已断言的行为与覆盖缺口

已执行断言包括：test-server/yennefer 及原身份/摘要绑定；完整原/候选文档与顺序；
拒绝扩大范围、伪造 actor/proof/聊天确认；原 operation/evidence 字节不变；独立管理员登录、
同源/同会话读取与每次 native 验证、取消验证和未审阅拒绝；单次并发消费和重启；
丢回包、提交前/提交后故障；到期重新审阅、不继承旧批准；迟到历史拒绝；规范化批次变化拒绝；
普通准备准入及 Manager token 伪造内部回执拒绝；新批次执行与回滚单独确认。

TestFlow 严格目标 2149：明确覆盖 0、明确未覆盖 0、unknown 2149，原因均为
source-coverage-missing（现有采集器对非 src 根的限制）。按类型：modified-block 1890、
condition-outcome 224、impacted-entry 5、unexpanded-change 30。不能把用例通过说成
完整源码/分支/有序路径覆盖；30 个未展开变化与候选路径搜索预算也继续保留未知。
完整 A/B 保留，范围选择为 5 入口、21 直接变化函数、55 相关函数；4892 项范围外变化
和 22 个未选入口没有从报告悄悄删除，其中大量来自生成 runtime；HTTP/页面补充测试
不将这些静态目标提升为已覆盖。

未执行：真实 9 项的准备、审批、重派、业务提交或回滚；真实历史 helper 的召回/撤权；
真实 SSH/Mongo 集群和断电持久性；真实 OS 弹窗/跨平台；整个仓库所有测试；有序 CFG trace。
没有证明历史从未派发，也没有对旧执行器的全局停止作出保证。

## 早期失败与修正

正式 TestFlow pilot/回归均无失败尝试。开发试跑首轮 orphan Jest 为 5/6，夹具没有把
显式 yennefer 策略传入 helper；修正夹具后保持业务断言并通过。原生首轮因 unit 镜像
无 express 未执行，换用已有固定 native 镜像后，公开 MCP 测试暴露新增 boolean/followup
字段未进入输出白名单；补齐闭合输出契约后 source/bundled 均通过，再补测 Manager
token 伪造 _businessImport 的拒绝。未放宽原未知保护或断言。

静态首轮 scope 使用错误方法身份被拒、pilot 使用错误 assetId 被 schema 拒绝，均未启动测试；
之后读取实际固定资产/符号身份重绑。首轮图受 1200 blocks 预算截断，正式图提高到 3000，
95 个两端函数/10600 blocks，truncated=false；partial-static 和动态调用未知仍保留。
