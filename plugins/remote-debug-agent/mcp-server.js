import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  migrateLegacyData,
  normalizeWindowsExtendedPath,
  readRuntimeManifest,
  resolveConfigPath,
  resolveDataDir,
} from "./runtime-support.js";

const DEFAULT_PROTOCOL_VERSION = "2024-11-05";
const AGENT_API_VERSION = 2;
const DEFAULT_AGENT_PORT = 4343;
const DEFAULT_SSH_PORT = 22;
const PROBE_TIMEOUT_MS = 1500;
const START_TIMEOUT_MS = 7000;
const AGENT_START_LOCK_TTL_MS = 30_000;
const AGENT_START_LOCK_POLL_MS = 250;
const FALLBACK_PORT_ATTEMPTS = 100;
const AGENT_LEASE_TTL_MS = 45_000;
const AGENT_LEASE_HEARTBEAT_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_FILE_TIMEOUT_MS = 60_000;
const MAX_FILE_TIMEOUT_MS = 300_000;
const DEFAULT_MONGODB_TIMEOUT_MS = 60_000;
const MAX_MONGODB_TIMEOUT_MS = 300_000;
const DEFAULT_MONGODB_MUTATION_TIMEOUT_MS = 120_000;
const MAX_MONGODB_MUTATION_TIMEOUT_MS = 600_000;
const DEFAULT_READ_MAX_BYTES = 256 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_APPROVED_COMMAND_TTL_MS = 30 * 60 * 1000;
const DEFAULT_APPROVED_EXECUTION_TIMEOUT_MS = 300_000;
const MAX_APPROVED_EXECUTION_TIMEOUT_MS = 900_000;
const DEFAULT_COMMAND_REVIEW_TIMEOUT_MS = 330_000;
const MAX_COMMAND_REVIEW_TIMEOUT_MS = 930_000;
const MAX_APPROVED_COMMAND_LENGTH = 16 * 1024;
const MAX_APPROVED_COMMANDS = 20;
const DEFAULT_ALLOWED_PATHS = ["/var/log", "/etc/nginx", "/home/app", "/root/.pm2", "/home/github"];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readPluginVersion() {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, ".codex-plugin", "plugin.json"), "utf8"),
    );
    return manifest.version || "unknown";
  } catch {
    return "unknown";
  }
}

const PLUGIN_VERSION = readPluginVersion();

function codexHomeDir() {
  return process.env.CODEX_HOME ||
    path.join(process.env.USERPROFILE || process.env.HOME || "", ".codex");
}

function marketplaceNameFromCachePath() {
  const parts = path.normalize(__dirname).split(path.sep);
  const cacheIndex = parts.lastIndexOf("cache");
  if (cacheIndex === -1 || cacheIndex + 1 >= parts.length) {
    return "";
  }

  return parts[cacheIndex + 1];
}

