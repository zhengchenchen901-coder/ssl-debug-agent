---
name: database-mutations
description: Safely plan, confirm, commit, inspect, and roll back bounded MongoDB document, index, import, and resumable bulk mutations through the structured Remote Debug Agent tools. Use this for database writes, updates, soft deletes, index changes, and business workflows composed from those operations.
---

# Database Mutations

Use the structured MongoDB mutation tools for database changes. Do not use
`remote_debug_run_command`, `mongosh --eval`, arbitrary JavaScript, or a raw
MongoDB URI for writes.

## Required workflow

1. Confirm the exact instance first. `default` and `test-server` are separate
   targets and their database profiles must never be mixed.
2. Use `remote_debug_mongodb_prepare_write` for a bounded document mutation or
   `remote_debug_mongodb_prepare_index` for an index change. A prepare call does
   not change the database.
3. Inspect the returned operation, database, collection, affected count, target
   ids, changed fields, rollback mode, expiration, and plan hash.
4. Ask the user to confirm the displayed change. Never treat a prepare result as
   permission to commit.
5. Call `remote_debug_mongodb_execute_mutation` with the exact `mutationId`,
   `planHash`, and confirmation phrase `确认执行`.
6. Verify the committed result with the read-only MongoDB tool where practical.
7. To undo a committed mutation, call
   `remote_debug_mongodb_rollback_mutation` with the same `mutationId` and
   `planHash` plus `确认回滚`.

## Safety boundaries

- Writes require explicit instance-level enablement and database/collection
  allowlists.
- Document writes are bounded and use a MongoDB transaction. Updates require an
  `_id` scope; `updateMany` requires an explicit bounded `_id.$in` list.
- Only `$set`, `$unset`, and `$inc` are accepted by the generic update tool.
- Insert documents must contain an explicit `_id` so their inverse is exact.
- Index creation and removal are compensating operations, not document
  transactions. Never create an index implicitly as part of a business write.
- A rollback must stop on `MONGODB_ROLLBACK_CONFLICT` if another operation has
  changed the target after the commit.
- Journal files are temporary and owner-only under the configured target
  `/tmp/remote-debug-agent/mutations` directory. Treat an expired or missing
  journal as not recoverable.
- Do not expose credentials, connection strings, or complete sensitive
  before-images in conversation output.

## Business workflows

For bulk inserts or data seeding, use `remote_debug_mongodb_prepare_import`.
It accepts up to 10000 documents / 4 MiB per input chunk, automatically split into
transactions of at most 2000 documents / 512 KiB (also capped by the instance's
`maxImportBatchDocuments`). All documents need explicit unique `_id` values;
existing documents are rejected rather than overwritten. Ordinary mixed
transactions retain their 20-operation limit.

Inspect every returned batch plan before committing the authorized batches with
the existing execute tool. Atomicity and rollback apply to individual batches,
not the whole dataset. `prepare_partial` means preparation stopped; inspect
`failedBatch` and the returned plans instead of reporting complete preparation.
Keep the exact input chunk, `importId`, order and options unchanged when retrying
prepare to recover the same journals. Repeating a committed batch does not
reinsert it. `commit_retryable` / `rollback_retryable` can reuse the same plan;
unknown or started outcomes require inspection before further action. Never
infer ownership of existing documents merely because their contents match.

For a project-specific action such as adding a member to a restaurant, first
use read-only queries to resolve and validate the restaurant and member, then
prepare a narrow domain mutation. Prefer a dedicated business tool with named
parameters and project invariants over exposing arbitrary collection, filter,
and update fields. If multiple document changes are required, keep them in one
transaction where possible and roll back child steps in reverse order when a
cross-service compensation is unavoidable.

## Resumable bulk jobs

For large different-value updates or cross-collection writes, follow
[`references/mongodb-bulk.md`](references/mongodb-bulk.md). Use the seven
`remote_debug_mongodb_*bulk*` tools only when the selected instance has bulk
changes explicitly enabled. The reference explains storage initialization,
chunk identity, preflight, authorization, long-running job recovery, verification,
rollback, and redacted examples. Do not substitute a script, shell command, or
direct HTTP call for the structured tool workflow.
