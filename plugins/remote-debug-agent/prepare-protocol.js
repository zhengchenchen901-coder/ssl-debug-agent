import { createHash } from "node:crypto";

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
