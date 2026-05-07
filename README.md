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
starting the local agent. Real environment variables override `.env` values.

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
credentials only from environment variables.

## Start The Agent

Use Node `22.18.0` for local development:

```powershell
nvm use 22.18.0
```

```powershell
cd remote-debug-agent\agent
npm install
npm start
```

The agent listens on `http://127.0.0.1:3000` by default.

Open `http://127.0.0.1:3000/` to view the local dashboard. It shows live
agent activity from the Codex plugin through Server-Sent Events, including
operation start, validation, streamed command output, completion, and failures.

## Install The Codex Plugin

From the `remote-debug-agent` directory:

```powershell
codex plugin install .\plugins\remote-debug-agent
```

The plugin starts `mcp-server.js`, which forwards tool calls to the local agent.
The bundled `.mcp.json` uses the nvm-managed Node shim at
`C:\nvm4w\nodejs\node.exe`, so run `nvm use 22.18.0` before testing the plugin.

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
