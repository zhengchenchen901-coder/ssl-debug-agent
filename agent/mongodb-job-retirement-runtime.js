// Fixed sandbox control protocol. This closes managed job admissions; it is not
// an assertion that fence-unaware historical SSH helpers or DB transactions died.
export const MONGODB_JOB_RETIREMENT_RUNTIME = String.raw`
function __bulkRetirement(jobId) {
  var dir = __bulkJobDir(jobId);
  if (!__fs.existsSync(dir)) return null;
  var record = __bulkReadJson(__path.join(dir, "retirement.json"), 65536);
  if (record && (record.version !== 1 || record.jobId !== jobId || record.database !== __config.database || record.status !== "terminated_unknown")) __bulkFail("MONGODB_BULK_LOG_INVALID", "invalid retirement record");
  return record;
}
function __bulkAssertNotRetired(jobId) {
  if (__bulkRetirement(jobId)) __bulkFail("MONGODB_BULK_JOB_RETIRED", "job was terminated by independent human risk review");
}
function __bulkRetirementView(record) {
  return Object.assign({}, record, { managedAdmissionClosed: true, historicalOutcome: "unknown", legacyInFlightOutcome: "unknown", controlRecordDigest: __bulkHash(record) });
}
function __bulkRetireJob(jobId) {
  var dir = __bulkEnsureJobDir(jobId);
  return __bulkWithLock(__path.join(__bulkRoot(), ".risk-retirement.lock"), function () {
  return __bulkWithLock(__bulkManifestLockPath(jobId), function () {
    var existing = __bulkRetirement(jobId);
    if (existing) {
      ["replacementJobId", "riskPlanId", "dispositionId", "originalRequestDigest", "replacementRequestDigest"].forEach(function (key) {
        if (existing[key] !== __request[key]) __bulkFail("MONGODB_BULK_RETIREMENT_CONFLICT", "retirement belongs to a different reviewed replacement");
      });
      return __bulkRetirementView(existing);
    }
    var priorLineage = __bulkReplacementLineage(__request.replacementJobId);
    if (priorLineage && (priorLineage.originalJobId !== jobId || priorLineage.riskPlanId !== __request.riskPlanId)) __bulkFail("MONGODB_BULK_RETIREMENT_CONFLICT", "replacement already belongs to another retirement");
    var replacementDir = __bulkJobDir(__request.replacementJobId);
    if (__fs.existsSync(replacementDir)) {
      var replacement = __bulkReadJson(__path.join(replacementDir, "manifest.json"), 4 * 1024 * 1024);
      if (replacement && (!replacement.riskLineage || replacement.riskLineage.originalJobId !== jobId || replacement.riskLineage.riskPlanId !== __request.riskPlanId)) __bulkFail("MONGODB_BULK_RETIREMENT_CONFLICT", "replacement job already exists outside this approved handoff");
    }
    var manifest = __bulkReadJson(__path.join(dir, "manifest.json"), 4 * 1024 * 1024);
    var record = { version: 1, jobId: jobId, database: __config.database, status: "terminated_unknown",
      replacementJobId: __request.replacementJobId, riskPlanId: __request.riskPlanId, dispositionId: __request.dispositionId,
      originalRequestDigest: __request.originalRequestDigest, replacementRequestDigest: __request.replacementRequestDigest,
      approvalAuditId: __request.approvalAuditId, originalJobFound: !!manifest, recordedAt: new Date().toISOString() };
    // Durable tombstone first. A crash can leave the old manifest unchanged, but
    // all supported get/write paths consult this pinned record before using it.
    __bulkWriteJson(__path.join(dir, "retirement.json"), record, 65536);
    if (manifest) {
      manifest.status = "terminated_unknown"; manifest.desiredState = "stop";
      manifest.replacedBy = record.replacementJobId; manifest.riskPlanId = record.riskPlanId;
      manifest.updatedAt = record.recordedAt; __bulkSaveManifest(manifest);
    }
    __bulkAppendJsonLine(__path.join(dir, "events.jsonl"), { at: record.recordedAt, event: "human_risk_job_terminated", riskPlanId: record.riskPlanId, replacementJobId: record.replacementJobId, historicalOutcome: "unknown" });
    return __bulkRetirementView(record);
  });
  });
}
function __bulkReplacementLineage(jobId) {
  var found = null, names = __fs.readdirSync(__bulkRoot());
  if (names.length > 2008) __bulkFail("SANDBOX_STORAGE_SCAN_LIMIT", "too many entries for lineage inspection");
  names.forEach(function (name) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) return;
    var retired = __bulkRetirement(name);
    if (retired && retired.replacementJobId === jobId) {
      if (found) __bulkFail("MONGODB_BULK_RETIREMENT_CONFLICT", "replacement has more than one original job");
      found = { originalJobId: retired.jobId, riskPlanId: retired.riskPlanId, dispositionId: retired.dispositionId,
        replacementRequestDigest: retired.replacementRequestDigest, historicalOutcome: "unknown" };
    }
  });
  return found;
}
`;
