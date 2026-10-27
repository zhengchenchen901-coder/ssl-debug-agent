import { SAFE_MUTATION_ID_PATTERN } from "./prepare-protocol.js";
const uuid = { type: "string", pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$" };
const instanceId = { type: ["string", "null"], description: "Explicit instance ID, or null for a Manager-only task. Never infer from a chat ID." };
const artifact = { type: "object", additionalProperties: false, required: ["category", "format", "name", "content"], properties: {
  category: { type: "string", enum: ["results", "reports", "exports", "attachments"] },
  format: { type: "string", enum: ["json", "markdown", "text", "csv", "jsonl", "html", "binary"] },
  encoding: { type: "string", enum: ["utf8", "base64"], description: "Use base64 only with format=binary; name must contain the desired download filename, such as report.pdf. Binary bytes are preserved verbatim, so generate attachments from already sanitized final data." },
  name: { type: "string", minLength: 1, maxLength: 120, description: "Display name without a directory. The store generates the physical file name." },
  content: { description: "Final UTF-8 text, a JSON value when format=json, or canonical base64 for format=binary. No raw credentials, preimages, reference maps or intermediate data." },
} };
const schema = (properties, required) => ({ type: "object", additionalProperties: false, properties, required });
export const FINAL_RESULT_TOOLS = [
  { name: "remote_debug_publish_final_result", description: "Publish the assembled FINAL deliverables of one concluded user task to local output/, isolated by instance and task. Call once after investigation/execution and final synthesis, never for progress, polling, query pages, plans awaiting approval, or each tool response. Use one stable UUID taskId for retries; identical publication is idempotent, different contents conflict. Does not execute or retry business operations. Final partial/failed/cancelled summaries must accurately describe missing evidence. Preserve opaque business references; never decode them.",
    inputSchema: schema({ instanceId, taskId: uuid, title: { type: "string", minLength: 1, maxLength: 160 }, type: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" },
      status: { type: "string", enum: ["completed", "partial", "failed", "cancelled"] }, final: { type: "boolean", const: true },
      references: schema({ operationIds: { type: "array", maxItems: 64, items: uuid }, jobId: { type: "string" }, mutationId: { type: "string", pattern: SAFE_MUTATION_ID_PATTERN.source, maxLength: 128 }, resourceTaskId: uuid }, []),
      artifacts: { type: "array", minItems: 1, maxItems: 32, items: artifact },
    }, ["instanceId", "taskId", "title", "status", "final", "artifacts"]) },
  { name: "remote_debug_list_final_results", description: "List persistent final task deliverables for an explicit instance (including deleted instances), or null for Manager tasks. Excludes all intermediate tool responses and progress.",
    inputSchema: schema({ instanceId, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 } }, ["instanceId"]) },
  { name: "remote_debug_get_final_result", description: "Read a final task manifest and its categorized artifact IDs. No remote operations.", inputSchema: schema({ instanceId, taskId: uuid }, ["instanceId", "taskId"]) },
  { name: "remote_debug_read_final_artifact", description: "Read a bounded UTF-8 preview of a final artifact by exact instance, task and artifact IDs. Use the authenticated Dashboard for a complete file download.",
    inputSchema: schema({ instanceId, taskId: uuid, artifactId: uuid, maxBytes: { type: "integer", minimum: 1, maximum: 262144 } }, ["instanceId", "taskId", "artifactId"]) },
];

export async function callFinalResultTool(name, args, { post, get, sanitize }) {
  const definition = FINAL_RESULT_TOOLS.find((tool) => tool.name === name);
  if (!definition || !args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some((key) => !Object.hasOwn(definition.inputSchema.properties, key)) ||
    definition.inputSchema.required.some((key) => !Object.hasOwn(args, key)) || args.instanceId !== null && (typeof args.instanceId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(args.instanceId))) {
    throw Object.assign(new Error("Invalid final result arguments"), { code: "FINAL_RESULT_INVALID" });
  }
  if (name === "remote_debug_publish_final_result") return post("/api/final-results", sanitizeFinalPublication(args, sanitize));
  const scope = args.instanceId === null ? "scope=manager" : `instanceId=${encodeURIComponent(args.instanceId)}`;
  const integer = (value, fallback, max, minimum = 0) => {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < minimum || value > max) throw Object.assign(new Error("Invalid final result pagination"), { code: "FINAL_RESULT_INVALID" });
    return value;
  };
  if (name === "remote_debug_list_final_results") return get(`/api/final-results?${scope}&offset=${integer(args.offset, 0, Number.MAX_SAFE_INTEGER)}&limit=${integer(args.limit, 20, 100, 1)}`);
  if (!new RegExp(uuid.pattern).test(args.taskId)) throw Object.assign(new Error("Invalid final task ID"), { code: "FINAL_RESULT_INVALID" });
  const base = `/api/final-results/${args.taskId}`;
  if (name === "remote_debug_get_final_result") return get(`${base}?${scope}`);
  if (!new RegExp(uuid.pattern).test(args.artifactId)) throw Object.assign(new Error("Invalid artifact ID"), { code: "FINAL_RESULT_INVALID" });
  return get(`${base}/artifacts/${args.artifactId}?${scope}&maxBytes=${integer(args.maxBytes, 65536, 262144, 1)}`);
}

// Binary attachments are opaque final files, not encoded text to execute or
// restore. Guard all metadata and textual artifacts; do not corrupt file bytes
// by applying text substitutions inside their base64 transport representation.
export function sanitizeFinalPublication(input, sanitize) {
  if (!input || !Array.isArray(input.artifacts)) return sanitize(input);
  const binaries = new Map();
  let encodedBytes = 0;
  const artifacts = input.artifacts.map((item, index) => {
    if (!item || item.encoding !== "base64") return item;
    if (typeof item.content !== "string" || (encodedBytes += item.content.length) > 12 * 1024 * 1024) throw Object.assign(new Error("Final attachment exceeds limit"), { code: "FINAL_RESULT_TOO_LARGE", statusCode: 413 });
    binaries.set(index, item.content);
    return { ...item, content: "[BINARY_ATTACHMENT]" };
  });
  const safe = sanitize({ ...input, artifacts });
  for (const [index, content] of binaries) safe.artifacts[index].content = content;
  return safe;
}
