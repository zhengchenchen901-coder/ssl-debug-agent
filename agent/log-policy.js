import posixPath from "node:path/posix";

export const LOG_CATEGORIES = Object.freeze([
  "system",
  "nginx",
  "application",
  "pm2",
]);

export const LOG_DEFAULT_LIMIT = 200;
export const LOG_MAX_LIMIT = 500;
export const LOG_DEFAULT_TAIL_LINES = 200;
export const LOG_MAX_TAIL_LINES = 2_000;
export const LOG_DEFAULT_MAX_BYTES = 256 * 1024;
export const LOG_MAX_BYTES = 256 * 1024;
export const LOG_MAX_CONTAINS_LENGTH = 256;
export const LOG_DEFAULT_SCAN_BYTES = 8 * 1024 * 1024;
export const LOG_MAX_SCAN_BYTES = 256 * 1024 * 1024;
export const LOG_MAX_ARCHIVE_SCAN_BYTES = 1 * 1024 * 1024 * 1024;
export const LOG_MAX_COMPRESSED_SOURCE_BYTES = 256 * 1024 * 1024;
export const LOG_MAX_SCAN_ENTRIES = 5_000;
export const LOG_MAX_ARCHIVE_MEMBERS = 5_000;
export const LOG_MAX_PAX_BYTES = 1 * 1024 * 1024;
export const LOG_MAX_MEMBER_BYTES = 256 * 1024 * 1024;

export const LOG_QUERY_CAPABILITIES = Object.freeze({
  modes: ["latest", "search", "files", "members"], remoteFiltering: true, temporaryExtraction: false,
  supportedCompression: ["none", "gzip", "tar-gzip"], maxFiles: 50,
  maxScanBytes: 256 * 1024 * 1024, maxExpandedBytes: 2 * 1024 * 1024 * 1024,
  maxDirectoryEntries: 5000, maxReturnedLines: 2000, maxReturnedBytes: 256 * 1024,
  backgroundJobs: { start: "/logs/jobs/start", get: "/logs/jobs/get", control: "/logs/jobs/control",
    maxConcurrentPerInstance: 2, maxQueuedPerInstance: 2, maxActiveAndQueued: 4, singlePassArchives: true,
    defaultJobTimeoutMs: 1800000, maxJobTimeoutMs: 7200000,
    defaultCpuPercent: 20, defaultReadBytesPerSecond: 2097152,
    defaultProcessBytesPerSecond: 4194304, rssLimitBytes: 201326592,
    defaultBatchScanBytes: 268435456, cumulativeExpandedByteLimit: null,
    pauseTtlMs: 300000, retentionMs: 1800000, maxRetainedJobs: 16,
    survivesWorkerRestart: false, perFileReceipts: true, receiptAcknowledgement: true,
    maxReceiptBytesPerJob: 8388608, fileResultPagination: true,
    controls: ["pause", "resume", "cancel", "stop_after_file", "narrow"],
    startFileBoundary: "stopAfterFile", evidencePaginationScope: "retained_evidence",
    completeness: ["scanComplete", "countsAreComplete", "evidenceComplete"] },
});

export const LOG_SUPPORTED_COMPRESSION = Object.freeze([
  "none",
  "gzip",
  "tar-gzip",
]);

export const LOG_UNSUPPORTED_COMPRESSION = Object.freeze([
  "bzip2",
  "xz",
  "zip",
]);

export const LOG_CAPABILITIES = Object.freeze({
  query: LOG_QUERY_CAPABILITIES,
  categories: [...LOG_CATEGORIES],
  supportedCompression: [...LOG_SUPPORTED_COMPRESSION],
  unsupportedCompression: [...LOG_UNSUPPORTED_COMPRESSION],
  archiveMemberListing: true,
  defaultLimit: LOG_DEFAULT_LIMIT,
  maxLimit: LOG_MAX_LIMIT,
  defaultTailLines: LOG_DEFAULT_TAIL_LINES,
  maxTailLines: LOG_MAX_TAIL_LINES,
  defaultMaxBytes: LOG_DEFAULT_MAX_BYTES,
  maxBytes: LOG_MAX_BYTES,
  maxContainsLength: LOG_MAX_CONTAINS_LENGTH,
  maxScanBytes: LOG_MAX_SCAN_BYTES,
  maxArchiveScanBytes: LOG_MAX_ARCHIVE_SCAN_BYTES,
  maxCompressedSourceBytes: LOG_MAX_COMPRESSED_SOURCE_BYTES,
  maxMemberBytes: LOG_MAX_MEMBER_BYTES,
  maxScanEntries: LOG_MAX_SCAN_ENTRIES,
  maxArchiveMembers: LOG_MAX_ARCHIVE_MEMBERS,
  pagination: "cursor",
});

export function logInputError(message, code = "INVALID_LOG_REQUEST") {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  error.layer = "worker";
  error.phase = "validation";
  error.retriable = false;
  return error;
}

export function normalizeLogJobLimits(value) {
  if (value === undefined || value === "") return {};
  let parsed = value;
  try { if (typeof value === "string") parsed = JSON.parse(value); } catch { throw logInputError("invalid REMOTE_DEBUG_LOG_JOB_LIMITS"); }
  const ranges = { maxJobTimeoutMs: [1000, 7200000], cpuPercent: [1, 50],
    readBytesPerSecond: [65536, 16777216], processBytesPerSecond: [65536, 33554432],
    rssLimitBytes: [64 * 1024 * 1024, 192 * 1024 * 1024] };
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw logInputError("invalid REMOTE_DEBUG_LOG_JOB_LIMITS");
  for (const [key, number] of Object.entries(parsed)) {
    const range = ranges[key];
    if (!range || !Number.isInteger(number) || number < range[0] || number > range[1]) throw logInputError(`invalid log job limit: ${key}`);
  }
  return { ...parsed };
}

