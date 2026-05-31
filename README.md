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
  -> SSH
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
      package.json
      skills/remote-debug/SKILL.md
```

## Configure SSH

Create `remote-debug-agent/.env` or set these environment variables before
using the plugin. Values in `.env` take precedence for `REMOTE_DEBUG_*`
settings. On first startup, the manager migrates this single-target config into
`.remote-debug/instances.json` as the `default` instance.

```powershell
$env:REMOTE_DEBUG_HOST = "example.com"
$env:REMOTE_DEBUG_PORT = "22"
$env:REMOTE_DEBUG_USER = "app"
$env:REMOTE_DEBUG_PRIVATE_KEY_PATH = "C:\Users\you\.ssh\id_ed25519"
$env:REMOTE_DEBUG_AGENT_PORT = "4343"
```

Optional:

```powershell
$env:REMOTE_DEBUG_PRIVATE_KEY_PASSPHRASE = "..."
$env:REMOTE_DEBUG_AUDIT_LOG = "C:\path\to\remote-debug-audit.jsonl"
$env:REMOTE_DEBUG_APPROVED_COMMANDS = "0"
$env:REMOTE_DEBUG_APPROVED_COMMAND_TIMEOUT_MS = "30000"
$env:REMOTE_DEBUG_APPROVED_COMMAND_MAX_TIMEOUT_MS = "300000"
```

Do not commit secrets or private keys. This project intentionally reads SSH
credentials only from `.env` or environment variables.

## Start The Agent

Use Node `22.18.0` for local development:

```powershell
nvm use 22.18.0
```

```powershell
cd remote-debug-agent\agent
npm install
```

The Codex plugin prewarms, starts, and repairs the local agent automatically from `.env`
after the MCP server initializes.
For manual debugging, run `npm start` in the `agent` directory. The agent listens
on `http://127.0.0.1:4343` by default, or `REMOTE_DEBUG_AGENT_PORT` when set.

Open `http://127.0.0.1:4343/` to view the local dashboard. It shows configured
instances and lets you create, edit, start, refresh, inspect, and delete remote
connection workers. The manager keeps the main port; workers receive ports from
the configured registry range.

## Install The Codex Plugin

From the `remote-debug-agent` directory:

```powershell
codex plugin marketplace add .
```

Then install or enable `remote-debug-agent` from Codex Desktop's plugin
marketplace UI. The plugin starts `mcp-server.js`, which reads `.env`, checks
the configured local agent port, starts the agent when it is missing, and only
restarts an existing process when it can confirm that process is Remote Debug
Agent.
The bundled `.mcp.json` starts Node with the `node` command, so make sure Node is
available on your `PATH` in the environment where Codex Desktop runs. If Codex
cannot find Node, change `plugins\remote-debug-agent\.mcp.json` to use the full
path to your local `node.exe`.

## Update The Codex Plugin

For users who installed this plugin from a local clone:

```powershell
git pull
codex plugin marketplace add .
```

Then reinstall or re-enable `remote-debug-agent` in Codex Desktop, and restart
Codex Desktop or open a new Codex thread so the MCP server reloads the updated
plugin files.
If Codex logs still reference an older cache path such as
`remote-debug-agent/1.0.0`, the old installed plugin is still active.

`codex plugin marketplace upgrade remote-debug-local` is only for Git-backed
marketplaces. Local marketplaces must be updated with `git pull` and
`codex plugin marketplace add .`, then reinstalled or re-enabled in Codex
Desktop.

For users who configured a Git-backed marketplace, use:

```powershell
codex plugin marketplace upgrade <marketplace-name>
```

## Troubleshooting Plugin Loading

If Codex Desktop says the `remote_debug_*` tools are unavailable, check the
loading path in three separate layers:

