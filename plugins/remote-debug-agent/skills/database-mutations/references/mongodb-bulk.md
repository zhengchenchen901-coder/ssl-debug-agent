# MongoDB Resumable Bulk Jobs

Use this workflow when a fixed data set needs many distinct updates or a
cross-collection write per business entity. For seeding documents into one
collection, use `remote_debug_mongodb_prepare_import` instead. For a small,
bounded change, use the existing mutation tools.

## Preconditions and storage setup

1. Confirm the exact instance and database profile. Read-only queries must
   establish the source rows, match key uniqueness, target collection schema,
   protected fields, and every exception rule.
2. Check capabilities and configuration. Both MongoDB writes and bulk jobs must
   be enabled on that instance. Every business collection and the reserved
   `__remote_debug_bulk_receipts` collection must be allowlisted. The persistent
   job directory defaults to `/var/lib/remote-debug-agent/bulk-jobs`; the
   directory must be durable and have owner-only permissions.
3. Before a business job, call
   `remote_debug_mongodb_prepare_bulk_storage`. Review and commit its
   `bulk_storage` plan using the existing mutation confirmation flow. This
   prepares the receipt collection and its TTL index plus the protected log
   directory. The storage-plan call requires `bulkEnabled: true`; turn the flag
   off again when no new bulk work should start. It does not remove either
   resource during rollback.
4. Verify MongoDB transaction support and any business unique-index prerequisite
   with read-only inspection. The bulk tool does not silently create a business
   collection or business index.

If storage, permissions, transactions, allowlists, or required indexes are
missing, stop and report the prerequisite. Never repair it with a shell command
or by widening an allowlist without an explicit request.

## Build and prepare a fixed plan

Each business unit has a stable `unitId` and up to 20 operations. An update must
target a specific `_id`, use only `$set`, `$unset`, or `$inc`, and state the
original value of every changed field. Use `{ "exists": false }` for a missing
field and `{ "exists": true, "value": null }` for explicit `null`. Inserts need
an explicit `_id`. A unit cannot be split across transactions. A collection and
document ID may occur only once in the complete job, so plan independent units
before upload.

Upload chunks in index order with the exact same job identity, purpose, rollback
period, and contents on retry. Repeating an identical chunk is idempotent;
reusing its index with different contents is a conflict. Close the upload with
an empty chunk marked `endOfUpload: true`. Only then does the tool inspect
preimages and return the immutable `planHash` and batch preview.

Default limits are 10,000 operations / 4 MiB per upload chunk, 100,000
operations / 40 MiB per job, 500 operations per batch (configurable up to
2,000), 512 KiB input per batch, and 8 MiB of rollback log per batch. A single
unit that exceeds a batch limit is rejected during preparation. Batch boundaries
may be reduced to fit actual snapshots; a unit is never split. Background
concurrency defaults to two and may be configured up to four.

Review the target database, purpose, total units and operations, changed fields,
batch count, representative target IDs, rollback expiry, concurrency, and any
preparation warnings. The preview is bounded; it is not a substitute for
checking the complete source match and exception counts before upload.

## Authorize, execute, and monitor

`remote_debug_mongodb_execute_bulk` requires `jobId`, the exact `planHash`, and
`确认执行`. The user authorizes the fixed job scope once; do not ask again for
each batch. Ask again if the database, selected rows, transformation, fields,
collections, or rollback scope changes.

The call starts a background job and returns its identity and effective
concurrency. Record the `jobId`, `planHash`, start time, and expected scope. Use
`remote_debug_mongodb_get_bulk_job` to check the current and queued batches,
committed totals, verification, errors, rollback expiry, and paginated
differences. Use `remote_debug_mongodb_list_bulk_jobs` to find the job after a
disconnect or manager restart.

Each transaction performs grouped reads by collection, checks every preimage,
uses one `bulkWrite` per collection in that transaction, verifies the resulting
documents, and inserts the unique commit receipt in the same transaction. An
unknown commit reply is reconciled by reading that receipt. A failure pauses new
batch dispatch; already-started transactions finish before the runner reports
the pause. Never submit changed inputs under the same job or claim success from
matching data alone.

