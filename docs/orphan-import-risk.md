# 无 intentId、缺历史回执的独立人工风险处置

策略 `human-orphan-import-risk-v1` 与原 intent 风险替代、执行接续审核分离。
公开 MCP `remote_debug_mongodb_disposition` 新增三种模式：

- `prepare_orphan_risk`：要求显式 instanceId/database、原 originalOperationId/importId、
  有序 wire requestDigest、完整 originalRequest/replacementRequest。原、候选输入使用
  现有 import wire 字段顺序；仅允许更换 importId，文档内容、BSON 字段顺序、
  文档顺序、集合、批次与回滚选项均相同。原操作身份是待处置身份声明，不能当作
  已验证派发身份。系统读取原受保护上下文；已存在 intent、歧义或扫描超限均拒绝。
- `inspect_orphan_risk`：读取独立风险计划、范围、来源与时点、缺失证据和审批审计。
- `consume_orphan_risk`：匹配精确 riskPlanId/reviewHash，原子消费一次已批准处置，
  登记唯一后续 intent，然后仅准备该导入。调用者不能传 actor/proof 或聊天确认。

管理员在独立工作台选择“无 intentId、缺历史回执”，登录后读取该具体计划。
同一会话五分钟审阅窗口内，核对原 operationId/importId、输入摘要、实例/数据库、
精确文档和顺序、唯一后续准备及批次身份，接受重复、迟到执行、部分成功、回滚
无法覆盖历史写入及回滚冲突风险，输入页面固定确认语句。每次最终批准均需新的
本机原生系统身份验证；Manager bearer、context capability、MCP 或聊天不能批准。
计划一小时，批准最多十五分钟且不超过计划期限；原输入不变可重新审阅到期且未消费
的计划，旧审核存档，批准不继承。

原始状态永远展示 `unresolved`，历史结果 `unknown`，`provesNotDispatched=false`。
批准、消费及后续结果分别保留加密、固定摘要且 pin 的审计，不新建原 intent、
不补造原回执，也不改写已有历史 operation/import_prepare_evidence。受保护存储未找到
记录只是有界本机观测；不声称远端未执行。原 import 和候选 import 的普通准备入口
定向关闭，跨 context 生效；相同原身份不能换摘要、候选或 operationId 取得第二次准入。
这不召回旧执行器、旧 SSH 请求或提交窗口中的事务，也不替代远端撤权证明。

一次处置只授权 `prepare_import_once`。后续 intent 和消费审计在同一 SQLite
事务提交，再进行异步 transport。重复消费、并发、重启或丢失回包都只返回现有状态，
不会再派发；即使同步预检拒绝也不复用本次授权。登记后、发出前崩溃会安全停止，
不会自动补发。可用现有精确 intent 查询/只读回执核对处理证据缺口；回执缺失继续未知。
准备拆批必须匹配已审阅的批次身份。实际写入和回滚继续逐批使用独立 mutationId/
planHash 及 `确认执行`/`确认回滚`，仍受事务、前置条件、幂等和回滚冲突检查保护。

本次开发及隔离测试只用合成数据。真实 test-server/yennefer 的 9 项继续暂缓；
本地代码实现或测试通过都不等于这些具体计划已获管理员批准，不允许凭聊天重派。
未安装/启用候选插件，未处理真实记录，未授权真实业务写入。
