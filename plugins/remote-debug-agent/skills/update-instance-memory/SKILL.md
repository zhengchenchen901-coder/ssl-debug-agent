---
name: update-instance-memory
description: Persist verified, redacted operational facts in a Remote Debug Agent instance's local memory. Use when the user explicitly asks Codex to remember, save, record, or update stable instance facts such as database topology, config paths, deployment layout, tool locations, or safe command-draft guidance for later remote diagnostics.
---

# Update Instance Memory

Store durable operational facts with `remote_debug_update_memory` so later tasks can reuse them
without editing `memory.json` or restarting the local manager.

## Workflow

1. Confirm that `remote_debug_list_instances` and `remote_debug_update_memory` are callable. If
   the update tool is unavailable, stop and ask the user to update or reinstall the plugin. Never
   patch the memory file or call the local HTTP API as a fallback.
2. Call `remote_debug_list_instances` and select the requested instance. Pass `instanceId` when
   multiple instances exist.
3. Verify each proposed fact with the relevant read-only Remote Debug Agent tools. Treat existing
   memory as cached context, not proof of current state.
4. Keep only stable facts that will improve future diagnostics or approved-command drafts. Exclude
   transient CPU, memory, disk, PID, uptime, and current health values unless the user explicitly
   wants a historical note.
5. Remove secrets before writing. Never store passwords, private keys, tokens, complete connection
   strings, or commands containing credentials. Store the config path and key name instead.
6. Call `remote_debug_update_memory` with a stable lowercase `topic`, a concise `summary`, and up to
   20 independently useful `facts`.
7. Call `remote_debug_list_instances` again and verify the note under
   `memory.summary.notes`. Report what was stored and whether any value was redacted.

Updating memory changes only local cached metadata. It does not execute a remote command and does
not use the approved-command confirmation phrase.

## Note Design

- Use one topic per durable area, such as `database`, `deployment`, `nginx`, or `tooling`.
- Reuse the same topic to replace stale guidance instead of creating timestamped duplicates.
- Phrase facts as self-contained statements another Codex session can act on.
- Include verification time when recency matters.
- Distinguish a remote service from a client tool. For example, an absent `mongod.service` does not
  imply that the application has no external MongoDB connection.

For database notes, prefer facts such as:

- business database name and configuration profile;
- configuration file path and the JSON key that contains the URI;
- provider, non-secret hosts, ports, replica-set name, authentication database, and read preference;
- absolute `mongodump` or `mongorestore` paths when the tools are not in `PATH`;
- safe draft guidance that reads credentials from the existing config at execution time without
  printing or embedding them.

Do not store a full MongoDB URI even if the agent would redact it. Redaction is a final safety net,
not permission to submit a secret.

## Failure Handling

- If validation rejects the topic or content, correct the note and retry once.
- If a submitted value returns as `[redacted]`, omit the sensitive value, replace it with a config
  reference, and write the corrected note.
- If live evidence conflicts with existing memory, update the same topic with the verified facts
  and state that the previous note was replaced.
