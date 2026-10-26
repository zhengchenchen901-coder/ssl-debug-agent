import { createHash, randomBytes, randomUUID } from "node:crypto";

const PREFIX = "rda_ref_v1_";
const REFERENCE = /^rda_ref_v1_[a-f0-9]{48}$/;
const REDACTED = "[REDACTED]";
const CONTROL_FIELD = /(?:Id|Hash|Digest|Fingerprint)$|^(?:id|database|collection|collections|name|operation|kind|status|state|intentState|recoveryCode|mode|command|confirmation|changedFields|atomicity|rollbackMode|riskLevel|storageRoot|journalPath|receiptsDatabase|receiptStorage|code|layer|phase|requestDigest|recordFingerprint|containmentScope|historicalOutcome|admission|missingRequirements|risk|fenceReason)$/;
const INPUTS = {
  remote_debug_mongodb_query: ["filter", "pipeline"],
  remote_debug_mongodb_prepare_write: ["filter", "document", "update", "deletedValue"],
  remote_debug_mongodb_prepare_transaction: ["operations"],
  remote_debug_mongodb_prepare_import: ["documents"],
  remote_debug_mongodb_prepare_bulk: ["units"],
};

function fail(code = "BUSINESS_REFERENCE_INVALID") {
  throw Object.assign(new Error("Business reference is unavailable or is not valid for this target or argument. Re-query the data in this MCP session."), { code, retriable: false });
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
function encoded(value) { return JSON.stringify(stable(value)); }
function object(entries) { return Object.fromEntries(entries); }

export function businessTargetScope(endpoint, instance, database) {
  if (!instance?.id || typeof database !== "string" || !database) fail("BUSINESS_PRIVACY_SCOPE_REQUIRED");
  return encoded({ endpoint, id: instance.id, host: instance.host, port: instance.port, username: instance.username,
    createdAt: instance.createdAt, configPath: instance.mongodb?.configPath, driverPath: instance.mongodb?.driverPath,
    configProfile: instance.mongodb?.configProfile, uriKey: instance.mongodb?.uriKey, database });
}

export function isBusinessField(field) {
  const leaf = field.split(".").at(-1);
  if (leaf.startsWith("$")) return false; // BSON tags/operators are schema, not business fields.
  const words = leaf.replace(/IDs$/, "Ids").replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[_-]+/).filter(Boolean);
  return /^(id|ids|key|keys|uuid|uuids|guid|guids|uid|uids|oid|oids|openid|unionid)$/.test(words.at(-1) || "");
}

// Preserve provenance when an aggregation exposes userId as e.g. "customer".
// Derived values remain private too; ordinary count/sum-of-constant fields do not.
function aggregationFields(pipeline = []) {
  let fields = new Set();
  function sensitive(expression, known) {
    if (typeof expression === "string" && expression.startsWith("$")) {
      const path = expression.replace(/^\$+/, "").replace(/^(?:ROOT|CURRENT)\./, "");
      return path.split(".").some(isBusinessField) || known.has(path);
    }
    if (Array.isArray(expression)) return expression.some((item) => sensitive(item, known));
    if (expression && typeof expression === "object") return Object.entries(expression).some(([key, child]) => key !== "$literal" && sensitive(child, known));
    return false;
  }
  for (const stage of pipeline) {
    const definition = stage.$project || stage.$addFields || stage.$set || stage.$group;
    if (definition) {
      const previous = fields; fields = stage.$group ? new Set() : new Set(fields);
      for (const [field, expression] of Object.entries(definition)) {
        if (sensitive(expression, previous)) fields.add(field);
        else if (expression !== 1 && expression !== true) fields.delete(field);
      }
    }
    if (stage.$lookup?.pipeline && stage.$lookup.as) for (const field of aggregationFields(stage.$lookup.pipeline)) fields.add(stage.$lookup.as + "." + field);
    if (stage.$facet) for (const [name, subpipeline] of Object.entries(stage.$facet)) for (const field of aggregationFields(subpipeline)) fields.add(name + "." + field);
    const root = stage.$replaceRoot?.newRoot || stage.$replaceWith;
    if (typeof root === "string" && root.startsWith("$")) {
      const prefix = root.slice(1) + "."; fields = new Set([...fields].filter((field) => field.startsWith(prefix)).map((field) => field.slice(prefix.length)));
    } else if (root && typeof root === "object") {
      const previous = fields; fields = new Set(Object.entries(root).filter(([, expression]) => sensitive(expression, previous)).map(([key]) => key));
    }
  }
  return fields;
}

