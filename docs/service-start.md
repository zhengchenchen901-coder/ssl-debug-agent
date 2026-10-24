# 按实例启动后端服务

本功能为 Remote Debug Agent 增加独立、受约束的服务生命周期能力。配置保存在每个实例自己的 `serviceProfiles` 中（本机实例注册表，文件权限沿用 0600），不继承 default 或其他实例。没有配置就拒绝启动，不推测目录、Node 或端口。

## 使用入口

管理面板：进入实例工作区 → 实例设置 → 服务与日志 →「按实例启动后端服务」→ 保存该实例的配置 JSON。配置形如 `{ "be": { ...profile } }`。保存后刷新该实例的 **Agent worker** 使配置生效；这不应重启远端 BE。实例总览中的「后端服务启动」可选择服务、检查状态或确认启动。空白保留原配置，`{}` 清空。

MCP 接口：

| 工具 | 用途 |
| --- | --- |
| `remote_debug_list_service_profiles` | 本地列出各实例的已保存配置和 `profileHash`，不连接远端 |
| `remote_debug_set_service_profile` | 按明确 `instanceId` 保存或移除一个配置，不启动服务 |
| `remote_debug_inspect_service` | 使用 `instanceId`、`serviceId`、`profileHash` 检查远端服务 |
| `remote_debug_start_service` | 同上，另带 `confirmation: "启动服务"`；仅在用户明确要求启动时调用 |

用户说“启动 test-server 的 be”即为这个结构化启动操作的授权。读取该实例当前配置摘要后可直接调用 `remote_debug_start_service`，不再为这个固定操作生成泛化 shell 草案或重复要求“使用命令”。`confirmation` 是调用方对用户意图的显式声明，不能被当成独立的人类身份认证；本地 HTTP token、SSH 主机校验、启用的实例绑定配置仍是强制边界。仅请求检查/配置不授权启动。停止、删除、重启、清理锁、变更部署等不在此能力内，仍需另行授权并走现有审阅流程。

受认证的管理 HTTP 接口为 `GET/POST /api/service-profiles`、`POST /services/inspect` 和 `POST /services/start`。POST 配置接受 `instanceId, serviceId, profile`（移除使用 `remove:true`）；执行接口不接受路径、命令、env 或配置覆盖。管理端与 worker 分别校验摘要、目标与已保存配置，另比对当前 SSH 信任和批准路径的内部摘要；旧 worker 不会使用新配置执行，需刷新后重新列出摘要。

## test-server 的已验证配置

[配置文件](examples/test-server-be-service.json) 是 2026-10-19 北京时间约 09:48 已验证事实的明确示例，可作为 `remote_debug_set_service_profile` 的参数。它绑定 `test-server / root@8.209.81.113:22`，**不会自动安装或激活到任何实例**。其他实例需独立核实后创建配置，不能直接复制这个配置。

它使用发布根的 `current/index.js`、绝对 Node 20.20.2 解释器、两个有序的 env-file **路径**，以 PM2 默认 fork 模板分别启动 A/B。A 的 REST/WS 端口为 9999/3333，B 为 8887/2222；关键环境、内存阈值和延迟均明列于文件。不固定历史 release 目录、PM2 ID、PID；每次现场解析 `current` 并校验属于 `releaseRoot/releases/<version>`。`current` 在过程中发生变化会中止并报告，不能跨版本继续启动。

`serviceProfiles` 支持 cwd、可选 releaseRoot、相对 JS entry、fork mode、绝对 interpreter、精确 nodeVersion、固定位置的 pm2Path、pm2Home、0–4 个有序 envFiles、1–8 个进程、非秘密白名单 env、预期 TCP 端口、startupMarker、stableMs、startupTimeoutMs、重启内存/延迟和 persist。配置目标同时绑定实例 ID、主机、SSH 端口和用户名。改变实例目标前须明确移除旧配置。路径须处于本实例批准的根目录内，执行前校验解释器及 env 文件的真实路径；env 文件只检查类型和可读性，不读取或复制内容。

目前只接受 `NODE_ENV, PORT, WS_PORT, CRON_PRIMARY, TRANSLATION_ENABLED, ORDER_AI_ENABLED, ORDER_AI_ALLOWED_RESTAURANTS`。拒绝 NODE_OPTIONS、自定义命令、shell、任意参数、秘密变量及 ecosystem/cluster。需要扩展白名单时应在源码中审阅并测试，不通过接口绕过。

