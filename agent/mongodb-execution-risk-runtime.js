// Fixed, Node 12 compatible remote protocol. Human acceptance never changes
// historical receipts. It reserves one child plan inside the existing import.
export const EXECUTION_RISK_SCRIPT = String.raw`
async function __executionRiskProposal(binding) {
  const old = __loadManifest();
  if (old.kind !== "import" || old.executionContinuation || old.request.database !== binding.database ||
      old.request.collection !== binding.collection || old.request.importId !== binding.importId ||
      old.mutationId !== binding.mutationId || old.planHash !== binding.planHash ||
      __importOrderedDigest(old.execution) !== __importOrderedDigest(binding.execution) ||
      ["planned", "committed", "rolled_back"].includes(old.status)) __fail("MONGODB_EXECUTION_REVIEW_CONFLICT", "exact unknown original execution required");
  __assertImportLive(old.request);
  const lineage = __readImportFile(old.mutationId, "import-lineage.json");
  if (!lineage || lineage.identity.riskPlanId !== binding.riskPlanId || lineage.identity.replacementImportId !== binding.importId ||
      !lineage.identity.replacementBatches.some(b => b.mutationId === old.mutationId && b.requestDigest === binding.batchRequestDigest))
    __fail("MONGODB_EXECUTION_REVIEW_CONFLICT", "existing unique replacement lineage required");
  const { operationId, ...orderedBatch } = old.request;
  if (__importOrderedDigest(orderedBatch) !== binding.batchRequestDigest) __fail("MONGODB_EXECUTION_REVIEW_CONFLICT", "ordered batch changed");
  if (Buffer.byteLength(JSON.stringify(old.request.documents)) > 128 * 1024) __fail("MONGODB_EXECUTION_REVIEW_TOO_LARGE", "bounded human review supports at most 128 KiB of documents");
  const loaded = await __loadClient();
  try {
    const collectionIdentity = await __importPreconditions(loaded.client, old.request);
    // This is a current prerequisite check only, never proof of non-execution.
    const existing = await __findDocs(loaded.client.db(old.request.database).collection(old.request.collection),
      { _id: { $in: old.request.documents.map(d => d._id) } }, 1);
    if (existing.length) __fail("MONGODB_MUTATION_TARGET_EXISTS", "continuation cannot overwrite or adopt documents");
    const continuation = { version: 1, reviewId: binding.reviewId, binding, historicalOutcome: "unknown" };
    const candidate = { schemaVersion: old.schemaVersion, mutationId: "import-" + __importOrderedDigest({ continuation }),
      operationId: old.operationId, kind: "import", request: old.request, before: [], beforeIndex: null, beforeOperations: [],
      collectionIdentity, riskLineage: old.riskLineage || { originalImportId: lineage.identity.importId, riskPlanId: binding.riskPlanId,
        dispositionId: lineage.identity.dispositionId, originalRequestDigest: lineage.identity.originalRequestDigest,
        replacementRequestDigest: lineage.identity.replacementRequestDigest }, executionContinuation: continuation };
    candidate.planHash = __planHash(candidate);
    return { binding, originalStatus: old.status, originalCollectionIdentity: old.collectionIdentity || null,
      collectionIdentity, candidate,
      missingEvidence: ["exact_historical_terminal_receipt", "legacy_in_flight_drain_not_proven"],
      source: { configPath: __configPath, driverPath: __driverPath, profile: __profileName, uriKey: __uriKey } };
  } finally { await __cleanup(() => loaded.client.close()); }
}
function __executionRiskReserved(binding, consume) {
  const previous = __readImportFile(binding.mutationId, "execution-continuation.json");
  if (!previous) return null;
  if (!consume || __importOrderedDigest(previous.binding) !== __importOrderedDigest(binding) ||
      previous.proposalDigest !== __request.proposalDigest || previous.approvalAuditId !== __request.approvalAuditId ||
      __planHash(previous.candidate) !== previous.candidate.planHash ||
      __importOrderedDigest(previous.candidate.executionContinuation.binding) !== __importOrderedDigest(binding))
    __fail("MONGODB_EXECUTION_CONTINUATION_RESERVED", "original already has one exact continuation");
  // Positive durable reservation is sufficient to finish publishing these same
  // bytes without acquiring or clearing a dead helper's locks. No business
  // execution occurs here, and missing reservation alone never permits replay.
  const child = __readImportFile(previous.candidate.mutationId, "manifest.json");
  if (child && (child.planHash !== previous.candidate.planHash || __planHash(child) !== child.planHash))
    __fail("MONGODB_EXECUTION_REVIEW_CONFLICT", "continuation plan changed");
  if (!child) __writeImportFile(previous.candidate.mutationId, "manifest.json", previous.candidate);
  return { reviewId: binding.reviewId, proposalDigest: previous.proposalDigest, approvalAuditId: previous.approvalAuditId,
    historicalOutcome: "unknown", managedOriginalClosed: true, ...__summary(child || previous.candidate) };
}
async function __executionRisk(consume) {
  const existing = __executionRiskReserved(__request.binding, consume);
  if (existing) return existing;
  const globalRelease = __importGlobalLock();
  let release;
  try {
    release = __acquireMutationLock(false);
    const binding = __request.binding;
    const recovered = __executionRiskReserved(binding, consume);
    if (recovered) return recovered;
    if (Date.now() >= binding.expiresAt) __fail("MONGODB_EXECUTION_REVIEW_EXPIRED", "review expired before reservation");
    const proposal = await __executionRiskProposal(binding), proposalDigest = __importOrderedDigest(proposal);
    if (!consume) return { proposal, proposalDigest };
    if (proposalDigest !== __request.proposalDigest) __fail("MONGODB_EXECUTION_REVIEW_CONFLICT", "prerequisites or original facts changed; review again");
    const candidate = { ...proposal.candidate, status: "planned", rollbackMode: "transactional", riskLevel: "high", requiresConfirmation: true,
      createdAt: new Date().toISOString(), rollbackExpiresAt: new Date(binding.expiresAt).toISOString(),
      affectedCount: proposal.candidate.request.documents.length, affectedIds: [],
      changedFields: [...new Set(proposal.candidate.request.documents.flatMap(d => Object.keys(d)))].slice(0, 20),
      afterHashes: [], afterOperations: [], afterIndex: null };
    if (__readImportFile(candidate.mutationId, "manifest.json")) __fail("MONGODB_EXECUTION_REVIEW_CONFLICT", "cannot adopt an existing child");
    // Close new managed dispatches first, then publish the child. Old helpers
    // already in flight may still commit; the human explicitly accepts this.
    __writeImportFile(binding.mutationId, "execution-continuation.json", { version: 1, binding, proposalDigest,
      approvalAuditId: __request.approvalAuditId, historicalOutcome: "unknown", candidate });
    __writeImportFile(candidate.mutationId, "manifest.json", candidate);
    return { reviewId: binding.reviewId, proposalDigest, approvalAuditId: __request.approvalAuditId,
      historicalOutcome: "unknown", managedOriginalClosed: true, ...__summary(candidate) };
  } finally { if (release) release(); globalRelease(); }
}
`;