function positiveInteger(value, fallback, maximum, field) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw logInputError(`${field} must be a positive integer`, `INVALID_${field.toUpperCase()}`);
  }
  return Math.min(value, maximum);
}

export function normalizeLogCategory(value) {
  if (value === undefined || value === null || value === "") {
    return "all";
  }
  if (typeof value !== "string" || (!["all", ...LOG_CATEGORIES].includes(value))) {
    throw logInputError(
      `category must be one of all, ${LOG_CATEGORIES.join(", ")}`,
      "INVALID_LOG_CATEGORY",
    );
  }
  return value;
}

export function normalizeLogListOptions(input = {}) {
  const category = normalizeLogCategory(input.category);
  const limit = positiveInteger(input.limit, LOG_DEFAULT_LIMIT, LOG_MAX_LIMIT, "limit");
  const cursor = input.cursor === undefined || input.cursor === null
    ? ""
    : input.cursor;
  if (typeof cursor !== "string" || cursor.length > 4_096) {
    throw logInputError("cursor must be a string no longer than 4096 characters", "INVALID_LOG_CURSOR");
  }

  return { category, limit, cursor };
}

export function normalizeArchiveMemberListOptions(input = {}) {
  const path = input.path;
  if (typeof path !== "string" || path.trim() === "") {
    throw logInputError("path must be a non-empty string", "INVALID_PATH");
  }
  const prefix = input.prefix === undefined || input.prefix === null ? "" : input.prefix;
  if (typeof prefix !== "string" || prefix.length > 512) {
    throw logInputError("prefix must be a string no longer than 512 characters", "INVALID_MEMBER_PREFIX");
  }
  const cursor = input.cursor === undefined || input.cursor === null ? "" : input.cursor;
  if (typeof cursor !== "string" || cursor.length > 4_096) {
    throw logInputError("cursor must be a string no longer than 4096 characters", "INVALID_LOG_CURSOR");
  }

  return {
    path,
    prefix: normalizeArchiveMemberPrefix(prefix),
    limit: positiveInteger(input.limit, LOG_DEFAULT_LIMIT, LOG_MAX_ARCHIVE_MEMBERS, "limit"),
    cursor,
  };
}

export function normalizeLogReadOptions(input = {}) {
  const path = input.path;
  if (typeof path !== "string" || path.trim() === "") {
    throw logInputError("path must be a non-empty string", "INVALID_PATH");
  }
  const memberPath = input.memberPath === undefined || input.memberPath === null
    ? ""
    : input.memberPath;
  if (typeof memberPath !== "string" || memberPath.length > 4_096) {
    throw logInputError("memberPath must be a string no longer than 4096 characters", "INVALID_MEMBER_PATH");
  }
  const contains = input.contains === undefined || input.contains === null ? "" : input.contains;
  if (typeof contains !== "string" || contains.length > LOG_MAX_CONTAINS_LENGTH) {
    throw logInputError(
      `contains must be a string no longer than ${LOG_MAX_CONTAINS_LENGTH} characters`,
      "INVALID_LOG_CONTAINS",
    );
  }

  return {
    path,
    memberPath: memberPath ? normalizeArchiveMemberPath(memberPath) : "",
    tailLines: positiveInteger(
      input.tailLines,
      LOG_DEFAULT_TAIL_LINES,
      LOG_MAX_TAIL_LINES,
      "tailLines",
    ),
    maxBytes: positiveInteger(input.maxBytes, LOG_DEFAULT_MAX_BYTES, LOG_MAX_BYTES, "maxBytes"),
    contains,
    caseSensitive: input.caseSensitive === true,
  };
}

export function normalizeArchiveMemberPrefix(value) {
  if (!value) {
    return "";
  }
  const normalized = normalizeArchiveMemberPath(value);
  return value.endsWith("/") ? `${normalized}/` : normalized;
}

export function normalizeArchiveMemberPath(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw logInputError("archive member path must be a non-empty string", "INVALID_MEMBER_PATH");
  }
  if (value.includes("\0") || value.includes("\\")) {
    throw logInputError("archive member path contains an unsafe character", "INVALID_MEMBER_PATH");
  }
  if (value.startsWith("/")) {
    throw logInputError("archive member path must be relative", "INVALID_MEMBER_PATH");
  }

  const normalized = posixPath.normalize(value);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw logInputError("archive member path escapes the archive", "ARCHIVE_MEMBER_PATH_NOT_ALLOWED");
  }
  return normalized;
}

export function encodeLogCursor(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeLogCursor(value, expectedKind) {
  if (!value) {
    return { kind: expectedKind, sourceIndex: 0, offset: 0 };
  }
  if (typeof value !== "string" || value.length > 4_096) {
    throw logInputError("cursor is invalid", "INVALID_LOG_CURSOR");
  }
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      decoded?.kind !== expectedKind ||
      !Number.isInteger(decoded.sourceIndex) || decoded.sourceIndex < 0 ||
      !Number.isInteger(decoded.offset) || decoded.offset < 0
    ) {
      throw new Error("invalid cursor fields");
    }
    return decoded;
  } catch {
    throw logInputError("cursor is invalid", "INVALID_LOG_CURSOR");
  }
}