## 启动和成功判定

1. 核验目标、启用配置及摘要、cwd/release、入口、实际 Node 版本、env 文件元数据，以及已有 PM2 daemon。检查/启动都不会自动创建 PM2 daemon。
2. 启动操作为当前 PM2_HOME 获取排他锁。检查所有同名注册、路径、模式、运行目录、Node 参数与版本、白名单 env、实际 `/proc/<pid>/exe/cwd/cmdline/environ` 和 PID 持有的 TCP socket inode。同名重复、异常/停止进程、路径冲突或未知注册均拒绝，不删除、不重启。
3. 所有预期端口必须空闲或由该配置的健康进程持有；每次补齐缺失进程前再次检查 PM2 与端口。命令通过固定 `execFile` 参数数组执行，`shell:false`；启动直接 JS entry，显式绝对 Node 与 env-file 参数，避开旧 PM2 daemon 的 cluster Node 14 问题。
4. 新进程和已有进程必须在稳定窗口内保持相同 PID、uptime、restart count，实际解释器/环境正确，所有端口均属对应 PID，并出现完成标记。新进程的标记须在启动前日志偏移之后，旧日志不能冒充本次启动。响应仅返回布尔证据与非秘密字段，不返回 PM2 jlist、进程环境、日志文本、命令 stdout/stderr。
5. 只有完整健康且本次创建过进程、配置启用 persist 时才运行一次 `pm2 save`。它保存整个 PM2 namespace；若发现其他停止/异常注册则跳过并报告 `persistenceWarning`。重复启动健康服务不创建进程、重启或保存。

`ok:true` 表示收到结构化结果，**只有 `status:"healthy"` 表示健康验证通过**。还需查看 `persisted` 和 `persistenceWarning`：

| status | 含义 |
| --- | --- |
| healthy | 当前配置的进程通过稳定性、端口和启动证据验证；`unchanged:true` 表示未新增进程 |
| missing | inspect 发现缺失进程，没有启动 |
| blocked | 未收到本次启动变更回执，前置条件/冲突阻止了启动；检查错误码和阶段 |
| partial | 已有进程收到启动回执，但后续启动、验证或保存失败；不回滚、不保存部分状态 |
| unknown | PM2 启动命令失败且可能已生效，或传输/响应不完整；先检查，不能自动重放 |

`started` 是成功 CLI 回执，`attempted` 是尝试启动列表，二者都不等同于健康。传输丢失/请求超时也可能已经产生远端进程；重新连接后先 inspect，不自动重放、不删除注册。锁未能释放时后续 start 拒绝；只有查明没有活动操作且另行授权后才处理残留锁。审计记录实例、服务、摘要、阶段、启动回执、状态、持久化与错误码，省略配置内容和远端原始输出。

## 限制与本地验证

目标为 Linux，有可读的 `/proc`、当前用户的 PM2 daemon、PM2 CLI 位于 `/usr/local/bin/pm2` 或 `/usr/bin/pm2`，SSH 环境 `node` 为 14+；应用 Node 为配置中精确的 20+。不会初始化 PM2、安装 Node、切换发布、迁移旧生态配置或修复异常注册。端口验证覆盖 TCP LISTEN，不验证公网/nginx 或业务 HTTP 语义；startupMarker 是有界日志尾部的字面标记，日志轮转/标记不在保留尾部会保守地不判成功。锁约束本插件的启动操作，不能阻止其他管理员同时运行 PM2 或切换发布；检测到变更即失败关闭。

测试仅使用临时目录、模拟 PM2、模拟 Linux proc/socket、受认证本地 HTTP 与 MCP stub。没有对 default 发起远程测试，也没有启停 test-server 的现有 BE。命令（本机 Node 22.18+）：

```sh
cd agent
node --test test/services.test.js test/services-http.test.js
npm test
npm run test:services-browser
npm run build:runtime
cd ../plugins/remote-debug-agent
npm test
```

运行时产物由仓库构建脚本生成；不修改已安装插件缓存。构建不等于发布/安装；实际安装并导入配置后的 test-server 验收仍需在获授权范围内执行。
