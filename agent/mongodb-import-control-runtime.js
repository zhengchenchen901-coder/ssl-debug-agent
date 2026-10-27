// Fixed remote Node 12 compatible helper. Control directories are not business
// manifests and are never listed as historical transactions or auto-cleaned.
export const IMPORT_CONTROL_SCRIPT = String.raw`
function __importControlId(database, importId) { return "import-control-" + __hash({ database, importId }); }
function __importDirectory(id, callback) {
  const previous = __request.mutationId;
  __request.mutationId = id;
  try { return callback(); } finally { __request.mutationId = previous; }
}
function __readImportFile(id, name) {
  return __importDirectory(id, () => {
    const directory = __journalDir(), file = __path.join(directory, name);
    for (const item of [__journalRoot, directory, file]) if (__fs.existsSync(item) && __fs.lstatSync(item).isSymbolicLink()) __fail("MONGODB_JOURNAL_SYMLINK_REJECTED", "unsafe import control path");
    if (!__fs.existsSync(file)) return null;
    const value = __fs.readFileSync(file, "utf8");
    if (Buffer.byteLength(value) > 8 * 1024 * 1024) __fail("MONGODB_IMPORT_RECEIPT_INVALID", "import control exceeds bounds");
    return JSON.parse(value);
  });
}
function __writeImportFile(id, name, value) {
  return __importDirectory(id, () => {
    __writeJsonAtomic(name, value);
    // The atomic writer syncs the file and its immediate directory. New
    // control/batch directories also need their parent entry made durable.
    for (const directory of [__journalRoot, __path.dirname(__journalRoot)]) {
      const fd = __fs.openSync(directory, "r");
      try { __fs.fsyncSync(fd); } finally { __fs.closeSync(fd); }
    }
    if (__importOrderedDigest(__readImportFile(id, name)) !== __importOrderedDigest(value)) __fail("MONGODB_IMPORT_RECEIPT_INVALID", "import control readback mismatch");
  });
}
function __importGlobalLock() { return __importDirectory("import-control-lock", () => __acquireMutationLock(false)); }
function __importBatchIdentity(plan) {
  return plan.batches.map(batch => {
    const { operationId, ...identity } = batch;
    return { mutationId: batch.mutationId, batchIndex: batch.batchIndex, documentCount: batch.documents.length,
      requestDigest: __createHash("sha256").update(JSON.stringify(identity)).digest("hex") };
  });
}
function __importOrderedDigest(value) { return __createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function __assertImportLive(request, mutationId) {
  if (mutationId && __readImportFile(mutationId, "execution-continuation.json"))
    __fail("MONGODB_EXECUTION_ORIGINAL_PROTECTED", "original execution remains unknown and closed to new managed writes");
  const child = mutationId && __readImportFile(mutationId, "manifest.json");
  if (child && child.executionContinuation) {
    const b = child.executionContinuation.binding;
    const reservation = __readImportFile(b.mutationId, "execution-continuation.json");
    const original = __readImportFile(b.mutationId, "manifest.json");
    if (!reservation || reservation.candidate.planHash !== child.planHash || !original || original.status === "committed")
      __fail("MONGODB_EXECUTION_REVIEW_CONFLICT", "continuation reservation missing or late original commit observed");
  }
  if (__readImportFile(__importControlId(request.database, request.importId), "retirement.json") ||
      mutationId && __readImportFile(mutationId, "import-retirement.json")) __fail("MONGODB_IMPORT_RETIRED", "original import is closed; historical outcome remains unknown");
}
function __reviewImportBatches(request) {
  return request.batches.map(batch => {
    let manifest;
    try { manifest = __readImportFile(batch.mutationId, "manifest.json"); }
    catch (error) { return { mutationId: batch.mutationId, batchIndex: batch.batchIndex, status: "unavailable", code: error.code || "MONGODB_IMPORT_MANIFEST_INVALID" }; }
    if (!manifest) return { mutationId: batch.mutationId, batchIndex: batch.batchIndex, status: "missing", historicalOutcome: "unknown" };
    const { operationId, ...identity } = manifest.request || {};
    const matching = manifest.kind === "import" && manifest.mutationId === batch.mutationId && manifest.request.database === request.database &&
      manifest.request.importId === request.importId && manifest.request.batchIndex === batch.batchIndex &&
      __importOrderedDigest(identity) === batch.requestDigest && __planHash(manifest) === manifest.planHash;
    return { mutationId: batch.mutationId, batchIndex: batch.batchIndex, status: matching ? manifest.status : "identity_conflict",
      planHash: matching ? manifest.planHash : undefined, rollbackExpiresAt: matching ? manifest.rollbackExpiresAt : undefined,
      execution: matching ? manifest.execution : undefined, historicalOutcome: "unknown" };
  });
}
function __importRetirementIdentity(value) { const { approvalAuditId, ...identity } = value; return __importOrderedDigest(identity); }
function __retireImport(request) {
  const release = __importGlobalLock();
  try {
    const original = __importControlId(request.database, request.importId), replacement = __importControlId(request.database, request.replacementImportId);
    const previous = __readImportFile(original, "retirement.json"), lineage = __readImportFile(replacement, "lineage.json");
    const { operationId, ...identity } = request;
    if (previous && __importRetirementIdentity(previous.identity) !== __importRetirementIdentity(identity) ||
        lineage && __importRetirementIdentity(lineage.identity) !== __importRetirementIdentity(identity)) __fail("MONGODB_IMPORT_RETIREMENT_CONFLICT", "import is already linked to another review");
    if (__readImportFile(replacement, "prepare.json") && !lineage) __fail("MONGODB_IMPORT_RETIREMENT_CONFLICT", "replacement import already exists");
    for (const batch of request.replacementBatches) {
      if (__readImportFile(batch.mutationId, "manifest.json") && !lineage) __fail("MONGODB_IMPORT_RETIREMENT_CONFLICT", "replacement batch already exists");
      const reserved = __readImportFile(batch.mutationId, "import-lineage.json");
      if (reserved && __importRetirementIdentity(reserved.identity) !== __importRetirementIdentity(identity)) __fail("MONGODB_IMPORT_RETIREMENT_CONFLICT", "replacement batch is already reserved");
    }
    const record = previous || { version: 1, identity, historicalOutcome: "unknown", legacyInFlightOutcome: "unknown", recordedAt: new Date().toISOString() };
    // Original closure is durable first. Interruption leaves it closed and the
    // identical handoff can finish the remaining exact reservations on retry.
    __writeImportFile(original, "retirement.json", record);
    for (const batch of request.originalBatches) {
      const old = __readImportFile(batch.mutationId, "import-retirement.json");
      if (old && __importRetirementIdentity(old.identity) !== __importRetirementIdentity(identity)) __fail("MONGODB_IMPORT_RETIREMENT_CONFLICT", "original batch belongs to another handoff");
      __writeImportFile(batch.mutationId, "import-retirement.json", record);
    }
    __writeImportFile(replacement, "lineage.json", record);
    for (const batch of request.replacementBatches) __writeImportFile(batch.mutationId, "import-lineage.json", record);
    const readback = __readImportFile(original, "retirement.json");
    if (__importOrderedDigest(readback) !== __importOrderedDigest(record)) __fail("MONGODB_IMPORT_RECEIPT_INVALID", "retirement readback mismatch");
    return { ...request, status: "terminated_unknown", managedAdmissionClosed: true, historicalOutcome: "unknown", controlRecordDigest: __importOrderedDigest(readback) };
  } finally { release(); }
}
async function __guardedImportPrepare(recover) {
  const plan = __request.mutation, receipt = __request.importReceipt;
  const database = recover ? __request.database : plan.database, importId = recover ? __request.importId : plan.importId;
  const controlId = __importControlId(database, importId), release = __importGlobalLock();
  try {
    __assertImportLive({ database, importId });
    let prior = __readImportFile(controlId, "prepare.json");
    const lineage = __readImportFile(controlId, "lineage.json");
    if (lineage && (!receipt || receipt.riskPlanId !== lineage.identity.riskPlanId || receipt.requestDigest !== lineage.identity.replacementRequestDigest)) __fail("MONGODB_IMPORT_LINEAGE_REQUIRED", "exact approved import identity required");
    if (!receipt) return await __prepareImportPlan();
    if (prior && __hash(prior.receipt) !== __hash(receipt)) {
      const { attempt: oldAttempt, ...oldBinding } = prior.receipt, { attempt: newAttempt, ...newBinding } = receipt;
      if (recover || prior.result && !["prepare_partial", "prepare_rejected"].includes(prior.result.status) || !prior.result || newAttempt !== oldAttempt + 1 || __hash(oldBinding) !== __hash(newBinding)) __fail("MONGODB_IMPORT_RECEIPT_CONFLICT", "import belongs to another protected intent or an unknown attempt");
      // Persist the new attempt before doing any work. A lost reply must now
      // reconcile this attempt, never infer completion from the old prefix.
      __writeImportFile(controlId, "prepare-attempt-" + oldAttempt + ".json", prior);
      prior = { version: 1, receipt, batches: prior.batches };
      __writeImportFile(controlId, "prepare.json", prior);
    }
    if (recover) {
      if (!prior || !prior.result) __fail("MONGODB_IMPORT_EVIDENCE_REQUIRED", "positive terminal preparation receipt required");
      const reviewed = __reviewImportBatches({ database, importId, batches: prior.batches });
      if (prior.result.batches.some((batch, index) => reviewed[index].planHash !== batch.planHash)) __fail("MONGODB_IMPORT_RECEIPT_CONFLICT", "batch receipt mismatch");
      // Return current statuses, retaining the immutable preparation receipt.
      return { ...prior.result, batches: prior.result.batches.map((batch, index) => ({ ...batch, status: reviewed[index].status })) };
    }
    const batches = __importBatchIdentity(plan);
    if (receipt.batchesDigest !== __importOrderedDigest({ batches }) || lineage && __importOrderedDigest(batches) !== __importOrderedDigest(lineage.identity.replacementBatches)) __fail("MONGODB_IMPORT_RECEIPT_CONFLICT", "normalized import batch identity changed");
    if (prior && prior.result) return prior.result;
    if (!prior) {
      // A risk replacement cannot adopt pre-existing journals, even with equal
      // documents. Reservation was made before this new preparation began.
      if (lineage && batches.some(batch => __readImportFile(batch.mutationId, "manifest.json"))) __fail("MONGODB_IMPORT_RECEIPT_CONFLICT", "replacement batch exists without this prepare receipt");
      __writeImportFile(controlId, "prepare.json", { version: 1, receipt, batches });
    }
    __request.importLineage = lineage ? { originalImportId: lineage.identity.importId, riskPlanId: lineage.identity.riskPlanId,
      dispositionId: lineage.identity.dispositionId, originalRequestDigest: lineage.identity.originalRequestDigest, replacementRequestDigest: lineage.identity.replacementRequestDigest } : undefined;
    // No transaction or batch plan processing has begun in this attempt.
    // Persist a positive, exact preflight rejection, not an absence inference.
    let preflightClient;
    try {
      preflightClient = (await __loadClient()).client;
      await __importPreconditions(preflightClient, plan);
    } catch (error) {
      const code = typeof error.code === "string" && /^MONGODB_[A-Z0-9_]{1,70}$/.test(error.code) ? error.code : "MONGODB_OPERATION_FAILED";
      const rejected = { kind: "import_plan", importId, database, collection: plan.collection, affectedCount: plan.affectedCount,
        batchCount: batches.length, status: "prepare_rejected", batches: [], requiresConfirmation: false, importReceipt: receipt,
        prepareRejection: { version: 1, stage: "preflight_rejected", code, diagnostic: __diagnostic(error) } };
      __writeImportFile(controlId, "prepare.json", { version: 1, receipt, batches, result: rejected });
      return rejected;
    } finally { if (preflightClient) await __cleanup(() => preflightClient.close()); }
    const result = { ...await __prepareImportPlan(), importReceipt: receipt };
    __writeImportFile(controlId, "prepare.json", { version: 1, receipt, batches, result });
    return result;
  } finally { release(); }
}
`;