1. Plugin configuration: Codex has the plugin installed and enabled.
2. MCP wrapper self-test: `mcp-server.js` can answer `initialize` and
   `tools/list` with the six expected tools.
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
remote_debug_list_instances, remote_debug_run_command,
remote_debug_read_file, remote_debug_list_dir,
remote_debug_prepare_command_draft, remote_debug_get_command_draft,
remote_debug_execute_command_draft
```

The MCP wrapper writes lifecycle events to
`plugins\remote-debug-agent\.runtime\mcp-error.log`, including `initialize`,
`tools/list`, `tools/call`, the resolved project root, agent URL, and plugin
version.

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
repository:

```powershell
git clone https://github.com/zhengchenchen901-coder/ssl-debug-agent.git
cd ssl-debug-agent
```

Install and start the local agent:

```powershell
cd agent
npm install
npm start
```

In another terminal, configure SSH credentials from the repository root:

```powershell
cd ..
Copy-Item .env.example .env
```

Edit `.env` with the target server details:

```text
REMOTE_DEBUG_HOST=example.com
REMOTE_DEBUG_PORT=22
REMOTE_DEBUG_USER=app
REMOTE_DEBUG_PRIVATE_KEY_PATH=C:\Users\you\.ssh\id_ed25519
REMOTE_DEBUG_AGENT_PORT=4343
```

Then install the Codex Desktop plugin from the repository root:

```powershell
codex plugin marketplace add .
```

Install or enable `remote-debug-agent` from Codex Desktop's plugin marketplace
UI, then restart Codex Desktop or open a new Codex thread after installation.
The plugin will start the local HTTP manager from `.env`; `npm start` is only
needed when you want to debug the manager manually.

## Exposed Tools

- `remote_debug_run_command`: run a whitelisted read-only diagnostic command.
- `remote_debug_read_file`: read a file under an allowed remote path.
- `remote_debug_list_dir`: list a directory under an allowed remote path.
- `remote_debug_list_instances`: list configured instances and runtime status.
- `remote_debug_prepare_command_draft`: generate an exact command draft for
  user review. It never executes commands.
- `remote_debug_get_command_draft`: view a previously generated command draft.
- `remote_debug_execute_command_draft`: execute a one-time command draft after
  the user explicitly chooses `使用命令`.

Operation tools accept an optional `instanceId`. If only one instance is
configured, the manager routes to it automatically. If multiple instances exist
and `instanceId` is missing, the tool returns `INSTANCE_ID_REQUIRED` with the
available instance summaries.

## Instance Memory

The manager keeps a small per-instance memory cache at
`.remote-debug/instances/<instanceId>/memory.json`. The cache is owned by the
manager process and is written atomically; workers report discoveries over IPC
instead of writing the file directly.

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
order with the approved-command timeout. A non-zero exit code or timeout stops
the remaining commands. This channel bypasses the read-only command allowlist,
but it does not bypass SSH configuration, timeouts, output limits, the one-time
hash check, or audit logging. Audit entries store command hashes and redacted
command previews instead of raw password-bearing command text.

Allowed commands:

```text
ls cat ps netstat df free tail grep mongodump mongo mongosh systemctl nginx which
```

Additional command constraints:

- MongoDB client/tool commands are limited to `--version`. Real database
  queries must not be disguised as read-only diagnostics; wait for the MCP
  approved-command draft tools and present the exact command for user review.
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
  -> agent/ssh.js SSH or SFTP client
  -> remote Linux server
```

`mcp-server.js` exposes the MCP tools, resolves `.env`, discovers or starts the
local HTTP manager, and forwards tool calls to `http://127.0.0.1:<port>`.
`remote_debug_run_command` forwards `instanceId`, `cmd`, and `timeoutMs` to the
manager's `/run` endpoint. `remote_debug_read_file` and
`remote_debug_list_dir` use the selected worker's SFTP-backed file endpoints.
The approved-command tools use
`/approved-command-drafts`, `/approved-command-drafts/get`, and
`/approved-command-drafts/execute`.

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
- `mongodump`, `mongo`, and `mongosh` are limited to `--version`.
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
cd remote-debug-agent\agent
npm test
```

The test suite uses Node's built-in test runner and mocks SSH/SFTP where needed.
