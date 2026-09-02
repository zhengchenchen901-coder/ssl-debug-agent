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
REMOTE_DEBUG_APPROVED_EXECUTION_TIMEOUT_MS=300000
REMOTE_DEBUG_APPROVED_EXECUTION_MAX_TIMEOUT_MS=900000
REMOTE_DEBUG_SSH_KEEPALIVE_INTERVAL_MS=15000
REMOTE_DEBUG_SSH_KEEPALIVE_COUNT_MAX=3
REMOTE_DEBUG_SSH_MAX_BUSINESS_CHANNELS=4
```

Do not commit secrets or private keys. This project intentionally reads SSH
credentials only from the selected config file or environment variables.

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
remote_debug_update_memory,
remote_debug_run_command,
remote_debug_read_file, remote_debug_list_dir,
remote_debug_prepare_command_draft, remote_debug_get_command_draft,
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

Direct HTTP calls to `http://127.0.0.1:<port>/run`, `/read-file`, or
`/list-dir`, or one-off Node scripts that import the local agent code, are
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
- `remote_debug_list_instances`: list configured instances and runtime status.
- `remote_debug_mongodb_query`: run a bounded, read-only MongoDB operation on
  the selected instance through its remote application configuration and
  existing Node MongoDB driver.
- `remote_debug_update_memory`: persist a verified, redacted operational note
  when the user explicitly asks Codex to remember or update instance facts.
- `remote_debug_prepare_command_draft`: generate an exact command draft for
  user review. It never executes commands.
- `remote_debug_get_command_draft`: view a previously generated command draft.
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
- `remote_debug_mongodb_query`: 60 seconds by default, 300 seconds maximum;
  returned documents are limited to 500 items and 512 KiB.
- `remote_debug_execute_command_draft`: 300 seconds by default, 900 seconds
  maximum for the entire command batch.

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
known. Successful `/run`, `/read-file`, and `/list-dir` results also update the
cache with newly observed config paths, log paths, service status, and directory
summaries.

Explicit user-requested notes are written through `remote_debug_update_memory`
and returned under `memory.summary.notes`. The tool updates manager-owned local
metadata only; it does not execute a remote command. Do not edit `memory.json`
directly.

Memory is context, not live truth. Treat it as a starting point and verify with
the tools when the exact current state matters. The cache is intentionally
sanitized before it is saved: private keys, passphrases, tokens, passwords,
credentials, and connection strings are redacted.

## Approved Command Drafts

The approved-command channel is for cases where Codex should present a minimal
set of remote write or maintenance commands, but a human must decide whether the
plugin may execute them. It is disabled by default. To enable it, set:

```text
REMOTE_DEBUG_APPROVED_COMMANDS=1
```

The flow is:

1. Codex calls `remote_debug_prepare_command_draft` with a purpose and exact
   command list.
2. The tool returns `draftId`, `commandHash`, `expiresAt`, and a command block
   that can be reviewed in the Codex conversation.
3. If the user chooses `只生成命令，不执行`, Codex must not call the execution
   tool and should leave the command block for manual execution.
4. If the user chooses `使用命令`, Codex calls
   `remote_debug_execute_command_draft` with the same `draftId`,
   `commandHash`, and the exact confirmation phrase `使用命令`.

Drafts are one-time use and expire after 30 minutes. Execution runs commands in
order under one shared operation deadline. A non-zero exit code or exhausted
deadline stops the remaining commands. This channel bypasses the read-only command allowlist,
but it does not bypass SSH configuration, timeouts, output limits, the one-time
hash check, or audit logging. Audit entries store command hashes and redacted
command previews instead of raw password-bearing command text.

Allowed commands:

```text
ls cat ps netstat df free tail grep mongodump mongo mongosh systemctl nginx which
```

Additional command constraints:

- MongoDB client/tool commands remain limited to `--version` in the generic
  command tool. Read-only queries must use `remote_debug_mongodb_query`; writes
  and maintenance still require an approved-command draft.
- `systemctl` is limited to read-only `status`, `is-active`, and `is-enabled`
  checks for `mongod`, `mongod.service`, `nginx`, and `nginx.service`.
- `nginx` is limited to diagnostic flags `-t`, `-T`, `-v`, and `-V`.
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
from the same declarative policy used by command and path validation, so MCP
clients do not need to copy the Agent allowlists.
`remote_debug_run_command` forwards `instanceId`, `cmd`, and `timeoutMs` to the
manager's `/run` endpoint. `remote_debug_read_file` and
`remote_debug_list_dir` use the selected worker's SFTP-backed file endpoints.
`remote_debug_mongodb_query` forwards the selected instance and a validated
read-only query to `/mongodb/query`; the worker executes a fixed Node helper
over SSH and reads the remote profile at execution time.
`remote_debug_update_memory` writes sanitized notes through `/api/memory`.
The approved-command tools use
`/approved-command-drafts`, `/approved-command-drafts/get`, and
`/approved-command-drafts/execute`.

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
  least one allowed absolute path under `/var/log`, `/etc/nginx`, `/home/app`,
  `/root/.pm2`, or `/home/github`.

Approved-command draft execution intentionally does not call `validateCommand`;
it relies on `REMOTE_DEBUG_APPROVED_COMMANDS=1`, the one-time draft ID, the
command hash, the exact confirmation phrase `使用命令`, timeouts, output limits,
and audit logging. Use it only for commands the user has reviewed.

If a command contains path arguments, the agent also resolves the remote
canonical paths before execution to reduce symlink escape risk. Audit logs are
written after each operation with command metadata, duration, result sizes, and
success or failure.

## Safety Rules

- No arbitrary shell.
- The only exception is the disabled-by-default approved-command draft workflow,
  which requires a one-time draft ID, command hash, and exact user confirmation.
- Read-only diagnostic commands cannot use shell control operators, pipes,
  redirects, command substitution, or newlines.
- Read-only diagnostic commands reject dangerous tokens such as `rm`, `sudo`,
  `shutdown`, `reboot`, `mkfs`, `chmod`, or `chown`. Approved draft commands
  are not allowlist-validated and must be explicitly reviewed before execution.
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
