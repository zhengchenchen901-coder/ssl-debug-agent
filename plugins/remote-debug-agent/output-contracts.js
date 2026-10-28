// Closed metadata objects; JSON is an explicit, recursively guarded data surface.
// New tools must opt in here before their results can leave the MCP process.
const scalar = "scalar";
const json = "json";
const fields = (names) => Object.fromEntries(names.split(/\s+/).filter(Boolean).map((key) => [key, scalar]));
const timing = fields("connectionGeneration queueMs connectMs validationMs executionMs errorLayer errorPhase");
const warning = fields("code message path source phase");
const error = { ...fields("operationId code message layer phase retriable cause causeCode intentId"), diagnostic: fields("phase category databaseCode filesystemCode serverMaxWireVersion driverVersion") };
const memory = { ...fields("status updatedAt initializedAt lastCheckedAt"), summary: json, changedSections: [scalar] };
const runtime = { ...fields("status workerPort pid startedAt stoppedAt lastHeartbeatAt lastUsedAt exitCode signal"), lastError: error, health: json, connection: json, memory, events: json };
const instance = {
  ...fields("id name enabled host port username privateKeyPath hasPassphrase connectOnStart createdAt updatedAt"),
  sourceRoots: json, logProjects: json, serviceProfiles: json, approvedCommands: json, commandReview: json,
  mongodb: { ...fields("enabled configPath driverPath configProfile uriKey database hasSandboxManagementPassword writeEnabled mutationsEnabled rollbackRoot rollbackTtlMs maxAffectedDocuments maxImportBatchDocuments bulkEnabled bulkRoot sandboxDatabase sandboxManagementProfile sandboxManagementUriKey bulkReceiptsCollection bulkBatchDocuments bulkBatchBytes bulkMaxDocuments bulkMaxBytes bulkMaxJobs bulkMaxFiles bulkConcurrency"), allowedDatabases: [scalar], allowedCollections: [scalar] },
  runtime, memory,
  hasPassphrase: "boolean",
};
instance.mongodb.hasSandboxManagementPassword = "boolean";
const common = { ...fields("ok instanceId operationId durationMs"), timing, memory };
const entry = fields("name path size modifyTime modified mtime permissions type isDirectory compression category source readable readReason linkName");
const mutation = {
  ...fields("mutationId operationId kind operation database collection name status rollbackMode riskLevel requiresConfirmation purpose createdAt committedAt rolledBackAt rollbackExpiresAt planHash affectedCount storageRoot receiptsDatabase importId batchCount batchIndex retryable journalPath intentId intentState"),
  collections: [scalar], changedFields: [scalar], affectedIds: json, storageStatus: json,
  rollbackRestoresDocuments: scalar, atomicity: scalar,
  execution: fields("intentId operationId version attempt mutationId planHash"),
  indexRecovery: fields("reason"), diagnostic: error.diagnostic,
  importExecution: { ...fields("version mutationId planHash database collection mode confirmation stage at"), outcomeEvidence: fields("kind sessionDigest transactionDigest requestId"), execution: fields("intentId operationId version attempt mutationId planHash") },
  collectionReceipt: fields("version mutationId planHash database collection stage rollbackMode acknowledgedAt"),
  failedBatch: { ...fields("batchIndex mutationId code"), diagnostic: error.diagnostic },
  prepareRejection: { ...fields("version stage code"), diagnostic: error.diagnostic },
  preview: { ...fields("affectedCount rollbackMode"), affectedIds: json, changedFields: [scalar] },
};
const batch = { ...mutation, ...fields("batchIndex operationCount unitCount rollbackBytes"), changedFields: [scalar], sampleIds: json };
mutation.batches = [batch];
const receiptStorage = fields("database collection legacy scope schemaVersion");
function bulkFailure(depth = 2) {
  const shape = { ...fields("version at code name message messageRedacted messageFingerprint layer phase batchIndex operationId parentOperationId outcome recovery retriable driverVersion nodeVersion collectionIndex collectionOperationCount"),
    ...fields("category driverCode writeErrorCount writeErrorsTruncated"), errorLabels: [scalar],
    writeErrors: [fields("code index category")], writeConcernErrors: [fields("code index category")],
    driverFrames: [fields("module line column")], frames: [fields("function line column")] };
  if (depth > 0) for (const key of ["cause", "receiptCheckFailure", "persistenceFailure"]) shape[key] = bulkFailure(depth - 1);
  return shape;
}
const bulk = {
  ...fields("terminationId reviewHash previousStatus"),
  lastFailure: bulkFailure(),
  ...fields("jobId database status mode desiredState createdAt updatedAt planHash rollbackExpiresAt operationCount unitCount batchCount nextBatch nextVerifyBatch nextRollbackBatch committedBatchCount rolledBackBatchCount activePhase queuedBatchCount verifiedBatchCount differenceOffset differenceLimit differenceCount hasMoreDifferences pauseReason effectiveConcurrency requiresConfirmation atomicity chunkIndex chunkHash nextChunkIndex duplicate inputBytes leaseId accepted background command"),
  riskLineage: fields("originalJobId riskPlanId dispositionId replacementRequestDigest historicalOutcome"),
  ...fields("replacementJobId riskPlanId dispositionId originalRequestDigest replacementRequestDigest approvalAuditId recordedAt controlRecordDigest historicalOutcome legacyInFlightOutcome"),
  managedAdmissionClosed: "boolean", originalJobFound: "boolean",
  receiptStorage, activeBatchIndexes: [scalar], committed: fields("matched modified inserted unchanged"),
  differences: json, changedFields: [scalar], planPreview: [batch], batches: [batch],
};
const historyScan = { ...fields("status complete snapshotBytes"), matches: [fields("operationId kind code validationRejected line sha256")] };
const bulkHistory = { ...fields("requestMatched recordFingerprint jobId chunkIndex evidence remoteEvidenceCode"),
  diagnostics: { ...fields("trust scanStatus intentBound requestDigestBound candidateCount"), mcp: historyScan, worker: historyScan } };