// Synchronous, bounded per-process cache. Production installs a private Manager
// adapter and commits pending mappings before publishing any response.
export function createBusinessPrivacy({ maxEntries = 100_000, maxBytes = 32 * 1024 * 1024, maxNodes = 100_000, maxDepth = 40 } = {}) {
  let contextId = randomUUID(), persistent = false;
  const records = new Map(), reverse = new Map(), strings = new Set(), pending = new Set();
  let bytes = 0, referenceUses = 0;
  function budget() {
    let nodes = 0;
    const deadline = performance.now() + 1000;
    return (depth) => { if (++nodes > maxNodes || depth > maxDepth || performance.now() > deadline) fail("BUSINESS_PRIVACY_LIMIT"); };
  }
  function targetScope(endpoint, instance, database) {
    return businessTargetScope(endpoint, instance, database);
  }
  function reference(value, scope) {
    if (value === null || value === undefined || value === REDACTED) return value;
    if (!scope) fail("BUSINESS_PRIVACY_SCOPE_REQUIRED");
    referenceUses++;
    // Embedded BSON document equality includes field order. Sort only target
    // metadata, never a stored business value or its reverse-lookup identity.
    const canonical = JSON.stringify(value), key = createHash("sha256").update(scope + "\n" + canonical).digest("hex");
    if (reverse.has(key)) return reverse.get(key);
    const size = Buffer.byteLength(canonical) + Buffer.byteLength(scope) + 160;
    if (records.size >= maxEntries || bytes + size > maxBytes) fail("BUSINESS_PRIVACY_LIMIT");
    const alias = PREFIX + randomBytes(24).toString("hex");
    records.set(alias, { scope, value: JSON.parse(canonical) }); reverse.set(key, alias); pending.add(alias); bytes += size;
    const remember = (item) => {
      if (typeof item === "string" && item.length >= 6 && !item.includes(PREFIX)) strings.add(item);
      else if (item && typeof item === "object") for (const child of Object.values(item)) remember(child);
    };
    remember(value);
    return alias;
  }
  function resolve(name, input, scope) {
    if (["remote_debug_mongodb_recover_operation", "remote_debug_mongodb_disposition"].includes(name) && input.originalRequest !== undefined) {
      const { originalRequest, replacementRequest, ...outer } = input;
      return { ...resolve(name, outer, scope), originalRequest: resolve("remote_debug_mongodb_prepare_bulk", originalRequest, scope),
        ...(replacementRequest !== undefined ? { replacementRequest: resolve("remote_debug_mongodb_prepare_bulk", replacementRequest, scope) } : {}) };
    }
    const check = budget();
    function walk(value, allowed, depth = 0) {
      check(depth);
      if (typeof value === "string" && value.includes(PREFIX)) {
        if (allowed !== true || !REFERENCE.test(value)) fail();
        const record = records.get(value);
        if (!record || record.scope !== scope) fail();
        return structuredClone(record.value);
      }
      if (Array.isArray(value)) return value.map((item) => walk(item, allowed === "units" ? "unit" : allowed === "operations" ? "operation" : allowed, depth + 1));
      if (value && typeof value === "object") return object(Object.entries(value).map(([key, child]) => {
        if (key.includes(PREFIX)) fail();
        const next = allowed === "unit" ? (key === "operations" ? "operations" : false)
          : allowed === "operation" ? ["id", "document", "filter", "update", "expected", "deletedValue"].includes(key) : allowed;
        const bsonTag = /^\$(?:oid|date|numberLong|numberInt|numberDecimal|numberDouble|binary|timestamp|regularExpression|minKey|maxKey)$/;
        return [key, walk(child, bsonTag.test(key) ? false : next, depth + 1)];
      }));
      return value;
    }
    return object(Object.entries(input).map(([key, value]) => [key, walk(value,
      INPUTS[name]?.includes(key) ? (["units", "operations"].includes(key) ? key : true) : false)]));
  }
  function business(value, scope, check, depth = 0, sensitive = false, fields = new Set(), path = "") {
    check(depth);
    if (sensitive) {
      if (Array.isArray(value)) return value.map((item) => business(item, scope, check, depth + 1, true));
      return reference(value, scope);
    }
    if (Array.isArray(value)) return value.map((item) => business(item, scope, check, depth + 1, false, fields, path));
    if (value && typeof value === "object") return object(Object.entries(value).map(([key, child]) => {
      const childPath = path ? path + "." + key : key;
      return [key, business(child, scope, check, depth + 1, isBusinessField(key) || fields.has(childPath), fields, childPath)];
    }));
    return value;
  }
  function learnInput(name, safeInput, scope) {
    const check = budget();
    // Only business surfaces, never index definitions, hashes, or credentials.
    // Input is credential-sanitized first; the actual request is never mutated.
    for (const key of INPUTS[name] || []) if (safeInput[key] !== undefined) business(safeInput[key], scope, check);
  }
  function protect(name, payload, { scope, queryOperation, queryPipeline, scopeForDatabase } = {}) {
    if (!name?.startsWith("remote_debug_mongodb_")) return { value: payload, replacements: 0 };
    const check = budget(), before = referenceUses;
    function walk(value, currentScope, depth = 0) {
      check(depth);
      if (Array.isArray(value)) return value.map((item) => walk(item, currentScope, depth + 1));
      if (!value || typeof value !== "object") return value;
      if (typeof value.database === "string" && scopeForDatabase) currentScope = scopeForDatabase(value.database);
      return object(Object.entries(value).map(([key, child]) => {
        if (key === "affectedIds") return [key, business(child, currentScope, check, depth + 1, true)];
        if (["sampleIds", "differences"].includes(key)) return [key, business(child, currentScope, check, depth + 1)];
        if (key === "data" && name === "remote_debug_mongodb_query" && !["ping", "listDatabases", "listCollections", "countDocuments"].includes(queryOperation)) return [key, business(child, currentScope, check, depth + 1, false, aggregationFields(queryPipeline))];
        return [key, walk(child, currentScope, depth + 1)];
      }));
    }
    const value = walk(payload, scope);
    return { value, replacements: referenceUses - before };
  }
  function scrubKnown(value, shape = "json") {
    const check = budget(), variants = new Set();
    for (const raw of strings) for (const item of [raw, encodeURIComponent(raw), JSON.stringify(raw).slice(1, -1)]) variants.add(item);
    const pattern = [...variants].sort((a, b) => b.length - a.length).map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    if (pattern.length > 1024 * 1024) fail("BUSINESS_PRIVACY_LIMIT");
    const matcher = pattern ? new RegExp(`(${PREFIX}[a-f0-9]{48})|(?:${pattern})`, "g") : null;
    function walk(item, depth = 0, contract = shape) {
      check(depth);
      if (typeof item === "string") {
        if (REFERENCE.test(item)) return item;
        return matcher ? item.replace(matcher, (match, ref) => ref || REDACTED) : item;
      }
      if (Array.isArray(item)) return item.map((child) => walk(child, depth + 1, Array.isArray(contract) ? contract[0] : "json"));
      if (item && typeof item === "object") {
        const result = Object.create(null);
        for (const [key, child] of Object.entries(item)) {
          // Closed-contract metadata is protocol, not a flexible business JSON
          // surface. A business value such as seed-0 must not corrupt importId
          // seed-01, database names, index definitions, or continuation hashes.
          const metadata = contract && typeof contract === "object" && !Array.isArray(contract);
          const next = metadata ? key : walk(key, depth + 1, "scalar");
          if (Object.hasOwn(result, next)) fail("BUSINESS_PRIVACY_KEY_COLLISION");
          const childContract = metadata ? contract[key] : "json";
          result[next] = metadata && CONTROL_FIELD.test(key) && (childContract === "scalar" || Array.isArray(childContract) && childContract[0] === "scalar")
            ? child : walk(child, depth + 1, childContract);
        }
        return result;
      }
      return item;
    }
    return walk(value);
  }
  function hydrate(items) {
    for (const { ref, scope, value } of items) {
      // Learn known string echoes with the same credential-first policy as new values.
      const alias = reference(value, scope), record = records.get(alias);
      pending.delete(alias); records.delete(alias); records.set(ref, record);
      reverse.set(createHash("sha256").update(scope + "\n" + JSON.stringify(value)).digest("hex"), ref);
    }
  }
  function acknowledge(aliases) {
    for (const [old, ref] of Object.entries(aliases)) {
      const record = records.get(old); if (!record) continue;
      pending.delete(old); records.delete(old); records.set(ref, record);
      reverse.set(createHash("sha256").update(record.scope + "\n" + JSON.stringify(record.value)).digest("hex"), ref);
    }
  }
  return { targetScope, resolve, learnInput, protect, scrubKnown, hydrate, acknowledge,
    attach: (id) => { contextId = id; persistent = true; },
    pending: () => [...pending].map((ref) => ({ ref, ...records.get(ref) })),
    // Clear only the cache after an operation; disk mappings and task pins remain.
    evict: () => { if (persistent && !pending.size) { records.clear(); reverse.clear(); strings.clear(); bytes = 0; } },
    metadata: () => ({ contextId, storage: persistent ? "encrypted_sqlite" : "process_memory", policyVersion: 1 }) };
}
