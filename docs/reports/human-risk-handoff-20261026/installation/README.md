# 本地插件更新

已通过配置中的本地marketplace正式安装并保持启用 `remote-debug-agent@remote-debug-local`，版本 `2.4.0+codex.20261026.5`。

- 安装目录：`/Users/zhengchenchen/.codex/plugins/cache/remote-debug-local/remote-debug-agent/2.4.0+codex.20261026.5`
- runtime：`2.4.0:e4e1734a9863e7c34476f9d50e27309c5d4b8686318c91c6435781bb117ed6a2`
- 65个安装文件与源码逐字节一致，26项runtime清单哈希全部匹配。
- 从安装目录运行正式launch.cjs，公开stdio initialize返回`.5`，tools/list返回51项，disposition含reviewMemo及human-risk-acceptance-v2说明。
- 新技能说明已安装：v2人工审核不再要求外部迁移回执或先隔离整实例。

安装已完成，运行态尚未统一切换：本机多个旧会话仍连接旧Manager（观察PID87921、`.4`入口），公开capabilities尚无新v2策略。握手通过受支持的显式本地URL禁止自动替换Manager，因此没有中断已有会话。请重启Codex，使旧MCP会话和本地Manager统一加载新版；不能把`.5`安装完成表述为当前旧Manager已经生效。

本次只提高本地发行元数据并重新打包，可执行runtime哈希与上轮693项通过/19跳过的候选相同，未重复执行完整回归。安装后的真实握手与哈希核验通过；TestFlow仅freeze固定未提交版本，snapshotId=`1c02775dc285feffd5cef0a67c9eecae8f78ec35afb2c1ff24fc3a0cc6a1fcf1`、captureVerified=true，无prepare/execute；既有node:test适配器/绑定/镜像缺口保持，未称为TestFlow测试通过。

全量marketplace列表检查遇到一个无关的Windows ponytail-local失效路径；指定remote-debug-local的安装成功，没有修改其它marketplace配置。安装器自动清理旧缓存后，已从对应Git历史恢复五个仍有旧进程引用的版本，并核验其runtime哈希；新安装选择仍为`.5`。恢复过程没有改动业务状态。没有删除配置、受保护上下文、任务记录或hold，没有远端服务重启、真实任务审核/终止/替代/业务写入、Git提交/推送/PR。

详情：update.json、handshake.json、testflow-freeze.json。

安装后的本地最终结果发布曾因当前旧MCP的`.4`缓存被安装器清除而失败（BUNDLED_AGENT_NOT_FOUND）。已恢复匹配的旧缓存后重试，详情见cache-recovery.json；不把该故障当作安装失败或业务操作失败。