const draft = { ...fields("draftId purpose commandHash commandCount commandBlock status createdAt expiresAt executedAt"), commands: [scalar], instructions: [scalar] };
const execution = {
  ...fields("ok commandsOk draftId commandHash status executedAt durationMs operationId"),
    results: [{ ...fields("commandIndex command commandPreview cmd ok stdout stderr exitCode durationMs timedOut"), timing }],
  stopped: fields("commandIndex reason exitCode"),
};
const violation = fields("commandIndex code severity rule reason message");
const model = { ...fields("status errorCode attempts durationMs decision isReadOnly riskLevel summary"), violations: [violation] };
const review = { ...fields("reason reviewedAt"), staticViolations: [violation], violations: [violation], model };
const sandbox = {
  ...fields("sandboxDatabase storageRoot jobCount bytes initialized activeFilesRetained jobId scannedBytes truncated cleanupHash fileCount retainedUntil removedFiles removedBytes removedReceipts"),
  receiptStorage, files: [fields("name bytes modified")], records: json,
  jobs: [{ ...fields("jobId status rollbackExpiresAt"), receiptStorage }], hasMore: scalar,
};
const access = {
  ...fields("setupId planHash status expiresAt instanceId sandboxDatabase collection managerUser managerRole executorRole managementProfile configPath configModeAfter backupMode collectionsInitialized passwordReset requiresConfirmation confirmation rollbackMode"),
  executionUser: fields("user db"), environment: json, managerPrivileges: json, executorPrivileges: json,
  existing: { ...fields("manager profile executorGranted"), roles: json },
};
const logResources = { ...fields("rssBytes peakRssBytes cpuMs readBytes processedBytes elapsedMs resourceState budgetRevision"),
  budget: fields("cpuMilliCores readBytesPerSecond processBytesPerSecond transferBytesPerSecond rssLimitBytes parallelism dispatchDelayMs mode reason") };
const fileReceipt = { ...fields("queryId fileIndex path compression status startedAt finishedAt scannedBytes expandedBytes scannedLines matchedLines selectedMembers completedMembers retainedEvidenceCount evidenceBytes evidenceTruncated scanComplete countsAreComplete evidenceComplete warningsTruncated reason"),
  source: fields("size modifyTime changeTime inode device"), error,
  warnings: [fields("code message memberPath lineNumber")] };
const logProgress = { ...fields("status scannedBytes expandedBytes matchedLines scannedLines totalFiles completedFiles failedFiles selectedMembers completedMembers currentFile currentMember batchesCompleted outputTruncated scanTruncated directoryListingTruncated countsAreComplete skippedFiles stoppedAtBoundary remainingDateFrom remainingDateTo stopAfterFile scanComplete"), resources: logResources, currentFileProgress: fileReceipt };
const logJob = {
  ...logProgress, ...fields("jobId createdAt startedAt finishedAt expiresAt returnedLines outputBytes complete coverage warningsTruncated groupsTruncated hasMoreRecords nextOffset requestedAction stopReason evidenceComplete evidenceTruncated retainedEvidenceCount paginationScope observedMatchedLines fileResultCount hasMoreFileResults nextFileOffset"),
  resourceTaskId: scalar, evidenceLimits: fields("count bytes"), fileResults: [fileReceipt], scopeControls: fields("dateFrom dateTo stopAfterFile"),
  progress: logProgress, resources: logResources, error,
  limits: fields("jobTimeoutMs cpuPercent readBytesPerSecond processBytesPerSecond rssLimitBytes batchScanBytes"),
  records: [fields("text file memberPath lineNumber timestamp level route method truncated")],
  groups: [fields("level route method code message count")],
  warnings: [{ ...warning, ...fields("file memberPath lineNumber") }],
};
const finalFile = fields("artifactId category format encoding name relativePath bytes sha256");
const finalResult = { ...fields("version taskId instanceId title type status publishedAt fingerprint totalBytes"), final: "boolean",
  privacy: fields("credentials binary policyVersion"), references: { operationIds: [scalar], ...fields("jobId mutationId resourceTaskId") }, files: [finalFile] };
