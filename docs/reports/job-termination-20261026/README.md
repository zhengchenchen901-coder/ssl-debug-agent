# 人工审核后永久终止 bulk 任务（本地实现）

后续更新：用户已授权并完成 .7 本地安装；运行中的 Manager/Worker 仍需重启 Codex 切换。见[安装报告](installation/README.md)。下文保留开发交付时的状态。

按用户最新决定，ZCIVO 当前替代任务不再恢复或重试；本轮新增独立的人工终止功能，不新建真实业务任务，不修改旧计划或守卫。实现已在本地完成并重新构建 runtime，**尚未安装或切换正在运行的 .6 插件，也尚未对真实 ZCIVO 任务执行人工终止**。真实任务最后只读状态仍为 paused，不能把本地开发完成写成真实任务已永久终止。

## 最终行为

管理员工作台新增“永久终止任务”。管理员填写实例对应的默认数据库、现有 jobId、固定 planHash 与原因，读取服务端实际任务状态后，核对五分钟有效的精确审核、勾选确认并输入“我确认永久终止此任务，不再恢复或重试”。最终提交必须完成新的原生 OS 身份验证，账号来自独立管理员会话。普通 Manager bearer、MCP、业务 context capability、调用者 actor 或结果对象均不能代替人工批准。

批准在加密存储事务内先保存永久准入阻断与审计。此后该实例下该 jobId 的上传、execute、resume、rollback 均拒绝；其他任务不受影响。再通过内部固定 Worker 通道写入远端 retirement.json，并独立读取同任务核验身份及 controlRecordDigest。没有公开 Manager 终止代理路由或 MCP 终止写工具。

- `termination_pending`：本地已永久阻断，远端终止记录未核验成功。保留阻断，重启或丢包后只能经新的人工工作台审核补齐同一份终止记录；不恢复业务执行。
- `terminated_unknown`：远端终止记录已独立核验。保留原历史及旧在途结果 unknown，不代表证明旧进程或旧事务从未提交。
- 永久阻断优先于原风险批准过期检查；无需续期原“创建替代任务”的批准来终止现有任务。
- 原计划、回执、前镜像、关联历史和引用保留；只读返回旧状态不能重新激活已终止任务。不自动回滚业务数据、清理恢复证据或创建下一份业务任务。
- 新版 helper 在执行与提交前检查终止记录。旧执行器或已经越过最后检查的事务仍可能迟到；人工审核明确保留这一未知性。

## 本地验证与边界

独立 Docker、network=none、源目录只读：105 项通过、0 失败、0 跳过。范围是新增终止、风险替代兼容、管理员工作台、隐私存储、批量事务、沙盒和审计。覆盖精确 job/hash/实例绑定、状态变化与审核过期拒绝、原风险批准过期后的独立终止、回包丢失、远端失败、命令回复不能代替独立回读、永久阻断、引用保留及提交前/后实际 SIGKILL 重启恢复。另一次定向 Worker/Manager HTTP 检查 2 项通过、0 失败、0 跳过，核验固定 action 和普通 Manager API 无法绕过独立审核。

独立浏览器使用临时合成存储、模拟 MongoDB driver、模拟 SSH 和原生身份验证器，完整走登录→填写目标→读取审核→精确确认→原生验证调用→远端记录回读→终态展示。验证修改输入使审核失效、零业务写入、无新任务、无页面异常；审核及终态截图已人工查看。它不代表真实 OS 提示或真实数据库集成通过。

验证期间有一轮保留记录用例缺少存储接口要求的 `records: []` 而失败，修正夹具后最终 105 项全过；并加强终止任务的 pinned 保留。早期浏览器夹具缺少 enabled 状态、误把同步终端接口模拟成 Promise 导致失败，已修正模拟器并重跑通过。最终报告不把早期失败混入通过计数。

TestFlow 使用当前安装技能和本项目配置 `/Users/zhengchenchen/Documents/Codex/2026-10-26/ssl-debug-agent-executor-retirement/workspace.json` 做诊断及工作区快照。默认 doctor 指向另一 BE 项目，已切换到明确的 ssl-debug-agent 配置。项目 adapter=node-test；当前已安装执行器 `dist/execution/prepare.js:26` 仅允许 be-jest / jest-unit，本项目也未声明测试资产/输入/状态/断言绑定及不可变执行依赖配置。因此未调用 prepare/execute，没有 TestFlow 执行 jobId，目标覆盖 unknown。上述容器和浏览器检查单独标记，不能当作 TestFlow 通过。补齐原生 node:test 适配器及版本化绑定和隔离契约后才能完成正式 TestFlow 验收。

容器使用 Node 22.23.3 固定镜像，模拟数据只存容器临时目录；依赖来自本地 agent/node_modules 的隔离副本，并非 TestFlow 依赖镜像复现。完整日志、源哈希、最终快照与未覆盖项见 evidence.json / testflow-freeze.json。

## 当前 ZCIVO 任务与后续人工操作

本次新增功能没有安装到运行实例，用户要求的人工作台批准尚未发生。需要安装包含本功能的新发行版本并核对 Manager/Worker 同步生效后，在 default 的独立管理员工作台进行审核：

- database：yenneferbak。
- jobId：432f9201-2933-4c77-afe1-675c9446a497。
- planHash：b68c679dc01a6429f4d96e5fb78efbe95f19a14798f225ee8d86b64201df8eec。
- 原因：原计划守卫已变化，永久终止旧计划，后续不再重试；未来另行基于最新状态准备新业务任务。

真实任务只读 operationId：f597ac00-5852-4a5e-960c-e98753d829ae，paused / activeBatchIndexes=[] / committedBatchCount=0 / verifiedBatchCount=0。它只证明该次读取的管理状态，不证明历史从未执行。原任务 37265270-8912-48c0-8c4d-2947a1cc6e41 的退役、未知历史及原保护均保留。

本轮没有真实 resume/execute/rollback、风险计划续期或新业务任务，没有安装/重启运行中的插件、变更权限、提交、推送、PR 或部署。已有安装元数据和上轮报告修改保留。工作区 runtime 是本功能候选构建，版本元数据仍沿用原 .6；正式安装前需单独生成新的发行版本，不能覆盖同版本安装并声称已经生效。
