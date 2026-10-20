# 按实例服务启动：本地验证记录

日期：2026-10-19（北京时间）。本机 Node 22.23.3。

| 检查 | 结果 |
| --- | --- |
| `agent/npm test` | 351 项：347 通过、4 跳过、0 失败 |
| `plugins/remote-debug-agent/npm test` | 71 项：69 通过、2 跳过、0 失败 |
| 最终服务 / HTTP / 安全边界测试 | 34 项全部通过，含 worker SSH 信任摘要变更拒绝 |
| 最终打包服务 / worker / output guard / MCP 协议回归 | 38 项：37 通过、1 跳过、0 失败 |
| `npm run test:services-browser` | 通过：认证、实例配置选择、检查、启动确认/取消、未配置禁用、配置 JSON 保存与隔离 |
| `npm run build:runtime` | 构建成功，重复构建 manifest 一致 |
| Node 14.21.3 `--check` 检查生成的 helper | 通过 |
| `git diff --check` | 通过 |

运行时 ID：`2.4.0:0518c2aa4046fe09088babfe114c447a1394ef493ae175a366276873f3e3ef21`。

跳过项是仓库已有的超大归档、真实 MongoDB 集成、PowerShell 安装以及已占用 4343 端口的默认监听检查；本功能新增的服务测试均通过。没有为获得默认端口而停止本机已有服务。

新增服务测试使用临时目录、模拟 Linux `/proc` 与 socket inode、模拟 PM2、受认证的本地 manager/worker HTTP 和 MCP stub。覆盖：配置绑定与持久化、跨实例拒绝、摘要过期、SSH 信任变化、白名单参数/秘密变量拒绝、PM2 ecosystem 入口及软链接绕过拒绝、实际 Node/模式/cwd/env 校验、PID 端口归属、同时启动互斥、幂等、冲突、退出与重启不稳定、旧启动日志、启动超时、部分成功、未知回执、全局保存约束、错误与输出脱敏。

测试没有向真实 default 或 test-server 发起远程调用，没有启停现有 BE，也没有安装或发布插件。test-server 的配置仅作为仓库内明确绑定的示例；真实远端验收尚未执行。初版仅支持 Linux、已存在的 PM2 daemon 和 fork 模式，验证 TCP 端口及有界启动日志，不包含公网/nginx 或业务 HTTP 验收。
