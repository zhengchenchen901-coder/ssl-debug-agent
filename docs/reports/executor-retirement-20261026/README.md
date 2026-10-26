# 执行边界与独立权威：本地候选交付

证据ID：`executor-retirement-20261026-local-candidate-v1`。**本地候选开发及合成验证完成；生产适用性与现场验收未完成，整体状态 partial。** 不能声称本案已迁移、撤权、批准或补分。核心限制与操作指引见 [执行边界文档](../../executor-retirement.md)，结构化结果见 [evidence.json](evidence.json)。

## 改动与边界

现有 SSH 将 helper 作为独立进程派发；普通 Node helper、Manager stopped、改配置/密码或本地 hold 不能独立约束全部旧进程、连接和事务。因此没有给原签名核验器加一个调用者可设置的“迁移完成”标记。

新增独立 `authority/retirement.py`，提供固定目标 prepare/inspect、精确 hash + 独立 root TTY 执行确认、冷退役执行、完成后重新核验并签发、显式续期绑定及可恢复审计。签发密钥在独立 root 控制台，不暴露给普通 MCP、HTTP 或 SSH helper。`authority/install-verifier.mjs` 提供所有者公钥指纹接入与签名回执导入；该 profile 的验证端文件也要求 root 控制。合成 backend 强制标记 synthetic，Manager 与导入器拒绝其回执。

**候选执行器仅支持整个专用 libvirt/KVM 旧执行与数据库 appliance 的永久冷退役。** 实际执行会 destroy/undefine 全部纳管域，核验 QEMU 消失，并将唯一 raw 磁盘原子移入 root 私有 vault，禁止重新执行旧环境。旧认证和任务执行命名空间整体退休；历史 commit/abort 结果保持 unknown。不是 MongoDB 原地继续服务的在线撤权排空，也不创建新数据库/业务服务。

这个架构前提必须由安装所有者从独立基础设施/数据库管理面验证，程序不能从 libvirt XML 发现或证明 VM 内部的真实 MongoDB 拓扑。共享 MongoDB、外部副本/队列/租约/存储、可恢复副本、宿主旧 helper、未管理权限或无法确认独占性时，不得使用该 profile。不存在“写入 topology 字符串就证明前提成立”的授权。**当前 default 是否适用仍 unknown；共享/外置数据库在线迁移实施器及新服务接入仍未交付。**

新增只读 Node 边界探测 helper 和本地命令草稿预览生成器，回答“能否复用现有命令草稿运行 helper”：可以走现有人工路径，必须先 review 精确 draft，再获得“使用命令”；Node 不在自动执行白名单。探测不读配置、凭据、环境、cmdline 或业务数据，进程统计不是 proof；本轮没有创建真实 draft 或远端执行 helper。预览见 [operations-preview.json](operations-preview.json) 与 [probe-draft-preview.json](probe-draft-preview.json)。数据库写入不得通过这条通用命令路径绕过结构化工具。

公开 risk/MCP、管理员页面和 capabilities 增加边界类型、迁移/证据摘要、服务可用性及所有者操作提示。完整输出契约、候选 runtime 与技能同步；没有安装/启用或重启。原独立管理员同会话审阅、新鲜原生 OS 验证、quarantine 及业务执行门禁保留，null-prototype 输入修复未回退。原有 `.4` 插件版本及既有未提交握手证据保留，没有另提升发行版本。

## 实际验证

| 最终执行 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: |
| Agent 完整 node:test | 543 | 0 | 14 |
| 插件完整 node:test | 140 | 0 | 5 |
| 独立权威 Python unittest | 31 | 0 | 0 |
| 合计（不重复计子集） | 714 | 0 | 19 |

另有最终公开 MCP 子集12项通过，以及真实 Chromium/独立管理员 HTTP 页面验证通过。页面里的签发方、原生 OS 验证和 MongoDB/worker 是明确测试替身；没有本案业务写入或真实批准。截图在 browser/。完整原生回归最终日志为 `agent-regression-final.tap`、`plugin-regression-final.tap`、`authority-tests.txt`；早期整轮和子集日志另存，不拼接为最终通过。

