# 人工审核裁决、原任务终止与关联替代：本地交付

证据ID：`human-risk-handoff-20261026-local-v2`。**按新需求完成本地实现与候选runtime/技能同步；原生回归和浏览器夹具通过。TestFlow执行仍有适配器/绑定/镜像缺口，真实安装与本案操作未进行。** 详细流程见 [人工风险裁决说明](../../human-risk-replacement.md)，结构化证据见 [evidence.json](evidence.json)。

## 已修改的条件

原实现把“人工可批准”和“可建立替代”都绑定外部永久撤权/排空回执，人工无法裁决机器不能确定的剩余风险。这一条件在新策略 human-risk-acceptance-v2 中取消，也取消先隔离整个实例的前置要求。独立管理员的明确风险批准成为最终授权依据。

新风险审阅展示原/新job、原记录指纹、精确请求/效果/封口摘要、期限、系统只读观测、调用者审核说明及来源、历史/在途未知和重复补偿风险。reviewMemo可承载已有业务核对事实、时间和证据ID，但不伪装成系统证明；说明/观测/策略均绑定审核hash。保持同一管理员会话读取、固定风险语句及新鲜原生OS所有者验证，聊天/MCP参数/Manager token不能代替。

批准事务关闭原job在本机的后续准入，将原任务控制状态记为terminated_unknown，记录批准人与风险审计；原operation历史保持uncertain原字节。随后create_replacement先通过固定内部Node helper持久化远端sandbox的定向retirement记录，再原子登记唯一替代intent/gate及审计并上传批准首块。缺失旧job时只写控制tombstone，不伪造旧任务历史。旧记录指向新job，新manifest.riskLineage指回原job/风险计划。远端失败不先建替代，丢失回包可沿同一计划/身份恢复。

原job的新上传/execute/resume/rollback及迟到本地结果均被管理准入拒绝。新版helper在开始和提交前检查终止记录；sandbox get/list优先展示该记录，清理拒绝删除。其它job不受定向终止影响；既有整实例hold不清除，仅保留正常精确替代例外。新job需正常封口后绑定不可变planHash，实际业务执行仍需单独确认。

终止范围是本系统后续调度和协作执行器，**不宣称已召回历史派发的旧helper、杀死全部数据库会话/事务或完成全局撤权**。这些未知和迟到/重复效果正是由人工审核接受的剩余风险，历史始终unknown。正常远端租约、预检冲突及业务授权不被绕过。

旧计划/批准保留旧策略，不静默套用v2；用原精确输入和同一proposal重新prepare才能取得新策略ID/hash供审核。保留原生/公开MCP的旧策略兼容测试。原null-prototype修复、未提交插件版本`.4`及握手证据未回退。

## 清理不需要的上一轮实现

已移除上一轮新增的libvirt冷退役执行器、root签发/接入代码、runtime独立authority目录和边界探测helper/预览生成器。恢复相应构建脚本；新流程无需停整库、生成私钥或迁移回执。旧测试/报告作为历史证据留存，并添加superseded说明。已有外部fence核验模块保留，仅用于兼容旧策略。

## 实际测试

| 最终完整原生回归 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: |
| Agent | 553 | 0 | 14 |
| 插件（完整重跑） | 140 | 0 | 5 |
| 合计 | 693 | 0 | 19 |

新增16项handoff回归与2项v2人工工作台回归，不与完整套件重复相加。覆盖无回执/无全实例隔离批准、审核说明和事实来源、原控制状态与历史分离、未批准候选禁止上传、远端终止失败、回包丢失与重启、并发唯一性、精确关联、远端旧任务入口拒绝、已存在替代拒绝收养、提交前终止导致事务回滚、四个真实SIGKILL提交边界，以及正常封口后的planHash准入。公共stdio MCP验证源码与实际bundled Manager，包含34unit/100operation的合成首块，保留输入等价及隐私边界负例。

真实Chromium与独立管理员HTTP夹具通过，页面显示无外部证明仍可人工批准；原生OS认证与MongoDB/worker为明确测试替身。截图在browser/。人工批准和替代创建均未执行夹具业务补分。

