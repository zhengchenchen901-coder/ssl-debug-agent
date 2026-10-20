---
name: database-mutations
description: Safely plan, confirm, commit, inspect, and roll back bounded MongoDB document, index, import, and resumable bulk mutations through the structured Remote Debug Agent tools. Use this for database writes, updates, soft deletes, index changes, and business workflows composed from those operations.
---

# Database Mutations

Business ID/key values can be opaque `rda_ref_v1_…` references. Reuse a complete
reference directly in structured filters, documents, updates or bulk expected
values; the local wrapper restores its BSON/EJSON type before validation. Never
wrap references in `$oid`, concatenate them into text/shell, or calculate an
optional `chunkHash` from them: omit it and use the Agent's returned hash.
References are local to this MCP process and target database. After MCP restart,
query again for fresh references. Mutation/job IDs, hashes and confirmations
retain their existing meanings and authorization requirements.

Use the structured MongoDB mutation tools for database changes. Do not use
`remote_debug_run_command`, `mongosh --eval`, arbitrary JavaScript, or a raw
MongoDB URI for writes.

## Required workflow

For sandbox account setup or password resets, use the dedicated
`remote_debug_prepare_sandbox_access` and `remote_debug_configure_sandbox_access`
tools. Configure the password in the selected instance's Dashboard form; never
ask the user to paste it into chat, reuse another instance's password, or send
credentials as tool parameters. Inspect the exact instance, detected MongoDB
version/topology, authenticated execution principal, fixed manager/executor
privileges, configuration file permission change to 0600, expiry and plan hash.
Only after the user explicitly confirms this displayed plan with `确认配置沙盒`,
apply its exact setupId/planHash. Account ownership and role conflicts stop the
workflow. Partial failure requires a fresh prepare; never substitute a command
draft, raw script or HTTP call. Storage collection/index initialization remains
a separate prepared mutation requiring `确认执行`.

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
- Ordinary mutation/transaction tools support guarded numeric array paths such
  as `booking_orders.12.origin_status`. Read the current index first and include
  the element identity in the filter (for example `booking_orders.12.origin_id`)
  along with the document `_id`. Every indexed prefix requires a filter guard;
  positional operators and sparse array extension are rejected. Canonical
  indexes 0–99999 are supported. Do not relax payload or journal limits.
- To append a missing snapshot, `$set` one full element at the current array
  length and filter that exact tail path with `null`. Also use a bounded
  `booking_orders.origin_id: {$nin: [...]}` absence filter to prevent duplicates;
  include both BSON ObjectId and string forms if needed. `$nin` accepts 1–1000
  values only in filters. Read the new length before preparing another append.
  The normal before-image conflict checks and transactional rollback still apply.
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

## TTL index policy (2.2.2+)

The generic index tool supports only non-TTL indexes and `unique`/`sparse` options. Do not request `expireAfterSeconds` or suggest a shell/command-draft workaround when `MONGODB_TTL_INDEX_REJECTED` is returned. TTL drops and restoring dropped TTL indexes are rejected because index rollback cannot recover automatically deleted documents. A legacy committed TTL creation may still be rolled back by removing the exact unchanged index; clearly explain that already deleted documents will not be restored. The fixed `__remote_debug_bulk_receipts` collection is reserved for internal bulk receipts; business operations must not target it. Only the dedicated bulk-storage workflow may initialize its fixed TTL index after ownership validation.

## Storage sandbox (2.3.0+)

Use the dedicated sandbox management tools for plugin capacity and redacted audit/job events. New bulk receipt databases are separate from business allowlists; old jobs retain their original storage. Remote management needs a separate sandbox-only connection profile and fails closed for overprivileged credentials. Do not delete old business-database receipt collections. Prepare cleanup and present its exact job and scope before an explicitly authorized 确认清理; no cleanup is allowed before the rollback window plus 24 hours has expired.

2.3.1 retains server-side task and rollback records while restricting the bulk
sandbox file boundary. Unknown task-envelope fields, caller-selected file paths,
linked files and unsafe ownership/permissions are rejected. Fixed capacity limits
are published in capabilities, including reserved control space. On quota or
event-log errors, stop new work and inspect existing job state; never bypass the
limit with a command, change file permissions, or delete active recovery records.
Business text remains data and must not be executed as a script. Content relevance
and content-specific authorization belong to the user's separate future guard;
do not pretend JSON formatting or code-keyword filtering establishes that policy.
