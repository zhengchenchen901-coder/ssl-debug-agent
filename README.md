# Remote Debug Agent

## 任务最终交付物

新增统一最终结果存储：`output/instances/<instanceId>/tasks/<taskId>/`，按 `results/reports/exports/attachments` 分类。任务收尾时通过 `remote_debug_publish_final_result` 一次发布；普通工具响应、轮询、分页和检查点不会归档。Dashboard 实例详情可列举、预览、下载和手动删除，Manager 任务有独立列表。相同任务重复发布相同内容复用已有文件，历史在重启后仍可读取。

通过 `REMOTE_DEBUG_OUTPUT_DIR` 指定绝对目录；源码开发默认使用项目根目录的 `output/`。支持的文本格式、接口、容量上限和恢复边界见 [最终交付物管理](docs/final-results.md)。代码与内置 runtime 更新后，需要更新安装版插件并重启 Manager 才会生效。

## Manual administrator workbench: 2.4.0

Windows 注册前会实际检查原生认证组件和交互式桌面是否可用。Windows
返回的受保护凭据在原生组件内解包，并按本地账户、域账户或 UPN 格式登录；
验证后的用户 SID 必须与插件当前用户一致。取消、凭据解析失败、登录被拒绝和
账户不匹配会显示不同提示及适用的 Windows 错误码，不输出系统密码或原始诊断。
macOS 保留现有 LocalAuthentication 流程。

Dashboard 在“新建实例”旁新增“注册管理员”，实例行新增“手动操作”。先解锁现有本地面板，再注册独立的插件管理员账号（密码至少 12 个字符）。注册需要系统身份验证；已有管理员时还需已有管理员账号和密码授权。忘记密码可在注册窗口选择“通过本机身份验证重置”，完成后撤销该账号的全部旧人工会话。

点击“手动操作”后，在独立本地端口的新窗口输入管理员账号和密码，即可连接交互式 SSH 终端。浏览器若拦截弹窗，需允许本地 dashboard 打开窗口。工作台包含连接预览、操作面板和可交互终端，支持窗口尺寸变化、Ctrl+C、清屏、断开和手动重连。自动 Worker 停止时仍可使用人工终端；禁用或删除实例则不能使用。实例编辑会撤销旧人工会话。

人工终端复用所选实例的 SSH 用户、私钥及已核验的主机指纹，建立独立连接，不经过自动命令/路径白名单。插件管理员不自动获得远端 root 权限；需要时由操作者在终端使用远端允许的 sudo。自动 MCP 工具保留原有权限。第二阶段已加入 MongoDB GUI 与真实 mongosh；实时日志面板和 Agent 命令建议留待后续阶段。

工作台“数据库”入口支持库/集合浏览、BSON Extended JSON 筛选与排序、有界游标分页、文档查看/确认替换和索引查看；操作区提供独立 mongosh。先在实例管理单独保存“人工数据库管理连接”，可复用远端 JSON/profile，但不沿用自动业务或沙盒权限。凭据留在远端，GUI 与 shell 启动时核验相同目标与数据库身份。切换入口保留 SSH 现场，变更连接撤销旧数据库授权。远端需有支持 EJSON 的 MongoDB Node 驱动和兼容的 mongosh，缺少客户端会明确报错。详见 [第二阶段说明](docs/plan/管理员手动工作台第二阶段.md)。

macOS 使用 LocalAuthentication 系统窗口验证 Touch ID 或当前用户密码；首次注册/恢复时会通过 `/usr/bin/xcrun swiftc` 编译随包提供的认证组件，因此需要 Xcode Command Line Tools。Windows 使用系统凭据窗口并验证登录身份的 SID 与当前运行插件的 Windows 用户一致。电脑密码不会提交给网页或 Node。Linux 暂未提供系统认证适配，注册/恢复明确不可用，不降级为网页声明验证成功。Windows 系统认证需在实际交互式桌面环境验收。

管理员密码仅以加盐 scrypt 哈希保存在 `<data-dir>/.remote-debug/manual-admin/accounts.json`；目录/文件使用本地所有者专用权限或 Windows ACL。人工 token 只保留在页面内存，刷新后重新登录；不写浏览器存储，不放入 URL。终端使用十秒有效的一次性连接票据，绑定当前实例；Manager/MCP token 不能作为人工登录凭据。15 分钟未输入或满 8 小时会话失效。连接断开不重放输入，重连会新建 Shell；SSH 断开不保证停止用户自行启动的后台进程。

人工会话的登录、终端连接、退出、失效及管理员变更元数据记录在同目录的 `sessions.jsonl`，不记录终端字节、密码或 token。原生认证组件缓存位于其 `native/` 子目录。页面、终端组件和认证源码均随 runtime 打包，不从 CDN 加载。详细接口、边界和验证见 [第一版说明](docs/plan/管理员手动工作台第一版.md)。

## Sandbox account administration: 2.3.2

沙盒账户的权限预检、角色/用户创建与验证明确使用主节点，专用管理连接也选择 primary；原业务连接分组及读取偏好保留。若实际连接直指从节点，预检会在数据库写入前返回 `SANDBOX_SETUP_PRIMARY_REQUIRED`。账户配置失败会显示固定阶段及经过筛选的数据库数字错误码或文件系统错误码，不输出原始驱动错误、连接串或密码。部分完成的账户配置仍须重新准备具体计划并确认，不能盲重放。

## Sandbox file boundary: 2.3.1

服务器继续保留批量任务、日志和回滚副本。沙盒仅接受结构化任务记录：块、业务单元和操作的未知字段会被拒绝，调用方不能通过 `fileName`、`path`、`content` 等额外参数上传文件或指定落盘位置。合法业务字段仍可包含文本或 Extended JSON 数据；数据内容是否与业务任务相关，交给后续插件与实例之间的内容护栏判断。本轮不使用代码关键词或后缀检测替代内容授权。

记录只写入配置的专用目录、插件生成的固定 JSON/JSONL 文件和控制锁；根目录、任务目录和已有记录须符合归属、0700/0600 权限及 canonical 路径检查，拒绝符号链接、硬链接和未知文件名。事件追加同时检查实际打开的文件描述符。所有记录按数据解析，不提供从沙盒加载模块或执行记录的接口。这是文件入口限制，不是 SSH 进程的容器隔离，也不会限制其他独立授权的远端管理功能。

每实例文件数据上限为 2 GiB，另留 64 MiB 和 1024 个文件条目给进度、租约、控制及事件记录；最多接纳 200 个任务目录、20000 个普通文件条目，单任务普通记录最多 1950 个（另留 50 个控制条目），单事件日志最多 8 MiB。写入通过实例级锁重新统计容量，包含原子替换临时文件所需空间。超过限额拒绝继续增长，不自动删改恢复记录；需通过已授权的过期任务清理释放空间后重试。预留空间提高恢复可用性，不能保证磁盘满或保留任务异常时所有恢复操作仍可完成。目录统计会增加准备和写入的文件系统开销；限额为逻辑文件大小和条目数，不替代操作系统磁盘配额。

## Plugin storage sandbox: 2.3.0

Dashboard 的实例表单新增“沙盒管理账户密码”和“保存并配置沙盒账户”。密码按实例保存，编辑时不回显，留空保留原值；本地 registry 使用所有者专用权限（Unix 目录 0700、文件 0600；Windows 使用并验证专用 ACL）。保存后配置流程只重新加载所选实例，先检测该实例的 MongoDB 版本、拓扑和有效权限，再显示准备结果；确认后才创建固定沙盒角色、为执行账户追加沙盒权限，并创建管理账户。后续修改密码并再次配置，只重置带有本插件归属标记且权限完全匹配的账户。重新加载配置本身不修改 MongoDB 账户。进行配置前请结束该实例正在进行的操作；其他实例的环境与密码不复用。

MCP 对应 `remote_debug_prepare_sandbox_access` → 展示实例、版本/拓扑、账户、完整权限范围、连接文件变更、到期时间与计划哈希 → 用户明确“确认配置沙盒” → `remote_debug_configure_sandbox_access`。准备只保存受保护的计划，不修改数据库账户或业务配置。执行使用该实例最新保存的密码，过期、密码/配置/环境变化、过期 Worker 配置、已有角色/账户冲突均拒绝执行；部分失败须重新准备，不执行猜测式回滚。现有连接必须已有创建角色/账户、授予角色及重置密码所需的管理权限，不自动提升权限，也不接受任意角色、数据库命令、连接串或脚本参数。

配置会为远端连接文件建立 0600 备份，并把更新后的连接文件设为 0600（属主/属组保留）；请确保应用使用该文件属主身份读取。仅新增/更新一个沙盒管理连接分组，业务连接分组保留。管理用户仅能读取和清理固定技术集合，不能初始化集合、创建索引或修改业务文档；技术集合/TTL 仍通过单独的结构化存储初始化计划确认。账户设置要求 MongoDB 4.0+ 和相应 wire protocol；准备结果单独报告单机/复制集/分片与事务能力。单机配置账户不代表其支持事务批量写入。真实集成目前验证 MongoDB 4.4.30 + driver 3.3.4，其他版本仍需按实例验收。

New resumable bulk jobs store receipts in `remote_debug_agent.__remote_debug_bulk_receipts` on the **same MongoDB deployment** as their business database. `mongodb.sandboxDatabase` may select another dedicated database, but it cannot be a business allowlisted database or `admin`/`local`/`config`. The execution helper uses the same MongoClient/session for business writes and the receipt insert, so both commit or abort together. The execution account needs the existing business privileges plus `find`/`insert` on the technical receipt collection; confirmed storage initialization additionally needs the appropriate index/collection creation privileges there. Do not add the sandbox database to the business write allowlist.

New jobs use v2 manifests and plans that bind receipt database, collection and scope into the plan hash. Existing v1 jobs continue to use their original business-database collection and original receipt IDs/digests for resume, duplicate detection and rollback. No receipt collection is automatically moved or deleted. Reuse the existing configured `bulkRoot` so old job files remain reachable; changing the root does not move them. Existing pending storage initialization plans retain their recorded destination; prepare a new initialization plan for the dedicated database before preparing new jobs. If a dedicated database setting changes, jobs bound to the earlier setting stop with a clear error instead of silently using a new namespace; restore that setting for their recovery.