function readMarketplaceSource(marketplaceName) {
  if (!marketplaceName) {
    return "";
  }

  const configPath = path.join(codexHomeDir(), "config.toml");
  if (!fs.existsSync(configPath)) {
    return "";
  }

  const sectionNames = new Set([
    `[marketplaces.${marketplaceName}]`,
    `[marketplaces."${marketplaceName}"]`,
  ]);
  let inSection = false;

  for (const line of fs.readFileSync(configPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inSection = sectionNames.has(trimmed);
      continue;
    }

    if (!inSection) {
      continue;
    }

    const match = /^source\s*=\s*(['"])(.*)\1\s*$/.exec(trimmed);
    if (match) {
      return normalizeWindowsExtendedPath(match[2]);
    }
  }

  return "";
}

function resolveProjectRoot() {
  if (process.env.REMOTE_DEBUG_PROJECT_ROOT) {
    return path.resolve(normalizeWindowsExtendedPath(process.env.REMOTE_DEBUG_PROJECT_ROOT));
  }

  const marketplaceSource = readMarketplaceSource(marketplaceNameFromCachePath());
  if (marketplaceSource) {
    return path.resolve(marketplaceSource);
  }

  return path.resolve(__dirname, "..", "..");
}

const projectRoot = resolveProjectRoot();
let latestMigration = null;
let activeAgentSettings = null;
const leaseClientId = `codex-mcp-${process.pid}-${randomUUID()}`;
let activeAgentLease = null;
let activeAgentRecoveryPromise = null;
const inFlightToolCalls = new Map();

const toolOperationPolicies = {
  remote_debug_run_command: { defaultMs: DEFAULT_TIMEOUT_MS, maxMs: MAX_TIMEOUT_MS },
  remote_debug_read_file: { defaultMs: DEFAULT_FILE_TIMEOUT_MS, maxMs: MAX_FILE_TIMEOUT_MS },
  remote_debug_list_dir: { defaultMs: DEFAULT_FILE_TIMEOUT_MS, maxMs: MAX_FILE_TIMEOUT_MS },
  remote_debug_list_logs: { defaultMs: DEFAULT_FILE_TIMEOUT_MS, maxMs: MAX_FILE_TIMEOUT_MS },
  remote_debug_list_log_archive_members: {
    defaultMs: DEFAULT_FILE_TIMEOUT_MS,
    maxMs: MAX_FILE_TIMEOUT_MS,
  },
  remote_debug_read_log: { defaultMs: DEFAULT_FILE_TIMEOUT_MS, maxMs: MAX_FILE_TIMEOUT_MS },
  remote_debug_mongodb_query: {
    defaultMs: DEFAULT_MONGODB_TIMEOUT_MS,
    maxMs: MAX_MONGODB_TIMEOUT_MS,
  },
  remote_debug_mongodb_prepare_write: {
    defaultMs: DEFAULT_MONGODB_MUTATION_TIMEOUT_MS,
    maxMs: MAX_MONGODB_MUTATION_TIMEOUT_MS,
  },
  remote_debug_mongodb_prepare_index: {
    defaultMs: DEFAULT_MONGODB_MUTATION_TIMEOUT_MS,
    maxMs: MAX_MONGODB_MUTATION_TIMEOUT_MS,
  },
  remote_debug_mongodb_prepare_transaction: {
    defaultMs: DEFAULT_MONGODB_MUTATION_TIMEOUT_MS,
    maxMs: MAX_MONGODB_MUTATION_TIMEOUT_MS,
  },
  remote_debug_mongodb_execute_mutation: {
    defaultMs: DEFAULT_MONGODB_MUTATION_TIMEOUT_MS,
    maxMs: MAX_MONGODB_MUTATION_TIMEOUT_MS,
  },
  remote_debug_mongodb_rollback_mutation: {
    defaultMs: DEFAULT_MONGODB_MUTATION_TIMEOUT_MS,
    maxMs: MAX_MONGODB_MUTATION_TIMEOUT_MS,
  },
  remote_debug_mongodb_list_mutations: {
    defaultMs: DEFAULT_MONGODB_MUTATION_TIMEOUT_MS,
    maxMs: MAX_MONGODB_MUTATION_TIMEOUT_MS,
  },
  remote_debug_execute_command_draft: {
    defaultMs: DEFAULT_APPROVED_EXECUTION_TIMEOUT_MS,
    maxMs: MAX_APPROVED_EXECUTION_TIMEOUT_MS,
  },
  remote_debug_review_command_draft: {
    defaultMs: DEFAULT_COMMAND_REVIEW_TIMEOUT_MS,
    maxMs: MAX_COMMAND_REVIEW_TIMEOUT_MS,
  },
};

function normalizeToolTimeoutMs(toolName, value) {
  const policy = toolOperationPolicies[toolName] || {
    defaultMs: DEFAULT_TIMEOUT_MS,
    maxMs: MAX_FILE_TIMEOUT_MS,
  };
  if (value === undefined || value === null) {
    return policy.defaultMs;
  }
  if (!Number.isInteger(value) || value <= 0) {
    const error = new Error("timeoutMs must be a positive integer");
    error.code = "INVALID_TIMEOUT";
    throw error;
  }
  return Math.min(value, policy.maxMs);
}

function createToolOperation(toolName, args = {}) {
  const timeoutMs = normalizeToolTimeoutMs(toolName, args.timeoutMs);
  const controller = new AbortController();
  return {
    operationId: randomUUID(),
    timeoutMs,
    deadlineAt: Date.now() + timeoutMs,
    controller,
    signal: controller.signal,
  };
}

function toolOperationError(operation, code, message, phase, cause) {
  const error = new Error(message);
  error.code = code;
  error.operationId = operation?.operationId;
  error.layer = "mcp";
  error.phase = phase;
  error.retriable = !["OPERATION_CANCELLED", "OPERATION_DEADLINE_EXCEEDED"].includes(code);
  error.cause = cause?.message || cause;
  error.payload = {
    operationId: error.operationId,
    code,
    layer: error.layer,
    phase,
    retriable: error.retriable,
    cause: error.cause,
  };
  return error;
}

function cancelToolOperation(requestId, reason) {
  const operation = inFlightToolCalls.get(requestId);
  if (!operation || operation.signal.aborted) {
    return;
  }
  operation.controller.abort(
    toolOperationError(
      operation,
      "OPERATION_CANCELLED",
      "operation cancelled by MCP client",
      "cancel",
      reason,
    ),
  );
}

const instanceIdProperty = {
  type: "string",
  description:
    "Remote Debug Agent instance id. Optional only when exactly one instance is configured.",
};

function timeoutProperty(defaultMs, maxMs) {
  return {
    type: "integer",
    minimum: 1,
    maximum: maxMs,
    description: `Total operation budget in milliseconds, including queueing, connection, execution, and cleanup. Defaults to ${defaultMs}.`,
  };
}

const tools = [
  {
    name: "remote_debug_list_instances",
    description:
      "List configured Remote Debug Agent instances, their runtime status, and instance-specific source roots before choosing an instanceId.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {},
    },
  },
  {
    name: "remote_debug_get_capabilities",
    description:
      "Read the authoritative Remote Debug Agent security capabilities, policy version, command constraints, common approved paths, per-instance source roots, and limits. This performs no remote operation.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {},
    },
  },
  {
    name: "remote_debug_mongodb_query",
    description:
      "Run one bounded read-only MongoDB operation through the selected instance's SSH worker. The worker reads the configured remote application profile and uses its existing MongoDB driver; it never accepts arbitrary JavaScript or shell commands.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["operation"],
      properties: {
        operation: {
          type: "string",
          enum: [
            "ping",
            "listDatabases",
            "listCollections",
            "find",
            "findOne",
            "countDocuments",
            "aggregate",
          ],
          description: "Read-only MongoDB operation.",
        },
        instanceId: instanceIdProperty,
        database: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "Optional database name; defaults to the selected instance profile.",
        },
        collection: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "Collection name for find, findOne, countDocuments, or aggregate.",
        },
        filter: {
          type: "object",
          description: "MongoDB filter document. Extended JSON values are supported where the remote driver supports them.",
        },
        projection: {
          type: "object",
          description: "Optional projection document for find or findOne.",
        },
        sort: {
          type: "object",
          description: "Optional sort document for find.",
        },
        pipeline: {
          type: "array",
          maxItems: 20,
          items: { type: "object" },
          description: "Aggregation pipeline; write-like stages are rejected and a bounded limit is appended.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "Maximum number of returned documents or names. Defaults to 50.",
        },
        skip: {
          type: "integer",
          minimum: 0,
          maximum: 100000,
          description: "Number of matching documents to skip for find.",
        },
        timeoutMs: timeoutProperty(DEFAULT_MONGODB_TIMEOUT_MS, MAX_MONGODB_TIMEOUT_MS),
      },
    },
  },
  {
    name: "remote_debug_mongodb_prepare_write",
    description:
      "Prepare a bounded, structured MongoDB document mutation without changing data. Writes are disabled unless the selected instance explicitly enables MongoDB mutations and allowlists the database and collection. The returned mutationId and planHash are required for commit or rollback.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["operation", "collection"],
      properties: {
        operation: {
          type: "string",
          enum: ["insertOne", "updateOne", "updateMany", "softDeleteOne"],
          description: "Bounded document mutation operation.",
        },
        instanceId: instanceIdProperty,
        database: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "Allowlisted database name; defaults to the selected instance profile.",
        },
        collection: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "Allowlisted collection name.",
        },
        document: {
          type: "object",
          description: "Document for insertOne. It must contain an explicit _id.",
        },
        filter: {
          type: "object",
          description: "Document filter. updateOne and softDeleteOne require _id; updateMany requires _id.$in.",
        },
        update: {
          type: "object",
          description: "Only $set, $unset, and $inc are supported for updateOne/updateMany.",
        },
        deletedField: {
          type: "string",
          maxLength: 128,
          description: "Field set by softDeleteOne; defaults to deletedAt.",
        },
        deletedValue: {
          type: "string",
          maxLength: 128,
          description: "Optional value for deletedField; defaults to the prepare timestamp.",
        },
        maxAffected: {
          type: "integer",
          minimum: 1,
          maximum: 1000,
          description: "Maximum documents allowed for updateMany.",
        },
        expectedCount: {
          type: "integer",
          minimum: 1,
          maximum: 1000,
          description: "Optional exact match count required at commit time.",
        },
        rollbackTtlMs: {
          type: "integer",
          minimum: 1,
          maximum: 604800000,
          description: "Rollback retention window, capped by the instance policy.",
        },
        purpose: {
          type: "string",
          maxLength: 500,
          description: "Human-readable reason for the mutation; it is stored only as redacted metadata.",
        },
        timeoutMs: timeoutProperty(DEFAULT_MONGODB_MUTATION_TIMEOUT_MS, MAX_MONGODB_MUTATION_TIMEOUT_MS),
      },
    },
  },
  {
    name: "remote_debug_mongodb_prepare_index",
    description:
      "Prepare a bounded MongoDB index create or drop operation without changing data. Index changes are compensating operations, not part of a document transaction, and require explicit commit confirmation.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["operation", "collection", "name"],
      properties: {
        operation: {
          type: "string",
          enum: ["createIndex", "dropIndex"],
          description: "Index migration operation.",
        },
        instanceId: instanceIdProperty,
        database: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "Allowlisted database name; defaults to the selected instance profile.",
        },
        collection: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "Allowlisted collection name.",
        },
        name: {
          type: "string",
          pattern: "^[A-Za-z_][A-Za-z0-9_.-]{0,127}$",
          description: "Exact non-_id_ index name.",
        },
        key: {
          type: "object",
          description: "Index key document. Each direction must be 1 or -1.",
        },
        options: {
          type: "object",
          description: "Only unique, sparse, and expireAfterSeconds options are supported.",
        },
        rollbackTtlMs: {
          type: "integer",
          minimum: 1,
          maximum: 604800000,
          description: "Rollback retention window, capped by the instance policy.",
        },
        timeoutMs: timeoutProperty(DEFAULT_MONGODB_MUTATION_TIMEOUT_MS, MAX_MONGODB_MUTATION_TIMEOUT_MS),
      },
    },
  },
  {
    name: "remote_debug_mongodb_prepare_transaction",
    description:
      "Prepare up to 20 bounded MongoDB document mutations in one same-database transaction without changing data. Each child operation keeps its before-image so the committed transaction can be rolled back atomically.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["operations"],
      properties: {
        instanceId: instanceIdProperty,
        database: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "Allowlisted database shared by every child operation.",
        },
        operations: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["operation", "collection"],
            properties: {
              operation: {
                type: "string",
                enum: ["insertOne", "updateOne", "updateMany", "softDeleteOne"],
              },
              collection: { type: "string", minLength: 1, maxLength: 128 },
              document: { type: "object" },
              filter: { type: "object" },
              update: { type: "object" },
              deletedField: { type: "string", maxLength: 128 },
              deletedValue: { type: "string", maxLength: 128 },
              maxAffected: { type: "integer", minimum: 1, maximum: 1000 },
              expectedCount: { type: "integer", minimum: 1, maximum: 1000 },
            },
          },
          description: "Each child must be an allowlisted bounded document mutation.",
        },
        rollbackTtlMs: {
          type: "integer",
          minimum: 1,
          maximum: 604800000,
        },
        purpose: { type: "string", maxLength: 500 },
        timeoutMs: timeoutProperty(DEFAULT_MONGODB_MUTATION_TIMEOUT_MS, MAX_MONGODB_MUTATION_TIMEOUT_MS),
      },
    },
  },
  {
    name: "remote_debug_mongodb_execute_mutation",
    description:
      "Commit a prepared MongoDB document or index mutation. Requires the exact mutationId, planHash, and confirmation phrase 确认执行. Document mutations use a MongoDB transaction; index changes are verified compensating operations.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["mutationId", "planHash", "confirmation"],
      properties: {
        instanceId: instanceIdProperty,
        mutationId: { type: "string", minLength: 1, maxLength: 128 },
        planHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
        confirmation: { type: "string", enum: ["确认执行"] },
        timeoutMs: timeoutProperty(DEFAULT_MONGODB_MUTATION_TIMEOUT_MS, MAX_MONGODB_MUTATION_TIMEOUT_MS),
      },
    },
  },
  {
    name: "remote_debug_mongodb_rollback_mutation",
    description:
      "Rollback a committed MongoDB mutation by its immutable journal. Requires the exact mutationId, planHash, and confirmation phrase 确认回滚. Rollback stops with a conflict if the target changed after commit.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["mutationId", "planHash", "confirmation"],
      properties: {
        instanceId: instanceIdProperty,
        mutationId: { type: "string", minLength: 1, maxLength: 128 },
        planHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
        confirmation: { type: "string", enum: ["确认回滚"] },
        timeoutMs: timeoutProperty(DEFAULT_MONGODB_MUTATION_TIMEOUT_MS, MAX_MONGODB_MUTATION_TIMEOUT_MS),
      },
    },
  },
  {
    name: "remote_debug_mongodb_list_mutations",
    description:
      "List bounded MongoDB mutation journals on the selected instance without reading document before-images.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {
        instanceId: instanceIdProperty,
        status: {
          type: "string",
          enum: ["planned", "committed", "rolled_back", "commit_failed", "rollback_failed"],
          description: "Optional journal status filter.",
        },
        timeoutMs: timeoutProperty(DEFAULT_MONGODB_MUTATION_TIMEOUT_MS, MAX_MONGODB_MUTATION_TIMEOUT_MS),
      },
    },
  },
  {
    name: "remote_debug_restart_instance",
    description:
      "Recover one explicitly selected Remote Debug Agent instance only when it is stopped or unhealthy. A running instance is left unchanged and transitional states are rejected. The caller owns retry limits.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["instanceId"],
      properties: {
        instanceId: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "Exact Remote Debug Agent instance id returned by remote_debug_list_instances.",
        },
      },
    },
  },
  {
    name: "remote_debug_update_memory",
    description:
      "Persist a verified, redacted operational note in one instance's local memory. Use only when the user explicitly asks to remember or update instance facts; this does not execute a remote command.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["topic", "summary", "facts"],
      properties: {
        topic: {
          type: "string",
          pattern: "^[a-z0-9][a-z0-9._-]{0,63}$",
          description: "Stable lowercase note key such as database or deployment.",
        },
        summary: {
          type: "string",
          minLength: 1,
          maxLength: 2048,
          description: "Concise durable summary. Never include credentials or connection strings.",
        },
        facts: {
          type: "array",
          maxItems: 20,
          items: { type: "string", minLength: 1, maxLength: 512 },
          description: "Verified stable facts used by later diagnostics or approved-command drafts.",
        },
        instanceId: instanceIdProperty,
      },
    },
  },
  {
    name: "remote_debug_run_command",
    description:
      "Run a whitelisted read-only Linux diagnostic command through the local Remote Debug Agent.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["cmd"],
      properties: {
        cmd: {
          type: "string",
          description:
            "Command such as 'netstat -tlnp', 'systemctl status nginx', or 'tail -n 100 /var/log/nginx/error.log'.",
        },
        instanceId: instanceIdProperty,
        timeoutMs: timeoutProperty(30_000, 120_000),
      },
    },
  },
  {
    name: "remote_debug_read_file",
    description:
      "Read a remote file under the common approved paths or the selected instance's configured source roots through SFTP path checks.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: {
          type: "string",
          description: "Absolute remote file path.",
        },
        instanceId: instanceIdProperty,
        timeoutMs: timeoutProperty(60_000, 300_000),
        maxBytes: {
          type: "integer",
          minimum: 1,
          maximum: DEFAULT_READ_MAX_BYTES,
          description: `Maximum bytes to return. Defaults to ${DEFAULT_READ_MAX_BYTES}.`,
        },
      },
    },
  },
  {
    name: "remote_debug_list_dir",
    description:
      "List a remote directory under the common approved paths or the selected instance's configured source roots through SFTP path checks.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: {
          type: "string",
          description: "Absolute remote directory path.",
        },
        instanceId: instanceIdProperty,
        timeoutMs: timeoutProperty(60_000, 300_000),
      },
    },
  },
  {
    name: "remote_debug_list_logs",
    description:
      "Discover bounded, categorized remote logs under approved system, nginx, application, and PM2 paths. Large directories use cursor pagination and unsupported compressed or binary files remain visible with a readability reason.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {
        instanceId: instanceIdProperty,
        category: {
          type: "string",
          enum: ["all", "system", "nginx", "application", "pm2"],
          description: "Log category; defaults to all.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "Maximum log entries to return. Defaults to 200.",
        },
        cursor: {
          type: "string",
          maxLength: 4096,
          description: "Cursor returned by an earlier call for the same category.",
        },
        timeoutMs: timeoutProperty(60_000, 300_000),
      },
    },
  },
  {
    name: "remote_debug_list_log_archive_members",
    description:
      "List readable and non-readable members inside an approved .tar.gz or .tgz log archive without extracting it to the remote server.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: {
          type: "string",
          description: "Absolute remote .tar.gz or .tgz log archive path.",
        },
        prefix: {
          type: "string",
          maxLength: 512,
          description: "Optional safe relative member prefix.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 5000,
          description: "Maximum archive members to return. Defaults to 200.",
        },
        cursor: {
          type: "string",
          maxLength: 4096,
          description: "Cursor returned by an earlier archive-member listing call.",
        },
        instanceId: instanceIdProperty,
        timeoutMs: timeoutProperty(60_000, 300_000),
      },
    },
  },
  {
    name: "remote_debug_read_log",
    description:
      "Read the newest bounded lines from an approved plain or gzip log, or from a selected regular-file member of a .tar.gz/.tgz archive. Optional contains matching is line-based and case-insensitive by default.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: {
          type: "string",
          description: "Absolute remote log or log archive path.",
        },
        memberPath: {
          type: "string",
          maxLength: 4096,
          description: "Safe relative archive member path; required for tar.gz archives.",
        },
        tailLines: {
          type: "integer",
          minimum: 1,
          maximum: 2000,
          description: "Maximum newest matching lines. Defaults to 200.",
        },
        maxBytes: {
          type: "integer",
          minimum: 1,
          maximum: DEFAULT_READ_MAX_BYTES,
          description: `Maximum UTF-8 output bytes. Defaults to ${DEFAULT_READ_MAX_BYTES}.`,
        },
        contains: {
          type: "string",
          maxLength: 256,
          description: "Optional plain-text substring to match in each log line.",
        },
        caseSensitive: {
          type: "boolean",
          description: "Whether contains matching is case-sensitive; defaults to false.",
        },
        instanceId: instanceIdProperty,
        timeoutMs: timeoutProperty(60_000, 300_000),
      },
    },
  },
  {
    name: "remote_debug_prepare_command_draft",
    description:
      "Create a one-time approved-command draft. This only generates commands; it never executes them. Call remote_debug_review_command_draft immediately before deciding whether human confirmation is required.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["purpose", "commands"],
      properties: {
        purpose: {
          type: "string",
          description: "Why these remote commands are needed.",
        },
        commands: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
          description: "Exact remote shell commands to show to the user for approval.",
        },
        instanceId: instanceIdProperty,
      },
    },
  },
  {
    name: "remote_debug_get_command_draft",
    description:
      "View a previously generated approved-command draft, including the exact command block and command hash.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["draftId"],
      properties: {
        draftId: {
          type: "string",
          description: "The draftId returned by remote_debug_prepare_command_draft.",
        },
        instanceId: instanceIdProperty,
      },
    },
  },
  {
    name: "remote_debug_review_command_draft",
    description:
      "Review a generated command draft with the local security policy and Codex safety reviewer. Automatically executes only when both approval flags are enabled, every command passes the existing read-only policy, and Codex returns an explicit low-risk approval; otherwise returns the full draft and violation points for human review.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["draftId"],
      properties: {
        draftId: {
          type: "string",
          description: "The draftId returned by remote_debug_prepare_command_draft.",
        },
        instanceId: instanceIdProperty,
        timeoutMs: timeoutProperty(DEFAULT_COMMAND_REVIEW_TIMEOUT_MS, MAX_COMMAND_REVIEW_TIMEOUT_MS),
      },
    },
  },
  {
    name: "remote_debug_execute_command_draft",
    description:
      "Execute a one-time approved-command draft only after the user explicitly chooses 使用命令. Requires the exact draftId, commandHash, and confirmation phrase.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["draftId", "commandHash", "confirmation"],
      properties: {
        draftId: {
          type: "string",
          description: "The draftId returned by remote_debug_prepare_command_draft.",
        },
        commandHash: {
          type: "string",
          description: "The commandHash returned by remote_debug_prepare_command_draft.",
        },
        confirmation: {
          type: "string",
          description: "Must exactly equal 使用命令.",
        },
        instanceId: instanceIdProperty,
        timeoutMs: timeoutProperty(300_000, 900_000),
      },
    },
  },
];

