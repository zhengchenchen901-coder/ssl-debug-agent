---
name: database-mutations
description: Safely plan, confirm, commit, inspect, and roll back bounded MongoDB document and index mutations through the structured Remote Debug Agent tools. Use this for database writes, updates, soft deletes, index changes, and business workflows composed from those operations.
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

For a project-specific action such as adding a member to a restaurant, first
use read-only queries to resolve and validate the restaurant and member, then
prepare a narrow domain mutation. Prefer a dedicated business tool with named
parameters and project invariants over exposing arbitrary collection, filter,
and update fields. If multiple document changes are required, keep them in one
transaction where possible and roll back child steps in reverse order when a
cross-service compensation is unavoidable.

