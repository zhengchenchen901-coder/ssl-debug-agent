# 实例配置导出与导入

在 Windows 10/11 和 macOS 上使用同一套操作，可将本地插件的连接实例迁移到另一台电脑，继续连接**同一台远端服务器**。目标电脑先安装包含此功能的兼容版本插件。

## 操作

1. 解锁源电脑的实例管理面板，在实例行点击“导出配置”。
2. 设置并确认 12–256 字符的加密口令，下载 `.rda-instance.json` 文件。
3. 在目标电脑解锁面板，点击“导入实例”，选择文件、输入原口令，再点击“解密预览”。
4. 核对远端目标、主机指纹和权限。需要时修改实例 ID 和名称，再点击“创建新实例”。重名、仅大小写不同或已有同名资料目录时，必须改 ID，不替换旧实例。
5. 导入后实例处于停止状态，确认配置后手动启动。没有主机指纹的旧实例仍需先填写可信来源核验的指纹。

文件包含 SSH 私钥、私钥口令、实例保存的沙盒数据库管理密码和运维记忆；内容使用 scrypt 派生密钥和 AES-256-GCM 加密。口令丢失无法恢复。请妥善保管文件和口令，不要将生产导出文件作为测试夹具或上传仓库。

## 迁移边界

保留实例的 SSH 目标、指纹、启用设置、批准命令配置、源码根路径、日志项目、服务启动配置，以及自动/人工 MongoDB 连接与权限。远端数据库凭据原本从服务器配置文件读取的，仍从同一远端文件读取，不下载远端文件。

实例 ID 修改时同步调整服务配置与记忆归属。SSH 私钥按原始字节保存到目标数据目录的 `.remote-debug/instances/<id>/imported-ssh-key`，不会沿用源电脑盘符或路径。审计路径重设，Worker 端口重新分配；Manager 全局设置沿用目标电脑，预览会提示差异。现有实例资料目录不会被覆盖，请使用新的 ID。

不复制远端程序、数据库、服务器文件、任务、日志、报告、人工管理员账号、认证令牌或隐私引用数据库。导入过程中不启动 Worker，不执行远端操作。源实例不受影响。

Windows 使用当前用户专用 ACL；macOS 使用目录 0700、文件 0600。权限无法建立/核验、目录重定向、文件占用或写入失败时会报错并清理本次新增资料，不降低保护要求。支持中文和空格目录，不需要 Bash、OpenSSL 命令行或管理员提权。

## 文件与接口

单个私钥最多 1 MiB，解密内容最多 8 MiB，HTTP 导入请求最多 12 MiB。格式或算法参数不兼容时拒绝导入，不自动降级。

三个接口均要求本机 Bearer 认证、匹配的 Host/Origin，响应禁用缓存：

| 接口 | JSON 请求 | 结果 |
| --- | --- | --- |
| `POST /api/instances/:id/export` | `{password}` | 带附件下载头的加密包 JSON |
| `POST /api/instances/import/preview` | `{bundle, password}` | `{ok, preview}`，不回显私钥和密码 |
| `POST /api/instances/import` | `{bundle, password, id, name}` | `{ok, instance, runtime}`，新实例处于停止状态 |

`bundle` 是完整加密包对象。预览不写入文件；创建时再次解密、校验并检查冲突。错口令或密文损坏统一返回 `TRANSFER_DECRYPT_FAILED`。密码、私钥及导出口令不写入活动日志或浏览器持久存储，关闭弹窗和退出面板会清除表单及预览。

## 开发验证

使用项目要求的 Node 22（>=22.18、<23），直接运行测试，不需要 TestFlow：

```text
cd agent
npm test
npm run test:transfer-browser
npm run build:runtime
cd ../plugins/remote-debug-agent
npm test
```

浏览器测试使用 `playwright-core`，通过 `RDA_BROWSER_EXECUTABLE` 指定已安装的 Chrome/Chromium 可执行文件；macOS 默认 Chrome 路径，其他平台默认 Chrome channel。测试使用临时目录与虚构凭据，不连接真实 SSH 或 MongoDB。

CI 的 Windows/macOS 矩阵运行原生权限和浏览器测试，随后交换仅含公开虚构数据的加密夹具，分别验证 Windows→Windows、macOS→macOS、Windows↔macOS。修改 CI 配置不代表已执行 CI 或完成 Windows 验收。

也可手动交换夹具目录，在两台电脑使用：

```text
node test/instance-transfer-interop.mjs export <夹具目录>
node test/instance-transfer-interop.mjs import <夹具目录> --require-both
```

`--require-both` 要求目录包含 `win32.json` 和 `darwin.json`；不要用文件重命名代替真实操作系统产出的夹具。仅单机验证时省略该参数，结果会列出实际源/目标平台。