For a paused or recovered job, inspect the exact `pauseReason`, lease, batch
receipts, and differences. Resume only the unchanged plan with
`remote_debug_mongodb_control_bulk_job`. A restart with an uncertain lease
requires inspection first; do not claim a failed transaction when the receipt
does not establish its outcome.

Turning `bulkEnabled` off blocks new plans and resume, but job inspection, pause,
and explicit rollback remain available while MongoDB writes, allowlists, receipt
configuration, and the persistent job path stay configured. Do not remove those
recovery prerequisites until the rollback window and active jobs have been
resolved.

## Verify and roll back

Report `completed` only when every batch committed and post-commit verification
finished. `review_required` means the verifier found later differences; page
through them and explain them without overwriting newer business changes. Check
the requested fields, protected fields, missed matches, duplicates, and business
exceptions with read-only queries where practical.

To reverse the job, call `remote_debug_mongodb_rollback_bulk_job` with the exact
`jobId`, `planHash`, and `确认回滚`. Rollback walks committed batches in reverse
order. It verifies each document still matches this job's postimage before
restoring its before-image. Any conflict stops rollback at that batch for
inspection; never force past it or use a stale plan. The log and receipt retention
is bounded by the displayed rollback expiry plus the receipt-retention window.

Keep the full report redacted. Do not include phone numbers, connection strings,
credentials, full before-images, or unbounded IDs. Use
[`../../../../../docs/templates/mongodb-bulk-execution-report.md`](../../../../../docs/templates/mongodb-bulk-execution-report.md)
and, when needed,
[`../../../../../docs/templates/mongodb-bulk-rollback-report.md`](../../../../../docs/templates/mongodb-bulk-rollback-report.md).

## Redacted workflow examples

The placeholders below must be resolved from the selected project and confirmed
with read-only queries. They are not actual collection schemas or permission to
write.

### Match by normalized phone and synchronize approved fields

Normalize phones using the project's defined rule, prove that each source phone
maps to at most one target, and keep ambiguous or unmatched rows in a separate
exception report. Use an `_id` target and include original values for every field
to change:

```json
{
  "unitId": "member-<stable-id>",
  "operations": [{
    "operation": "updateOne",
    "collection": "<allowlisted-member-collection>",
    "id": "<verified-target-_id>",
    "expected": {
      "displayName": { "exists": true, "value": "<current-value>" },
      "phoneVerified": { "exists": false }
    },
    "update": {
      "$set": { "displayName": "<approved-source-name>", "phoneVerified": true }
    }
  }]
}
```

Do not store raw phone numbers in the job purpose, unit IDs, report, or preview.

### Fill only missing fields

For each selected `_id`, query the field's existence separately from its value.
An explicit `null` is not missing. Exclude rows with a present field or a
conflicting source value; the expected condition prevents a later change from
being overwritten.

```json
{
  "unitId": "record-<stable-id>",
  "operations": [{
    "operation": "updateOne",
    "collection": "<allowlisted-collection>",
    "id": "<verified-_id>",
    "expected": { "<field>": { "exists": false } },
    "update": { "$set": { "<field>": "<approved-value>" } }
  }]
}
```

### Add a VIP binding across two collections

Resolve the VIP, member, group, and existing private binding first. Confirm the
business uniqueness rule and unique index for the member/group pair. Keep the
member update and private-document write in one unit so they commit or roll back
together. If a binding already exists, handle it as an exception rather than
assuming that the IDs are interchangeable.

```json
{
  "unitId": "vip-binding-<stable-member-id>",
  "operations": [
    {
      "operation": "updateOne",
      "collection": "<allowlisted-member-collection>",
      "id": "<verified-member-_id>",
      "expected": { "vipStatus": { "exists": true, "value": false } },
      "update": { "$set": { "vipStatus": true } }
    },
    {
      "operation": "insertOne",
      "collection": "<allowlisted-private-collection>",
      "document": {
        "_id": "<precomputed-stable-_id>",
        "memberId": "<verified-member-id>",
        "groupId": "<verified-group-id>"
      }
    }
  ]
}
```

If the real schema requires upsert, array editing, or more than one write to the
same document, stop. V1 intentionally does not infer those behaviors.
