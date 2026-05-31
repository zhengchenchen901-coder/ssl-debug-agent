# 非工具运行时代码固化规则

本文档仅固化当前 Remote Debug Agent 的插件启动过程和插件工具注册过程，作为后续功能拓展的基础约束。除非有明确缺陷、兼容性问题或经过验证的新需求，不应修改这两条基础链路。

## 固化范围

当前固化范围包括：

- `plugins/remote-debug-agent/mcp-server.js` 中的项目根目录解析、`.env` 读取、Agent 探测、启动、复用、重启、fallback 端口、生命周期日志、MCP stdio 协议解析和响应。
- `plugins/remote-debug-agent/mcp-server.js` 中的 `initialize`、`tools/list`、`resources/list`、`tools/call`、`ping` 处理流程，以及工具列表注册和调用转发的基础形态。

不属于本次固化范围的内容包括本地 Agent 的功能模块：HTTP API 编排、配置、安全校验、SSH/SFTP、审计、活动流、approved-command 机制、dashboard，以及后续新增的具体业务工具能力。这些模块后续可以按需求调整和拓展，但应继续通过插件启动链路和工具注册链路接入。

## 可拓展模块

以下内容属于功能模块，不在本文档中固化：

- `agent/server.js` 的 HTTP API 编排、状态接口、事件流、运行时状态写入、审计调用和依赖注入结构。
- `agent/config.js`、`agent/security.js`、`agent/ssh.js`、`agent/audit.js`、`agent/activity.js`、`agent/approved-commands.js` 中的具体配置、安全、SSH/SFTP、审计、活动流和 approved-command 行为。
- `agent/public/` 下的本地 dashboard 展示与交互。

这些模块可以随插件功能变化而调整。调整时应同步更新对应测试、README 或专门的功能规则文档，避免把功能模块约束混入本文件。

## 当前正确链路

插件启动链路已确认正确：

1. MCP wrapper 从 marketplace cache、`REMOTE_DEBUG_PROJECT_ROOT` 或本地源码路径解析项目根目录。
2. wrapper 合并进程环境与项目 `.env`，以 `REMOTE_DEBUG_*` 配置生成 Agent URL、端口、Agent 目录和配置指纹。
3. wrapper 在 `initialize` 和 `tools/list` 后预热本地 Agent；在工具调用前通过 `ensureAgentReady()` 确认 Agent 可用。
4. wrapper 只会复用健康且配置指纹匹配的 Remote Debug Agent。
5. wrapper 只会在确认目标进程是 Remote Debug Agent 且配置不匹配或不健康时重启它。
6. 配置端口被其他服务占用时，wrapper 会在有限范围内选择 fallback 端口，不应杀掉非本项目进程。
7. Agent 由本地 Node 进程启动，监听 `127.0.0.1`。`/status` 需保留 wrapper 判断健康状态所需的兼容字段；其他状态信息可随功能模块调整。

插件工具注册链路已确认正确：

1. `tools` 数组是 MCP 对外工具清单的唯一注册入口。
2. `tools/list` 返回当前工具清单；schema 使用严格对象结构并关闭 `additionalProperties`。
3. `tools/call` 只根据工具名进入 `callTool()`，再转发到本地 Agent HTTP API。
4. MCP wrapper 不承载具体业务执行逻辑；具体执行由本地 Agent 的可拓展功能模块负责。
5. `resources/list` 当前返回空资源列表；除非插件需要公开 MCP resources，否则保持该行为。

## 后续扩展规则

- 新增远程调试能力时，优先在本地 Agent 功能模块中增加 HTTP endpoint，并在对应模块内完成参数校验、执行、记录和状态反馈。
- MCP wrapper 只增加必要的工具定义和 `callTool()` 到本地 HTTP endpoint 的映射，不应把业务执行逻辑搬进 `mcp-server.js`。
- 不因新增工具重写项目根目录解析、`.env` 合并、Agent 预热、进程复用、fallback 端口或 MCP stdio framing。
- 不因新增工具改变现有工具名、参数 schema、返回包装格式或错误包装格式；确需调整时必须同步更新兼容性说明和 smoke test。
- 功能模块可以调整安全策略、审计策略、活动流和 approved-command 行为；调整时应明确兼容性影响并补充对应测试。
- dashboard 可以随功能模块变化调整展示与交互，但不应改变 MCP wrapper 的启动和工具注册语义。

## 修改门槛

以下代码区域默认视为稳定基础设施，后续功能拓展时不要顺手修改：

- `mcp-server.js` 的 Agent 启动、健康检查、重启、fallback、prewarm 和 stdio 协议处理。
- `mcp-server.js` 的 `initialize`、`tools/list`、`resources/list`、`tools/call` 分发骨架。
- `mcp-server.js` 中工具清单注册入口和 `callTool()` 转发约定。

只有满足至少一个条件时才考虑修改上述区域：

- 有可复现 bug，且修复不能通过新增工具层代码完成。
- Codex MCP 协议或插件宿主行为发生变化，当前启动/注册链路不再兼容。
- Agent 功能模块调整后，当前启动/注册链路需要配套兼容。
- 测试覆盖证明当前稳定链路在修改后仍然保持兼容。

## 必跑验证

修改非工具运行时代码或新增工具映射后，至少运行：

```powershell
cd agent
npm test

cd ..\plugins\remote-debug-agent
npm test
npm run diagnose
```

如果只新增文档且未改源码，可以只运行测试确认当前固化基线仍然通过。

## 文本与编码规则

- 代码文件继续保持 UTF-8。
- 保留现有中文原文，不改写无关行。
- 不把现有中文改成乱码、转义序列或替代文本。
- 编辑包含中文的文件时，只修改完成当前任务必需的内容。
