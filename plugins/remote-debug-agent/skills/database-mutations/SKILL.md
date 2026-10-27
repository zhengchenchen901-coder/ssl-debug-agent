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

## Standalone permanent bulk-job termination

When the user decides a bulk job must never resume (for example its immutable
guards have changed), use the independent administrator workbench's
“永久终止任务”. Review the explicit instance, configured database, existing
jobId, immutable planHash and reason. The workbench reads the current job,
binds its state to a five-minute review and requires the exact phrase
`我确认永久终止此任务，不再恢复或重试` plus fresh native OS owner verification.
MCP, a context capability, Manager token or a caller-provided actor/receipt
cannot approve termination. No new business task is created.

Approval permanently closes this job's local upload/execute/resume/rollback
admissions before the fixed worker helper writes a remote retirement record.
The Manager independently reads that record back. `termination_pending` means
local admissions are closed but remote acknowledgement is incomplete; report
that distinction and finish only this termination through a fresh workbench
review. A lost reply or restart never reopens the job or runs business writes.
`terminated_unknown` preserves historical and legacy in-flight uncertainty;
it does not certify cancellation of old dispatched transactions. Plans,
receipts, before-images, risk lineage and protections remain pinned, with no
automatic business rollback or cleanup. Existing risk-approval expiry does
not block this independent termination flow.

After termination, do not retry or refresh the old job/plan. Any future business
work needs a separately prepared new identity and guards based on current data,
its own review and execution authorization. Never create that task merely to
terminate this one.

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
For bulk, only a complete first chunk is supported. Its business effects, recipients,
amounts, unit order and batch expiry dates must equal the original; only scalar
preimages on updated paths and explicit remediation_job_id/job_id associations
can change. Identity/absence guards, payload changes or extra units are rejected.
Changed guards produce a different exact review. Do not put the unauthorized
52 records into this case's proposal or reset original batch dates.

For an uncertain `/mongodb/imports/prepare`, provide the exact original import
input and a replacement import input. Only `importId` may change: preserve the
same target, collection, documents (including BSON field order), document order,
batchSize, purpose and rollback TTL options. Never wrap an import in bulk units.
The plan binds both ordered inputs and all deterministic transaction batch
identities. Manager observations show exact matching batch manifests/plan hashes,
current statuses or a bounded missing/conflict/unavailable result. Missing
receipts never prove non-execution. Original bytes, uncertain history and recovery
evidence stay pinned, including historical imports without an importId identity.

The same independent workbench and fresh native OS verification approve import
plans. Approval closes only the original import and its exact known batch IDs.
`create_replacement` records and reads back durable import retirement/lineage
controls before reserving one replacement intent, then prepares its exact batches
without business writes. Do not seal an import with bulk tools. Inspect all
returned batches and use normal mutation execute/rollback confirmations on each
exact mutationId/planHash. Atomicity and rollback remain per batch. A partial
prepare is explicitly partial. A terminal partial receipt can continue preparation
with the exact same input/intent (or the same approved create_replacement plan);
the prefix evidence and existing batch plans are preserved. An unknown attempt
cannot be repeated. Lost replies reconcile the same import intent
using positive exact receipts; absent/incomplete evidence stays uncertain. Do not
change importId, repeat an uncertain dispatch or clear controls to recover it.
Expired approval requires a fresh review of the same replacement identity.

`BUSINESS_DISPOSITION_INPUT_INVALID` means the original or proposed first chunk
failed local bulk validation before risk-plan storage or remote dispatch. Check
the exact chunk's document shape, IDs, allowed collections, value limits and
identity/array guards. It is not a storage outage or permission to upload a
different job. Credential redaction that changes the exact input still requires
`BUSINESS_DISPOSITION_ORIGINAL_BYTES_REQUIRED`; never reconstruct lost bytes.

inspect_risk exposes the policy version, exact input/effect digests, expiry,
Manager-observed remote job status and residual risks. Optional reviewMemo is
bounded and sanitized, explicitly a caller statement rather than verified proof.
Preserve dates and evidence timestamps; do not describe an older business snapshot
as current. historicalOutcome remains unknown.

New plans use human-risk-acceptance-v2. The independent administrator is the
final authority for the remaining uncertainty: external migration receipts and
instance-wide quarantine are NOT prerequisites for this policy. Do not trap human
review behind machine certainty that cannot be obtained. Already-quarantined
instance holds remain intact; this flow does not silently remove them.

Final approval MUST happen in the independent human administrator workbench:
open “未知任务风险处置”, read the exact riskPlanId in that authenticated session,
review facts, gaps, old/new identities, effects and duplicate/late-commit risks,
and type `我接受历史结果未知的风险，并批准建立此替代任务`.
Fresh native OS owner verification is mandatory. Manager credentials, a privacy
capability, chat confirmation, MCP arguments or a caller-supplied actor/proof
cannot substitute. Never ask for an administrator password in chat. Development
permission does not approve any real plan.

Approval closes the original job's managed local admissions and active task flag,
pins its original uncertain record unchanged, and records who accepted which
risks. create_replacement next writes and verifies an exact durable retirement
record in the remote sandbox using the fixed internal Node helper, then records
the unique replacement intent and both directions of the lineage. Missing remote
jobs receive a control tombstone, not fabricated historical upload/execute data.
Unsupported caller-provided result/proof or retirement routes remain unavailable
through public MCP. Retired control records are never eligible for sandbox cleanup.

Termination here covers managed admissions and cooperative workers. It does not
prove that previously dispatched fence-unaware helpers, authenticated sessions or
in-flight MongoDB transactions were cancelled. Those unknowns are disclosed for
human acceptance, not falsely certified away. A new helper checks retirement
before work and before commit; races or older code can still leave late effects.
History is never rewritten as “proven not executed”.

Legacy plans retain their old external-fence requirements and signatures; their
approvals are never promoted to this new policy. Re-prepare the exact proposal
under v2, review its new identity/hash and obtain a new native human approval.
Do not use an old riskPlanId or old approval to bypass the policy transition.

After the human approves the exact plan, create_replacement consumes its
riskPlanId and approved reviewHash. After remote retirement acknowledgement, it atomically records
one replacement intent, admission gate and audit lineage, then uploads only the
approved first chunk through the existing protected prepare protocol. It never
executes business writes. Lost replies reconcile the same intent; never change
job/arguments to retry. Only that candidate and its derived empty seal are
allowed through the hold. Seal using the normal prepare_bulk tool (chunkIndex=1,
empty units, endOfUpload=true, same purpose/TTL). Only an exact accepted sealed
plan admits normal execute/resume/rollback for its immutable planHash; business
execution retains its existing explicit confirmation and rollback rules.

The plan lasts one hour; v2 approval lasts at most fifteen minutes and no longer
than the plan. Legacy approval also remains bounded by its external receipt. Expiry or changed evidence requires fresh review and
native confirmation of the same identity; it does not authorize another job.
Only one replacement may be established per original disposition. A preparation
conflict is a failure to inspect, not permission to create a different task.
The same replacement identity is reused after expiry or a lost reply.
No deployment, migration, real disposition or new business job is performed just
to verify this feature; use disposable local fixtures.

New import prepare envelopes support atomic closure of an unclaimed attempt.
Only a Manager/store `rejected_before_dispatch` result allows identical input
to reserve a new attempt within the same intent. A delayed claim is fenced; a
claim that wins first stays uncertain without exact positive remote evidence.
Worker configuration mismatch is refused before transport, without automatic
restart. Inspect in-flight work before explicitly refreshing; a refresh failure
or a missing receipt never proves that an earlier request did not execute.
