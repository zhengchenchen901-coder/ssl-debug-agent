import { privacyError } from "./privacy-key.js";
import { IMPORT_PREPARE_ROUTE } from "../plugins/remote-debug-agent/prepare-protocol.js";

const DIGEST = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const IMPORT_LOOKUP_MAX_RECORDS = 1000;
const MAX_BYTES = 8 * 1024 * 1024;

export function validateImportLookup(input) {
  if (!UUID.test(input.originalOperationId || "") || !DIGEST.test(input.requestDigest || "") ||
      typeof input.importId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.importId)) {
    throw privacyError("BUSINESS_OPERATION_LOOKUP_INVALID");
  }
}

// Internal store action only. Authenticate and validate the current target in
// the normal storage protocol first. No new index, intent, attempt, event or pin
// is written, including for records predating this reader.
export function resolveImportOperation(store, input, ctx, scope) {
  validateImportLookup(input);
  const target = JSON.parse(input.scope);
  const rows = store.db.prepare("SELECT kind,id,length(envelope) bytes FROM records WHERE ctx=? AND scope=? AND kind IN ('operation','import_prepare_evidence') ORDER BY kind,id LIMIT ?")
    .all(ctx, scope, IMPORT_LOOKUP_MAX_RECORDS + 1);
  if (rows.length > IMPORT_LOOKUP_MAX_RECORDS || rows.reduce((n, row) => n + row.bytes, 0) > MAX_BYTES) {
    return { state: "unresolved", reason: "trusted_lookup_budget_exceeded" };
  }
  const matches = new Map();
  for (const row of rows) {
    const record = store.get(row.kind, row.id, ctx, scope);
    if (record.route !== IMPORT_PREPARE_ROUTE || record.operationId !== input.originalOperationId ||
        record.identity?.instanceId !== target.id || record.identity.importId !== input.importId ||
        record.identity.database !== undefined && record.identity.database !== target.database ||
        record.importPrepare?.requestDigest !== input.requestDigest) continue;
    const id = row.kind === "operation" ? row.id : record.intentId;
    if (!DIGEST.test(id || "") || record.importPrepare.binding !== id ||
        !Number.isSafeInteger(record.importPrepare.attempt) || record.importPrepare.attempt < 1) continue;
    const key = id + ":" + record.importPrepare.attempt;
    const previous = matches.get(key);
    // Current and archived records can share an attempt, but differing evidence
    // is ambiguous. Never pick a convenient record from a partial scan.
    if (previous && JSON.stringify(previous.record) !== JSON.stringify(record)) return { state: "unresolved", reason: "trusted_records_ambiguous" };
    matches.set(key, { id, record, archived: row.kind !== "operation" });
  }
  if (matches.size !== 1) return { state: "unresolved", reason: matches.size ? "trusted_records_ambiguous" : "trusted_record_not_found" };
  return { state: "resolved", ...matches.values().next().value };
}