最终插件第一次完整运行有1项既有并发启动测试失败：没有观察到AGENT_START_LOCK_WAITING事件；保持相同源码、完整单独重跑后140通过/0失败/5跳过。失败日志plugin-regression-final.tap与成功plugin-regression-retry.tap均保留，不放宽该断言。另保留两次新夹具初始失败：上传夹具错误包含instanceId，被字段守卫拒绝；目标变化测试原期待409，实际既有会话指纹校验返回401/MANUAL_SESSION_EXPIRED，修正为核验该更早的拒绝。具体见evidence.json。

19项跳过涉及真实MongoDB、Windows/Keychain、超大日志及本机默认端口被占用，完整标题均保存。未用真实实例补测。真实原生OS弹窗、目标Node/Linux/MongoDB矩阵、本案现场终止/替代及业务事务均未验收。

候选runtime：`2.4.0:e4e1734a9863e7c34476f9d50e27309c5d4b8686318c91c6435781bb117ed6a2`，26项清单哈希全匹配。未安装、启用或重启真实环境。

## TestFlow固定与缺口

使用当前安装技能及仓库外配置，未创建Git提交：

- snapshot/workflow：`e88f5157122e5b05a1833158f43690fe73412a257476ffbc8c69ee141a938cfe`
- flow：`9b511e7a-40f1-4b0a-888d-a39082809613`
- P1：`cb5ae719-40ae-4c79-a48f-6bea84901c97`
- scope：`a6ffd483e25e48d3d8081afb8843b09d05fedb09f4aba51d2a2871014f283aac`
- P2：`25752456-c9f4-40fa-b37f-e7acaebe084e`
- P3：`b23e1137-8f94-484c-b6e8-d92aba598c39`

captureVerified/fixedInputVerified=true；分析时workspaceStateUnchanged=true。通过安装版storage.readJson读取完整分片产物，并restoreSnapshot重新核验快照；265个源码/测试/技能/runtime文件与当前逐字节一致，详见source-runtime-verification.json。

完整影响6504符号（包含生成runtime），局部范围227函数、333延迟调用；两端图433函数侧/15554块，partial-static、truncated=true。P3为1300目标、2候选路径、705资产、0确认关联或导入证据、1295未规划目标、2未绑定路径，executable=false。序列化远端helper和动态调用未构成完整静态CFG；原生断言通过不等于这些目标、块/分支或有序路径已覆盖。

TestFlow prepare/execute未运行，无jobId。实读当前执行配置守卫仍报“缺少匹配的be-jest/jest-unit执行适配器”，项目为node:test，并缺版本化执行绑定、不可变依赖镜像与隔离契约。补齐正式适配器/绑定/镜像后需重新freeze/prepare/execute；doctor/静态图不表述为测试通过。

第一次freeze因原生测试日志仍在写入被拒绝，稳定后成功；第一次scope含非candidate入口被拒绝，改用P1实际入口，完整变更集合仍保留；plan的maxTargets=20000超过契约被拒绝，按10000重试成功。三个诊断ID及原生失败均保存，不隐藏失败尝试。

## 本案如何接续

本轮没有操作真实ZCIVO任务。16:00的只读证据可作为人工说明：default/yenneferbak原33笔未标记补偿、33人余额0、关联流水0，原/proposal job未找到，本机原prepare意图仍uncertain；该事实不是当前时点快照，也不是从未执行证明。原33笔33人2097分及36原批次保持，范围外52笔4488分与正常兑换80分不加入。

后续最少步骤为：另行授权安装/启用本地候选；通过原受保护context路径及精确原输入/同一proposal重新prepare_risk，附上有时点的事实和未知说明；管理员在独立工作台完成本次风险审核；随后用新plan/hash create_replacement，由系统记录原任务终止并建立关联替代。旧15:06风险计划既属旧策略，也已到16:06期限，不能复用。无需先全局迁移、停数据库或人工生成proof。

新流程的真实终止/替代动作属于具体人工风险计划批准后的后续操作；本轮开发授权不代替它。正常业务上传/封口后的补分执行仍按既有授权与确认核验。本地代码与候选runtime已可审阅；没有提交、推送、PR、部署、真实批准、终止、创建替代、上传/补分或跨会话发消息。
