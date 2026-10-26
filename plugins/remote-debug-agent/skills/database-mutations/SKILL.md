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
References are bound to a protected local context and target database. The host
can reattach the same local context file after MCP/Manager/computer restarts;
otherwise query again. Never request its capability or encryption key in chat.
Mutation/job IDs, hashes and confirmations retain their existing meanings and
authorization requirements.

On `BUSINESS_OPERATION_RECONCILIATION_REQUIRED`, inspect the existing mutation
journal or bulk job with the same instance and immutable plan hash. Do not
create a replacement job or change arguments to bypass the uncertain intent.
The local store can recognize an exact matching remote terminal result without
replaying the write. For an interrupted bulk job, inspect its lease/recovery
state before using the existing resume flow within the original approval.

Use `remote_debug_mongodb_recover_operation` with the same explicit instance,
database and the error's `intentId`. Its default `mode=inspect` reads local state;
`mode=reconcile` lets the Manager fetch exact remote evidence. For ordinary
document/index/transaction prepare, reconciliation can return the existing plan
or fence a provably unprepared attempt in the technical journal. Only after it
reports `rejected_before_dispatch` may the identical prepare be retried within
the same intent; do not change its parameters or create a replacement plan.
`prepared` returns the existing plan and still requires the normal commit
confirmation. Bulk prepare now records the exact request/attempt and accepted
chunk hash through the Manager. A verified pre-SSH rejection is
`rejected_before_dispatch`; an unclaimed attempt can be atomically fenced.
Positive chunk/manifest evidence (and the exact sealed plan for an end marker)
can recover a lost reply as `complete`; this means preparation delivery only,
never business execution. A dispatched attempt without that evidence stays
`uncertain` with `bulk_prepare_evidence_required`. Historical bulk envelopes
without this protocol return `legacy=true` and `bulk_prepare_identity_required`;
do not invent an identity from an error shown in chat or a missing job.
Legacy ordinary intents without a verifiable identity remain protected
with `legacy_evidence_required`; missing lists/indexes and elapsed lock age are
not recovery proof. Never clear a journal, local record or lock to bypass this.

For an original historical bulk intent, use the same tool with
`mode=historical` in its original protected context. Without `originalRequest`
it returns bounded Manager/worker log diagnostics and a protected-record
fingerprint. To seek recovery, provide the exact original bulk input as
`originalRequest`; this is a candidate for keyed identity verification, not
evidence and not another upload. The Manager verifies the original intent's
keyed JSON identity before reading the exact remote chunk/manifest/plan. Only
positive matching remote evidence can complete preparation delivery, preserving
the original intent/job and an audit event. Missing original bytes, request
mismatch, missing job, plain log validation errors, and caller-supplied proof
cannot discharge protection. `historical_dispatch_evidence_required` means stop;
the reported fingerprint remains unchanged. Never re-upload the candidate to
test it, invent a dispatch ticket, edit protection records, or decode opaque
references. Credential-redacted historical bytes cannot be reconstructed by
guessing. This path never compensates points or authorizes business execution.

After index execute/rollback, `commit_unknown` / `rollback_unknown` are never
permission to repeat DDL. Reconcile the original intent in its original protected
context. The Manager reads the exact mutation/plan and execution acknowledgement,
then performs bounded primary catalog verification; only verified ownership can
complete the receipt and retain compensating rollback evidence. A concurrent
same-spec no-op or a matching index name is not ownership evidence. Historical
`commit_failed` journals without an execution acknowledgement remain uncertain
(`legacy_execution_evidence_required`); do not rewrite them or create replacement
plans. Missing protected context must be restored through its supported context
attachment, not by copying capabilities into chat. Without original trusted
evidence, retain the unresolved receipt and report the independently verified
database state separately. The rollback TTL is a request window, not automatic
rollback or proof that historical compensation can run.

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

## Final task deliverables

When this user task concludes, follow [final-result publication](../final-results.md)
to save its final summary and requested files through the unified local module.
Do not archive intermediate responses, polling, checkpoints, or pending plans.

## Original-intent disposition and human-approved risk replacement