Local audit and memory files remain in `<data-dir>/.remote-debug/instances/<instanceId>/`; remote bulk files remain under the protected configured `bulkRoot` (default `/var/lib/remote-debug-agent/bulk-jobs`). Ordinary mutation journals retain their existing `/tmp/remote-debug-agent/mutations` location for compatibility and remain inspectable through the mutation-list tool. The update does not move existing files or initialize production storage automatically.

The dashboard instance details now include sandbox capacity, audit/event export and prepared expired-job cleanup. Equivalent MCP tools are `remote_debug_get_sandbox`, `remote_debug_export_sandbox_log`, `remote_debug_prepare_sandbox_cleanup`, and `remote_debug_cleanup_sandbox`. They accept instance/job IDs, never caller-selected paths, databases or collections. Local export reads only bounded redacted audit tails and excludes credentials/memory contents; active local audit files are retained. Remote export reads bounded redacted job events, not business before-images. Metadata scans are bounded and remote management uses a background SSH channel.

Remote management requires a distinct connection profile using the same MongoDB endpoints, connection type and replica-set setting as execution, in the same remote application configuration, selected by `mongodb.sandboxManagementProfile`; `sandboxManagementUriKey` defaults to `url`. For example, configure business profile `production` and separate profile `remote_debug_manager`, then set:

```json
{
  "sandboxDatabase": "remote_debug_agent",
  "sandboxManagementProfile": "remote_debug_manager",
  "sandboxManagementUriKey": "url"
}
```

Use an authenticated MongoDB deployment and a custom manager role whose privileges are limited to `find` and `remove` on `{db:"remote_debug_agent",collection:"__remote_debug_bulk_receipts"}`. Create this account through the explicitly confirmed structured sandbox-access setup, or have a database administrator provision it and store its URI in the management profile. The generic database mutation tools do not create users or grant roles. It inspects the authenticated user's effective privileges and refuses management credentials with business, wildcard, cluster-wide or write/index-management privileges. Execution and management connections remain distinct; no arbitrary URI is accepted through MCP. Local audit inspection needs only the existing authenticated local Manager session. This is application and database permission isolation, not an OS/container sandbox for the SSH process.

Cleanup is per job: only `completed` or `rolled_back` v2 jobs with no live lease, no unknown files/symlinks, and an expired rollback window plus an extra 24 hours are eligible. Prepare returns an exact `cleanupHash`; execution requires that hash and `确认清理`, rechecks state/retention/files, and deletes only matching expired scoped receipts and that job's files. V1 receipts in business databases are **read-only to sandbox management** and are never automatically deleted. Old collections can be retired separately by an administrator only after all dependent jobs and recovery windows have ended. If management credentials are absent or overprivileged, management fails closed while ordinary authorized bulk execution remains available.

## TTL index safety: 2.2.2

Generic index tools support non-TTL indexes only (`unique` and `sparse` options). Business `expireAfterSeconds` is rejected during plan preparation and execution, including immutable plans prepared by older versions. Preparing or committing a TTL index drop is also rejected because its compensating rollback would restore automatic deletion. Restoring a previously dropped TTL index through an old rollback journal is blocked. An already committed legacy TTL creation can still be rolled back by removing that exact unchanged index, but the response explicitly reports `rollbackRestoresDocuments: false`: documents already deleted by MongoDB are not recovered. Existing business TTL indexes are not automatically changed by this update.

The sole automatic-expiry exception is bulk job storage: the fixed `__remote_debug_bulk_receipts` collection with index `remote_debug_bulk_receipt_expiry`, key `{expiresAt: 1}` and `expireAfterSeconds: 0`. Both remote initialization helpers verify or establish the plugin ownership marker **before** creating the index and refuse non-empty unowned collections, foreign markers, views, or changed index definitions. Generic document/import/transaction/index tools cannot write to this reserved collection. Custom `bulkReceiptsCollection` names are no longer accepted by bulk tools; existing custom storage is not renamed or migrated automatically. Resolve any existing custom jobs with an administrator before upgrading their configuration; changing the name does not transfer their receipt history.

## Security upgrade: 2.2.1

Stop the previous Manager after active operations finish before upgrading. The new MCP refuses to reuse an unauthenticated legacy Agent. Re-enable/reinstall the plugin and reload the chat after upgrading the runtime.

The Manager generates a 256-bit access token in `<data-dir>/.runtime/http-auth.json` (override with `REMOTE_DEBUG_AUTH_FILE`). The file and its directory are owner-only; initialization fails if permissions/Windows ACL cannot be protected. MCP reads it automatically. Copy the `token` value into the dashboard unlock form; it stays in that tab only. Logout or a 401 clears it. Never share this file or put its token in a URL. Ordinary HTTP clients must send `Authorization: Bearer <token>`. MCP and diagnostics verify a fresh, listener-bound health proof before sending a credential to a local port; merely claiming to be an Agent cannot obtain the token. Only dashboard assets and minimal `/health` are public. Worker tokens are independent, delivered through private IPC, and expire at worker restart.

SSH now requires verified OpenSSH SHA256 host-key fingerprints on every connection and reconnect. Add up to four entries to an instance’s `hostKeyFingerprints` array in the dashboard, or configure `REMOTE_DEBUG_SSH_HOST_KEY_FINGERPRINTS=["SHA256:..."]` for the environment-defined instance. Obtain fingerprints through a trusted server console or administrator; for example, run `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256` on that console and verify the configured server offers the corresponding key. An unverified network scan does not establish trust. Existing instances migrate to registry v4 with an empty array and cannot connect until configured. Changing the host/port clears previously inherited pins; enter verified pins again and refresh the instance. `SSH_HOST_KEY_REQUIRED` and `SSH_HOST_KEY_MISMATCH` stop retries until configuration is corrected.

File-reading command arguments are now parsed per executable. Every file operand must be an allowed absolute path and is canonicalized and POSIX-quoted before execution. Supported options: `cat -n/-b/-s/-v/-E/-T/-A`, `ls -l/-a/-A/-h/-d/-t/-r/-S/-1/-n/-i/-p/-F`, `tail -n/-c/--lines/--bytes`, and `grep -E/-F/-i/-v/-n/-H/-h/-c/-l/-L/-s/-w/-x/-o/-e/-m/-A/-B/-C`. Safe short options may be combined. Tail counts are at most 10,000 lines or 1 MiB; grep numeric options are at most 10,000. Recursive reads, symlink-following options, grep pattern files, relative file operands, and follow/retry tails are rejected. Use the structured log tools for recursive searches.

Custom Agent URLs outside loopback require HTTPS and a matching owner-only credential file. Redirects are rejected; authorization failures are reported without restarting a Manager or selecting another port. Independent diagnostic mode remains read-only and cannot perform SSH or instance operations. These changes protect the local API boundary; they do not protect against a process that already fully controls the current user account.

### MCP sensitive output guard

The MCP wrapper applies an always-on output guard before sending tool results
to Codex. `output-contracts.js` defines allowed response fields for every tool;
unknown metadata fields are omitted and unregistered tools cannot return data.
Explicit JSON surfaces (business query documents, log events, capabilities and
memory summaries) keep their flexible structure but are recursively sanitized.
New tools and metadata fields must add an output contract and protocol tests.

The guard masks credential fields of any JSON type, password/token/API-key
assignments and command flags, Authorization and Cookie headers, authenticated
URLs, PEM private keys, and recognizable token formats. It also checks nested
and escaped JSON text. Configured HTTP tokens, environment secrets and local
per-instance SSH/sandbox passwords are matched even in unlabelled text. Known
configured secrets stay in process memory only; additional secrets discovered
in a response are scoped to that response. This is deterministic filtering,
not model review, and has no raw-output bypass switch.

Successful payloads include `outputGuard` metadata with the policy version,
replacement count and omitted-field count; no matched values are included.
Error messages, approved diagnostic fields, wrapper stderr and lifecycle event
details are sanitized too. Raw upstream error payloads/stacks are not forwarded.
The final transport supports only the existing JSON text tool result format;
new structured/media result types require an explicit guard implementation.
Static server-owned tool schemas remain unchanged. Draft IDs, plan hashes,
confirmation phrases and ordinary diagnostics remain available unless they
themselves contain a detected secret.

Responses are buffered before output. HTTP bodies and final serialized results
are limited to 8 MiB; traversal has depth, work and time limits. An invalid shape,
unsupported result, exceeded limit or guard failure returns a fixed
`OUTPUT_GUARD_BLOCKED` error without including the original content. Replacements
use `[REDACTED]` and are not executable secret references. This guard does not
change remote operations or their stored data; a blocked response does not mean
an operation was cancelled, so inspect its status before retrying a write.

The boundary covers this plugin's MCP output, not independent terminal/file
access or data previously placed in a chat. Unknown opaque secrets and arbitrary
encodings cannot be guaranteed detectable. Phone/email/identity-number masking
and per-collection business privacy policies are not part of this first layer.

### MongoDB business references (phase 1)

Structured MongoDB results now replace business identifier/key values with random
`rda_ref_v1_…` references after credential redaction. This covers query documents,
mutation `affectedIds`, bulk `sampleIds` and verification differences. Fields named
`id`, `_id`, `ids`, `key`, `keys`, UUID/UID/GUID aliases, and camel/snake/kebab ID/key
suffixes are recognized recursively; ordinary fields such as `valid` and `monkey`
and BSON tags such as `$minKey` are preserved. Aggregation projections and derived
expressions retain identifier provenance when fields are renamed. Credentials
still become `[REDACTED]` and never become executable references.

Reuse the **whole reference** as a structured value in query filters/pipelines,
document writes, transactions, imports, and bulk operations/expected values. Do
not put it inside `$oid`/`$numberLong`, interpolate it into shell/text, or compute a
chunk hash over references. Omit optional `chunkHash` to let the Agent calculate
the hash of the restored, normalized contents. Index definitions, plugin control
IDs, database/collection names, counts, confirmation phrases and execution hashes
retain their existing contracts; control identifiers should not embed business
data. Existing allowlists, prepare/commit checks and confirmations still apply.