function parseEnvFile(contents) {
  const parsed = {};

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
      if (line.includes("\"")) {
        value = value
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r")
          .replace(/\\t/g, "\t")
          .replace(/\\"/g, "\"");
      }
    } else {
      value = value.replace(/\s+#.*$/, "");
    }

    parsed[key] = value;
  }

  return parsed;
}

function readEnvFile(envPath) {
  if (!envPath || !fs.existsSync(envPath)) {
    return {};
  }

  return parseEnvFile(fs.readFileSync(envPath, "utf8"));
}

function loadDotEnv() {
  const dataDir = resolveDataDir(process.env);
  latestMigration = migrateLegacyData({
    legacyRoot: projectRoot,
    dataDir,
    env: process.env,
  });
  return readEnvFile(resolveConfigPath(process.env, dataDir));
}

function loadRemoteDebugEnv() {
  const env = { ...process.env };
  const dotEnv = loadDotEnv();

  for (const [key, value] of Object.entries(dotEnv)) {
    if (key.startsWith("REMOTE_DEBUG_")) {
      env[key] = value;
    }
  }

  return env;
}

function mergeEnvironment(...sources) {
  const merged = {};
  const keysByNormalizedName = new Map();

  for (const source of sources) {
    for (const [key, value] of Object.entries(source || {})) {
      if (value === undefined) {
        continue;
      }

      const normalizedKey = process.platform === "win32" ? key.toUpperCase() : key;
      const existingKey = keysByNormalizedName.get(normalizedKey);
      if (existingKey && existingKey !== key) {
        delete merged[existingKey];
      }

      merged[key] = String(value);
      keysByNormalizedName.set(normalizedKey, key);
    }
  }

  return merged;
}

function parsePositivePort(value, fallback) {
  if (value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    const error = new Error(`REMOTE_DEBUG_AGENT_PORT must be a valid TCP port: ${value}`);
    error.code = "INVALID_AGENT_PORT";
    throw error;
  }

  return parsed;
}

function parseSshPort(value) {
  if (value === undefined || value === "") {
    return DEFAULT_SSH_PORT;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    const error = new Error(`REMOTE_DEBUG_PORT must be a valid TCP port: ${value}`);
    error.code = "INVALID_SSH_PORT";
    throw error;
  }

  return parsed;
}

