# 人工风险裁决后终止原任务并建立关联替代任务

新策略 `human-risk-acceptance-v2` 将机器无法消除的不确定性交由独立管理员裁决。它不要求先证明“历史从未执行”、全局撤权或提供外部迁移签名；也不要求先隔离整个实例。管理员接受剩余风险后，系统关闭原任务的后续准入，写入远端沙盒的定向终止记录，再建立与原任务关联的唯一替代任务。业务执行仍需正常的具体计划确认。

## 审核依据与权限

prepare_risk 仍须在原受保护上下文中匹配原请求身份，验证候选业务效果等价。对象、金额、原批次日期、身份/缺失守卫、单元顺序不可扩大；允许的标量前镜像刷新及明确job关联重绑不变。新增可选 reviewMemo（最多4000字符，服务器脱敏）用于说明已有事实、观测时间、证据标识、无法判断的部分和重复补偿风险；它明确标记为“调用者说明，不是已验证证明”。Manager还通过只读任务接口记录旧job当前状态或具体读取失败，带独立来源与时点。不把不可用/不存在写成“未执行”。

审核hash绑定新策略、原记录指纹、候选和封口摘要、期限、说明与系统观测。新策略使用独立plan命名空间；旧策略plan及批准不会静默升级。沿用精确原输入及同一候选重新prepare，才会生成v2计划供独立审阅。正式切换不读取/手改受保护SQLite，也不伪造历史回执。

有权管理员须在独立工作台“未知任务风险处置”的同一登录会话读取具体计划，核对事实/缺口/原新任务/范围，输入“我接受历史结果未知的风险，并批准建立此替代任务”，完成新的原生OS所有者验证。MCP、聊天确认、Manager token、context capability、actor/proof参数不能代替。开发授权不等于对真实计划的风险批准。

## 批准后的状态流转

1. 批准事务同时保存批准身份/时点/精确hash、风险审计、原job定向准入关闭，以及原本机任务active=false/status=terminated_unknown。原operation的uncertain历史字节与不透明引用映射保留并pin，不伪装为“从未执行”。不新建业务job或执行补分。
2. 正式公开create_replacement消费批准的plan/hash。先调用固定内部Node helper，在原远端sandbox写入0600、fsync+rename的retirement.json，关联原/新job、plan/disposition/原请求摘要及批准审计。若原job缺失，只写定向控制记录，不补造旧manifest/chunk/交易历史。公开MCP和Manager代理不提供自由retire入口或调用者proof上传。
3. 完成远端终止确认后，在本机一个SQLite事务内登记唯一替代intent、gate、处置关联及审计，再通过现有prepare协议上传精确首块。旧retirement指向新job，新manifest.riskLineage指回原job和riskPlan。远端已有不属于本次交接的新job会拒绝，不能静默收养。
4. 正常上传派生空封口，绑定其精确planHash。后续execute/resume/rollback继续验证此不可变计划和既有业务确认，不因人工风险批准自动执行业务。

原job的定向关闭跨context生效，不影响同实例其它job。候选job在审批/创建前保留，不能从普通prepare入口提前上传；创建后只放行批准首块、派生空封口及其sealed planHash。已存在的整实例quarantine hold不清除；新v2流程可不建立该hold，已有hold仅沿原有精确替代例外准入。

## “终止”的事实范围

新版Manager拒绝原job的上传/execute/resume/rollback等后续请求。新版helper在开始工作和事务提交前检查远端终止记录，协作worker停止后续批次调度。get/list优先展示retirement控制记录，原manifest晚写也不能覆盖它。终止记录不进入自动清理，重启后继续拒绝旧job。

这不是全局SSH/MongoDB撤权证书：已经派发且不知道新检查的历史helper、已认证连接、处于提交窗口的事务，仍可能存在迟到结果。历史是否提交/回滚以及这些在途结果保持unknown，正是这次由管理员接受的剩余风险。系统不宣称把它们全部杀死、排空或证明永久不可执行。正常远端租约和业务前镜像冲突检查也不被绕过；如果仍占用原租约，替代任务的业务执行可能受阻，应检查实际任务状态而非清锁。

## 失败与恢复

本机批准/关闭事务与替代身份登记事务均为原子事务；不跨人机等待持有事务。远端记录采用全局交接锁+每job manifest锁，拒绝同一原job绑定不同替代或多个原job占用同一替代。远端写失败时，原本机入口保持关闭，不产生替代intent/上传。远端成功但回包丢失时，重复同一create可读取同一终止记录继续；创建后回包丢失继续原intent的恢复，不换job或改请求。

计划1小时，批准最多15分钟且不超过计划。到期后重新prepare并原生审阅同一身份；不重开旧任务、不继承旧批准、不建立第二个替代。说明/前镜像变化产生新的精确审核；已批准某个替代后，不能换候选绕过唯一关系。读取原任务历史仍可见uncertain，与其控制状态terminated_unknown同时存在，两者含义不同。

## 本案只供审阅的接续

2026-10-26 16:00的default/yenneferbak只读核对显示原33笔未补偿、33人余额0、关联独立/内嵌流水0；原和proposal job均未找到，本机原intent仍为prepare路径的uncertain。上述时点事实支持“未观察到2097分持久落地”，不证明从未准备或从未执行；不应冒充后续最新快照。

在候选软件另获安装/启用授权后，可用原受保护context路径（仅交给启动环境，不打开文件）和精确原输入、原proposal，通过公开prepare_risk生成新的v2计划，附带上述事实、证据时点和剩余风险说明。由管理员独立审核；通过后再调用同一计划的create_replacement。原33笔33人2097分、36原批次不扩大，范围外52笔4488分、正常兑换80分不纳入。旧15:06的plan属于旧策略且到16:06过期，不能沿用其批准或hash。

