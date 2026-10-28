// Closed review diagnostics: no values, document field paths or raw messages.
const CODES = new Set(["INVALID_MONGODB_MUTATION", "MONGODB_IMPORT_COUNT_LIMIT", "MONGODB_IMPORT_SIZE_LIMIT", "MONGODB_IMPORT_ID_INVALID", "MONGODB_IMPORT_DUPLICATE_ID", "MONGODB_IMPORT_BATCH_LIMIT", "MONGODB_MUTATION_DOCUMENT_TOO_LARGE", "MONGODB_MUTATION_ID_REQUIRED", "MONGODB_FIELD_REJECTED", "MONGODB_OPERATOR_REJECTED", "MONGODB_DATABASE_NOT_ALLOWED", "MONGODB_COLLECTION_NOT_ALLOWED"]);
export function importReviewDiagnostic(input) {
  if (!["originalRequest", "replacementRequest"].includes(input?.requestField) || !CODES.has(input?.code)) return undefined;
  return { requestField: input.requestField, code: input.code };
}