References preserve the wire BSON/EJSON value and type. Native BSON encoding now
preserves Long precision and supports decoding an already decoded ObjectId, while
ordinary JSON counts remain numbers. Each MongoDB call refreshes the Manager's
instance catalog, pins omitted instance/database defaults, and binds references
to a persistent privacy context, Agent origin, instance target/profile and database. Unknown,
wrong-target, embedded or misplaced references fail before the business request.
There is no tool to export the reference map.

Phase 2 commits mappings, task associations, operation intents and output delivery
records to **encrypted local SQLite** through an authenticated private Manager
service and a dedicated storage Worker. WAL with `synchronous=FULL` commits before
a reference is returned. `outputGuard.businessPrivacy` reports the context ID and
`storage: encrypted_sqlite`. The bounded 100,000-entry/32 MiB MCP cache is not the
source of truth. No raw-value enumeration, SQL, key export or mapping-export MCP
tool is available.

The macOS adapter keeps the master key in Keychain; Windows/Linux currently fail
closed for protected MongoDB operations until a credential adapter is provided.
An unavailable/locked keychain, changed target, corrupt record or wrong key never
falls back to plaintext or process-only references. Configure the MCP-only
`REMOTE_DEBUG_PRIVACY_CONTEXT_FILE` to reattach the **same owner-only local
context file** across MCP/Manager/computer restarts. Without that setting each
MCP starts a new context and saves its attachment file under
`<data-dir>/.private/contexts/<contextId>.json`; reattach by configuring that file
locally. Never paste its capability into chat. See
[storage and recovery](docs/business-privacy-storage.md) for retention, key
availability and uncertain-write reconciliation. References obtained in phase 1
cannot be recovered after their original memory-only process exits.

Known identifier strings of at least six characters are also scrubbed
from flexible text/errors/diagnostics, including URL/JSON escaping; this is not a
general guarantee for free-text logs, arbitrary encodings or unknown field names.
New business values should enter through the local workbench/import path if they
must never appear in the chat.

Local isolated verification is in
`plugins/remote-debug-agent/test/business-privacy*.test.js`. The opt-in real MongoDB
test `test/business-privacy-mongo.e2e.mjs` requires `RDA_PRIVACY_TEST_URI` pointing to
a **dedicated disposable loopback replica set** with `directConnection=true`, plus
`RDA_PRIVACY_TEST_DRIVER` pointing to a local driver. It creates unique databases,
runs the real Agent helpers through a fresh local MCP process, and removes its
databases and temporary files afterward. It never loads saved remote instances.

### Dashboard MCP output preview

Each instance row has an **输出预览** button. It opens a live list of the
plugin's final, guarded tool responses, including errors and guard blocks.
**全局输出** shows tools without an instance, such as instance/capability lists.
Tool content and the exact JSON-RPC message can be viewed or copied; the preview
does not confirm Codex reception or subsequent context processing. Responses
appear after each tool returns, rather than streaming unguarded SSH chunks.

The wrapper copies the same final serialized message written to MCP stdout
into a bounded asynchronous publisher. Separate authenticated endpoints handle
ingest (`POST /api/output-preview/records`), summary snapshots
(`GET /api/output-preview/records`), SSE notices
(`GET /api/output-preview/events`) and full-message reads
(`GET /api/output-preview/records/:id`). SSE contains metadata only. The browser
uses an Authorization header for both streaming and full reads; tokens never
appear in stream URLs. The Manager's resolved instance header also attributes
failed and implicit single-instance calls without guessing from later config.

This cache is independent of activity, audit and remote sandbox storage. It is
memory-only: up to 100 responses / 10 MiB per instance (including the global
bucket), and 500 responses / 50 MiB overall, whichever limit is reached first.
Oldest records are evicted and Manager restarts clear the cache. The ingest
route alone allows up to 17 MiB of JSON to carry an escaped final MCP message
of at most 8 MiB; business API limits remain unchanged. The publisher queue is
bounded to 64 messages / 20 MiB with short request timeouts and no retries or
manager startup. A failed/full publisher never waits in the tool delivery path;
its next successful notice reports dropped records.

Preview controls include pause/resume, follow latest, clear display, full copy
and an expanded window. Selecting a message preserves the follow setting: new
output in that view selects the latest message when enabled, while status
refreshes preserve the selected message. Clearing affects only the current
display, not the Manager cache. The page displays at most 256K characters per selected message;
copy reads the complete retained message. Reconnects replay retained summaries,
report cache gaps, and detect Manager restarts. Logout aborts streams and full
reads and clears displayed content. Received text is never rendered as HTML.

Run `cd agent && npm run test:preview-browser` for the isolated real-browser
MCP-to-dashboard check. On macOS it uses installed Google Chrome; elsewhere set
`RDA_PREVIEW_BROWSER_EXECUTABLE` to a compatible Chromium binary. The fixture
uses temporary credentials/registry and a mocked worker, with no remote SSH.

## Project log queries

Configure `logProjects` on each instance in the dashboard or with
`remote_debug_set_log_project`. Paths must already be under the instance's
approved roots. These mappings persist locally and do not expand permissions:

```json
{"be":{"root":"/home/github/app","directories":["/home/github/app/logs"]}}
```

`REMOTE_DEBUG_LOG_PROJECTS` supplies the same JSON mapping in environment-based
setups. Configured source roots also provide a default `<root>/logs` mapping.
Use `remote_debug_list_log_projects` once, then reuse the instance/project id.

- `remote_debug_query_logs` with `mode: "latest"` reads small tail blocks from
  the newest selected file. Its default file count is one.
- `mode: "files"` selects candidate files by `date` or `dateFrom`/`dateTo` and
  literal `fileContains`, without recursive filesystem discovery.
- `mode: "members"` lists a selected tar-gzip archive's members remotely;
  `memberPrefix` and `memberOffset` narrow or page the member listing. The
  existing archive-member tool also uses this streaming path.
- `mode: "search"` scans selected files on the server and returns bounded
  matching records. It accepts literal `contains`, exact JSON `route`, `method`
  and `level`, plus inclusive `fromTime`/`toTime` with explicit timezones. Nested
  JSON payloads inside application `message` strings are supported.
- Gzip and tar-gzip are decompressed as streams. For tar archives,
  `memberContains`/`memberPath` selects regular members; container filename
  filters and member filters are separate. No temporary extraction directory
  or remote helper file is created. An exact selected member stops after that
  member. Traversal paths and link members cannot be read.

Results include source file/member, line number (or `lineFromEnd` for tail
reads), parsed fields, scanned/expanded bytes, matching/returned counts and
coverage. `countsAreComplete` concerns scan coverage; `outputTruncated` only
concerns returned records. Do not infer no matches for the whole date when
coverage is bounded. File pages expose `nextFileOffset`; the directory can
change between calls, so these are not immutable snapshots.

Searches and compressed/project queries use one background channel per
instance. Default scan limits are 32 MiB of selected log content and 1 GiB of
expanded archive content, capped at 256 MiB and 2 GiB respectively. File,
directory-entry, line, output and execution-time limits also apply. The target
needs Node 12.12+ in its SSH command PATH; the helper is separately transpiled
for older deployed Node versions. CPU/read I/O costs still exist despite zero
temporary disk writes.

For a full day, many files, or a large archive, use the background search tools:

1. `remote_debug_start_log_query` accepts the same project/path, date, record
   and member filters as a synchronous search. It returns a `jobId` immediately.
   It selects all matching files within the bounded directory manifest, rather
   than stopping at a file page. Do not pass synchronous `maxFiles`,
   `maxScanBytes` or `maxExpandedBytes`; `batchScanBytes` (default 256 MiB) is a
   progress boundary and never restarts or truncates the stream.
2. `remote_debug_get_log_query` returns cumulative progress, resource metrics,
   exact match counts, up to 100 error groups and bounded evidence. Poll about
   every 5 seconds initially, backing off for longer tasks. Use `offset` and
   `nextOffset` to page retained evidence. Only `status: "completed"` and
   `countsAreComplete: true` certify full coverage. `partial` records skipped
   lines, changed/unreadable files or incomplete discovery. Evidence and group
   truncation are reported separately from scan coverage.
3. `remote_debug_control_log_query` accepts `action: "pause"`, `"resume"` or
   `"cancel"`. A pause retains the decompressor with bounded backpressure; it
   expires after 5 minutes. Cancelling closes the remote process/channel.

File completion is recorded independently of the whole task. `fileResults`
contains each observed file's path, source identity, scanned/expanded bytes,
line/match counts, retained evidence count, warnings and completeness. A receipt
is acknowledged by the local worker before the next file begins, and remains
available after cancellation. `fileOffset`/`fileLimit` and `nextFileOffset`
page these receipts separately from evidence. The local receipt budget is
8 MiB per job; exceeding it fails the task explicitly rather than dropping
receipts. Receipt retention uses the same task expiry/worker lifetime as results.

`scanComplete` means the selected stable bytes were covered;
`countsAreComplete` means all matches were counted; `evidenceComplete` means
all matching original records were retained. For example, an oversized line
can make counts incomplete despite full byte coverage, and a 50-record sample
can coexist with exact counts of millions of matches. `paginationScope` is
`"retained_evidence"`: reaching the last evidence page cannot recover discarded
matches. Responses expose `retainedEvidenceCount`, `observedMatchedLines`,
`evidenceLimits` and `evidenceTruncated`. Per-file flags certify only that file
under the task's member/record filters, including when the whole task is cancelled.

Set `stopAfterFile` to an exact selected path at start for a known last archive,
or control with `action: "stop_after_file"` and optionally that path. Omitting
the path finishes the current file and stops before opening the next. Invalid
or passed boundaries fail explicitly. `action: "narrow"` accepts inclusive
`dateFrom`/`dateTo` and only shrinks the dates of files not yet started; it keeps
completed/current files and their counts. Skipped files get receipts with zero
scanned bytes. Boundary/range commands await a remote acknowledgement. Such
early termination is `stopped` with a `stopReason` and incomplete original task
scope, while earlier receipts remain independently complete. A boundary at the
last selected file still completes the original scope. Set a boundary in advance;
asking after a later file starts cannot undo that file's reads.

