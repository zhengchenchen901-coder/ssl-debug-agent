import { LOG_QUERY_RUNTIME_SOURCE } from "./log-query-runtime-source.js";
import { normalizeLogProjects } from "./log-projects.js";
import { assertPathAllowed } from "./security.js";
import { logInputError, normalizeArchiveMemberPath, normalizeArchiveMemberPrefix, LOG_QUERY_CAPABILITIES } from "./log-policy.js";
import { operationError } from "./operation.js";

export const LOG_QUERY_MARKER = "__REMOTE_DEBUG_LOG_QUERY__";
export { LOG_QUERY_CAPABILITIES };

function text(value, field, maximum = 256) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > maximum || value.includes("\0")) throw logInputError(`${field} is invalid`, "INVALID_LOG_QUERY");
  return value;
}
function integer(value, fallback, maximum, field) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw logInputError(`${field} must be a positive integer`, "INVALID_LOG_QUERY");
  return Math.min(value, maximum);
}
function date(value, field) {
  const result = text(value, field, 10);
  const parsed = new Date(`${result}T00:00:00Z`);
  if (result && (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result)) throw logInputError(`${field} must be YYYY-MM-DD`, "INVALID_LOG_QUERY");
  return result;
}
function timestamp(value, field) {
  const result = text(value, field, 40);
  if (result && (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(result) || !Number.isFinite(Date.parse(result)))) throw logInputError(`${field} requires an ISO timestamp with timezone`, "INVALID_LOG_QUERY");
  return result;
}

export function normalizeLogQuery(input, config) {
  const projects = normalizeLogProjects(config.logs?.projects, config.security.allowedPaths, config.security.sourceRoots);
  const projectId = text(input.projectId, "projectId", 32);
  const path = text(input.path, "path", 4096);
  if (Boolean(projectId) === Boolean(path)) throw logInputError("provide exactly one of projectId or path", "INVALID_LOG_QUERY");
  if (projectId && !Object.hasOwn(projects, projectId)) throw logInputError(`unknown log project: ${projectId}`, "LOG_PROJECT_NOT_FOUND");
  if (path) assertPathAllowed(path, config.security.allowedPaths);
  const contains = text(input.contains, "contains");
  const route = text(input.route, "route");
  if (route && !route.startsWith("/")) throw logInputError("route must be an exact absolute route", "INVALID_LOG_QUERY");
  const level = text(input.level, "level", 16).toLowerCase();
  const method = text(input.method, "method", 16).toUpperCase();
  const fromTime = timestamp(input.fromTime, "fromTime");
  const toTime = timestamp(input.toTime, "toTime");
  const mode = input.mode || (contains || route || level || method || fromTime || toTime ? "search" : "latest");
  if (!LOG_QUERY_CAPABILITIES.modes.includes(mode)) throw logInputError("mode must be latest, search, files, or members", "INVALID_LOG_QUERY");
  if (mode === "members" && (!path || !/\.(?:tar\.gz|tgz)$/i.test(path))) throw logInputError("members mode requires an exact tar.gz path", "NOT_A_LOG_ARCHIVE");
  if (mode === "latest" && (contains || route || level || method || fromTime || toTime)) throw logInputError("use search mode for record filters", "INVALID_LOG_QUERY");
  if (["files", "members"].includes(mode) && (contains || route || level || method || fromTime || toTime)) throw logInputError("record filters require search mode", "INVALID_LOG_QUERY");
  const dateFrom = date(input.date || input.dateFrom, "dateFrom");
  const dateTo = date(input.date || input.dateTo, "dateTo");
  if ((dateFrom && dateTo && dateFrom > dateTo) || (fromTime && toTime && Date.parse(fromTime) > Date.parse(toTime))) throw logInputError("start must precede end", "INVALID_LOG_QUERY");
  const fileOffset = input.fileOffset ?? 0;
  if (!Number.isInteger(fileOffset) || fileOffset < 0 || fileOffset > 5000) throw logInputError("invalid fileOffset", "INVALID_LOG_QUERY");
  const memberPath = text(input.memberPath, "memberPath", 4096);
  const memberOffset = input.memberOffset ?? 0;
  if (!Number.isInteger(memberOffset) || memberOffset < 0 || memberOffset > 5000) throw logInputError("invalid memberOffset", "INVALID_LOG_QUERY");
  if (memberPath && path && !/\.(?:tar\.gz|tgz)$/i.test(path)) throw logInputError("memberPath requires a tar.gz or tgz archive", "ARCHIVE_MEMBER_NOT_ALLOWED");
  return {
    projectId, path, directories: projectId ? projects[projectId].directories : [],
    allowedRoots: config.security.allowedPaths, mode, dateFrom, dateTo, fromTime, toTime,
    fileContains: text(input.fileContains, "fileContains"),
    memberContains: text(input.memberContains, "memberContains"),
    memberPath: memberPath ? normalizeArchiveMemberPath(memberPath) : "",
    memberPrefix: normalizeArchiveMemberPrefix(text(input.memberPrefix, "memberPrefix", 512)),
    memberOffset, maxArchiveMembers: 5000,
    contains, caseSensitive: input.caseSensitive === true, route, level, method, fileOffset,
    limit: integer(input.limit, 50, mode === "members" ? 5000 : 2000, "limit"),
    maxBytes: integer(input.maxBytes, 256 * 1024, 256 * 1024, "maxBytes"),
    maxFiles: integer(input.maxFiles, mode === "latest" ? 1 : 10, 50, "maxFiles"),
    maxScanBytes: integer(input.maxScanBytes, 32 * 1024 * 1024, LOG_QUERY_CAPABILITIES.maxScanBytes, "maxScanBytes"),
    maxExpandedBytes: integer(input.maxExpandedBytes, 1024 * 1024 * 1024, LOG_QUERY_CAPABILITIES.maxExpandedBytes, "maxExpandedBytes"),
    maxLineBytes: 1024 * 1024, maxDirectoryEntries: 5000,
  };
}

