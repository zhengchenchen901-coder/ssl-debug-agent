# Remote Debug Agent

Remote Debug Agent is a Codex Desktop plugin plus a local HTTP agent for safe
Linux server debugging over SSH.

Architecture:

```text
Codex Desktop
  -> Codex plugin
  -> local MCP wrapper
  -> local Node HTTP agent
  -> SSH
  -> remote Linux server
```

The local HTTP agent is the security boundary. Codex never receives arbitrary
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
settings so the plugin and local agent use the same target and port.

```powershell
$env:REMOTE_DEBUG_HOST = "example.com"
$env:REMOTE_DEBUG_PORT = "22"
$env:REMOTE_DEBUG_USER = "app"
$env:REMOTE_DEBUG_PRIVATE_KEY_PATH = "C:\Users\you\.ssh\id_ed25519"
$env:REMOTE_DEBUG_AGENT_PORT = "3000"
```

Optional:

```powershell
$env:REMOTE_DEBUG_PRIVATE_KEY_PASSPHRASE = "..."
$env:REMOTE_DEBUG_AUDIT_LOG = "C:\path\to\remote-debug-audit.jsonl"
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

The Codex plugin starts and repairs the local agent automatically from `.env`.
For manual debugging, run `npm start` in the `agent` directory. The agent listens
on `http://127.0.0.1:3000` by default, or `REMOTE_DEBUG_AGENT_PORT` when set.

Open `http://127.0.0.1:3000/` to view the local dashboard. It shows live
agent activity from the Codex plugin through Server-Sent Events, including
operation start, validation, streamed command output, completion, and failures.

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
REMOTE_DEBUG_AGENT_PORT=3000
```

Then install the Codex Desktop plugin from the repository root:

```powershell
codex plugin marketplace add .
```

Install or enable `remote-debug-agent` from Codex Desktop's plugin marketplace
UI, then restart Codex Desktop or open a new Codex thread after installation.
The plugin will start the local HTTP agent from `.env`; `npm start` is only
needed when you want to debug the agent manually.

## Exposed Tools

- `remote_debug_run_command`: run a whitelisted read-only diagnostic command.
- `remote_debug_read_file`: read a file under an allowed remote path.
- `remote_debug_list_dir`: list a directory under an allowed remote path.

Allowed commands:

```text
ls cat ps netstat df free tail grep
```

Allowed path roots:

```text
/var/log
/etc/nginx
/home/app
```

## Safety Rules

- No arbitrary shell.
- No shell control operators, pipes, redirects, command substitution, or newlines.
- No dangerous commands such as `rm`, `sudo`, `shutdown`, `reboot`, `mkfs`,
  `chmod`, or `chown`.
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
