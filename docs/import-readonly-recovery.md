# Read-only import recovery lookup

`remote_debug_mongodb_resolve_import` accepts an explicit `instanceId` and
`database` (including `test-server` / `yennefer`), `originalOperationId`,
`importId`, and `requestDigest`. Attach the **original** context through the
existing host `REMOTE_DEBUG_PRIVACY_CONTEXT_FILE` setting. Never copy its
capability/key into a tool argument or another context.

`requestDigest` is the existing preparation protocol digest:

```js
prepareRequestDigest(importPreparePayload(originalArgs))
```

Use the immutable original arguments with their original document and BSON
field order. The protocol uses SHA-256 of ordered JSON, excluding transport
operationId/deadline/timeout and internal prepare envelopes. It is **not** a
file hash, a hash of a differently ordered argument object, a digest of redacted
values, or a hash computed from opaque reference aliases. A saved input-file
SHA may be used to verify the local file first, but cannot replace the bound
wire digest. Digest derivation is local; never call prepare to obtain it.

The Manager validates the current target profile and original context, then
reads a consistent SQLite snapshot of at most 1,000 encrypted operation and
archived import-attempt records / 8 MiB in that exact context and scope. Only
an existing record matching the original operationId, importId, protocol digest,
instance, database scope, intent binding and attempt can return an intentId.
The reader never creates an index, migrates records, derives a new intent,
reserves an attempt, re-pins data or parses logs as evidence. Missing metadata,
ambiguous records, corruption and exhausted budgets fail closed. No partial scan
is treated as a unique match. Malformed input/authentication errors are errors;
missing or inadequate historical evidence returns `state=unresolved`.

The lookup uses the same import observation branch exposed as
`remote_debug_mongodb_recover_operation(mode="observe")` once intentId is known.
Existing `inspect` / `reconcile` behavior is preserved. Observation verifies
an existing local preparation receipt, or reads the exact remote import receipt
via the existing `/mongodb/imports/recover-prepare` helper and applies the same
binding, ordered batch identity, attempt and plan checks as normal recovery.
It does not invoke prepare/execute/rollback, fence an unclaimed attempt, update
the original operation or archive, clear locks, retry, retire tasks or extend
windows. The remote helper may acquire/release its normal exclusive read guard;
it cannot clear another helper's lock or write preparation/control files in
recovery mode. Missing remote plans remain unresolved.

Results retain `readOnly=true`, `intentId`, `attempt`, `protectedState`,
`evidenceSource` and the exact guarded `result` when proven. A positive remote
observation can report `state=complete` while `protectedState=uncertain`:
**the protected state has not been reconciled and no retry was admitted**.
`archived=true` identifies a prior attempt, not the current attempt's admission
state. A prepared plan still retains its original identity, confirmation and
expiry requirements; a partial/rejected preparation retains its actual status.

`rejected_before_dispatch` requires an existing, exact, durable rejection whose
attempt and Manager-owned evidence (`unclaimed_attempt_fence` or
`preflight_before_ssh`) match the stored attempt. This reader never closes a new
attempt to obtain that label. The current historical storage has no separate
no-intent dispatch-termination certificate; when no intent was generated or no
trusted association exists, the result stays unresolved. Log messages, absent
journals, short duration, static guard analysis and user statements do not fill
that gap. Installing this reader cannot retroactively create historical proof.

Normal MCP output/reference delivery bookkeeping may create its own records;
it does not modify the original operation/attempt, protective pins or history.
The new reader is source-only until separately installed. Development and its
isolated tests must not reissue the nine EJPOH requests, open production privacy
storage, modify original protection records, or update an installed plugin cache.
