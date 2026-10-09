---
name: environment-check
description: Diagnose Remote Debug Agent startup failures, missing remote_debug tools, and incompatible local runtime environments; show the actual requirements and the existing dashboard's environment report.
---

# Plugin Environment Diagnosis

Use this skill when Remote Debug Agent tools are unavailable or a local plugin
startup check fails. It requires local file/shell access, not the failed MCP.

Resolve the installed plugin root from this skill's location (two directories
above it). Read the existing `.runtime/environment-report.json` under
`REMOTE_DEBUG_DATA_DIR`, then `REMOTE_DEBUG_PROJECT_ROOT`, otherwise
`%LOCALAPPDATA%/RemoteDebugAgent` on Windows or `~/.remote-debug-agent` elsewhere.
The dashboard uses the same report. Existing reports are snapshots: retain
their timestamps and distinguish an actual plugin launch from a manual check.

If a fresh check is needed, run `node <plugin-root>/launch.cjs --check` through
the local shell. This prints structured JSON and saves an offline dashboard;
the entrypoint keeps a compatible current Node, otherwise finds an existing
compatible version in PATH or NVM and relaunches only the plugin under it.
`REMOTE_DEBUG_NODE_PATH` in the process environment or `config.env` can explicitly
select an executable; an invalid explicit selection is reported without silently
falling back. `runtimeSelection` records the bootstrap and actual MCP runtimes.
Automatic selection does not change the user's global PATH or NVM default.
exit code 1 means a failed check, not a broken diagnostic script. The regular
plugin launch also serves a diagnostic-only dashboard when possible. Use
`dashboardUrl` from the report rather than assuming port 4343; otherwise open
`offlineDashboard`. A manual shell check describes that shell's executable,
which may differ from the executable used by the Codex MCP startup process.
Compare paths and `runtimeSelection` before claiming the plugin environment has
been fixed. Use a new actual plugin launch to confirm host tool discovery.

When Node is missing or older than 14, run
`python3 <plugin-root>/scripts/offline-report.py` (Windows: `py -3`) if Python 3
is available. It produces the same offline dashboard. If neither Node nor
Python is available, explain that no automatic report generator can run and
give the Node requirement from the plugin's package.json.

Report failed items with their actual values, required conditions and remedies.
Give a short explanation in the chat and open/link the dashboard for details.
Do not reproduce configuration contents, credentials or arbitrary logs.
Configuration files are optional when environment variables or the instance
registry provide the connection settings. Remote SSH and MongoDB checks belong
to the relevant instance workflow; do not contact every remote instance during
local startup diagnosis.

`checked` confirms local prerequisites only; `ready` records that the MCP
received a tools/list request. Neither proves that the current chat has callable
tools. Inspect the current tool table before resuming the original task. If
local checks pass but tools are absent, explain the remaining host/session
problem and suggest reloading the plugin or opening a new chat.

Do not change the user's default Node version, install software, or bypass MCP
through direct database/HTTP operations merely to diagnose visibility. Re-run
the relevant business skill only once its required tools are callable.