export function buildLogQueryScript(query, operation) {
  const input = { ...query, deadlineAt: operation.deadlineAt };
  return `${LOG_QUERY_RUNTIME_SOURCE}\nrunRemoteLogQuery(${JSON.stringify(input)}).then(result => {
    let payload = JSON.stringify({ok:true,...result});
    while (Buffer.byteLength(payload) > 768 * 1024 && result.records && result.records.length) {
      if (result.records.length === 1) result.records.length = 0;
      else result.records.splice(Math.ceil(result.records.length / 2));
      result.returnedLines = result.records.length;
      result.content = result.records.map(record => record.text).join("\\n") + (result.records.length ? "\\n" : "");
      result.outputBytes = result.records.reduce((bytes, record) => bytes + Buffer.byteLength(record.text), 0);
      result.outputTruncated = true;
      payload = JSON.stringify({ok:true,...result});
    }
    if (Buffer.byteLength(payload) > 768 * 1024) throw new Error("log query response too large");
    console.log(${JSON.stringify(LOG_QUERY_MARKER)} + payload);
  }).catch(error => {
    console.log(${JSON.stringify(LOG_QUERY_MARKER)} + JSON.stringify({ok:false,error:{code:error.code||"LOG_QUERY_FAILED",message:error.message}}));
    process.exitCode=1;
  });\n`;
}

export async function queryLogs(input, options) {
  const query = normalizeLogQuery(input, options.config);
  const result = await options.runSSH("node", {
    config: options.config, operation: options.operation,
    stdin: buildLogQueryScript(query, options.operation),
    priority: query.mode === "latest" && query.path && !/\.(?:gz|tgz)$/i.test(query.path) ? "interactive" : "background",
  });
  if (result.stdoutTruncated) throw operationError("log query response exceeded the limit", { code: "LOG_QUERY_RESPONSE_TOO_LARGE", statusCode: 502, layer: "logs", phase: "response" });
  const line = String(result.stdout || "").split(/\r?\n/).find((line) => line.startsWith(LOG_QUERY_MARKER));
  let payload;
  try { payload = line && JSON.parse(line.slice(LOG_QUERY_MARKER.length)); } catch { /* reject below */ }
  if (!payload || !payload.ok || result.exitCode !== 0) {
    throw operationError(payload?.error?.message || "remote log helper failed; Node must be available on the target", {
      code: payload?.error?.code || "LOG_QUERY_HELPER_FAILED", statusCode: 502,
      layer: "logs", phase: "remote-query", operationId: options.operation.operationId,
      details: { exitCode: result.exitCode, stderr: String(result.stderr || "").slice(0, 2048) },
    });
  }
  delete payload.ok;
  return { ...payload, remoteDurationMs: payload.durationMs, timing: result.timing };
}