`remote_debug_mongodb_disposition` retains the original protected context and
requires explicit instanceId/database. prepare / inspect / quarantine preserve
the original uncertain record; quarantine separately requires the displayed
reviewHash and `确认隔离原意图`. Its instance-wide local write-admission hold is
not a remote cancellation certificate. Never clear that hold or original locks.
The legacy admit_replacement mode remains a denial-only compatibility endpoint.

When historical evidence cannot determine the outcome, use prepare_risk with
that dispositionId/reviewHash, exact originalRequest and an exact
replacementRequest. The candidate is a proposal, not another job or upload.
Only a complete first chunk is supported. Its business effects, recipients,
amounts, unit order and batch expiry dates must equal the original; only scalar
preimages on updated paths and explicit remediation_job_id/job_id associations
can change. Identity/absence guards, payload changes or extra units are rejected.
Changed guards produce a different exact review. Do not put the unauthorized
52 records into this case's proposal or reset original batch dates.

`BUSINESS_DISPOSITION_INPUT_INVALID` means the original or proposed first chunk
failed local bulk validation before risk-plan storage or remote dispatch. Check
the exact chunk's document shape, IDs, allowed collections, value limits and
identity/array guards. It is not a storage outage or permission to upload a
different job. Credential redaction that changes the exact input still requires
`BUSINESS_DISPOSITION_ORIGINAL_BYTES_REQUIRED`; never reconstruct lost bytes.

inspect_risk exposes the riskPlanId, exact input/effect digests, expiry, missing
fence prerequisites and a signed-migration challenge. historicalOutcome stays
unknown; current business balances or matching ledgers do not change it.

Final approval MUST happen in the independent human administrator workbench:
open “未知任务风险处置”, read the riskPlanId in that authenticated session, review
the target/old and proposed jobs/digests/scope, acknowledge the duplicate-risk
warning, and type `我接受历史结果未知的风险，并批准建立此替代任务`.
Fresh native OS owner verification is mandatory. Manager credentials, a privacy
capability, chat confirmation, MCP arguments or a caller-supplied actor/proof
cannot substitute. Do not ask the user to disclose their administrator password.
This task's permission to develop this feature is not final approval of any
real risk plan. Approval records history as unknown, never “proven not executed”.

Approval requires an externally enforced, trusted migration receipt provisioned
by the installation owner. The source supports REMOTE_DEBUG_EXECUTOR_TRUST_FILE
and REMOTE_DEBUG_EXECUTOR_RECEIPT_DIRECTORY; no public tool uploads a receipt or
changes trust. Ed25519 verification authenticates the configured external
issuer; it does not itself revoke old MongoDB/SSH credentials or drain sessions.
That issuer must actually complete and attest the permanent all-path retirement,
including old processes/queues/leases, authenticated sessions, terminal in-flight
transactions and restarts. Do not generate a real receipt merely to bypass this
requirement. Without this external integration, missing/invalid/expired proof,
or unsupported Windows ACL verification, approval and creation fail closed.

After the human approves the exact plan, create_replacement consumes its
riskPlanId and approved reviewHash. It atomically records the unknown retirement,
one replacement intent, admission gate and audit lineage, then uploads only the
approved first chunk through the existing protected prepare protocol. It never
executes business writes. Lost replies reconcile the same intent; never change
job/arguments to retry. Only that candidate and its derived empty seal are
allowed through the hold. Seal using the normal prepare_bulk tool (chunkIndex=1,
empty units, endOfUpload=true, same purpose/TTL). Only an exact accepted sealed
plan admits normal execute/resume/rollback for its immutable planHash; business
execution retains its existing explicit confirmation and rollback rules.

The plan lasts one hour; approval lasts at most fifteen minutes and no longer
than the external receipt. Expiry or changed evidence requires fresh review and
native confirmation of the same identity; it does not authorize another job.
Only one replacement may be established per original disposition. A preparation
conflict is a failure to inspect, not permission to create a different task.
Future certificate renewal/installation requires owner-controlled provisioning.
No deployment, migration, real disposition or new business job is performed just
to verify this feature; use disposable local fixtures.