本轮只开发本地代码、同步候选runtime并测试合成夹具；没有安装/启用插件、修改真实任务状态、执行真实终止/替代/业务上传/补分或管理员批准。上一轮新增的libvirt冷退役执行器、root签发接入和探测helper已移除，旧测试/报告仅作历史材料。现有外部fence核验模块保留用于兼容旧策略，不作为v2准入前提。


## Import 原意图的人工重试审核

`/mongodb/imports/prepare` 使用独立 import 协议与命名空间，不转成 bulk。
公开 disposition 的 originalRequest / replacementRequest 接受严格 bulk 或
import 联合 schema；历史 import 仍按原路由、原上下文、精确 keyed JSON
身份核验。旧信封缺少 importId 元数据时，以原 keyed 请求验证，不补造历史
operationId、planHash、dispatch 回执，不修改原 uncertain 字节或恢复证据。

Import 候选仅可更换 importId。目标实例/数据库/集合、文档内容及 BSON 字段
顺序、文档顺序、batchSize、purpose、rollbackTtlMs 必须完全相同。审核计划
保存加密的原始与候选输入，绑定当前配置归一化后的原/新批次 mutationId、
文档数和有序请求摘要。配置或拆批变化会拒绝旧审核。Manager 通过只读固定
helper 检查每批 manifest 的精确请求摘要和 planHash，展示 committed、
commit_unknown 等状态，以及 missing、identity_conflict、unavailable；这些
观测均带来源/时点，不能消除原意图的未知结果。

独立工作台沿用同一登录会话读取、五分钟审阅窗口、固定确认短语与每次重新
执行的本机所有者身份验证。MCP、Manager token、actor/proof 或聊天确认均
不能批准。工作台展示 importId、集合、文档数、原/新批次身份、回执观测和
剩余风险，业务文档不出现在审核详情中。

批准事务固定唯一关联，关闭原 import 和已绑定原批次的后续准入，保留原
uncertain 记录及引用 pin。建立阶段先调用仅限内部的 `/mongodb/imports/retire`，
在既有 rollbackRoot 下写入 fsync+rename 的 import 控制目录、原批次定向
关闭标记和新批次 lineage 预留，再读取终止回执；不创建旧业务 manifest，
不把 missing 视为历史未执行。普通 Manager HTTP 代理不暴露这些控制路由。
原生验证取消、回执失败或到期均不能建立替代；相同审核可在重启/回包丢失后
接续，不能占用另一个已有 import 或建立第二个替代。

替代身份登记后使用独立 importPrepare 回执准备原生 import 批次，manifest
包含与不可变 planHash 绑定的 riskLineage。新 import prepare 也使用精确回执；
同步预检确证未派发时允许同意图重试。派发后结果丢失只读取精确终态 prepare
回执并核对批次，缺失证据保持 uncertain，不重派。prepare_partial 保留已准备
批次与失败批次，不能报告全量准备成功。完整终态 partial 回执允许使用同一
输入、同一意图继续准备下一 attempt，先归档完整前缀证据；远端不完整回执
绝不允许这样重派。原批次 journal/planHash 复用，不重复业务提交。每批仍须现有 `确认执行` / `确认回滚`
及精确 mutationId/planHash；幂等、已有文档拒绝、事务未知保护和回滚冲突检查
不变。控制记录不属于业务 manifest，不进入自动清理。

新版 helper 在 prepare、commit/rollback 入口和事务提交前检查原 import
定向关闭。该检查不能召回旧 helper 或证明已派发事务未执行；批准接受的正是
迟到提交、重复导入和部分批次成功等剩余风险。本功能未改变 bulk 的首块、
守卫等价、封口和执行校验。开发仅使用可丢弃本地夹具；真实审核、安装启用和
业务迁移均需独立处理。

## Import dispatch safety (2026-10-27 follow-up)

MongoDB admissions compare the worker's captured startup configuration against
current Manager instance/worker settings immediately before transport. A stale
or unknown worker configuration returns `WORKER_CONFIGURATION_STALE` with a
Manager-generated `not_dispatched` attestation. Updating registry never restarts
or cancels existing work. Later updates affect subsequent admissions; already
admitted requests retain their original configuration and unknown-result
protection. The Dashboard update response and instance runtime show whether an
explicit refresh is required. Inspect in-flight work before refreshing; failed
refresh/start does not permit dispatch.

For new import envelopes, reconcile can atomically close an unclaimed attempt
as `rejected_before_dispatch` / `unclaimed_attempt_fence`. SQLite rechecks the
current attempt and dispatched bit under the same write transaction. A delayed
claim cannot run after closure; a claim winning first preserves uncertainty.
The identical intent may reserve the next attempt, preserving the complete
closed envelope in pinned `import_prepare_evidence`. Late old results cannot
mutate a newer attempt. Missing batches, missing remote files or lost replies
never close an already claimed attempt; historical envelopes still require
trusted legacy evidence or the independent human risk workflow.

Remote import control writes sync file, containing directory, journal root and
its parent, then read back the exact value before acknowledging each reservation.
Partial I/O failure keeps completed closure/lineage records and can be completed
only with the same handoff identity. A process killed while holding the global
exclusive lock remains blocked; there is no age-based lock reclaim, cancellation
proof or automatic replacement. Actual power-loss durability and legacy helper
in-flight outcomes are not certified by the isolated process-crash tests.
