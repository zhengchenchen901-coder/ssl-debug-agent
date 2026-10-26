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
  const { operationId, deadlineAt, timeoutMs, _businessPrepare, ...request } = input;
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

export function isPrepareTicket(value) {
  return value && /^[a-f0-9-]{36}$/.test(value.mutationId || "") &&
    /^[a-f0-9]{64}$/.test(value.binding || "") && /^[a-f0-9]{64}$/.test(value.requestDigest || "") &&
    Number.isSafeInteger(value.attempt) && value.attempt > 0;
}
