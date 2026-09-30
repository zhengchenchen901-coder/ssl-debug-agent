# Remote Debug Agent

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

If Codex Desktop says the `remote_debug_*` tools are unavailable, check the
loading path in three separate layers:

1. Plugin configuration: Codex has the plugin installed and enabled.
2. MCP wrapper self-test: `mcp-server.js` can answer `initialize` and
   `tools/list` with the expected tools.
3. Current session tool table: the active Codex thread actually exposes
   callable `remote_debug_*` tools to the model.

First confirm the first two layers with the bundled diagnostic script:

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

Configure the non-secret connection metadata under each instance in
`.remote-debug/instances.json` (the file is normally under the local data
directory):

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
local Manager with an older runtime ID is safely replaced; an external
`REMOTE_DEBUG_AGENT_URL` remains compatible with any existing V2 runtime. The
manager only accepts workers whose ready IPC message reports
`protocolVersion: 2`. Registry files are migrated to version 3; legacy
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
- Tokens may only contain the safe character set used by
  `SAFE_TOKEN_PATTERN`.
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
