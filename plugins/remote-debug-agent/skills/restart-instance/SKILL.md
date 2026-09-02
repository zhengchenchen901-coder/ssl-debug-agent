---
name: restart-instance
description: Safely inspect and recover a stopped or unhealthy Remote Debug Agent instance with the restricted restart tool. Use when a user asks to restart, recover, or bring back a configured remote-debug instance, or when an authorized management workflow reports that an instance is stopped or unhealthy.
---

# Restart Instance

Use the instance list and authoritative lifecycle policy before attempting recovery. The restart tool controls only the local Remote Debug Agent worker for the selected instance; it does not reboot the remote Linux host.

## Workflow

1. Call `remote_debug_get_capabilities` and verify `authority` is `remote-debug-agent` and `lifecycle.instanceRestart` permits recovery.
2. Call `remote_debug_list_instances`. Require the exact `instanceId`; never guess it from a hostname or environment label.
3. Read the runtime status and `lastError` or recent events. Restart only `stopped` or `unhealthy` instances. Do not disrupt a healthy running instance.
4. State the observed status and reason, then call `remote_debug_restart_instance` once.
5. Call `remote_debug_list_instances` again and report whether the instance returned to `running` with healthy worker state.

## Safety Rules

- Never bypass the MCP tool with private manager HTTP calls, process kills, shell commands, or service-control commands.
- Treat `starting` and `stopping` as transitions: do not retry immediately.
- Do not loop inside the skill. A human or external management service must own a finite, persisted retry budget and cooldown.
- If recovery fails, preserve and report the structured error. Do not hide or overwrite the original stop reason.
- Automated callers must have explicit policy authorization and must notify the configured operational or approval conversation about downtime, reason, attempt number, and final result.
