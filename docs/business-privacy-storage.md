# 业务引用的本机持久化与恢复

第二阶段保留第一阶段的字段策略、凭据不可还原脱敏、BSON/EJSON 类型和复合 ID 字段顺序。只改变本地映射的生命周期，不改变 MongoDB 白名单、影响范围、计划哈希、确认或远端有效期。

## 数据与密钥

生产数据库位于用户数据目录的 `.private/business/privacy.sqlite`，不随插件缓存发布。macOS 只接受本机 APFS/HFS 文件系统；拒绝已知同步目录、插件缓存和非系统别名符号链接。目录权限 0700，数据库及 WAL/SHM 为 0600。应把数据目录选在用户本机非同步位置；自定义名称的同步目录不能仅凭路径自动识别，不能将其作为受支持的部署位置。

`PrivacyService` 将有界请求队列送往专用 Worker，Worker 封装 Node 22.18–22.x 的实验性 `node:sqlite` 同步 API。首次迁移在短事务中创建 schema v1；数据库使用 WAL、`synchronous=FULL`、5 秒 busy timeout。主线程不执行 SQLite 查询或 Keychain 命令。

上下文、引用原值、任务状态、操作意图、交付输出和脱敏事件都先通过 AES-256-GCM 加密后再写入 SQLite。每条记录使用随机 12 字节 nonce、完整认证标签和 key version；AAD 绑定记录类型、版本、记录 ID、上下文和目标范围。业务值按原 JSON/EJSON 字段顺序序列化，绝不排序。反向索引用独立 HKDF 子密钥的 HMAC-SHA256；数据库不存低熵业务值的普通哈希。元数据索引仅暴露随机引用/上下文、带密钥摘要、时间及 pin 标志。新事件只含计数和不透明关联 ID；业务异常正文不会进入新存储错误。

macOS 主密钥由登录 Keychain 的 `com.remote-debug-agent.business-privacy.v1` generic-password 项保护，account 为持久目录路径摘要。通过 `security -i` 的标准输入创建密钥，不放入 argv、环境变量、配置或日志。已有数据库缺失密钥时不会生成替代密钥。Linux/Windows 目前没有生产凭据适配器，保护数据的 MongoDB 调用安全失败；普通诊断能力仍可使用。测试通过构造器注入临时内存密钥，该入口不属于 HTTP/MCP 协议。不要复制数据库到其他目录后期待原路径绑定的 Keychain 项自动匹配；本阶段不提供密钥导出或轮换工具。

## 上下文附着

每个 MCP 默认创建独立上下文，并将附着文件保存为 `<data-dir>/.private/contexts/<contextId>.json`。文件是 0600 的本机能力凭据，包含 Manager origin 和随机 capability，不含主密钥或业务值。输出只报告 context ID；知道 ID 并不能附着。

在宿主的本机 MCP 环境或 `config.env` 设置 `REMOTE_DEBUG_PRIVACY_CONTEXT_FILE` 为该文件的绝对路径，然后重新启动相应 MCP。多个 MCP 明确使用同一个文件才共享上下文。也可预先设置一个尚不存在的本机文件路径，让首次调用创建它，后续进程复用。父目录须已存在。不要将文件正文、capability 或密钥交给模型；不根据 Codex chat ID 猜测上下文。

Manager 必须通过现有回环 HTTP 身份证明和 Bearer 认证。私有存储接口还检查上下文 capability、当前实例配置和 origin。引用绑定实例目标、profile、数据库；换端口/origin、目标或 profile 后旧引用不会被重定向。HTTP 路由没有对应的 MCP 工具，不提供任意 SQL、原值枚举、反查搜索或映射/密钥导出；只按调用已经持有的完整引用精确取回所需值。

电脑重启后，先解锁原用户的 Keychain、启动同一配置的 Manager，再重新附着原文件。Keychain 不可用时本阶段安全拒绝请求；解锁后需重新启动该 Manager 的存储服务（重启 Manager 即可）。不删除数据库、重建密钥或绕过范围检查。第一阶段未落盘的内存映射无法补救，原 MCP 退出后必须重新查询。

## 交付与保留

输出先完成凭据脱敏和业务替换，再在一个事务内提交引用映射、去重结果、任务关联、加密输出和交付记录，最后输出 MCP 响应。多个 MCP 的同值并发请求通过唯一 HMAC 索引获得同一引用。事务提交前崩溃不暴露未持久化引用；提交后、输出前崩溃保留引用，下次同上下文查询仍复用它。stdout 写出后另记 published 标志；这只说明本进程已写出，不代表 Codex 确认收取。内存缓存可清空，磁盘映射不随缓存删除。

普通映射滑动保留 30 天；已完成操作回执保留 90 天。任务关联至少保留配置的回滚窗口及 30 天。活动任务、未决意图及其引用持续 pin；读到已完成/回滚等终态后才允许在保留期之后清理。每 16 次发布触发一次最多 100 个行/关联的清理；单次维护调用上限 1000，不进行无界清表。未决任务不能根据本机超时推断为完成，长期未解决的任务可能持续占用存储。上下文 capability 有一年有效期；不在上下文过期后绕过认证读取数据。

## 远端操作恢复

发出可产生副作用的结构化请求前，先可靠提交输入映射、引用 pin 和操作意图。幂等身份包括上下文、目标、路由和原始顺序的经过凭据脱敏的请求，不包含易变 operationId/deadline。接到成功回执后再记录完成；同一已完成请求返回已记账回执，不重发远端业务写入。pause/resume 是明确的状态控制，已完成的一次 pause 不会抑制后续 resume 后再次 pause。

丢失回执或进程崩溃留下 `uncertain`。再次调用时先用现有 `bulk/job` 或 mutation list 获取远端计划/日志。bulk get 同时检查既有租约并报告 `recovery_required`。只有同 job/mutation ID、同不可变 planHash、对应提交或回滚终态的证据才能完成本地对账并返回结果；其余情况返回 `BUSINESS_OPERATION_RECONCILIATION_REQUIRED`，不自动重放。准备阶段若还没有可匹配的远端 ID，也保留未决状态。

中断的批量任务通过原有 get + control/resume 流程继续；远端 `mongodb-bulk-runtime` 在同一批次事务内写业务变更和技术 receipt，并在恢复/重试时校验同批 planHash/batchHash。SQLite 事务不能替代这个远端事务，不能把恢复变成新建任务、扩大计划或延长授权。远端失去租约时先检查状态，原确认、白名单、计划有效期和回滚窗口继续适用。

本阶段不迁移实例注册表、operational memory、旧审计、大日志及远端回滚文件。源码和内置 runtime 的构建不等同于已安装插件升级；运行中进程也不会因磁盘文件改动自动采用新代码。
