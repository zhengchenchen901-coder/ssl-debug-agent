// Closed metadata objects; JSON is an explicit, recursively guarded data surface.
// New tools must opt in here before their results can leave the MCP process.
const scalar = "scalar";
const json = "json";
const fields = (names) => Object.fromEntries(names.split(/\s+/).filter(Boolean).map((key) => [key, scalar]));
const timing = fields("connectionGeneration queueMs connectMs validationMs executionMs errorLayer errorPhase");
const warning = fields("code message path source phase");
const error = { ...fields("operationId code message layer phase retriable cause"), diagnostic: fields("phase databaseCode filesystemCode") };
const memory = { ...fields("status updatedAt initializedAt lastCheckedAt"), summary: json, changedSections: [scalar] };
const runtime = { ...fields("status workerPort pid startedAt stoppedAt lastHeartbeatAt lastUsedAt exitCode signal"), lastError: error, health: json, connection: json, memory, events: json };
const instance = {
  ...fields("id name enabled host port username privateKeyPath hasPassphrase connectOnStart createdAt updatedAt"),
  sourceRoots: json, logProjects: json, approvedCommands: json, commandReview: json,
  mongodb: { ...fields("enabled configPath driverPath configProfile uriKey database hasSandboxManagementPassword writeEnabled mutationsEnabled rollbackRoot rollbackTtlMs maxAffectedDocuments maxImportBatchDocuments bulkEnabled bulkRoot sandboxDatabase sandboxManagementProfile sandboxManagementUriKey bulkReceiptsCollection bulkBatchDocuments bulkBatchBytes bulkMaxDocuments bulkMaxBytes bulkMaxJobs bulkMaxFiles bulkConcurrency"), allowedDatabases: [scalar], allowedCollections: [scalar] },
  runtime, memory,
  hasPassphrase: "boolean",
};
instance.mongodb.hasSandboxManagementPassword = "boolean";
const common = { ...fields("ok instanceId operationId durationMs"), timing, memory };
const entry = fields("name path size modifyTime modified mtime permissions type isDirectory compression category source readable readReason linkName");
const mutation = {
  ...fields("mutationId operationId kind operation database collection name status rollbackMode riskLevel requiresConfirmation purpose createdAt committedAt rolledBackAt rollbackExpiresAt planHash affectedCount storageRoot receiptsDatabase importId batchCount batchIndex retryable journalPath"),
  collections: [scalar], changedFields: [scalar], affectedIds: json, storageStatus: json,
  rollbackRestoresDocuments: scalar, atomicity: scalar,
  failedBatch: fields("batchIndex mutationId code"),
  preview: { ...fields("affectedCount rollbackMode"), affectedIds: json, changedFields: [scalar] },
};
const batch = { ...mutation, ...fields("batchIndex operationCount unitCount rollbackBytes"), changedFields: [scalar], sampleIds: json };
mutation.batches = [batch];
const receiptStorage = fields("database collection legacy scope schemaVersion");
const bulk = {
  ...fields("jobId database status mode desiredState createdAt updatedAt planHash rollbackExpiresAt operationCount unitCount batchCount nextBatch nextVerifyBatch nextRollbackBatch committedBatchCount rolledBackBatchCount activePhase queuedBatchCount verifiedBatchCount differenceOffset differenceLimit differenceCount hasMoreDifferences pauseReason effectiveConcurrency requiresConfirmation atomicity chunkIndex chunkHash nextChunkIndex duplicate inputBytes leaseId accepted background command"),
  receiptStorage, activeBatchIndexes: [scalar], committed: fields("matched modified inserted unchanged"),
  differences: json, changedFields: [scalar], planPreview: [batch], batches: [batch],
};
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
const logResources = fields("rssBytes peakRssBytes cpuMs readBytes processedBytes elapsedMs");
const logProgress = { ...fields("status scannedBytes expandedBytes matchedLines scannedLines totalFiles completedFiles failedFiles selectedMembers completedMembers currentFile currentMember batchesCompleted outputTruncated scanTruncated directoryListingTruncated countsAreComplete"), resources: logResources };
const logJob = {
  ...logProgress, ...fields("jobId createdAt startedAt finishedAt expiresAt returnedLines outputBytes complete coverage warningsTruncated groupsTruncated hasMoreRecords nextOffset requestedAction"),
  progress: logProgress, resources: logResources, error,
  limits: fields("jobTimeoutMs cpuPercent readBytesPerSecond processBytesPerSecond rssLimitBytes batchScanBytes"),
  records: [fields("text file memberPath lineNumber timestamp level route method truncated")],
  groups: [fields("level route method code message count")],
  warnings: [{ ...warning, ...fields("file memberPath lineNumber") }],
};
const contracts = {
  remote_debug_list_instances: { ...fields("defaultInstanceId"), manager: json, lifecycle: json, instances: [instance] },
  remote_debug_get_capabilities: { capabilities: json },
  remote_debug_mongodb_query: { ...fields("operation database collection resultCount"), data: json },
  remote_debug_mongodb_prepare_write: mutation,
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
