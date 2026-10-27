import { createHash } from "node:crypto";

// Preserve the historical prepare wire field order: the keyed legacy intent
// binds this exact JSON representation, including BSON document field order.
export function bulkPreparePayload(args) {
  return { instanceId: args.instanceId, jobId: args.jobId, database: args.database, chunkIndex: args.chunkIndex,
    chunkHash: args.chunkHash, units: args.units, purpose: args.purpose, rollbackTtlMs: args.rollbackTtlMs,
    endOfUpload: args.endOfUpload, timeoutMs: args.timeoutMs };
}

// Preserve BSON/index document field order. Transport deadlines are not identity.
export function prepareRequestDigest(input) {
  const { operationId, deadlineAt, timeoutMs, _businessPrepare, _businessImport, ...request } = input;
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

export function isPrepareTicket(value) {
  return value && /^[a-f0-9-]{36}$/.test(value.mutationId || "") &&
    /^[a-f0-9]{64}$/.test(value.binding || "") && /^[a-f0-9]{64}$/.test(value.requestDigest || "") &&
    Number.isSafeInteger(value.attempt) && value.attempt > 0;
}

// Keep the public import wire identity identical to prepare_import, including
// document field order. This is a distinct protocol, never a bulk envelope.
export function importPreparePayload(args) {
  return { instanceId: args.instanceId, importId: args.importId, database: args.database,
    collection: args.collection, documents: args.documents, batchSize: args.batchSize,
    rollbackTtlMs: args.rollbackTtlMs, purpose: args.purpose, timeoutMs: args.timeoutMs };
}
export const IMPORT_PREPARE_ROUTE = "/mongodb/imports/prepare";
export const isImportRequest = value => value && Object.hasOwn(value, "importId") && !Object.hasOwn(value, "jobId");
export function importBatchIdentity(plan) {
  return plan.batches.map(({ operationId, ...batch }) => ({ mutationId: batch.mutationId,
    batchIndex: batch.batchIndex, documentCount: batch.documents.length,
    requestDigest: prepareRequestDigest(batch) }));
}

export const SAFE_MUTATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