function parsePositiveInt(value, fallback) {
  if (value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBooleanFlag(value) {
  if (value === undefined || value === "") {
    return false;
  }

  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function publicTargetFromEnv(env) {
  return {
    host: env.REMOTE_DEBUG_HOST || "",
    port: parseSshPort(env.REMOTE_DEBUG_PORT),
    username: env.REMOTE_DEBUG_USER || "",
  };
}

function publicSecurityConfig(env = {}, dataDir = resolveDataDir(env)) {
  const approvedMaxTimeoutMs = parsePositiveInt(
    env.REMOTE_DEBUG_APPROVED_EXECUTION_MAX_TIMEOUT_MS,
    MAX_APPROVED_EXECUTION_TIMEOUT_MS,
  );
  const approvedDefaultTimeoutMs = Math.min(
    parsePositiveInt(
      env.REMOTE_DEBUG_APPROVED_EXECUTION_TIMEOUT_MS,
      DEFAULT_APPROVED_EXECUTION_TIMEOUT_MS,
    ),
    approvedMaxTimeoutMs,
  );

  return {
    allowedPaths: DEFAULT_ALLOWED_PATHS,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    maxTimeoutMs: MAX_TIMEOUT_MS,
    defaultFileTimeoutMs: DEFAULT_FILE_TIMEOUT_MS,
    maxFileTimeoutMs: MAX_FILE_TIMEOUT_MS,
    defaultReadMaxBytes: DEFAULT_READ_MAX_BYTES,
    maxCommandOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
    approvedCommands: {
      enabled: parseBooleanFlag(env.REMOTE_DEBUG_APPROVED_COMMANDS),
      ttlMs: DEFAULT_APPROVED_COMMAND_TTL_MS,
      executionTimeoutMs: approvedDefaultTimeoutMs,
      maxExecutionTimeoutMs: approvedMaxTimeoutMs,
      maxCommandLength: MAX_APPROVED_COMMAND_LENGTH,
      maxCommands: MAX_APPROVED_COMMANDS,
    },
    commandReview: {
      configPath:
        env.REMOTE_DEBUG_COMMAND_REVIEW_CONFIG_PATH ||
        path.resolve(dataDir, ".remote-debug", "command-review.json"),
      autoExecuteEnabled: parseBooleanFlag(env.REMOTE_DEBUG_COMMAND_REVIEW_AUTO_EXECUTE),
      refresh: parseBooleanFlag(env.REMOTE_DEBUG_COMMAND_REVIEW_REFRESH),
      reviewTimeoutMs: 30_000,
      maxRetries: 1,
    },
  };
}

function fingerprintConfigFromEnv(env, dataDir, port) {
  return {
    agent: {
      host: "127.0.0.1",
      port,
    },
    ssh: {
      host: env.REMOTE_DEBUG_HOST || "",
      port: parseSshPort(env.REMOTE_DEBUG_PORT),
      username: env.REMOTE_DEBUG_USER || "",
      privateKeyPath: env.REMOTE_DEBUG_PRIVATE_KEY_PATH || "",
      passphrase: env.REMOTE_DEBUG_PRIVATE_KEY_PASSPHRASE || "",
      readyTimeout: 10_000,
    },
    security: publicSecurityConfig(env, dataDir),
    audit: {
      logPath:
        env.REMOTE_DEBUG_AUDIT_LOG ||
        path.resolve(dataDir, ".remote-debug", "audit", "remote-debug-agent.jsonl"),
    },
  };
}

function configFingerprintFromEnv(env, dataDir, port) {
  return createHash("sha256")
    .update(JSON.stringify(fingerprintConfigFromEnv(env, dataDir, port)))
    .digest("hex");
}

function agentSettings() {
  const env = loadRemoteDebugEnv();
  const dataDir = resolveDataDir(process.env);
  const configPath = resolveConfigPath(process.env, dataDir);
  const explicitUrl = env.REMOTE_DEBUG_AGENT_URL || "";
  const port = parsePositivePort(env.REMOTE_DEBUG_AGENT_PORT, DEFAULT_AGENT_PORT);
  const agentUrl = explicitUrl || `http://127.0.0.1:${port}`;
  const explicitAgentDir = env.REMOTE_DEBUG_AGENT_DIR || "";
  const runtime = readRuntimeManifest(__dirname);
  if (!explicitUrl && !explicitAgentDir && !runtime.manifest) {
    const error = new Error(
      `Bundled Remote Debug Agent runtime was not found: ${runtime.manifestPath}`,
    );
    error.code = "BUNDLED_AGENT_NOT_FOUND";
    error.payload = { manifestPath: runtime.manifestPath };
    throw error;
  }
  const agentDir = path.resolve(
    explicitAgentDir || path.resolve(__dirname, "runtime", "agent"),
  );
  const runtimeId = explicitAgentDir
    ? env.REMOTE_DEBUG_RUNTIME_ID || `development:${PLUGIN_VERSION}`
    : runtime.manifest?.runtimeId || `external:${PLUGIN_VERSION}`;
  const serverFile = explicitAgentDir
    ? "server.js"
    : runtime.manifest?.server || "server.cjs";
  const workerFile = explicitAgentDir
    ? "worker-entry.js"
    : runtime.manifest?.worker || "worker-entry.cjs";
  const statePath = path.resolve(dataDir, ".runtime", "agent-state.json");
  const runtimeDir = path.resolve(dataDir, "logs");
  const target = publicTargetFromEnv(env);
  const configFingerprint = configFingerprintFromEnv(env, dataDir, port);
  const managerFingerprint = createHash("sha256")
    .update(JSON.stringify({ runtimeId, agentUrl, port, explicitUrl }))
    .digest("hex");

  return {
    env,
    dataDir,
    configPath,
    explicitUrl: Boolean(explicitUrl),
    agentUrl,
    port,
    preferredPort: port,
    target,
    configFingerprint,
    sourceFingerprint: managerFingerprint,
    runtimeId,
    agentDir,
    agentCwd: dataDir,
    serverPath: path.resolve(agentDir, serverFile),
    workerEntryPath: path.resolve(agentDir, workerFile),
    statePath,
    runtimeDir,
    logPath: path.resolve(runtimeDir, "mcp-error.log"),
  };
}

function agentSettingsWithPort(settings, port) {
  return {
    ...settings,
    agentUrl: `http://127.0.0.1:${port}`,
    port,
    configFingerprint: configFingerprintFromEnv(settings.env, settings.dataDir, port),
  };
}

async function appendPluginLog(settings, event) {
  const entry = {
    time: new Date().toISOString(),
    component: "mcp-server",
    pluginVersion: PLUGIN_VERSION,
    projectRoot,
    mcpServerPath: __filename,
    pid: process.pid,
    agentUrl: settings.agentUrl,
    port: settings.port,
    agentDir: settings.agentDir,
    dataDir: settings.dataDir,
    runtimeId: settings.runtimeId,
    migration: latestMigration,
    explicitAgentUrl: settings.explicitUrl,
    ...event,
  };

  try {
    await fsp.mkdir(settings.runtimeDir, { recursive: true });
    await fsp.appendFile(settings.logPath, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (error) {
    console.error("failed to write MCP runtime log", error);
  }
}

function fallbackLogSettings(error) {
  const dataDir = resolveDataDir(process.env);
  const runtimeDir = path.resolve(dataDir, "logs");

  return {
    agentUrl: "",
    port: null,
    agentDir: "",
    dataDir,
    explicitUrl: false,
    runtimeDir,
    logPath: path.resolve(runtimeDir, "mcp-error.log"),
    settingsError: {
      code: error?.code || "AGENT_SETTINGS_ERROR",
      message: error?.message || "failed to resolve Remote Debug Agent settings",
    },
  };
}

function logSettings() {
  try {
    return agentSettings();
  } catch (error) {
    return fallbackLogSettings(error);
  }
}

function toolArgumentSummary(name, args = {}) {
  if (name === "remote_debug_list_instances" || name === "remote_debug_get_capabilities") {
    return {};
  }

  if (name === "remote_debug_mongodb_query") {
    return {
      instanceId: typeof args.instanceId === "string" ? args.instanceId.slice(0, 128) : undefined,
      operation: typeof args.operation === "string" ? args.operation.slice(0, 64) : undefined,
      database: typeof args.database === "string" ? args.database.slice(0, 128) : undefined,
      collection: typeof args.collection === "string" ? args.collection.slice(0, 128) : undefined,
      filterKeys: args.filter && typeof args.filter === "object" && !Array.isArray(args.filter)
        ? Object.keys(args.filter).slice(0, 50)
        : [],
      pipelineLength: Array.isArray(args.pipeline) ? args.pipeline.length : 0,
      limit: args.limit,
      skip: args.skip,
      timeoutMs: args.timeoutMs,
    };
  }

  if (name === "remote_debug_mongodb_prepare_write") {
    return {
      instanceId: typeof args.instanceId === "string" ? args.instanceId.slice(0, 128) : undefined,
      operation: typeof args.operation === "string" ? args.operation.slice(0, 64) : undefined,
      database: typeof args.database === "string" ? args.database.slice(0, 128) : undefined,
      collection: typeof args.collection === "string" ? args.collection.slice(0, 128) : undefined,
      filterKeys: args.filter && typeof args.filter === "object" && !Array.isArray(args.filter)
        ? Object.keys(args.filter).slice(0, 20)
        : [],
      documentKeys: args.document && typeof args.document === "object" && !Array.isArray(args.document)
        ? Object.keys(args.document).slice(0, 50)
        : [],
      updateKeys: args.update && typeof args.update === "object" && !Array.isArray(args.update)
        ? Object.keys(args.update).slice(0, 20)
        : [],
      maxAffected: args.maxAffected,
      expectedCount: args.expectedCount,
      rollbackTtlMs: args.rollbackTtlMs,
      timeoutMs: args.timeoutMs,
    };
  }

  if (name === "remote_debug_mongodb_prepare_index") {
    return {
      instanceId: typeof args.instanceId === "string" ? args.instanceId.slice(0, 128) : undefined,
      operation: typeof args.operation === "string" ? args.operation.slice(0, 64) : undefined,
      database: typeof args.database === "string" ? args.database.slice(0, 128) : undefined,
      collection: typeof args.collection === "string" ? args.collection.slice(0, 128) : undefined,
      name: typeof args.name === "string" ? args.name.slice(0, 128) : undefined,
      keyFields: args.key && typeof args.key === "object" && !Array.isArray(args.key)
        ? Object.keys(args.key).slice(0, 20)
        : [],
      optionKeys: args.options && typeof args.options === "object" && !Array.isArray(args.options)
        ? Object.keys(args.options).slice(0, 20)
        : [],
      rollbackTtlMs: args.rollbackTtlMs,
      timeoutMs: args.timeoutMs,
    };
  }

  if (name === "remote_debug_mongodb_prepare_transaction") {
    return {
      instanceId: typeof args.instanceId === "string" ? args.instanceId.slice(0, 128) : undefined,
      database: typeof args.database === "string" ? args.database.slice(0, 128) : undefined,
      operationCount: Array.isArray(args.operations) ? args.operations.length : undefined,
      collections: Array.isArray(args.operations)
        ? [...new Set(args.operations.map((item) => item?.collection).filter((item) => typeof item === "string"))].slice(0, 20)
        : [],
      rollbackTtlMs: args.rollbackTtlMs,
      timeoutMs: args.timeoutMs,
    };
  }

  if (name === "remote_debug_mongodb_execute_mutation" || name === "remote_debug_mongodb_rollback_mutation") {
    return {
      instanceId: typeof args.instanceId === "string" ? args.instanceId.slice(0, 128) : undefined,
      mutationId: typeof args.mutationId === "string" ? args.mutationId.slice(0, 128) : undefined,
      planHash: typeof args.planHash === "string" ? args.planHash.slice(0, 128) : undefined,
      timeoutMs: args.timeoutMs,
    };
  }

  if (name === "remote_debug_mongodb_list_mutations") {
    return {
      instanceId: typeof args.instanceId === "string" ? args.instanceId.slice(0, 128) : undefined,
      status: typeof args.status === "string" ? args.status.slice(0, 64) : undefined,
      timeoutMs: args.timeoutMs,
    };
  }

  if (name === "remote_debug_restart_instance") {
    return {
      instanceId: typeof args.instanceId === "string" ? args.instanceId.slice(0, 128) : undefined,
    };
  }

  if (name === "remote_debug_update_memory") {
    return {
      instanceId: typeof args.instanceId === "string" ? args.instanceId.slice(0, 128) : undefined,
      topic: typeof args.topic === "string" ? args.topic.slice(0, 64) : undefined,
      factCount: Array.isArray(args.facts) ? args.facts.length : undefined,
    };
  }

  if (name === "remote_debug_run_command") {
    return {
      instanceId: typeof args.instanceId === "string" ? args.instanceId.slice(0, 128) : undefined,
      cmd: typeof args.cmd === "string" ? args.cmd.slice(0, 256) : undefined,
      timeoutMs: args.timeoutMs,
    };
  }

  if (name === "remote_debug_read_file") {
    return {
      instanceId: typeof args.instanceId === "string" ? args.instanceId.slice(0, 128) : undefined,
      path: typeof args.path === "string" ? args.path.slice(0, 512) : undefined,
      maxBytes: args.maxBytes,
      timeoutMs: args.timeoutMs,
    };
  }

  if (name === "remote_debug_list_dir") {
    return {
      instanceId: typeof args.instanceId === "string" ? args.instanceId.slice(0, 128) : undefined,
      path: typeof args.path === "string" ? args.path.slice(0, 512) : undefined,
      timeoutMs: args.timeoutMs,
    };
  }

  if (name === "remote_debug_list_logs") {
    return {
      instanceId: typeof args.instanceId === "string" ? args.instanceId.slice(0, 128) : undefined,
      category: typeof args.category === "string" ? args.category.slice(0, 32) : undefined,
      limit: args.limit,
      hasCursor: typeof args.cursor === "string" && args.cursor.length > 0,
      timeoutMs: args.timeoutMs,
    };
  }

  if (name === "remote_debug_list_log_archive_members") {
    return {
      instanceId: typeof args.instanceId === "string" ? args.instanceId.slice(0, 128) : undefined,
      path: typeof args.path === "string" ? args.path.slice(0, 512) : undefined,
      prefix: typeof args.prefix === "string" ? args.prefix.slice(0, 128) : undefined,
      limit: args.limit,
      hasCursor: typeof args.cursor === "string" && args.cursor.length > 0,
      timeoutMs: args.timeoutMs,
    };
  }

  if (name === "remote_debug_read_log") {
    return {
      instanceId: typeof args.instanceId === "string" ? args.instanceId.slice(0, 128) : undefined,
      path: typeof args.path === "string" ? args.path.slice(0, 512) : undefined,
      memberPath: typeof args.memberPath === "string" ? args.memberPath.slice(0, 256) : undefined,
      tailLines: args.tailLines,
      maxBytes: args.maxBytes,
      contains: typeof args.contains === "string" ? args.contains.slice(0, 128) : undefined,
      caseSensitive: args.caseSensitive === true,
      timeoutMs: args.timeoutMs,
    };
  }

  if (name === "remote_debug_prepare_command_draft") {
    return {
      instanceId: typeof args.instanceId === "string" ? args.instanceId.slice(0, 128) : undefined,
      purpose: typeof args.purpose === "string" ? args.purpose.slice(0, 256) : undefined,
      commandCount: Array.isArray(args.commands) ? args.commands.length : undefined,
    };
  }

  if (name === "remote_debug_get_command_draft") {
    return {
      instanceId: typeof args.instanceId === "string" ? args.instanceId.slice(0, 128) : undefined,
      draftId: typeof args.draftId === "string" ? args.draftId.slice(0, 128) : undefined,
    };
  }

  if (name === "remote_debug_execute_command_draft") {
    return {
      instanceId: typeof args.instanceId === "string" ? args.instanceId.slice(0, 128) : undefined,
      draftId: typeof args.draftId === "string" ? args.draftId.slice(0, 128) : undefined,
      commandHash: typeof args.commandHash === "string" ? args.commandHash.slice(0, 128) : undefined,
      timeoutMs: args.timeoutMs,
    };
  }

  return {
    keys: Object.keys(args).slice(0, 20),
  };
}

async function logMcpLifecycle(code, message, event = {}) {
  const settings = logSettings();
  const details = {
    level: "info",
    code,
    message,
    settingsError: settings.settingsError,
    ...event,
  };

  await appendPluginLog(settings, details);
}

let outputFraming = "content-length";

function sendMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (outputFraming === "json-line") {
    process.stdout.write(`${body.toString("utf8")}\n`);
    return;
  }

  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function sendResult(id, result) {
  sendMessage({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  sendMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

function protocolVersionFor(params) {
  return typeof params?.protocolVersion === "string" && params.protocolVersion
    ? params.protocolVersion
    : DEFAULT_PROTOCOL_VERSION;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const upstreamSignal = options.signal;
  const abortFromUpstream = () => {
    if (!controller.signal.aborted) {
      controller.abort(upstreamSignal.reason || new Error("request cancelled"));
    }
  };
  if (upstreamSignal?.aborted) abortFromUpstream();
  else upstreamSignal?.addEventListener("abort", abortFromUpstream, { once: true });
  const timer = setTimeout(() => {
    const error = new Error("request timeout");
    error.code = "FETCH_TIMEOUT";
    controller.abort(error);
  }, options.timeoutMs ?? PROBE_TIMEOUT_MS);

  try {
    const { timeoutMs: _timeoutMs, ...fetchOptions } = options;
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed;

    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { ok: false, raw: text };
    }

    return { response, parsed };
  } finally {
    clearTimeout(timer);
    upstreamSignal?.removeEventListener("abort", abortFromUpstream);
  }
}

function leasePayload() {
  return {
    clientId: leaseClientId,
    ttlMs: AGENT_LEASE_TTL_MS,
    source: "codex-plugin",
    pid: process.pid,
  };
}

async function renewAgentLease(settings, phase) {
  try {
    const { response, parsed } = await fetchJson(new URL("/api/leases", settings.agentUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Remote-Debug-Source": "codex-plugin",
      },
      body: JSON.stringify(leasePayload()),
      timeoutMs: PROBE_TIMEOUT_MS,
    });

    if (!response.ok || parsed.ok === false) {
      throw new Error(parsed.error?.message || `lease request failed with HTTP ${response.status}`);
    }

    return true;
  } catch (error) {
    await appendPluginLog(settings, {
      level: "warn",
      code: "AGENT_LEASE_RENEW_FAILED",
      message: `Remote Debug Agent lease ${phase} failed: ${error.message}`,
    });
    return false;
  }
}

async function releaseAgentLease(lease = activeAgentLease) {
  if (!lease) {
    return;
  }

  if (lease.timer) {
    clearInterval(lease.timer);
  }

  if (!lease.settings.explicitUrl) {
    try {
      await fetchJson(new URL(`/api/leases/${encodeURIComponent(leaseClientId)}`, lease.settings.agentUrl), {
        method: "DELETE",
        headers: {
          "X-Remote-Debug-Source": "codex-plugin",
        },
        timeoutMs: PROBE_TIMEOUT_MS,
      });
    } catch {
      // Lease expiry is the fallback when best-effort release is not delivered.
    }
  }

  if (activeAgentLease === lease) {
    activeAgentLease = null;
  }
}

async function syncAgentLease(settings) {
  if (settings.explicitUrl) {
    await releaseAgentLease();
    return;
  }

  const sameLease =
    activeAgentLease &&
    activeAgentLease.settings.agentUrl === settings.agentUrl &&
    activeAgentLease.settings.sourceFingerprint === settings.sourceFingerprint;

  if (!sameLease) {
    await releaseAgentLease();
    activeAgentLease = {
      settings,
      timer: null,
    };
    await renewAgentLease(settings, "registration");
    activeAgentLease.timer = setInterval(() => {
      renewAgentLease(settings, "heartbeat")
        .then((ok) => {
          if (!ok) {
            return recoverAgentLease(settings, "heartbeat");
          }
          return null;
        })
        .catch((error) => {
          console.error("failed to recover Remote Debug Agent lease", error);
        });
    }, AGENT_LEASE_HEARTBEAT_MS);
    activeAgentLease.timer.unref?.();
    return;
  }

  await renewAgentLease(settings, "ensure");
}

async function activateAgentSettings(settings) {
  activeAgentSettings = settings;
  await syncAgentLease(settings);
  return settings;
}

function isConnectionRefused(error) {
  const code = error?.cause?.code || error?.code;
  return code === "ECONNREFUSED" || code === "ENOENT";
}

async function probeAgent(settings) {
  try {
    const { response, parsed } = await fetchJson(new URL("/status", settings.agentUrl));
    if (parsed?.name === "remote-debug-agent") {
      return { kind: "agent", response, status: parsed };
    }

    return { kind: "occupied", response, status: parsed };
  } catch (error) {
    if (isConnectionRefused(error)) {
      return { kind: "unreachable", error };
    }

    return { kind: "occupied", error };
  }
}

function agentStatusIsHealthy(status, settings) {
  const agentPort = status?.agent?.port;
  const portMatches = settings.explicitUrl || agentPort === undefined || agentPort === settings.port;
  const runtimeMatches =
    settings.explicitUrl || status?.agent?.runtimeId === settings.runtimeId;
  const capabilities = status?.capabilities || {};

  return Boolean(
    status?.name === "remote-debug-agent" &&
      status?.mode === "manager" &&
      status?.apiVersion === AGENT_API_VERSION &&
      capabilities.persistentSsh === true &&
      capabilities.operationDeadlines === true &&
      capabilities.cancellation === true &&
      capabilities.structuredHealth === true &&
      runtimeMatches &&
      portMatches,
  );
}

function agentSourceMatches(settings, currentSettings) {
  return settings?.sourceFingerprint === currentSettings?.sourceFingerprint;
}

function statusSummary(status) {
  return {
    pid: status?.agent?.pid,
    port: status?.agent?.port,
    configFingerprint: status?.agent?.configFingerprint,
    runtimeId: status?.agent?.runtimeId,
    target: status?.target,
  };
}

function expectedSummary(settings) {
  return {
    port: settings.port,
    preferredPort: settings.preferredPort,
    configFingerprint: settings.configFingerprint,
    sourceFingerprint: settings.sourceFingerprint,
    runtimeId: settings.runtimeId,
    target: settings.target,
  };
}

async function logAgentConfigChanged(settings, status, previousSettings) {
  await appendPluginLog(settings, {
    level: "warn",
    code: "AGENT_CONFIG_CHANGED",
    message: "Remote Debug Agent configuration changed; restarting local agent.",
    previous: previousSettings ? expectedSummary(previousSettings) : undefined,
    actual: statusSummary(status),
    expected: expectedSummary(settings),
  });
}

async function stopStaleAgent(settings, status, currentSettings) {
  try {
    await stopConfirmedAgent(
      settings,
      status,
      "Stopping stale Remote Debug Agent after configuration change.",
    );
    return true;
  } catch (error) {
    await appendPluginLog(currentSettings, {
      level: "warn",
      code: error.code || "AGENT_RESTART_UNSAFE",
      message: `Skipping stale Remote Debug Agent stop: ${error.message}`,
      details: error.payload,
    });

    if (settings.port === currentSettings.port) {
      throw error;
    }

    return false;
  }
}

async function readState(settings) {
  try {
    return JSON.parse(await fsp.readFile(settings.statePath, "utf8"));
  } catch {
    return null;
  }
}

function execFileText(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true }, (error, stdout) => {
      resolve(error ? "" : stdout);
    });
  });
}

async function findListeningPid(port) {
  if (process.platform === "win32") {
    const output = await execFileText("netstat", ["-ano", "-p", "tcp"]);
    for (const line of output.split(/\r?\n/)) {
      if (!line.includes("LISTENING")) continue;

      const parts = line.trim().split(/\s+/);
      const localAddress = parts[1] || "";
      const pid = Number.parseInt(parts[4], 10);
      if (localAddress.endsWith(`:${port}`) && Number.isInteger(pid)) {
        return pid;
      }
    }
  } else {
    const output = await execFileText("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
    const pid = Number.parseInt(output.trim().split(/\s+/)[0], 10);
    if (Number.isInteger(pid)) {
      return pid;
    }
  }

  return null;
}

async function stopConfirmedAgent(settings, status, reason = "Stopping unhealthy Remote Debug Agent before restart.") {
  const state = await readState(settings);
  const pid =
    status?.agent?.pid ||
    (state?.name === "remote-debug-agent" && state?.port === settings.port ? state.pid : null) ||
    (await findListeningPid(settings.port));

  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    const error = new Error("Remote Debug Agent is unhealthy, but no safe local pid was found to restart it.");
    error.code = "AGENT_RESTART_UNSAFE";
    error.payload = { agentUrl: settings.agentUrl, port: settings.port, status, state };
    throw error;
  }

  await appendPluginLog(settings, {
    level: "warn",
    code: "AGENT_RESTARTING",
    message: reason,
    pid,
  });
  process.kill(pid);

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const probe = await probeAgent(settings);
    if (probe.kind === "unreachable") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function agentStartLockPath(settings) {
  const hash = createHash("sha256")
    .update(JSON.stringify({
      agentUrl: settings.agentUrl,
      sourceFingerprint: settings.sourceFingerprint,
    }))
    .digest("hex");
  return path.resolve(settings.runtimeDir, `agent-start-${hash}.lock`);
}

async function readAgentStartLock(lockPath) {
  try {
    return JSON.parse(await fsp.readFile(lockPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    return {
      lockId: "",
      createdAt: null,
      readError: {
        code: error.code || "AGENT_START_LOCK_READ_ERROR",
        message: error.message,
      },
    };
  }
}

function summarizeAgentStartLock(lock) {
  if (!lock) {
    return null;
  }
  return {
    lockId: lock.lockId || "",
    mcpPid: Number.isInteger(lock.mcpPid) ? lock.mcpPid : null,
    agentUrl: lock.agentUrl || "",
    serverPath: lock.serverPath || "",
    reason: lock.reason || "",
    createdAt: lock.createdAt || null,
    readError: lock.readError || undefined,
  };
}

function agentStartLockAgeMs(lock) {
  const createdAtMs = Date.parse(lock?.createdAt || "");
  if (Number.isNaN(createdAtMs)) {
    return Number.POSITIVE_INFINITY;
  }
  return Date.now() - createdAtMs;
}

async function acquireAgentStartLock(settings, reason, startupAttemptId) {
  await fsp.mkdir(settings.runtimeDir, { recursive: true });
  const lockPath = agentStartLockPath(settings);
  const lock = {
    lockId: startupAttemptId,
    mcpPid: process.pid,
    agentUrl: settings.agentUrl,
    serverPath: settings.serverPath,
    reason,
    createdAt: new Date().toISOString(),
  };

  try {
    const handle = await fsp.open(lockPath, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(lock, null, 2)}\n`, "utf8");
    } finally {
      await handle.close();
    }
    await appendPluginLog(settings, {
      level: "info",
      code: "AGENT_START_LOCK_ACQUIRED",
      message: "Acquired Remote Debug Agent startup lock.",
      startupAttemptId,
      lockPath,
      lock: summarizeAgentStartLock(lock),
    });
    return { acquired: true, lockPath, lock };
  } catch (error) {
    if (error?.code !== "EEXIST") {
      await appendPluginLog(settings, {
        level: "error",
        code: "AGENT_START_LOCK_FAILED",
        message: `Remote Debug Agent startup lock could not be acquired: ${error.message}`,
        startupAttemptId,
        lockPath,
        details: {
          code: error.code || "AGENT_START_LOCK_ERROR",
          message: error.message,
        },
      });
      throw error;
    }

    const currentLock = await readAgentStartLock(lockPath);
    await appendPluginLog(settings, {
      level: "info",
      code: "AGENT_START_LOCK_WAITING",
      message: "Waiting for another MCP process to start Remote Debug Agent.",
      startupAttemptId,
      lockPath,
      lock: summarizeAgentStartLock(currentLock),
      lockAgeMs: agentStartLockAgeMs(currentLock),
    });
    return { acquired: false, lockPath, lock: currentLock };
  }
}

async function releaseAgentStartLock(settings, lockPath, startupAttemptId) {
  const currentLock = await readAgentStartLock(lockPath);
  if (currentLock?.lockId !== startupAttemptId) {
    return;
  }

  await fsp.rm(lockPath, { force: true });
  await appendPluginLog(settings, {
    level: "info",
    code: "AGENT_START_LOCK_RELEASED",
    message: "Released Remote Debug Agent startup lock.",
    startupAttemptId,
    lockPath,
  });
}

async function markAgentStartLockStale(settings, lockPath, lock, startupAttemptId) {
  await fsp.rm(lockPath, { force: true });
  await appendPluginLog(settings, {
    level: "warn",
    code: "AGENT_START_LOCK_STALE",
    message: "Remote Debug Agent startup lock was stale and has been cleared.",
    startupAttemptId,
    lockPath,
    lock: summarizeAgentStartLock(lock),
    lockAgeMs: agentStartLockAgeMs(lock),
  });
}

async function logAgentReadyAfterLockWait(settings, startupAttemptId, status) {
  await appendPluginLog(settings, {
    level: "info",
    code: "AGENT_READY",
    message: "Remote Debug Agent is ready after waiting for startup lock.",
    startupAttemptId,
    waitedForStartLock: true,
    pid: status?.agent?.pid,
  });
}

async function startAgent(settings, reason, startupAttemptId = randomUUID()) {
  if (!fs.existsSync(settings.serverPath)) {
    const error = new Error(`Remote Debug Agent server not found: ${settings.serverPath}`);
    error.code = settings.env.REMOTE_DEBUG_AGENT_DIR
      ? "AGENT_SERVER_NOT_FOUND"
      : "BUNDLED_AGENT_NOT_FOUND";
    error.payload = { agentDir: settings.agentDir, serverPath: settings.serverPath };
    throw error;
  }

  await appendPluginLog(settings, {
    level: "info",
    code: "AGENT_STARTING",
    message: reason,
    startupAttemptId,
    serverPath: settings.serverPath,
  });

  let child;
  try {
    child = spawn(process.execPath, [settings.serverPath], {
      cwd: settings.agentCwd,
      detached: true,
      env: mergeEnvironment(process.env, settings.env, {
        REMOTE_DEBUG_AGENT_PORT: String(settings.port),
        REMOTE_DEBUG_AGENT_LIFETIME: "desktop",
        REMOTE_DEBUG_PROJECT_ROOT: settings.dataDir,
        REMOTE_DEBUG_RUNTIME_ID: settings.runtimeId,
        REMOTE_DEBUG_WORKER_ENTRY_PATH: settings.workerEntryPath,
        REMOTE_DEBUG_AUDIT_LOG:
          settings.env.REMOTE_DEBUG_AUDIT_LOG ||
          path.resolve(
            settings.dataDir,
            ".remote-debug",
            "audit",
            "remote-debug-agent.jsonl",
          ),
      }),
      stdio: "ignore",
      windowsHide: true,
    });
  } catch (error) {
    const wrapped = new Error(`Remote Debug Agent process could not be spawned: ${error.message}`);
    wrapped.code = "AGENT_SPAWN_FAILED";
    wrapped.payload = {
      serverPath: settings.serverPath,
      agentDir: settings.agentDir,
      spawnError: {
        code: error.code,
        message: error.message,
      },
    };
    await appendPluginLog(settings, {
      level: "error",
      code: wrapped.code,
      message: wrapped.message,
      startupAttemptId,
      details: wrapped.payload,
    });
    throw wrapped;
  }

  let agentReady = false;
  let spawnError = null;
  let childExit = null;

  child.once("error", (error) => {
    spawnError = {
      code: error.code,
      message: error.message,
    };
    appendPluginLog(settings, {
      level: "error",
      code: "AGENT_SPAWN_ERROR",
      message: `Remote Debug Agent process emitted an error: ${error.message}`,
      startupAttemptId,
      details: {
        serverPath: settings.serverPath,
        agentDir: settings.agentDir,
        error: spawnError,
      },
    }).catch((logError) => {
      console.error("failed to write MCP spawn error log", logError);
    });
  });

  child.once("exit", (code, signal) => {
    childExit = {
      pid: child.pid,
      code,
      signal,
    };
    appendPluginLog(settings, {
      level: agentReady ? "warn" : "error",
      code: "AGENT_PROCESS_EXITED",
      message: agentReady
        ? "Remote Debug Agent process exited after readiness."
        : "Remote Debug Agent process exited before readiness.",
      startupAttemptId,
      details: childExit,
    }).catch((logError) => {
      console.error("failed to write MCP process exit log", logError);
    });
  });

  child.unref();

  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastProbe;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (spawnError || childExit) {
      break;
    }

    lastProbe = await probeAgent(settings);
    if (lastProbe.kind === "agent" && agentStatusIsHealthy(lastProbe.status, settings)) {
      agentReady = true;
      await appendPluginLog(settings, {
        level: "info",
        code: "AGENT_READY",
        message: "Remote Debug Agent is ready.",
        startupAttemptId,
        pid: lastProbe.status?.agent?.pid,
      });
      return;
    }
    if (lastProbe.kind === "occupied") {
      break;
    }
  }

  const state = await readState(settings);
  const error = new Error(`Remote Debug Agent did not become ready at ${settings.agentUrl}`);
  error.code = "AGENT_START_FAILED";
  error.payload = {
    agentUrl: settings.agentUrl,
    port: settings.port,
    lastProbe,
    spawnError,
    childExit,
    lastError: state?.lastError,
  };
  await appendPluginLog(settings, {
    level: "error",
    code: error.code,
    message: error.message,
    startupAttemptId,
    details: error.payload,
  });
  throw error;
}

async function startAgentWithLock(settings, reason) {
  const startupAttemptId = randomUUID();

  while (true) {
    const readyProbe = await probeAgent(settings);
    if (readyProbe.kind === "agent" && agentStatusIsHealthy(readyProbe.status, settings)) {
      await logAgentReadyAfterLockWait(settings, startupAttemptId, readyProbe.status);
      return;
    }

    const lockAttempt = await acquireAgentStartLock(settings, reason, startupAttemptId);
    if (lockAttempt.acquired) {
      try {
        const probeAfterLock = await probeAgent(settings);
        if (probeAfterLock.kind === "agent" && agentStatusIsHealthy(probeAfterLock.status, settings)) {
          await logAgentReadyAfterLockWait(settings, startupAttemptId, probeAfterLock.status);
          return;
        }
        await startAgent(settings, reason, startupAttemptId);
        return;
      } finally {
        await releaseAgentStartLock(settings, lockAttempt.lockPath, startupAttemptId);
      }
    }

    let currentLock = lockAttempt.lock;
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, AGENT_START_LOCK_POLL_MS));

      const probe = await probeAgent(settings);
      if (probe.kind === "agent" && agentStatusIsHealthy(probe.status, settings)) {
        await logAgentReadyAfterLockWait(settings, startupAttemptId, probe.status);
        return;
      }

      currentLock = await readAgentStartLock(lockAttempt.lockPath);
      if (!currentLock) {
        break;
      }

      if (agentStartLockAgeMs(currentLock) > AGENT_START_LOCK_TTL_MS) {
        await markAgentStartLockStale(settings, lockAttempt.lockPath, currentLock, startupAttemptId);
        break;
      }
    }
  }
}

async function resolveFallbackAgentSettings(settings, initialProbe) {
  const attempted = [];
  const endPort = Math.min(65535, settings.port + FALLBACK_PORT_ATTEMPTS);

  await appendPluginLog(settings, {
    level: "warn",
    code: "AGENT_PORT_OCCUPIED",
    message: "Configured Remote Debug Agent port is occupied; looking for a fallback port.",
    details: {
      port: settings.port,
      agentUrl: settings.agentUrl,
      status: initialProbe.status,
      error: initialProbe.error?.message,
      fallbackStartPort: settings.port + 1,
      fallbackEndPort: endPort,
    },
  });

  for (let port = settings.port + 1; port <= endPort; port += 1) {
    const candidate = agentSettingsWithPort(settings, port);
    const probe = await probeAgent(candidate);

    if (probe.kind === "unreachable") {
      await appendPluginLog(candidate, {
        level: "info",
        code: "AGENT_FALLBACK_PORT_SELECTED",
        message: "Selected fallback Remote Debug Agent port.",
        preferredPort: settings.port,
        port,
      });
      return { settings: candidate, action: "start" };
    }

    if (probe.kind === "agent" && agentStatusIsHealthy(probe.status, candidate)) {
      await appendPluginLog(candidate, {
        level: "info",
        code: "AGENT_FALLBACK_REUSED",
        message: "Reusing healthy Remote Debug Agent on fallback port.",
        preferredPort: settings.port,
        port,
        pid: probe.status?.agent?.pid,
      });
      return { settings: candidate, action: "reuse" };
    }

    attempted.push({
      port,
      kind: probe.kind,
      statusName: probe.status?.name,
      error: probe.error?.message,
    });
  }

  const error = new Error(
    `Port ${settings.port} is occupied and no fallback Remote Debug Agent port is available.`,
  );
  error.code = "AGENT_PORT_OCCUPIED";
  error.payload = {
    agentUrl: settings.agentUrl,
    port: settings.port,
    status: initialProbe.status,
    error: initialProbe.error?.message,
    fallbackStartPort: settings.port + 1,
    fallbackEndPort: endPort,
    attempted,
  };
  await appendPluginLog(settings, {
    level: "error",
    code: error.code,
    message: error.message,
    details: error.payload,
  });
  throw error;
}

async function performEnsureAgentReady() {
  const settings = agentSettings();
  if (settings.explicitUrl) {
    const probe = await probeAgent(settings);
    if (!agentStatusIsHealthy(probe.status, settings)) {
      const error = new Error(
        `Remote Debug Agent at ${settings.agentUrl} does not implement the required V2 protocol.`,
      );
      error.code = probe.kind === "unreachable"
        ? "AGENT_UNAVAILABLE"
        : "AGENT_PROTOCOL_MISMATCH";
      error.payload = {
        agentUrl: settings.agentUrl,
        expectedApiVersion: AGENT_API_VERSION,
        actualApiVersion: probe.status?.apiVersion,
        status: probe.status,
      };
      throw error;
    }
    if (
      !activeAgentSettings ||
      activeAgentSettings.agentUrl !== settings.agentUrl ||
      activeAgentSettings.sourceFingerprint !== settings.sourceFingerprint
    ) {
      await appendPluginLog(settings, {
        level: "info",
        code: "AGENT_EXTERNAL_URL",
        message: "External Remote Debug Agent URL configured; skipping local restart management.",
      });
    }
    return activateAgentSettings(settings);
  }

  if (activeAgentSettings) {
    const activeProbe = await probeAgent(activeAgentSettings);
    const sameSource = agentSourceMatches(activeAgentSettings, settings);

    if (
      activeProbe.kind === "agent" &&
      sameSource &&
      agentStatusIsHealthy(activeProbe.status, activeAgentSettings)
    ) {
      return activateAgentSettings(activeAgentSettings);
    }

    if (activeProbe.kind === "agent") {
      const previousSettings = activeAgentSettings;
      if (!sameSource) {
        await logAgentConfigChanged(settings, activeProbe.status, previousSettings);
        await stopStaleAgent(previousSettings, activeProbe.status, settings);
        activeAgentSettings = null;
      } else {
        await appendPluginLog(previousSettings, {
          level: "warn",
          code: "AGENT_UNHEALTHY",
          message: "Fallback Remote Debug Agent responded but does not match the configured target.",
          status: activeProbe.status,
          expected: expectedSummary(previousSettings),
        });
        await stopConfirmedAgent(previousSettings, activeProbe.status);
        await startAgentWithLock(previousSettings, "Restarting unhealthy fallback Remote Debug Agent.");
        return activateAgentSettings(previousSettings);
      }
    } else {
      activeAgentSettings = null;
    }
  }

  const probe = await probeAgent(settings);
  if (probe.kind === "agent" && agentStatusIsHealthy(probe.status, settings)) {
    return activateAgentSettings(settings);
  }

  if (probe.kind === "agent") {
    if (probe.status?.agent?.configFingerprint !== settings.configFingerprint) {
      await logAgentConfigChanged(settings, probe.status, null);
      await stopStaleAgent(settings, probe.status, settings);
    } else {
      await appendPluginLog(settings, {
        level: "warn",
        code: "AGENT_UNHEALTHY",
        message: "Remote Debug Agent responded but does not match the configured target.",
        status: probe.status,
        expected: expectedSummary(settings),
      });
      await stopConfirmedAgent(settings, probe.status);
    }
    await startAgentWithLock(settings, "Restarting unhealthy Remote Debug Agent.");
    return activateAgentSettings(settings);
  }

  if (probe.kind === "unreachable") {
    await startAgentWithLock(settings, "Starting missing Remote Debug Agent.");
    return activateAgentSettings(settings);
  }

  const fallback = await resolveFallbackAgentSettings(settings, probe);
  if (fallback.action === "start") {
    await startAgentWithLock(fallback.settings, "Starting Remote Debug Agent on fallback port.");
  }
  return activateAgentSettings(fallback.settings);
}

let ensureAgentReadyPromise = null;

function ensureAgentReady() {
  if (!ensureAgentReadyPromise) {
    ensureAgentReadyPromise = performEnsureAgentReady().finally(() => {
      ensureAgentReadyPromise = null;
    });
  }

  return ensureAgentReadyPromise;
}

function recoverAgentLease(settings, phase) {
  if (settings.explicitUrl) {
    return Promise.resolve(null);
  }

  if (!activeAgentRecoveryPromise) {
    activeAgentRecoveryPromise = (async () => {
      await appendPluginLog(settings, {
        level: "info",
        code: "AGENT_LEASE_RECOVERY_STARTED",
        message: `Recovering Remote Debug Agent after lease ${phase} failure.`,
      });

      const recoveredSettings = await ensureAgentReady();
      await appendPluginLog(recoveredSettings, {
        level: "info",
        code: "AGENT_LEASE_RECOVERY_READY",
        message: "Remote Debug Agent recovered after lease failure.",
      });
      return recoveredSettings;
    })()
      .catch(async (error) => {
        await appendPluginLog(settings, {
          level: "error",
          code: "AGENT_LEASE_RECOVERY_FAILED",
          message: `Remote Debug Agent lease recovery failed: ${error.message}`,
          details: {
            code: error.code,
            payload: error.payload,
          },
        });
        throw error;
      })
      .finally(() => {
        activeAgentRecoveryPromise = null;
      });
  }

  return activeAgentRecoveryPromise;
}

function scheduleAgentPrewarm(trigger) {
  let settings;
  try {
    settings = agentSettings();
  } catch (error) {
    console.error(`failed to resolve Remote Debug Agent settings during ${trigger}: ${error.message}`);
    const fallbackSettings = fallbackLogSettings(error);
    appendPluginLog(fallbackSettings, {
      level: "error",
      code: error.code || "AGENT_PREWARM_SETTINGS_FAILED",
      message: `Remote Debug Agent prewarm could not resolve settings during ${trigger}: ${error.message}`,
      details: fallbackSettings.settingsError,
    }).catch((logError) => {
      console.error("failed to write MCP prewarm settings failure log", logError);
    });
    return;
  }

  if (settings.explicitUrl || ensureAgentReadyPromise) {
    return;
  }

  ensureAgentReady().catch((error) => {
    appendPluginLog(settings, {
      level: "error",
      code: error.code || "AGENT_PREWARM_FAILED",
      message: `Remote Debug Agent prewarm failed during ${trigger}: ${error.message}`,
      details: error.payload,
    }).catch((logError) => {
      console.error("failed to write MCP prewarm failure log", logError);
    });
  });
}

async function requestAgent(pathName, payload, options = {}) {
  const operation = options.operation;
  if (operation?.signal.aborted) {
    throw operation.signal.reason;
  }
  if (operation && Date.now() >= operation.deadlineAt) {
    throw toolOperationError(
      operation,
      "OPERATION_DEADLINE_EXCEEDED",
      "operation deadline exceeded before contacting manager",
      "manager_connect",
    );
  }

  let settings;
  try {
    settings = await ensureAgentReady();
  } catch (error) {
    error.operationId ||= operation?.operationId;
    error.layer ||= "mcp";
    error.phase ||= "manager_connect";
    if (error.retriable === undefined) {
      error.retriable = error.code === "AGENT_UNAVAILABLE";
    }
    error.payload = {
      operationId: error.operationId,
      code: error.code || "AGENT_START_FAILED",
      layer: error.layer,
      phase: error.phase,
      retriable: error.retriable,
      ...(error.payload || {}),
    };
    throw error;
  }
  const method = options.method || "POST";
  let response;
  let parsed;

  try {
    const requestPayload = method === "GET"
      ? undefined
      : {
          ...(payload || {}),
          ...(operation
            ? { operationId: operation.operationId, deadlineAt: operation.deadlineAt }
            : {}),
        };
    const remainingMs = operation
      ? Math.max(1, operation.deadlineAt - Date.now())
      : payload?.timeoutMs || DEFAULT_TIMEOUT_MS;
    const result = await fetchJson(new URL(pathName, settings.agentUrl), {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Remote-Debug-Source": "codex-plugin",
        ...(operation ? { "X-Remote-Debug-Operation-Id": operation.operationId } : {}),
      },
      body: method === "GET" ? undefined : JSON.stringify(requestPayload),
      timeoutMs: remainingMs + 5_000,
      signal: operation?.signal,
    });
    response = result.response;
    parsed = result.parsed;
  } catch (error) {
    if (operation?.signal.aborted) {
      throw operation.signal.reason || toolOperationError(
        operation,
        "OPERATION_CANCELLED",
        "operation cancelled",
        "request",
        error,
      );
    }
    if (error?.code === "FETCH_TIMEOUT") {
      throw toolOperationError(
        operation,
        "OPERATION_DEADLINE_EXCEEDED",
        "operation deadline exceeded while waiting for manager response",
        "request",
        error,
      );
    }
    const wrapped = new Error(`Remote Debug Agent is unavailable at ${settings.agentUrl}: ${error.message}`);
    wrapped.code = "AGENT_UNAVAILABLE";
    wrapped.operationId = operation?.operationId;
    wrapped.layer = "mcp";
    wrapped.phase = "manager_connect";
    wrapped.retriable = true;
    wrapped.cause = error.message;
    wrapped.payload = {
      operationId: operation?.operationId,
      code: wrapped.code,
      layer: wrapped.layer,
      phase: wrapped.phase,
      retriable: true,
      cause: wrapped.cause,
      agentUrl: settings.agentUrl,
      port: settings.port,
    };
    throw wrapped;
  }

  if (!response.ok || parsed.ok === false) {
    const logsUnsupported = response.status === 404 && pathName.startsWith("/logs/");
    const message = parsed.error?.message || (logsUnsupported
      ? "the connected Remote Debug Agent does not support log tools; reinstall or restart the bundled plugin"
      : `agent request failed with HTTP ${response.status}`);
    const code = parsed.error?.code || (logsUnsupported ? "LOGS_UNSUPPORTED" : "AGENT_REQUEST_FAILED");
    const error = new Error(message);
    error.code = code;
    error.operationId = parsed.error?.operationId || operation?.operationId;
    error.layer = parsed.error?.layer;
    error.phase = parsed.error?.phase;
    error.retriable = parsed.error?.retriable;
    error.cause = parsed.error?.cause;
    error.payload = {
      agentUrl: settings.agentUrl,
      port: settings.port,
      ...parsed,
    };
    throw error;
  }

  return parsed;
}

async function callAgent(pathName, payload, operation) {
  return requestAgent(pathName, payload, { operation });
}

async function getAgent(pathName, operation) {
  return requestAgent(pathName, undefined, { method: "GET", operation });
}

async function callTool(name, args, operation) {
  if (name === "remote_debug_list_instances") {
    const result = await getAgent("/api/instances", operation);
    return result;
  }

  if (name === "remote_debug_get_capabilities") {
    return getAgent("/api/capabilities", operation);
  }

  if (name === "remote_debug_mongodb_query") {
    return callAgent("/mongodb/query", {
      instanceId: args?.instanceId,
      operation: args?.operation,
      database: args?.database,
      collection: args?.collection,
      filter: args?.filter,
      projection: args?.projection,
      sort: args?.sort,
      pipeline: args?.pipeline,
      limit: args?.limit,
      skip: args?.skip,
    }, operation);
  }

  if (name === "remote_debug_mongodb_prepare_write") {
    return callAgent("/mongodb/mutations/prepare", {
      instanceId: args?.instanceId,
      kind: "document",
      operation: args?.operation,
      database: args?.database,
      collection: args?.collection,
      document: args?.document,
      filter: args?.filter,
      update: args?.update,
      deletedField: args?.deletedField,
      deletedValue: args?.deletedValue,
      maxAffected: args?.maxAffected,
      expectedCount: args?.expectedCount,
      rollbackTtlMs: args?.rollbackTtlMs,
      purpose: args?.purpose,
      timeoutMs: args?.timeoutMs,
    }, operation);
  }

  if (name === "remote_debug_mongodb_prepare_index") {
    return callAgent("/mongodb/mutations/prepare", {
      instanceId: args?.instanceId,
      kind: "index",
      operation: args?.operation,
      database: args?.database,
      collection: args?.collection,
      name: args?.name,
      key: args?.key,
      options: args?.options,
      rollbackTtlMs: args?.rollbackTtlMs,
      timeoutMs: args?.timeoutMs,
    }, operation);
  }

  if (name === "remote_debug_mongodb_prepare_transaction") {
    return callAgent("/mongodb/mutations/prepare", {
      instanceId: args?.instanceId,
      kind: "transaction",
      database: args?.database,
      operations: args?.operations,
      rollbackTtlMs: args?.rollbackTtlMs,
      purpose: args?.purpose,
      timeoutMs: args?.timeoutMs,
    }, operation);
  }

  if (name === "remote_debug_mongodb_execute_mutation") {
    return callAgent("/mongodb/mutations/execute", {
      instanceId: args?.instanceId,
      mutationId: args?.mutationId,
      planHash: args?.planHash,
      confirmation: args?.confirmation,
      timeoutMs: args?.timeoutMs,
    }, operation);
  }

  if (name === "remote_debug_mongodb_rollback_mutation") {
    return callAgent("/mongodb/mutations/rollback", {
      instanceId: args?.instanceId,
      mutationId: args?.mutationId,
      planHash: args?.planHash,
      confirmation: args?.confirmation,
      timeoutMs: args?.timeoutMs,
    }, operation);
  }

  if (name === "remote_debug_mongodb_list_mutations") {
    return callAgent("/mongodb/mutations/list", {
      instanceId: args?.instanceId,
      status: args?.status,
      timeoutMs: args?.timeoutMs,
    }, operation);
  }

  if (name === "remote_debug_restart_instance") {
    return callAgent(`/api/instances/${encodeURIComponent(args.instanceId)}/restart`, {}, operation);
  }

  if (name === "remote_debug_update_memory") {
    return callAgent("/api/memory", {
      instanceId: args?.instanceId,
      topic: args?.topic,
      summary: args?.summary,
      facts: args?.facts,
    }, operation);
  }

  if (name === "remote_debug_run_command") {
    return callAgent("/run", {
      instanceId: args?.instanceId,
      cmd: args?.cmd,
      timeoutMs: args?.timeoutMs,
    }, operation);
  }

  if (name === "remote_debug_read_file") {
    return callAgent("/read-file", {
      instanceId: args?.instanceId,
      path: args?.path,
      maxBytes: args?.maxBytes,
      timeoutMs: args?.timeoutMs,
    }, operation);
  }

  if (name === "remote_debug_list_dir") {
    return callAgent("/list-dir", {
      instanceId: args?.instanceId,
      path: args?.path,
      timeoutMs: args?.timeoutMs,
    }, operation);
  }

  if (name === "remote_debug_list_logs") {
    return callAgent("/logs/list", {
      instanceId: args?.instanceId,
      category: args?.category,
      limit: args?.limit,
      cursor: args?.cursor,
      timeoutMs: args?.timeoutMs,
    }, operation);
  }

  if (name === "remote_debug_list_log_archive_members") {
    return callAgent("/logs/archive-members", {
      instanceId: args?.instanceId,
      path: args?.path,
      prefix: args?.prefix,
      limit: args?.limit,
      cursor: args?.cursor,
      timeoutMs: args?.timeoutMs,
    }, operation);
  }

  if (name === "remote_debug_read_log") {
    return callAgent("/logs/read", {
      instanceId: args?.instanceId,
      path: args?.path,
      memberPath: args?.memberPath,
      tailLines: args?.tailLines,
      maxBytes: args?.maxBytes,
      contains: args?.contains,
      caseSensitive: args?.caseSensitive,
      timeoutMs: args?.timeoutMs,
    }, operation);
  }

  if (name === "remote_debug_prepare_command_draft") {
    return callAgent("/approved-command-drafts", {
      instanceId: args?.instanceId,
      purpose: args?.purpose,
      commands: args?.commands,
    }, operation);
  }

  if (name === "remote_debug_get_command_draft") {
    return callAgent("/approved-command-drafts/get", {
      instanceId: args?.instanceId,
      draftId: args?.draftId,
    }, operation);
  }

  if (name === "remote_debug_review_command_draft") {
    return callAgent("/approved-command-drafts/review", {
      instanceId: args?.instanceId,
      draftId: args?.draftId,
      timeoutMs: args?.timeoutMs,
    }, operation);
  }

  if (name === "remote_debug_execute_command_draft") {
    return callAgent("/approved-command-drafts/execute", {
      instanceId: args?.instanceId,
      draftId: args?.draftId,
      commandHash: args?.commandHash,
      confirmation: args?.confirmation,
      timeoutMs: args?.timeoutMs,
    }, operation);
  }

  const error = new Error(`unknown tool: ${name}`);
  error.code = "UNKNOWN_TOOL";
  throw error;
}

async function handleRequest(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    const protocolVersion = protocolVersionFor(params);
    await logMcpLifecycle("MCP_INITIALIZE", "MCP initialize received.", {
      requestId: id,
      method,
      protocolVersion,
      clientName: params?.clientInfo?.name,
      clientVersion: params?.clientInfo?.version,
    });
    sendResult(id, {
      protocolVersion,
      capabilities: {
        resources: {},
        tools: {},
      },
      serverInfo: {
        name: "remote-debug-agent",
        version: PLUGIN_VERSION,
      },
    });
    scheduleAgentPrewarm("initialize");
    return;
  }

  if (method === "tools/list") {
    await logMcpLifecycle("MCP_TOOLS_LIST", "MCP tools/list received.", {
      requestId: id,
      method,
      toolNames: tools.map((tool) => tool.name),
      toolCount: tools.length,
    });
    sendResult(id, { tools });
    scheduleAgentPrewarm("tools/list");
    return;
  }

  if (method === "resources/list") {
    await logMcpLifecycle("MCP_RESOURCES_LIST", "MCP resources/list received.", {
      requestId: id,
      method,
    });
    sendResult(id, { resources: [] });
    return;
  }

  if (method === "tools/call") {
    const startedAt = Date.now();
    const toolName = params?.name;
    const toolArguments = params?.arguments || {};
    const operation = createToolOperation(toolName, toolArguments);
    inFlightToolCalls.set(id, operation);
    await logMcpLifecycle("MCP_TOOLS_CALL_STARTED", "MCP tools/call started.", {
      requestId: id,
      operationId: operation.operationId,
      method,
      toolName,
      arguments: toolArgumentSummary(toolName, toolArguments),
    });

    try {
      const result = await callTool(toolName, toolArguments, operation);
      await logMcpLifecycle("MCP_TOOLS_CALL_COMPLETED", "MCP tools/call completed.", {
        requestId: id,
        operationId: operation.operationId,
        method,
        toolName,
        durationMs: Date.now() - startedAt,
        ok: true,
      });
      sendResult(id, {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      });
    } catch (error) {
      await logMcpLifecycle("MCP_TOOLS_CALL_FAILED", "MCP tools/call failed.", {
        requestId: id,
        operationId: operation.operationId,
        method,
        toolName,
        durationMs: Date.now() - startedAt,
        ok: false,
        error: {
          code: error.code || "TOOL_CALL_FAILED",
          message: error.message,
        },
      });
      sendResult(id, {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: false,
                error: {
                  operationId: error.operationId || operation.operationId,
                  code: error.code || "TOOL_CALL_FAILED",
                  message: error.message,
                  layer: error.layer,
                  phase: error.phase,
                  retriable: error.retriable,
                  cause: error.cause,
                },
                details: error.payload,
              },
              null,
              2,
            ),
          },
        ],
      });
    } finally {
      inFlightToolCalls.delete(id);
    }
    return;
  }

  if (method === "ping") {
    sendResult(id, {});
    return;
  }

  if (id !== undefined) {
    sendError(id, -32601, `method not found: ${method}`);
  }
}

let inputBuffer = Buffer.alloc(0);

function dispatchMessage(message) {
  if (message.method && message.id === undefined) {
    if (message.method === "notifications/cancelled") {
      cancelToolOperation(message.params?.requestId, message.params?.reason);
    }
    return;
  }

  handleRequest(message).catch((error) => {
    if (message.id !== undefined) {
      sendError(message.id, -32603, error.message);
    }
  });
}

function parseMessages() {
  while (true) {
    const bufferStart = inputBuffer.subarray(0, Math.min(inputBuffer.length, 32)).toString("utf8");
    if (!bufferStart.startsWith("Content-Length:")) {
      const lineEnd = inputBuffer.indexOf("\n");
      if (lineEnd === -1) {
        return;
      }

      const line = inputBuffer.subarray(0, lineEnd).toString("utf8").trim();
      inputBuffer = inputBuffer.subarray(lineEnd + 1);
      if (!line) {
        continue;
      }

      outputFraming = "json-line";
      dispatchMessage(JSON.parse(line));
      continue;
    }

    const headerEnd = inputBuffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      return;
    }

    const header = inputBuffer.subarray(0, headerEnd).toString("utf8");
    const contentLengthMatch = /^Content-Length:\s*(\d+)$/im.exec(header);
    if (!contentLengthMatch) {
      throw new Error("missing Content-Length header");
    }

    const contentLength = Number.parseInt(contentLengthMatch[1], 10);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;
    if (inputBuffer.length < bodyEnd) {
      return;
    }

    const body = inputBuffer.subarray(bodyStart, bodyEnd).toString("utf8");
    inputBuffer = inputBuffer.subarray(bodyEnd);
    outputFraming = "content-length";
    dispatchMessage(JSON.parse(body));
  }
}

process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  parseMessages();
});

process.stdin.on("error", (error) => {
  console.error(error);
});

process.stdin.on("close", () => {
  for (const [requestId] of inFlightToolCalls) {
    cancelToolOperation(requestId, "MCP stdin closed");
  }
  releaseAgentLease().catch((error) => {
    console.error("failed to release Remote Debug Agent lease", error);
  });
});