Cancellation immediately reports `cancelling`; boundary stops report `stopping`.
Terminal top-level and `progress.status` values agree. Unknown, null, empty,
wrong-type, oversized and action-inapplicable parameters are rejected by the
background tool/Agent rather than silently ignored. Synchronous limits such as
`maxFiles`/`maxScanBytes`, member-list prefixes and start offsets are not
background search parameters.

Managed instances run at most two background log helpers, with at most four
active/queued log jobs in total, subject to SSH channel and resource admission.
The standalone log runner without the shared resource service retains one helper.
Each archive is opened and streamed once for all selected members; there is no
temporary extraction or remote result file. Background searches are not stopped
at 2 GiB of expanded data. Resource control instead defaults to an average CPU
target of 20% of one core, 2 MiB/s source reads, 4 MiB/s expanded processing, a
64 MiB V8 heap and a monitored 192 MiB RSS termination threshold. CPU/throughput
limits use cooperative pacing and bounded buffers, not OS-enforced quotas.
Task deadlines default to 30 minutes (`jobTimeoutMs`, maximum 120 minutes),
independent of individual tool request timeouts. Increase runtime for larger
ranges before raising `cpuPercent`, `readBytesPerSecond` or
`processBytesPerSecond`. `REMOTE_DEBUG_LOG_JOB_LIMITS` can lower administrative
ceilings using a JSON object with `maxJobTimeoutMs`, `cpuPercent`,
`readBytesPerSecond`, `processBytesPerSecond` and/or `rssLimitBytes`.

Default retained evidence is the first 50 matches, with a 256 KiB serialized
record budget. Samples are streamed once as they are found and can be paged
while a task is running; statistics continue after samples fill. Interrupted
tasks retain those samples with incomplete counts. Progress frames are coalesced to once
per 5 seconds except control acknowledgements. No unmatched log text crosses
SSH. Results are kept only in local worker memory, at most 16 jobs, expiring
30 minutes after termination or earlier under retention pressure. A tool/MCP
client disconnect does not cancel an accepted job. Loss of the local worker or
SSH process cannot restore an in-memory gzip state; such queries must be
restarted without adding old partial counts. Remote control loss has a
60-second watchdog. Source metadata is checked before and after reads; changes
invalidate complete coverage. This detects common changes, not a filesystem
snapshot. Background tools need both the updated Agent and reloaded MCP tools.

### Shared remote resources and instance tasks

The Manager owns a shared `RemoteResourceManager`; each Worker registers task
metadata through private IPC using a per-execution generation. Log, database and
ordinary SSH/SFTP operations appear under **任务** on the instance row. The task
panel shows current/recent tasks, phases, progress, granted/observed resources,
and reasons for waiting or throttling. It reads local bounded metadata rather
than repeatedly enumerating remote database jobs. Refreshing/closing the page
does not change scheduling. Worker history is bounded to 200 tasks; the Manager
retains up to 1000 recent terminal/active records for 30 minutes. Manager restarts
clear this metadata cache; durable MongoDB receipts and journals remain the
authoritative recovery record. Worker loss marks its tasks interrupted and holds
their grants for the 60-second remote-watchdog grace period.

`resource-policy.js`, `remote-resource-manager.js`, `remote-resource-sampler.js`,
`worker-resource-client.js`, `task-registry.js`, and the serialized
`remote-resource-runtime.js` separate policy, telemetry, admission and cooperative
enforcement from log-query business logic. Logs use the common runtime for CPU,
source-read/expanded-byte pacing and RSS monitoring. SSH/SFTP receiving is paced
using a separate transfer budget. Generic commands and database services use
admission controls rather than OS-enforced CPU/memory quotas. Database bulk work
changes only the concurrency/spacing of later approved batches, preserving
in-flight waves and their original plan. A budget reduction must be acknowledged
before its CPU can be reassigned to another executor.

The resource domain defaults to SSH host/port. Configure `domains` explicitly
when aliases refer to the same machine or different container/quota scopes need
separate accounting. One Worker samples each busy domain every 5 seconds (idle
domains every 30 seconds, with on-demand revalidation before work) using a
fixed read-only Node helper. It reads CPU/memory counters, I/O wait and cgroup-v2
CPU/memory ceilings when available; unsupported sampling remains unknown. There
is no remote daemon installation or extraction file. Stale samples block heavy
work conservatively while control/ordinary operations retain protected admission.
CPU pressure lowers the bulk pool immediately; recovery increases in steps.

Default domain limits are 1000 CPU millicores (one core), with 50m reserved for
control and 200m for non-bulk tasks; 1 GiB of task memory with 256 MiB protected;
8 MiB/s source reads, 16 MiB/s expanded processing and 4 MiB/s SSH transfers.
The transfer pool reserves 2 MiB/s for control/non-bulk work. These are logical,
cooperative budgets, not disk-device quotas or guarantees about `mongod` CPU.
Task memory reservations and RSS ceilings are not enlarged by a manual boost.
Paused helpers continue to count against resident-memory accounting.

**手动最高档** applies to bulk tasks only and prioritizes the selected task for
the remaining domain budget after control/non-bulk reserves and uninterruptible
in-flight database work. There is one selected maximum per resource domain;
selecting another task returns the previous one to auto. The mode is stored in
the backend and can be reverted with **恢复自动**. It can raise a task's normal
requested rates, but never the resource pool or explicit administrative
`REMOTE_DEBUG_LOG_JOB_LIMITS` ceilings. Running commands, existing stream/channel
occupancy and safe batch boundaries can delay activation; the panel reports the
grant and reason. Pauses release CPU/throughput demand without reclaiming live
RSS. Completion/cancellation/failure/connection loss releases the selection.
This is a dashboard scheduling action and does not approve or start a database
mutation. Task IDs and mode revisions protect against stale or cross-instance
actions. Task controls and resource mode changes are authenticated and audited.

`REMOTE_DEBUG_RESOURCE_POLICY` supplies validated JSON overrides for domain
limits, protected reserves, sampling cadence and instance-to-domain mapping.
For example, `{"cpuMilliCores":1500,"domains":{"default":"production"}}`.
Restart the local Manager after changing this administrative configuration.
Log API `limits` are the original requests; `resources.budget` is the effective
remote grant. No manual-maximum MCP tool is exposed.

The existing `remote_debug_read_log` tool now uses the same remote helper and
keeps its chronological output format. Its runtime improvement works in
existing sessions; the new tools require an MCP/session reload to become
visible. Older direct-library SFTP callers retain the existing decoder.

Remote Debug Agent is a Codex Desktop plugin plus a local HTTP manager for safe
Linux server debugging over SSH.

Architecture:

```text
Codex Desktop
  -> Codex plugin
  -> local MCP wrapper
  -> local Node HTTP manager
  -> per-instance worker process
  -> SshConnectionSupervisor (one persistent transport per running instance)
  -> channel scheduler (4 business permits + 1 control permit)
  -> remote Linux server
```

The local HTTP manager and worker are the security boundary. Codex never receives arbitrary
shell access; it can only call the exposed MCP tools, and the agent validates
commands and paths before anything reaches SSH.

## Layout

```text
remote-debug-agent/
  agent/
    package.json
    server.js
    config.js
    ssh.js
    security.js
    audit.js
    test/
  plugins/
    remote-debug-agent/
      .codex-plugin/plugin.json
      .mcp.json
      mcp-server.js
      runtime-support.js
      runtime/agent/
        runtime-manifest.json
        server.cjs
        worker-entry.cjs
      package.json
      skills/mongodb/SKILL.md
      skills/command-draft-review/SKILL.md
      skills/remote-debug/SKILL.md
      skills/update-instance-memory/SKILL.md
  scripts/
    install.ps1
```

## Configure SSH

For a fresh clone, copy `.env.example` to `.env` and edit the required SSH
values before running the installer. The installer validates the configuration
and copies it to `%LOCALAPPDATA%\RemoteDebugAgent\config.env`; the installed
plugin does not depend on the clone afterward.

```powershell
Copy-Item .env.example .env
notepad .env
```

Configuration path precedence is `REMOTE_DEBUG_ENV_PATH`, then
`<data-dir>\config.env`. Data directory precedence is
`REMOTE_DEBUG_DATA_DIR`, `REMOTE_DEBUG_PROJECT_ROOT` for compatibility, then
`%LOCALAPPDATA%\RemoteDebugAgent`. Set these bootstrap path variables in the
Windows environment before running the installer; do not place them inside the
SSH config file.

Optional settings include:

```powershell
REMOTE_DEBUG_PRIVATE_KEY_PASSPHRASE=...
REMOTE_DEBUG_AUDIT_LOG=C:\path\to\remote-debug-audit.jsonl
REMOTE_DEBUG_APPROVED_COMMANDS=0
REMOTE_DEBUG_COMMAND_REVIEW_AUTO_EXECUTE=0
# Set to 1 for one Manager start to regenerate the review config from Codex.
REMOTE_DEBUG_COMMAND_REVIEW_REFRESH=0
# REMOTE_DEBUG_COMMAND_REVIEW_CONFIG_PATH=C:\path\to\command-review.json
REMOTE_DEBUG_APPROVED_EXECUTION_TIMEOUT_MS=300000
REMOTE_DEBUG_APPROVED_EXECUTION_MAX_TIMEOUT_MS=900000
REMOTE_DEBUG_SSH_KEEPALIVE_INTERVAL_MS=15000
REMOTE_DEBUG_SSH_KEEPALIVE_COUNT_MAX=3
REMOTE_DEBUG_SSH_MAX_BUSINESS_CHANNELS=4
```

Do not commit secrets or private keys. This project intentionally reads SSH
credentials only from the selected config file or environment variables.

## Per-Instance Source Reading

Each instance may define labeled source roots in
`<data-dir>\.remote-debug\instances.json`. The existing common read roots remain
available, while `sourceRoots` is added only to the selected instance:

```json
{
  "id": "test-server",
  "sourceRoots": {
    "be": "/home/github/OD-Yennefer-BE-next-release/current",
    "h5": "/var/www/new_od_order",
    "mgr": "/var/www/ner_od_backoffice"
  }
}
```