const contracts = {
  remote_debug_publish_final_result: { result: finalResult, duplicate: "boolean" },
  remote_debug_list_final_results: { results: [finalResult], ...fields("total totalBytes unavailable nextOffset outputDirectory") },
  remote_debug_get_final_result: { result: finalResult },
  remote_debug_read_final_artifact: { file: finalFile, content: scalar, truncated: "boolean", previewAvailable: "boolean" },
  remote_debug_list_service_profiles: { instances: [{ instanceId: scalar, profiles: [{ ...fields("serviceId profileHash"), profile: {
    ...fields("instanceId enabled cwd releaseRoot entry mode interpreter nodeVersion pm2Path pm2Home maxMemoryRestart restartDelayMs stableMs startupTimeoutMs startupMarker persist"),
    target: fields("host port username"), envFiles: [scalar], processes: [{ name: scalar, ports: [scalar], env: fields("NODE_ENV PORT WS_PORT CRON_PRIMARY TRANSLATION_ENABLED ORDER_AI_ENABLED ORDER_AI_ALLOWED_RESTAURANTS") }],
  } }] }] },
  remote_debug_set_service_profile: fields("serviceId profileHash workerRefreshRequired"),
  ...Object.fromEntries(["remote_debug_inspect_service", "remote_debug_start_service"].map(name => [name, {
    ...fields("serviceId profileHash status phase resolvedCwd nodeVersion mode persisted unchanged persistenceWarning recovery"),
    started: [scalar], attempted: [scalar], missing: [scalar],
    verified: [{ ...fields("name pid status restarts startupMarkerSeen interpreterVerified environmentVerified"), ports: [scalar] }], error,
  }])),
  remote_debug_list_instances: { ...fields("defaultInstanceId"), manager: json, lifecycle: json, instances: [instance] },
  remote_debug_get_capabilities: { capabilities: json },
  remote_debug_mongodb_query: { ...fields("operation database collection resultCount"), data: json },
  remote_debug_mongodb_resolve_import: { ...fields("intentId state route attempt protectedState reason evidenceSource"), readOnly: "boolean", archived: "boolean", result: { ...common, ...mutation, ...bulk } },
  remote_debug_mongodb_recover_operation: { ...fields("intentId state route attempt mutationId legacy reason recoveryCode protectedState evidenceSource"), readOnly: "boolean", result: { ...common, ...mutation, ...bulk }, history: bulkHistory },
  remote_debug_mongodb_disposition: { ...fields("mutationId proposalDigest originalStatus reservationAuditId effectDigest"),
    lateOriginalCommitObserved: "boolean", lateObservation: { ...fields("receiptDigest status observedAt auditId"), exactAcknowledgedCommit: "boolean" },
    managedOriginalClosed: "boolean", missingEvidence: [scalar], originalCollectionIdentity: json, collectionIdentity: json,
 ...fields("dispositionId reviewHash state recordFingerprint createdAt expiresAt quarantinedAt auditId admission admissionAuditId containmentScope historicalOutcome confirmation"), requiresConfirmation: "boolean",
    localContainment: "boolean", remoteFenceConfirmed: "boolean", replacementAllowed: "boolean", missingRequirements: [scalar], historicalEvidenceGaps: [scalar],
    ...fields("kind replacementImportId batchCount documentCount atomicity riskPlanId replacementJobId replacementRequestDigest sealRequestDigest effectDigest risk fenceReason fenceReceiptId fenceFingerprint fenceValidUntil unitCount operationCount approvalAuditId creationAuditId replacementIntentId planHash"),
    humanConfirmationRequired: "boolean", humanApproved: "boolean", canApprove: "boolean", collections: [scalar],
    ...fields("approvalPolicy approvalAuthority reviewMemo memoSource originalTaskState terminationScope remoteTermination legacyInFlightOutcome warning"),
    acceptedResidualRisk: "boolean",
    originalBatches: [fields("mutationId batchIndex documentCount requestDigest")], replacementBatches: [fields("mutationId batchIndex documentCount requestDigest")],
    batches: [fields("mutationId planHash batchIndex status")],
    observations: { ...fields("source observedAt status code historicalOutcome"), batches: [fields("mutationId batchIndex status code planHash rollbackExpiresAt historicalOutcome")] },
    binding: { ...fields("kind route importId collection contextId instanceId database intentId requestDigest originalOperationId jobId chunkIndex chunkHash planHash reviewId riskPlanId originalPrepareIntentId replacementPrepareIntentId attempt executionProtocol mutationId batchRequestDigest expiresAt"), execution: fields("intentId operationId version attempt mutationId planHash") },
    fenceChallenge: { ...fields("version targetScopeDigest replacementJobId replacementRequestDigest sealRequestDigest effectDigest"),
      binding: fields("kind route importId collection contextId instanceId database intentId requestDigest originalOperationId jobId chunkIndex chunkHash planHash") },
    result: { ...common, ...bulk, ...mutation, error, ...fields("intentId intentState state"), result: { ...common, ...bulk, ...mutation } } },
  remote_debug_mongodb_prepare_write: mutation,
  remote_debug_mongodb_prepare_collection: mutation,
  remote_debug_mongodb_prepare_index: mutation,
  remote_debug_mongodb_prepare_transaction: mutation,
  remote_debug_mongodb_prepare_import: mutation,
  remote_debug_mongodb_prepare_bulk_storage: mutation,
  remote_debug_mongodb_execute_mutation: mutation,
  remote_debug_mongodb_rollback_mutation: mutation,
  remote_debug_mongodb_list_mutations: { entries: [mutation] },
  remote_debug_mongodb_prepare_bulk: bulk,
  remote_debug_mongodb_execute_bulk: bulk,
  remote_debug_mongodb_get_bulk_job: bulk,
  remote_debug_mongodb_control_bulk_job: bulk,
  remote_debug_mongodb_rollback_bulk_job: bulk,
  remote_debug_mongodb_list_bulk_jobs: { ...fields("offset limit total hasMore"), jobs: [bulk] },
  remote_debug_prepare_sandbox_access: access,
  remote_debug_configure_sandbox_access: access,
  remote_debug_get_sandbox: sandbox,
  remote_debug_export_sandbox_log: sandbox,
  remote_debug_prepare_sandbox_cleanup: sandbox,
  remote_debug_cleanup_sandbox: sandbox,
  remote_debug_restart_instance: { ...fields("restarted action previousStatus"), instance, runtime },
  remote_debug_update_memory: { note: { ...fields("topic summary updatedAt"), facts: [scalar] } },
  remote_debug_run_command: fields("stdout stderr exitCode timedOut"),
  remote_debug_read_file: fields("path content truncated"),
  remote_debug_list_dir: { path: scalar, entries: [entry] },
  remote_debug_list_logs: { ...fields("category nextCursor hasMore truncated scannedEntries sourceCount"), entries: [entry], warnings: [warning] },
  remote_debug_list_log_archive_members: { ...fields("path compression nextCursor hasMore truncated scannedBytes"), members: [entry] },
  remote_debug_read_log: fields("path memberPath compression content truncated scannedTruncated scannedBytes archiveScannedBytes totalLines matchedLines"),
  remote_debug_query_logs: {
    ...fields("mode projectId content returnedLines matchedLines scannedLines scannedBytes expandedBytes outputBytes outputTruncated scanTruncated complete coverage countsAreComplete hasMoreFiles nextFileOffset hasMoreMembers nextMemberOffset memberBytes directoryListingTruncated warningsTruncated"),
    files: [entry], scannedFiles: [fields("path scannedBytes startByte endByte")],
    records: [{ ...fields("text file path memberPath lineNumber lineFromEnd timestamp level route method truncated"), source: json }],
    members: [entry], warnings: [warning],
  },
  remote_debug_start_log_query: logJob,
  remote_debug_get_log_query: logJob,
  remote_debug_control_log_query: logJob,
  remote_debug_list_log_projects: { instances: [{ instanceId: scalar, projects: json }] },
  remote_debug_set_log_project: { projects: json },
  remote_debug_prepare_command_draft: draft,
  remote_debug_get_command_draft: draft,
  remote_debug_execute_command_draft: execution,
  remote_debug_review_command_draft: { ...draft, draft, decision: scalar, review, execution },
};

export const OUTPUT_CONTRACTS = Object.freeze(Object.fromEntries(
  Object.entries(contracts).map(([name, shape]) => [name, { ...common, ...shape }]),
));

// Raw upstream payloads/stack traces are deliberately absent from error contracts.
export const ERROR_CONTRACT = {
  ...common, error,
  details: { ...fields("ok operationId code layer phase retriable cause agentUrl port manifestPath"), error },
};
