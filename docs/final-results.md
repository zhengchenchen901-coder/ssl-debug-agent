# 任务最终交付物管理

`FinalResultStore` 只保存任务收尾后明确发布的最终文件。MCP 普通响应、输出预览、日志查询分页、进度轮询、资源调度终态和执行检查点均不会触发写入。

## 位置与目录

源码开发默认使用项目根目录的 `output/`，从 `agent/` 启动也使用根目录。MCP 启动安装版 Manager 时，能定位源码项目则使用该项目的 `output/`，否则使用数据目录的 `output/`。生产安装建议在本机 `config.env` 显式配置绝对路径：

```dotenv
REMOTE_DEBUG_OUTPUT_DIR=/absolute/path/to/ssl-debug-agent/output
```

修改后重新启动 Manager。连接外部 Manager 时以该 Manager 的配置为准；列表响应和 Dashboard 显示实际目录。不写插件缓存，升级不会随缓存删除产物。

```text
output/
  instances/<instanceId>/tasks/<taskId>/
    manifest.json
    results/<artifactId>.json
    reports/<artifactId>.md
    exports/<artifactId>.csv
    attachments/<artifactId>.txt
  manager/tasks/<taskId>/...
```

使用稳定 UUID 作为目录名，发布时间、任务标题保存在清单内。类别按用途划分，按需创建。支持 UTF-8 的 JSON、Markdown、文本、CSV、JSONL、HTML；JSON 内容传 JSON 值，其余文本格式传文本。图片、PDF、Office 等二进制最终文件使用 `format=binary`、`encoding=base64`，`content` 传规范 base64，`name` 传含扩展名的下载文件名。磁盘使用生成的 `.bin` 文件名，下载恢复展示文件名。HTML 只提供文本预览和附件下载；二进制附件提供完整下载。

## 发布与读取

MCP 提供四个工具：`remote_debug_publish_final_result`、`remote_debug_list_final_results`、`remote_debug_get_final_result`、`remote_debug_read_final_artifact`。现有工作流在整项任务收尾时调用发布工具，并保持业务引用为不透明引用；不还原业务原值。

```json
{
  "instanceId": "test-server",
  "taskId": "61a8317d-4cb7-48ae-bd5b-266237c8a6ad",
  "title": "接口错误排查最终报告",
  "type": "diagnostic",
  "status": "completed",
  "final": true,
  "artifacts": [
    { "category": "reports", "format": "markdown", "name": "排查报告", "content": "# 排查结果\n最终结论与证据范围。\n" },
    { "category": "results", "format": "json", "name": "汇总", "content": { "matched": 12, "complete": true } }
  ]
}
```

`instanceId` 必须显式提供，Manager 任务传 `null`。同一任务的启动/查询/恢复不产生新交付目录；任务收尾时汇总一次。最终状态接受 `completed/partial/failed/cancelled`，失败和取消只保存最终摘要及明确交付的部分结果。

清单保存文件类别、展示名、物理相对路径、字节数、SHA-256、发布时间及任务关联。现有资源任务 ID 不是产物身份；通过 `references.operationIds/jobId/mutationId/resourceTaskId` 建立关联。运行态任务清理、Worker/Manager 重启不影响历史读取。已删除实例的历史可使用原实例 ID 通过工具或 HTTP API 读取。

HTTP API 复用 Manager 的回环 Host/Origin 和 Bearer 身份认证：

| 操作 | 接口 |
| --- | --- |
| 发布最终文件 | `POST /api/final-results` |
| 按实例列举 | `GET /api/final-results?instanceId=test-server&offset=0&limit=20` |
| Manager 任务 | `GET /api/final-results?scope=manager` |
| 清单 | `GET /api/final-results/<taskId>?instanceId=test-server` |
| 限量预览 | `GET /api/final-results/<taskId>/artifacts/<artifactId>?instanceId=test-server&maxBytes=65536` |
| 完整下载 | 同上，增加 `download=1` |
| 手动删除最终文件 | `DELETE /api/final-results/<taskId>?instanceId=test-server` |

SDK 可直接构造 `new FinalResultStore({root: absolutePath})` 并调用 `publishFinalResult`、`listFinalResults`、`getFinalResult`、`openArtifact`、`cleanupFinalResult`。它们不执行远端操作，也不复制远端恢复文件。SDK 的默认凭据护栏识别文本凭据；有已知业务引用的工作流须先经过 MCP 的业务隐私处理，不应直接写入原始数据库结果。

## 一致性与边界

先完成元数据和文本文件的凭据护栏检查再写入，MCP 额外执行当前上下文的已知业务值清理；未识别的自由文本不提供通用业务脱敏保证。Manager 还记住本机认证和实例中配置的凭据。二进制内容不执行文本替换，按原始字节保存，应由已完成脱敏的最终数据生成；清单标注 `text_redacted` 和 `binary=verbatim`，不声称二进制经过内容脱敏。目录使用所有者权限，文件以 0600 创建；Windows 复用本机 ACL 保护。拒绝根目录/子目录符号链接、文件符号链接和硬链接，通过任务/文件 ID 定位，读取时核对大小和摘要。

每任务最多 32 个文件，单文件 4 MiB，任务内容合计 8 MiB；请求及护栏也有独立上限，JSON 编码开销可能使实际可接受内容更小。每个实例/Manager 分区最多 10000 项目录。第一版没有跨实例磁盘配额或自动过期删除；磁盘不足明确报告归档失败，保留已有文件，支持 Dashboard 手动清理。

最终文件先在与 `output/` 同级的 `.output-final-staging/` 内准备，全部同步后原子移动任务目录；`output/` 不出现半成品。任务目录保持不可变，相同任务和相同内容重复发布复用已有结果，不同内容返回 `FINAL_RESULT_CONFLICT`。进程崩溃可能留下不可见的 staging 残留；确认没有发布者运行后可人工清理该临时区，不能将残留当作已经发布的交付物。输出目录及临时区应位于同一本机文件系统。

业务成功与归档成功独立：发布失败不改变已发生的数据库/服务器操作，也不得触发重放。丢失发布响应时使用同一 taskId 和同一内容重试。删除实例不删除产物；手动删除仅移除本地最终文件，不触碰远端回滚窗口、日志、租约或加密引用存储。

历史 `docs/reports`、旧 output 文件不自动搬迁，不猜测任务归属。新工作流通过统一发布入口生成最终交付物。