`remote_debug_read_file` and `remote_debug_list_dir` follow these roots through
SFTP. A `current` symlink is resolved on the remote host for each operation;
files that resolve outside the configured root are rejected. Source roots are
read-only and do not grant command execution or remote write access.

## Install The Codex Plugin

Windows 10/11 and Node `22.18+` from the Node 22 release line are required.
From the repository root, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

The script is idempotent. It checks Node and Codex Marketplace support,
validates every bundled runtime file, initializes user configuration, migrates
persistent legacy data without overwriting existing files, and registers the
absolute repository path with Codex Marketplace. It does not run npm and does
not start the Agent.

To validate prerequisites and configuration without changing files or Codex
configuration, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -CheckOnly
```

Use `-ConfigPath C:\path\to\remote-debug.env` to initialize from another
configuration file. If no configuration exists, the installer writes a
template to the user data directory and stops; edit it, then rerun the script.

After the script succeeds, install or enable `remote-debug-agent` in Codex
Desktop and open a new task. Codex copies the plugin and its prebuilt Manager,
Worker, and dashboard into its plugin cache. The MCP wrapper starts that cached
runtime automatically, so the clone can be renamed or removed after
installation.

Open `http://127.0.0.1:4343/` to view the local dashboard. It shows configured
instances and lets you create, edit, start, refresh, inspect, and delete remote
connection workers. The manager keeps the main port; workers receive ports from
the configured registry range.

## Update The Codex Plugin

For users who installed this plugin from a local clone:

```powershell
git pull
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

Then reinstall or re-enable `remote-debug-agent` in Codex Desktop, and restart
Codex Desktop or open a new Codex thread so the MCP server reloads the updated
plugin files.
If Codex logs still reference an older cache path such as
`remote-debug-agent/1.0.0`, the old installed plugin is still active.

`codex plugin marketplace upgrade remote-debug-local` is only for Git-backed
marketplaces. Local marketplaces must be updated with `git pull` and the
installer, then reinstalled or re-enabled in Codex Desktop.

For users who configured a Git-backed marketplace, use:

```powershell
codex plugin marketplace upgrade <marketplace-name>
```

## Troubleshooting Plugin Loading

Startup checks identify the host OS and exercise private directory/file permissions
using disposable probes. Windows uses a separate ACL adapter through the system
Windows PowerShell executable and .NET owner/DACL APIs, without loading
PowerShell.Security or requesting audit/SACL privileges. macOS and Linux retain
the existing owner checks and POSIX directory/file modes (`0700`/`0600`). Failed
permission probes are shown in the environment report before MCP starts; the
checks do not modify existing credentials or weaken permission requirements.

Bundled assets use LF line endings on both platforms so a Windows checkout does
not invalidate artifact hashes generated on macOS. Compatibility CI runs on both
Windows and macOS; platform-specific tests still require their native runner.

If Codex Desktop says the `remote_debug_*` tools are unavailable, check the
loading path in three separate layers:

1. Plugin configuration: Codex has the plugin installed and enabled.
2. MCP wrapper self-test: `mcp-server.js` can answer `initialize` and
   `tools/list` with the expected tools.
3. Current session tool table: the active Codex thread actually exposes
   callable `remote_debug_*` tools to the model.

First confirm the first two layers with the bundled diagnostic script:

The plugin entrypoint is `launch.cjs`. It checks the actual Node executable
against the packaged Node requirement (`>=22.18 <23`), bundled artifact hashes,
and report-directory permissions before loading MCP. If the initial Node is
incompatible, it finds an already installed compatible Node in PATH or NVM and
relaunches only the plugin process using that executable. The current runtime
is retained when compatible; NVM versions are considered newest first within
the supported range. No global PATH or NVM default is changed. An optional
`REMOTE_DEBUG_NODE_PATH` in the environment or `config.env` pins a user-selected
executable; an invalid explicit selection fails visibly. The report records
both the bootstrap runtime and the selected MCP runtime. `config.env` is
optional; SSH and MongoDB connectivity are checked when those features are used.

Reports are saved under the resolved data directory as
`.runtime/environment-report.json`, including timestamps and up to ten previous
failure snapshots. If that directory cannot be written, the launcher saves a
failure report under a user-specific system temporary directory instead.
The existing dashboard displays these at the top of the
page. When startup fails, a Node 14-compatible diagnostic-only server reuses
the dashboard assets on a free loopback port (preferred Agent port through
preferred port + 9), without starting workers. Its URL is printed to stderr
and saved as `dashboardUrl`; it expires after 30 minutes. A successful launch
stops only the diagnostic server identified by its private shutdown token.
An existing Agent dashboard can also display a later failed MCP launch.

Use `node launch.cjs --check` from the installed plugin root for a fresh local
check without starting a dashboard server. Reports also have a self-contained
offline copy at `.runtime/environment-dashboard.html`. If Node is absent or
older than 14, `python3 scripts/offline-report.py` (Windows: `py -3`) generates
that view using Python's standard library. When neither runtime is available,
the environment-check skill reports the requirements without claiming a
report was generated. Manual shell checks describe that shell's Node, which
may differ from Codex's MCP launch environment.

The dashboard's “刷新报告” reads the latest saved result; it does not restart
instances. After changing the launch environment, reload the plugin or open a
fresh chat to run its startup check again. Passing prerequisites or receiving
`tools/list` does not establish that the current chat exposes callable tools.

```powershell
cd plugins\remote-debug-agent
npm run diagnose
```

The diagnose command starts `mcp-server.js` over stdio, sends `initialize` and
`tools/list`, checks the local HTTP agent `/status` endpoint, and prints the
resolved source root, installed cache path, Codex plugin enablement state, MCP
server path, MCP runtime log path, and the installed cache's latest
`MCP_INITIALIZE` and `MCP_TOOLS_LIST` lifecycle records. A healthy MCP wrapper
should list:

```text
remote_debug_list_instances, remote_debug_get_capabilities,
remote_debug_mongodb_query,
remote_debug_mongodb_prepare_write, remote_debug_mongodb_prepare_index,
remote_debug_mongodb_prepare_transaction,
remote_debug_mongodb_prepare_bulk_storage,
remote_debug_mongodb_prepare_bulk, remote_debug_mongodb_execute_bulk,
remote_debug_mongodb_get_bulk_job, remote_debug_mongodb_list_bulk_jobs,
remote_debug_mongodb_control_bulk_job, remote_debug_mongodb_rollback_bulk_job,
remote_debug_mongodb_execute_mutation, remote_debug_mongodb_rollback_mutation,
remote_debug_mongodb_list_mutations,
remote_debug_update_memory,
remote_debug_run_command,
remote_debug_read_file, remote_debug_list_dir,
remote_debug_list_logs, remote_debug_list_log_archive_members,
remote_debug_read_log,
remote_debug_prepare_command_draft, remote_debug_get_command_draft,
remote_debug_review_command_draft,
remote_debug_execute_command_draft
```

The MCP wrapper writes lifecycle events to
`%LOCALAPPDATA%\RemoteDebugAgent\logs\mcp-error.log` by default, including
`initialize`, `tools/list`, `tools/call`, the data directory, runtime ID, agent
URL, and plugin version.

Passing diagnose means the plugin is configured and the wrapper process can
expose the tools. It does not prove that an already-open Codex thread has
loaded those tools into its current tool table. If diagnose lists the tools and
the installed cache log shows a recent `MCP_TOOLS_LIST`, but the current Codex
thread still does not expose `remote_debug_*`, the failure is in the host
session tool injection layer. Reinstall or re-enable the plugin in Codex
Desktop, restart Codex Desktop, and then open a fresh thread. If a fresh thread
still lacks the tools while diagnose remains healthy, report the issue with the
diagnose output and the installed cache lifecycle lines.

Interpret troubleshooting evidence conservatively. A missing path in the
installed plugin cache, an unavailable `remote_debug_*` tool in the current
thread, or a local HTTP warning from `127.0.0.1:<port>` are separate signals.
None of them alone proves that the source checkout lacks `agent/`, that the
plugin installation is broken, or that the remote target is unhealthy. Use the
explicit `npm run diagnose` fields first, then state whether a conclusion is
confirmed or still only suggested.

Direct HTTP calls to `http://127.0.0.1:<port>/run`, `/read-file`, `/list-dir`,
or `/logs/*`, or one-off Node scripts that import the local agent code, are
development diagnostics only. If the current session cannot call
`remote_debug_*`, stop after plugin visibility diagnosis instead of using HTTP
to complete the user's remote task. Normal Codex usage should go through the
`remote_debug_*` MCP tools so the plugin remains the visible safety boundary.

## Use From A Fresh Clone

Another Codex Desktop user can install this plugin directly from the Git
repository without installing npm packages:

```powershell
git clone https://github.com/zhengchenchen901-coder/ssl-debug-agent.git
cd ssl-debug-agent
Copy-Item .env.example .env
notepad .env
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

Install or enable `remote-debug-agent` from Codex Desktop's plugin marketplace
UI, then open a new task. The cached plugin starts its bundled local HTTP
manager automatically. Do not run `npm install` or `npm start` for normal
installation.

## Development

Source development uses Node `22.18.0`:

```powershell
cd agent
npm install
npm run check:runtime
npm test
cd ..\plugins\remote-debug-agent
npm test
```

The generated runtime under `plugins\remote-debug-agent\runtime\agent` is
committed. Run `npm run build:runtime` after Manager, Worker, dependency, or
dashboard changes, then verify a second build leaves no Git diff.

For manual Manager debugging only, run `npm start` from `agent`. Set
`REMOTE_DEBUG_AGENT_DIR` to the source `agent` directory to make the MCP wrapper
use source files instead of the bundled runtime.

## Exposed Tools

- `remote_debug_get_capabilities`: return the authoritative machine-readable
  security policy version, command constraints and examples, allowed path roots,
  resource limits, and approved-command availability without contacting a
  remote instance.
- `remote_debug_run_command`: run a whitelisted read-only diagnostic command.
- `remote_debug_read_file`: read a file under an allowed remote path.
- `remote_debug_list_dir`: list a directory under an allowed remote path.
- `remote_debug_list_logs`: discover categorized system, nginx, application, and
  PM2 logs with bounded cursor pagination.
- `remote_debug_list_log_archive_members`: list members inside a `.tar.gz` or
  `.tgz` log archive without extracting it remotely.
- `remote_debug_read_log`: read the newest lines from plain/gzip logs or a
  selected regular-file archive member, with optional substring filtering.
- `remote_debug_list_instances`: list configured instances and runtime status.
- `remote_debug_mongodb_query`: run a bounded, read-only MongoDB operation on
  the selected instance through its remote application configuration and
  existing Node MongoDB driver.
- `remote_debug_mongodb_prepare_write`: create a bounded document mutation plan
  without changing data. Only explicit `_id`-scoped writes and soft deletes are
  supported, and the instance must allowlist writes, databases, and collections.
- `remote_debug_mongodb_prepare_index`: prepare a separately confirmed index
  creation or removal. Index changes are compensating operations rather than
  MongoDB document transactions.
- `remote_debug_mongodb_prepare_transaction`: prepare up to 20 bounded document
  writes in one same-database MongoDB transaction for a composite operation.
- `remote_debug_mongodb_prepare_import`: prepare bulk inserts in one allowlisted
  collection, split automatically into independent batches of at most 2000
  documents and 512 KiB. Each batch has its own commit and rollback plan.
- `remote_debug_mongodb_prepare_bulk_storage`, `remote_debug_mongodb_prepare_bulk`,
  `remote_debug_mongodb_execute_bulk`, `remote_debug_mongodb_get_bulk_job`,
  `remote_debug_mongodb_list_bulk_jobs`, `remote_debug_mongodb_control_bulk_job`,
  and `remote_debug_mongodb_rollback_bulk_job`: prepare the protected durable
  receipt/log storage, then run a fixed cross-collection bulk plan as a resumable
  background job with per-batch verification and guarded reverse rollback.
- `remote_debug_mongodb_execute_mutation`: commit a prepared document,
  transaction, or index plan with the exact confirmation `确认执行`.
- `remote_debug_mongodb_rollback_mutation`: roll back a committed mutation with
  the exact plan hash and confirmation `确认回滚`; it stops on conflicts rather
  than overwriting later changes.
- `remote_debug_mongodb_list_mutations`: list available temporary mutation
  journals without returning stored before-images.
- `remote_debug_update_memory`: persist a verified, redacted operational note
  when the user explicitly asks Codex to remember or update instance facts.
- `remote_debug_prepare_command_draft`: generate an exact command draft for
  user review. It never executes commands.
- `remote_debug_get_command_draft`: view a previously generated command draft.
- `remote_debug_review_command_draft`: run the local hard-policy and Codex
  reviewer; safe drafts can be automatically executed when explicitly enabled.
- `remote_debug_execute_command_draft`: execute a one-time command draft after
  the user explicitly chooses `使用命令`.

Operation tools accept an optional `instanceId`. If only one instance is
configured, the manager routes to it automatically. If multiple instances exist
and `instanceId` is missing, the tool returns `INSTANCE_ID_REQUIRED` with the
available instance summaries.

`timeoutMs` is one end-to-end operation budget measured from MCP receipt. It
includes manager/worker routing, channel queueing, SSH connection recovery,
path validation, execution, and cancellation cleanup. Defaults and limits are:

- `remote_debug_run_command`: 30 seconds by default, 120 seconds maximum.
- `remote_debug_read_file` and `remote_debug_list_dir`: 60 seconds by default,
  300 seconds maximum. `remote_debug_read_file` also exposes `maxBytes`.
- `remote_debug_list_logs`, `remote_debug_list_log_archive_members`, and
  `remote_debug_read_log`: 60 seconds by default, 300 seconds maximum. Log
  listings are limited to 500 entries per page; log reads return at most 2,000
  lines and 256 KiB of UTF-8 output.
- `remote_debug_mongodb_query`: 60 seconds by default, 300 seconds maximum;
  returned documents are limited to 500 items and 512 KiB.
- `remote_debug_mongodb_prepare_write`, `remote_debug_mongodb_prepare_index`,
  `remote_debug_mongodb_prepare_transaction`,
  `remote_debug_mongodb_execute_mutation`,
  `remote_debug_mongodb_rollback_mutation`, and
  `remote_debug_mongodb_list_mutations`: 120 seconds by default, 600 seconds
  maximum. Mutation plans limit the affected documents to the instance policy;
  transactions contain at most 20 child operations.
- `remote_debug_execute_command_draft`: 300 seconds by default, 900 seconds
  maximum for the entire command batch.
- `remote_debug_review_command_draft`: 330 seconds by default, 930 seconds
  maximum for review plus the command batch; the Codex review itself is limited
  to 30 seconds with at most one retry.

## Log Discovery And Compressed Reads

Use `remote_debug_list_logs` before choosing a log path. It inspects the
approved system, Nginx, application, and PM2 locations for the selected
instance. The application scope combines configured source roots, PM2 working
directories, and shallow log directories under `/home/github`; it includes the
current and historical paths used by the Yennefer, Dambuster, EccoPOS, and
DBScript deployments found on the configured hosts. Large directories such as
`/root/.pm2/logs` are returned in cursor-paginated pages.

Use `remote_debug_read_log` for text logs. It returns the newest lines by
default, supports a bounded plain-text `contains` filter, and reads plain files
or `.gz` files through SFTP. For `.tar.gz` or `.tgz`, call
`remote_debug_list_log_archive_members` first and pass a regular-file
`memberPath` to `remote_debug_read_log`. Archives are streamed and never
extracted to the remote filesystem.

The Agent supports `none`, `gzip`, and `tar-gzip`. `.xz`, `.bz2`, `.zip`,
binary system logs, directories, and archive links remain visible in listings
with `readable: false` and a reason, but reading them returns a structured
unsupported-format or non-readable-member error. Archive member names are
relative and path traversal is rejected. Log audit records contain metadata
and result statistics, not the returned log body.

## MongoDB Read-Only Access

MongoDB access is a dedicated MCP tool, not an unrestricted shell command. The
tool always runs through the selected instance's SSH worker, so `default` and
`test-server` cannot accidentally share a local connection. It loads the URI
from the remote application's JSON configuration on that instance and uses the
existing remote `mongodb` Node driver; the URI and credentials are never part of
the MCP request, command arguments, response, memory cache, or audit record.

Configure the non-secret connection metadata in the dashboard's instance
create/edit dialog under **MongoDB 连接配置**. Enable MongoDB and enter the remote
JSON configuration path, remote driver path, configuration profile, URI field
name, and optional default database. Existing values are filled in when editing.
After saving, reload a running instance with **重新加载配置**; stopped instances
use the saved configuration on their next start. Database/collection discovery
uses the saved worker configuration, so save and reload connection changes
before reading those options.

These settings are stored under each instance in `.remote-debug/instances.json`
(the file is normally under the local data directory):

```json
{
  "id": "default",
  "mongodb": {
    "enabled": true,
    "configPath": "/home/github/.../config.json",
    "driverPath": "/home/github/.../node_modules/mongodb",
    "configProfile": "production",
    "uriKey": "url",
    "database": "yenneferbak"
  }
}
```

`configProfile` and `database` are per-instance values. The tool supports
`ping`, `listDatabases`, `listCollections`, `find`, `findOne`,
`countDocuments`, and `aggregate`. It rejects arbitrary JavaScript, write-like
aggregation stages, and unbounded results. Writes, deletes, exports, restores,
and index changes remain in the explicit approved-command workflow.

## Instance Memory

The manager keeps a small per-instance memory cache at
`%LOCALAPPDATA%\RemoteDebugAgent\.remote-debug\instances\<instanceId>\memory.json`
by default. The cache is owned by the manager process and is written atomically;
workers report discoveries over IPC instead of writing the file directly.

When a worker starts, the manager asks it to run a background init discovery if
the instance has no usable memory, if the previous memory failed, or if the
target host, port, or username changed. Worker readiness only waits for SSH and
the local HTTP listener; memory may remain `initializing` until the background
probe finishes. The first version collects conservative metadata only: target
summary, system/resource summaries, shallow listings under allowed roots, common
nginx/log/PM2 paths, and MongoDB service/client presence. Probe failures make
the memory `partial`; they do not stop the worker after SSH readiness has
succeeded.

Tool responses from the manager include a `memory` summary when an instance is
known. Successful `/run`, `/read-file`, `/list-dir`, and `/logs/*` results also
update the cache with newly observed config paths, log paths, service status,
and directory summaries.

Explicit user-requested notes are written through `remote_debug_update_memory`
and returned under `memory.summary.notes`. The tool updates manager-owned local
metadata only; it does not execute a remote command. Do not edit `memory.json`
directly.

Memory is context, not live truth. Treat it as a starting point and verify with
the tools when the exact current state matters. The cache is intentionally
sanitized before it is saved: private keys, passphrases, tokens, passwords,
credentials, and connection strings are redacted.

## MongoDB Mutations And Rollback

The MongoDB query tool remains read-only. Mutation tools are disabled unless the
selected instance explicitly enables them and provides database and collection
allowlists. A global `.env` example is:

```text
REMOTE_DEBUG_MONGODB_CONFIG={"enabled":true,"configPath":"/home/app/config.json","driverPath":"/home/app/node_modules/mongodb","configProfile":"production","uriKey":"url","database":"yennefer","writeEnabled":true,"allowedDatabases":["yennefer"],"allowedCollections":["restaurant_members"],"rollbackRoot":"/tmp/remote-debug-agent/mutations","maxAffectedDocuments":100}
```

The safe mutation flow is:

```text
prepare -> inspect affected count and fields -> 确认执行 -> commit -> verify
                                                    |
                                                    -> 确认回滚 -> rollback
```

`insertOne`, `_id`-scoped `updateOne`, bounded `_id.$in` `updateMany`, and
`softDeleteOne` are stored as transaction-backed plans. A same-database
`prepare_transaction` can combine up to 20 such child operations. The plan
stores before-images remotely and rechecks them at commit and rollback time;
later changes cause `MONGODB_ROLLBACK_CONFLICT` instead of an unsafe overwrite.

### Updating individual array elements

The ordinary mutation and transaction tools accept explicit array indexes, for
example `$set: { "booking_orders.12.origin_status": "2" }`. Keep the document
`_id` filter and guard that element's identity with
`"booking_orders.12.origin_id": { "$oid": "<order-id>" }`. Every indexed prefix
requires a filter guard. Indexes must be canonical decimals from 0 to 99999;
positional `$`, `$[]`, `$[name]`, prototype paths and sparse array extension are
rejected. Index definitions and soft-delete field names are unchanged.

Preflight checks that each index addresses an actual array element. `$set` may
also append one complete element at the immediate tail of an existing array:
filter `"booking_orders.13": null` when the current length is 13. For idempotent
insertion, also filter `"booking_orders.origin_id": { "$nin": ["<order-id>"] }`
(include both string and ObjectId forms when existing data mixes types).
`$nin` is supported only in filters, with 1–1000 values. Multiple appends to the
same array require separate plans, rereading its length after each commit.

Only the small patch is sent; the 256 KiB payload limit is unchanged. The server
still saves the full before-image within the existing journal limit, checks for
any concurrent document change, commits transactionally and refuses rollback if
the document has changed afterward. Prepare, confirmation and allowlists remain
mandatory. Existing bulk-job tools have their separate field validation policy;
use ordinary mutation/transaction tools for indexed patches.

Index creation and removal use the separate index tool. They are compensating
operations, not part of the document transaction. An index must not be created
implicitly by a business operation. Create required unique indexes as a schema
migration first, then let the business tool verify that the prerequisite exists.

### Bulk imports

Use `remote_debug_mongodb_prepare_import` for data seeding instead of thousands
of `insertOne` child operations. It keeps the existing write enablement and
database/collection allowlists. Ordinary transactions still allow 20 operations;
their `maxAffectedDocuments` policy is unchanged. The independent instance setting
`mongodb.maxImportBatchDocuments` defaults to 2000 and can lower the batch size
(its hard maximum is 2000). Save it in the instance's MongoDB configuration and
reload that instance to apply a change.

```json
{
  "instanceId": "test-server",
  "importId": "seed-members-chunk-001",
  "database": "yennefer",
  "collection": "restaurant_members",
  "batchSize": 2000,
  "purpose": "Test data import",
  "documents": [
    { "_id": "seed-members-000001", "memberId": "example-1" },
    { "_id": "seed-members-000002", "memberId": "example-2" }
  ]
}
```

The example shows the request shape, not a verified business schema. Supply
documents matching the target collection's schema and validators. Every document
needs an explicit `_id`: a non-empty string of at most 256 characters, a safe
integer, or Extended JSON `{"$oid":"..."}`. Duplicate IDs within the input are
rejected, and existing database documents are never skipped or overwritten.

One prepare call accepts at most 10000 documents and 4 MiB of UTF-8 JSON document
data. Larger datasets must be sent in smaller input chunks, with a stable
`importId` per chunk. Each chunk is split at the requested/instance document
limit or 512 KiB, whichever is reached first (at most 100 batches per call).
The dedicated HTTP prepare endpoint, `/mongodb/imports/prepare`, accepts 5 MiB
including metadata; other HTTP request limits remain unchanged.

Prepare returns `batches[]`, each with a `mutationId`, `planHash`, count, a sample
of up to 10 IDs, and status. Review the plans and commit the chosen batches using
`remote_debug_mongodb_execute_mutation` with `确认执行`. Each batch uses one
`insertMany` inside a transaction with bulk pre/post checks. The target deployment
must support MongoDB transactions and the configured driver must provide BSON
EJSON support. Roll back an individual batch with the existing rollback tool and
`确认回滚`; rollback verifies document hashes before removing anything.

Atomicity is **per batch**, not for the entire input chunk or dataset. For 140000
small documents, 2000 per batch means 70 transactions; larger documents need more
batches because of the byte limit. A failed later batch does not undo earlier
committed batches. There is no automatic commit during prepare.

Retry prepare with the **exact same importId, input order, documents, batchSize,
purpose and rollback options**, and unchanged batch policy, to recover the same
journals. If preparation fails after some batches, `status: "prepare_partial"`
returns the completed plans and `failedBatch`; do not treat this as a complete
plan. Repeating a committed batch returns its saved result without reinserting.
Failures before the commit command use `commit_retryable` (or
`rollback_retryable`) and may be retried using the same plan. Connection loss
during commit, or failure to save the outcome, produces an unknown/started state
that blocks blind retry and rollback. Inspect it before recovery; matching data
alone is not proof that this import owns it. Temporary journals and their expiry
still bound the retry and rollback window.

The target worker writes owner-only manifests and a journal under
`/tmp/remote-debug-agent/mutations/<mutationId>/`. The directory is temporary;
reboot or cleanup can make an expired rollback unavailable. The journal does
not appear in list responses with before-images, and normal output and audit
records contain summaries rather than complete sensitive documents. Use a
persistent protected journal or database operation record when a rollback window
must survive a server restart.

Mutation risk is exposed in every plan: single inserts and ID-scoped updates are
`medium`, soft deletes and bounded batches are `high`, index removal is `high`,
and a composite transaction is `high`. Every mutation still requires explicit
`确认执行`; a risk label never grants automatic execution.

Skills are orchestration only. Project-specific workflows such as adding a
member to a restaurant should query and validate the entities, prepare a narrow
domain mutation or a bounded transaction, show the preview, request confirmation,
commit, and verify. They should not generate MongoDB shell scripts.

### Resumable cross-collection bulk jobs

Use the general bulk tools for large, different-value updates or related writes
that must commit together by business unit. This capability is disabled by
default. Its instance policy must explicitly enable both MongoDB writes and bulk
jobs, allowlist every business collection plus
`__remote_debug_bulk_receipts`, and point `bulkRoot` at a persistent protected
filesystem path. Configure `bulkBatchDocuments` from 1 to 2000 (default 500),
`bulkConcurrency` from 1 to 4 (default 2), and a rollback window of at most seven
days. For example, keep `bulkEnabled: false` until the target instance and
storage initialization plan have been reviewed:

```json
{
  "bulkEnabled": false,
  "bulkRoot": "/var/lib/remote-debug-agent/bulk-jobs",
  "bulkReceiptsCollection": "__remote_debug_bulk_receipts",
  "bulkBatchDocuments": 500,
  "bulkConcurrency": 2,
  "bulkRollbackTtlMs": 604800000
}
```

Prepare the technical receipt collection/index and persistent directory as a
separate explicitly confirmed storage mutation before preparing a business
job. The storage-plan tool also requires `bulkEnabled: true`; enable it only for
the reviewed storage setup or an authorized job, then turn it off when no new
bulk work should start. Upload ordered chunks with stable `unitId` values and
finish with an empty end-of-upload marker. A business unit is never split across transactions; no
collection/document ID can occur twice in one job. Inserts require explicit
`_id`; updates require original-value checks and support only `$set`, `$unset`,
and `$inc`. One transaction writes all operations in its batch and a unique
receipt together. The runner continues after the initiating request disconnects,
pauses new batches on errors, resumes the same immutable plan after inspection,
and verifies results before completion. Rollback proceeds from the newest
committed batch to the oldest and stops on a later-change conflict.

The default limits are 20 operations per business unit, 10,000 operations and
4 MiB per upload, 100,000 operations and 40 MiB per job, 500 operations per
batch (configurable to 2,000), 512 KiB batch input, 8 MiB rollback log per batch,
and concurrency 2 (maximum 4). Existing ordinary transactions keep their
20-operation limit. Setting `bulkEnabled` to false blocks new jobs and resume;
job inspection, pause, and explicit rollback remain available while MongoDB
writes, the allowlists, and the stored job path stay configured. No bulk
capability or data mutation is enabled by this documentation example. Follow
the [`database-mutations` skill bulk workflow](plugins/remote-debug-agent/skills/database-mutations/references/mongodb-bulk.md)
for identity resolution, preflight, authorization, status recovery, examples,
and delivery reports.

For example, once a project has an allowlisted `restaurant_members` collection,
an add-member workflow can combine an `insertOne` for the membership relation
and an `_id`-scoped `updateOne` for a related counter in
`remote_debug_mongodb_prepare_transaction`. Both changes then commit or roll
back together. The collection names and fields must come from the project's
verified schema; this plugin does not guess them.

## Approved Command Drafts

The approved-command channel is for cases where Codex should present a minimal
set of remote write or maintenance commands. It is disabled by default. To
allow the new automatic reviewer to execute a draft, both the instance's
approved-command setting and the global review setting must be enabled:

```text
REMOTE_DEBUG_APPROVED_COMMANDS=1
REMOTE_DEBUG_COMMAND_REVIEW_AUTO_EXECUTE=1
```

Automatic execution is limited to commands that pass the existing read-only
security policy and a separate Codex semantic review. A small set of known
maintenance commands can pass static and semantic review but remains
`manual_confirmation`; delete, privilege, database-shell, or uncertain commands
are not granted automatic execution.

The reviewer configuration is stored at
`<data-dir>/.remote-debug/command-review.json`. It contains only non-secret
Codex connection metadata. The file is generated from `CODEX_HOME/config.toml`
the first time it is needed. Set `REMOTE_DEBUG_COMMAND_REVIEW_REFRESH=1` for a
single Manager start (then reset it to `0`) to explicitly refresh the snapshot.
Codex authentication remains
owned by the Codex CLI; API keys are not copied into this project or the review
configuration.

The flow is:

1. Codex calls `remote_debug_prepare_command_draft` with a purpose and exact
   command list.
2. Codex immediately calls `remote_debug_review_command_draft` with the returned
   `draftId`; the review tool retrieves the immutable stored draft.
3. If the local policy and Codex reviewer approve a low-risk read-only draft,
   the Manager automatically executes it and returns the execution result.
4. Otherwise the tool returns the complete draft, `draftId`, `commandHash`,
   expiration, and indexed violation points for the current conversation.
5. If the user chooses `只生成命令，不执行`, Codex must not call the execution
   tool and should leave the command block for manual execution.
6. If the user chooses `使用命令`, Codex calls
   `remote_debug_execute_command_draft` with the same `draftId`,
   `commandHash`, and the exact confirmation phrase `使用命令`.

Drafts are one-time use and expire after 30 minutes. Execution runs commands in
order under one shared operation deadline. A non-zero exit code or exhausted
deadline stops the remaining commands. This channel bypasses the read-only command allowlist,
but the automatic reviewer does not. Neither path bypasses SSH configuration,
timeouts, output limits, the one-time hash check, or audit logging. Audit entries
store command hashes, redacted command previews, and review summaries instead of
raw password-bearing command text.

Allowed commands:

```text
ls cat ps netstat df free tail grep mongodump mongo mongosh systemctl nginx which
```

Additional command constraints:

- MongoDB client/tool commands remain limited to `--version` in the generic
  command tool. Read-only queries must use `remote_debug_mongodb_query`; bounded
  writes and index changes must use the structured MongoDB mutation tools.
- Direct `remote_debug_run_command` keeps `systemctl` limited to read-only
  `status`, `is-active`, and `is-enabled` checks. The command-draft reviewer
  recognizes `reload` and `restart` for the same allowlisted units, but keeps
  them manual confirmation.
- Direct `remote_debug_run_command` keeps `nginx` limited to diagnostic flags
  `-t`, `-T`, `-v`, and `-V`; the command-draft reviewer recognizes only manual
  `nginx -s reload` as an additional maintenance profile.
- The command-draft reviewer recognizes `pm2 reload <app>` and
  `pm2 restart <app>` as manual-only profiles. Arbitrary database shells and
  script interpreters are not a substitute for structured mutation tools.
- Path-reading commands such as `ls`, `cat`, `tail`, and `grep` require at
  least one allowed absolute path.

Example commands:

```text
mongodump --version
mongo --version
mongosh --version
systemctl status mongod
systemctl status nginx
nginx -t
nginx -T
cat /etc/nginx/nginx.conf
ls /etc/nginx
grep server_name /etc/nginx/nginx.conf
```

Allowed path roots:

```text
/var/log
/etc/nginx
/home/app
/root/.pm2
/home/github
```

## Architecture And Command Security

The plugin is an MCP wrapper and local manager launcher. It does not execute SSH
commands directly. The command path is:

```text
Codex
  -> plugins/remote-debug-agent/mcp-server.js
  -> agent/server.js local HTTP manager
  -> agent/worker-entry.js per-instance worker
  -> agent/ssh-connection-supervisor.js persistent SSH transport
  -> agent/channel-scheduler.js channel permits
  -> agent/ssh.js exec/SFTP operations
  -> remote Linux server
```

`mcp-server.js` exposes the MCP tools, resolves `config.env`, discovers or
starts the bundled local HTTP manager, and forwards tool calls to
`http://127.0.0.1:<port>`.
`remote_debug_get_capabilities` reads `/api/capabilities`; the payload is built
from the same declarative policy used by command and path validation, including
the per-instance source roots, so MCP clients do not need to copy the Agent
allowlists.
`remote_debug_run_command` forwards `instanceId`, `cmd`, and `timeoutMs` to the
manager's `/run` endpoint. `remote_debug_read_file` and
`remote_debug_list_dir` use the selected worker's SFTP-backed file endpoints.
The log tools use `/logs/list`, `/logs/archive-members`, and `/logs/read`;
their worker-side implementation performs canonical SFTP checks, bounded
directory paging, gzip decoding, and streaming tar parsing without remote shell
commands or temporary extraction files.
`remote_debug_mongodb_query` forwards the selected instance and a validated
read-only query to `/mongodb/query`; the worker executes a fixed Node helper
over SSH and reads the remote profile at execution time.
The structured MongoDB mutation tools use `/mongodb/mutations/prepare`,
`/mongodb/mutations/execute`, `/mongodb/mutations/rollback`, and
`/mongodb/mutations/list`. The worker runs a fixed Node MongoDB helper, never
accepts a URI or JavaScript from the caller, persists a protected temporary
manifest on the target, and uses a same-database transaction for document
mutations or a verified compensating action for index changes.
`remote_debug_update_memory` writes sanitized notes through `/api/memory`.
The approved-command tools use
`/approved-command-drafts`, `/approved-command-drafts/get`,
`/approved-command-drafts/review`, and `/approved-command-drafts/execute`.
The Manager owns `/approved-command-drafts/review`: it retrieves the stored
draft from the selected Worker, runs the local hard-policy checks, and invokes
an isolated `codex exec` subprocess for semantic review. The subprocess only
returns structured review data; it never receives remote-debug tools or remote
SSH access.

The V2 MCP only accepts a manager whose `/status` reports `apiVersion: 2`, the
required capabilities, and the current bundled `agent.runtimeId`. A confirmed
local Manager with an older runtime ID is safely replaced; an explicit
`REMOTE_DEBUG_AGENT_URL` requires a V2 runtime with authenticated HTTP support and a matching protected local credential file. The
manager only accepts workers whose ready IPC message reports
`protocolVersion: 2`. Registry files are migrated to version 4; legacy
approved-command `timeoutMs` fields are converted to the new shared execution
budget fields when the registry is loaded.

Each running worker owns one persistent `ssh2.Client`. SSH keepalive runs every
15 seconds with three missed responses allowed. Transport loss degrades the
instance without stopping the worker; reconnect uses jittered exponential
backoff from 1 to 30 seconds and rereads the private key for every attempt.
Interactive operations have priority, background work is limited to one
business channel, and a background request waiting 10 seconds receives a
scheduling opportunity. Exec channels are never retried after opening; SFTP is
retried once only before data has been returned.

Errors carry `operationId`, `code`, `layer`, `phase`, `retriable`, and `cause`
across MCP, manager, worker, scheduler, and SSH. `AGENT_UNAVAILABLE` is reserved
for an unreachable manager and `WORKER_UNAVAILABLE` for an unreachable worker
HTTP endpoint. `/status`, instance APIs, and the dashboard expose worker,
transport, authentication, target, and operation health. Audit records add
connection generation plus queue, connect, validation, execution, and error
layer/phase timing fields without persisting complete stdout.

The local HTTP manager and worker are the security boundary. For `/run`, `agent/server.js`
calls `validateCommand` from `agent/security.js` before any SSH command is
executed. Only the normalized command returned by validation is passed to
`agent/ssh.js`.

Command validation applies these checks:

- The command must be a non-empty string and no longer than 4096 characters.
- Shell control characters are rejected, including `;`, `&`, `|`, backticks,
  `$`, redirects, brackets, backslashes, and newlines.
- Tokens support literal single/double quoting for spaces and quotes in paths or search expressions; shell substitutions and control operators remain forbidden. Quoted arguments are reserialized safely before execution.
- The executable must be in `ALLOWED_COMMANDS`.
- Dangerous commands are denied even if they appear inside a token, including
  `rm`, `sudo`, `shutdown`, `reboot`, `mkfs`, `chmod`, and `chown`.
- `tail -f` and `tail --follow` are rejected.
- `mongodump`, `mongo`, and `mongosh` remain limited to `--version` when used
  through the generic command tool; MongoDB reads use
  `remote_debug_mongodb_query`.
- `systemctl` is limited to read-only `status`, `is-active`, and `is-enabled`
  checks for `mongod`, `mongod.service`, `nginx`, and `nginx.service`.
- `nginx` is limited to diagnostic flags `-t`, `-T`, `-v`, and `-V`.
- Path-reading commands such as `ls`, `cat`, `tail`, and `grep` require at
  least one allowed absolute path under the common roots or the selected
  instance's configured source roots.

Approved-command draft execution is reserved for explicitly reviewed
maintenance commands. MongoDB shell mutations are rejected at draft creation;
database writes should use the structured mutation tools. The one-time draft
ID, command hash, exact confirmation phrase `使用命令`, timeouts, output limits,
and audit logging remain in force. Automatic execution is still limited to
read-only commands; known service-control profiles can reach semantic review
but remain manual confirmation.

If a command contains path arguments, the agent also resolves the remote
canonical paths before execution to reduce symlink escape risk. Audit logs are
written after each operation with command metadata, duration, result sizes, and
success or failure.

## Safety Rules

- No arbitrary shell.
- The disabled-by-default approved-command draft workflow is for explicitly
  reviewed maintenance commands and requires a one-time draft ID, command hash,
  and exact user confirmation. Automatic execution is narrower and requires the
  local read-only policy plus a Codex review.
- MongoDB writes, soft deletes, and index changes use explicitly enabled,
  allowlisted structured mutation tools. Document changes use a transaction;
  index changes use a verified compensating rollback journal. A commit or
  rollback must stop when the target no longer matches the recorded version.
- Read-only diagnostic commands cannot use shell control operators, pipes,
  redirects, command substitution, or newlines.
- Read-only diagnostic commands reject dangerous tokens such as `rm`, `sudo`,
  `shutdown`, `reboot`, `mkfs`, `chmod`, or `chown`. Manual approved drafts are
  not allowlist-validated; automatic review rejects anything that fails the
  existing allowlist or exposes sensitive command material.
- File and directory operations use SFTP and validate canonical remote paths to
  reduce symlink escape risk.
- Audit logs are JSONL and record operation metadata, duration, result size, and
  success or failure. They never record private keys or passphrases.

## Tests

```powershell
cd agent
npm run check:runtime
npm test
cd ..\plugins\remote-debug-agent
npm test
```

The test suites use Node's built-in test runner and mock SSH/SFTP where needed.
The plugin smoke tests also run the prebuilt runtime from an isolated cache with
no `node_modules` or `NODE_PATH`.

## 按实例启动后端服务

Remote Debug Agent 支持为每个实例独立保存后端启动配置，通过管理面板「后端服务启动」或 `remote_debug_list_service_profiles` / `remote_debug_start_service` 选择并启动。它只补齐缺失的 PM2 fork 进程，核验实际 Node/PID/端口/环境/启动标记与稳定性，异常状态不会被自动删除或重启。配置缺失不继承其他实例。

详见 [使用、安全边界与结果判定](docs/service-start.md)，以及 [仅绑定 test-server 的 BE 配置示例](docs/examples/test-server-be-service.json)。服务启动能力包含在插件中；示例配置不会自动写入任何实例。