31项权威测试包含实际临时磁盘文件移动和子进程 SIGKILL（域移除后、磁盘移动后、签发记录后）的持久恢复；hypervisor 本身是合成替身。XML/virsh 参数用固定替身验证，未执行任何真实 virsh/systemctl/MongoDB/SSH 动作。未覆盖真实 Linux/libvirt、重启后的现场持续阻断、数据库/SSH 权限和事务终结、新边界服务、真实 root 接入正向流程或原生 OS 弹窗。19个跳过标题全部在 evidence.json 中，涉及真实 MongoDB、平台/Keychain、超大日志、已占用默认端口；未操作真实实例补测。

一次中间 Python 测试夹具编辑出现 IndentationError，加载阶段未执行测试；修正后31项全部通过，详情见 failed-attempts.json。未放宽业务或安全断言。

候选 runtime：`2.4.0:5cea06624eca1ed74551f614f5c4d97405f5a95edc0dc5328dd3d77b229efdba`，31项产物哈希全部匹配。分发包含独立 authority 源码/指引，但代码从普通用户可写 checkout/plugin cache 直接运行时拒绝生产入口；打包不安装权威或生成密钥。真实已安装版未修改。

## TestFlow

读取了当前 `codex-testflow/0.2.0` 技能，使用仓库外工作区配置。没有为测试创建 Git 提交。

- snapshot/workflow：`e60f8a2b9f360b2794987474afdd5ada72713c41fb2da2651b9144d72fb2a90c`
- flow：`a96b6855-492c-4821-a64a-4c9d9bb50655`
- P1：`4fdd4dc9-5221-4a44-86b5-db8eac97f071`
- scope：`64235effe46f870056efe7c4df27b1e92c547345e97adba6fe550899f9b5d54d`
- P2：`15354d50-2787-47cd-9ef8-1239f942aa3c`
- P3：`75047e15-2d5b-4a7c-a2a4-5f8baa857959`

captureVerified/fixedInputVerified=true，分析时 workspaceStateUnchanged=true。通过当前安装版 storage.readJson 读取完整分片产物；调用 restoreSnapshot 核验快照，并逐字节核对276个源码/测试/技能/runtime文件与当前版本，全部一致，见 source-and-runtime-check.json。快照后只新增交付报告/日志，没有改变实现。

完整影响集合1432个符号；范围48函数、83个延迟调用。两端图71函数侧/3711块，partial-static、truncated=true。P3有1733目标、3条候选路径、697资产、0确认关联/导入证据、1724未规划目标、3未绑定路径，executable=false。静态的1733 uncoveredTargets不代替实际测试覆盖；Python权威不受当前 TypeScript 静态适配器覆盖，保持 unknown。

**TestFlow prepare/execute 未执行，无 jobId。** 实读当前 executionWorkspace 守卫拒绝本项目：“缺少匹配的 be-jest/jest-unit 执行适配器”。本项目使用 node:test 与 Python unittest，且缺版本化执行绑定、不可变依赖镜像和隔离契约。补齐正式适配器/绑定/镜像后，需重新固定输入并 prepare/execute；没有伪造 Jest 绑定或借用 BE 成功。doctor/静态分析/候选构图不是 TestFlow 测试通过，也没有目标/块/分支/有序路径覆盖结论。

## 最少现场接续与独立授权点

首先只需审阅只读 Node 探测草稿，并由所有者确认实际基础设施/数据库拓扑。若是共享/外置 MongoDB，不能执行冷退役模板；必须先设计、实现并验收适配该拓扑的独立撤权/事务终结与新 broker 迁移方案。若确实符合独占 appliance 条件，先在专用 Linux/libvirt 实验环境验收，再另行授权候选安装/启用、全部旧业务永久停机与精确迁移计划。root 签发/验证端接入独立完成，不向聊天提供私钥或管理员密码。

真实 disposition quarantine 会 hold default 实例全部 MongoDB 写入，必须另行审阅精确 disposition hash 并“确认隔离原意图”。最终风险批准仍只能有权管理员在同一独立工作台会话读取精确新鲜 riskPlan，输入原固定风险确认语句并完成新的原生 OS 所有者验证。create_replacement、上传/封口、业务执行和任何回滚不被上述开发或运维安装授权自动涵盖。

本案原15:06:38风险计划到期为2026-10-26 16:06:38.255（北京时间）；本轮未重读真实状态，不假定交付时有效。保留同一业务身份、unknown历史和原保护；不猜填缺失 operation/chunk/plan。33笔33人2097分及36原批次保持，范围外52笔4488分和正常兑换80分不纳入。本轮真实迁移/隔离/批准/新job/补分均为0，没有提交、推送、PR、部署、真实重启或跨会话发消息。
