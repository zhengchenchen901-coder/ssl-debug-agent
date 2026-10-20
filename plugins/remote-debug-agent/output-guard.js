import { OUTPUT_CONTRACTS, ERROR_CONTRACT } from "./output-contracts.js";

export const REDACTED = "[REDACTED]";
export const GUARD_BLOCKED = Object.freeze({
  ok: false,
  error: Object.freeze({ code: "OUTPUT_GUARD_BLOCKED", message: "Output was blocked by the sensitive information guard.", retriable: false }),
});
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_NODES = 100_000;
const MAX_DEPTH = 40;
const MAX_SECRETS = 2048;
const SECRET_NAME = /(?:password|passwd|passphrase|pwd|secret|token|apikey|privatekey|authorization|cookie|credentials?|connectionstring|dsn|accesskey(?:id)?|signingkey|encryptionkey)(?:s|hash|digest)?$/i;
const ASSIGNMENT_NAME = String.raw`[\w.-]*(?:password|passwd|passphrase|pwd|secret|token|api[_-]?key|private[_-]?key|client[_-]?secret|access[_-]?key(?:[_-]?id)?|connection[_-]?string|dsn)`;
const ASSIGNMENT = new RegExp(String.raw`(\b${ASSIGNMENT_NAME}["']?\s*[=:]\s*)("(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s,;}&]+)`, "gi");
const CLI_SECRET = new RegExp(String.raw`(--?(?:password|passwd|passphrase|pwd|pass|token|secret|api[-_]?key|client[-_]?secret)(?:=|\s+))("(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s;]+)`, "gi");

export function isSensitiveKey(key) {
  const normalized = key.replace(/[^a-z0-9]/gi, "");
  return SECRET_NAME.test(normalized) || /^(?:auth|authentication)$/i.test(normalized);
}

function blocked() { throw new Error("OUTPUT_GUARD_BLOCKED"); }
function decodeEscapes(value) {
  return value.replace(/\\u([0-9a-f]{4})|\\x([0-9a-f]{2})|\\([\\"'/=:])/gi,
    (_, unicode, hex, literal) => literal || String.fromCharCode(parseInt(unicode || hex, 16)));
}

export function createOutputGuard({ maxBytes = MAX_BYTES, maxNodes = MAX_NODES, maxDepth = MAX_DEPTH, budgetMs = 1000, businessPrivacy } = {}) {
  // Process-local, never serialized. Retain rotated credentials until this MCP exits.
  const secrets = new Set();
  let unavailable = false;
  function remember(value) {
    if (typeof value !== "string" || !value || value === REDACTED) return;
    if (value.length > maxBytes || secrets.size >= MAX_SECRETS && !secrets.has(value)) { unavailable = true; return; }
    secrets.add(value);
  }
  function context() {
    if (unavailable) blocked();
    const deadline = performance.now() + budgetMs;
    let nodes = 0, bytes = 0;
    const localSecrets = new Set(secrets);
    return { secrets: localSecrets, replacements: 0, omittedFields: 0, remember(value) {
      if (typeof value !== "string" || !value || value === REDACTED) return;
      if (value.length > maxBytes || localSecrets.size >= MAX_SECRETS && !localSecrets.has(value)) blocked();
      localSecrets.add(value);
    }, check(value, depth) {
      if (++nodes > maxNodes || depth > maxDepth || performance.now() > deadline) blocked();
      if (typeof value === "string") bytes += Buffer.byteLength(value);
      if (bytes > maxBytes * 8) blocked();
    } };
  }
  function learn(value, ctx, depth = 0) {
    ctx.check(value, depth);
    if (typeof value === "string") {
      const decoded = decodeEscapes(value);
      if (decoded !== value) learn(decoded, ctx, depth + 1);
      if (/^[\[{"]/.test(value.trim())) {
        let parsed;
        try { parsed = JSON.parse(value); } catch { /* ordinary text */ }
        if (parsed !== undefined && parsed !== value) learn(parsed, ctx, depth + 1);
      }
      for (const pattern of [ASSIGNMENT, CLI_SECRET]) {
        for (const match of value.matchAll(pattern)) {
          const secret = match[2].replace(/^["']|["']$/g, "");
          ctx.remember(secret);
        }
      }
      for (const match of value.matchAll(/\b(?:Bearer|Basic)\s+([a-z0-9._~+/=-]+)/gi)) ctx.remember(match[1]);
    }
    else if (Array.isArray(value)) { for (const item of value) learn(item, ctx, depth + 1); }
    else if (value && typeof value === "object") {
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) blocked();
      for (const [key, child] of Object.entries(value)) {
        learn(key, ctx, depth + 1);
        if (isSensitiveKey(key)) learnSecret(child, ctx, depth + 1);
        else learn(child, ctx, depth + 1);
      }
    } else if (!["string", "number", "boolean", "undefined"].includes(typeof value) && value !== null) blocked();
  }
  function learnSecret(value, ctx, depth) {
    if (typeof value === "string") { ctx.check(value, depth); ctx.remember(value); }
    else if (typeof value === "number") { ctx.check(value, depth); ctx.remember(String(value)); }
    else if (Array.isArray(value)) { for (const item of value) learnSecret(item, ctx, depth + 1); }
    else if (value && typeof value === "object") {
      ctx.check(value, depth);
      for (const child of Object.values(value)) learnSecret(child, ctx, depth + 1);
    } else ctx.check(value, depth);
  }
  function replacePatterns(text, ctx) {
    // Recognize syntax before exact matches can obscure a PEM/URI/header label.
    let result = text
      .replace(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g, REDACTED)
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s"'<>]*@/gi, `$1${REDACTED}@`)
      .replace(/\b(?:Bearer|Basic)\s+[a-z0-9._~+/=-]+/gi, REDACTED)
      .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\r\n]+/gi, REDACTED)
      .replace(CLI_SECRET, `$1${REDACTED}`)
      .replace(ASSIGNMENT, `$1${REDACTED}`)
      .replace(/\b(?:sk-(?:proj-|svcacct-)?[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|xox[baprs]-[a-z0-9-]{16,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/gi, REDACTED)
      .replace(/\beyJ[a-z0-9_-]{5,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b/gi, REDACTED);
    for (const secret of [...ctx.secrets].sort((left, right) => right.length - left.length)) {
      ctx.check?.(undefined, 0);
      const variants = [...new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])].sort((left, right) => right.length - left.length);
      for (const variant of variants) {
        result = variant.includes(REDACTED)
          ? result.split(variant).join(REDACTED)
          : result.split(REDACTED).map((part) => part.split(variant).join(REDACTED)).join(REDACTED);
      }
    }
    return result;
  }
  function text(value, ctx, depth) {
    // Parse JSON carried inside stdout/log strings, including nested JSON strings.
    const trimmed = value.trim();
    if (/^[\[{"]/.test(trimmed)) {
      let parsed;
      try { parsed = JSON.parse(trimmed); } catch { /* ordinary text */ }
      if (parsed !== undefined && parsed !== value) {
        learn(parsed, ctx, depth + 1);
        const safe = walk(parsed, "json", ctx, depth + 1);
        if (JSON.stringify(parsed) !== JSON.stringify(safe)) return JSON.stringify(safe);
        return value;
      }
    }
    let result = replacePatterns(value, ctx);
    // Escaped/embedded JSON and escaped credential labels: avoid unsafe span mapping.
    let decoded = value;
    for (let round = 0; round < 3 && decoded.includes("\\"); round++) {
      decoded = decodeEscapes(decoded);
      if (replacePatterns(decoded, ctx) !== decoded) { result = REDACTED; break; }
    }
    if (result !== value) ctx.replacements++;
    ctx.check(undefined, depth);
    return result;
  }
  function walk(value, shape, ctx, depth = 0) {
    ctx.check(value, depth);
    if (value === undefined || value === null) return value;
    if (shape === "boolean") { if (typeof value !== "boolean") blocked(); return value; }
    if (shape === "scalar" && typeof value === "object") blocked();
    if (shape !== "scalar" && shape !== "json" && typeof value !== "object") blocked();
    if (typeof value === "string") return text(value, ctx, depth);
    if (typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) blocked();
      if (ctx.secrets.has(String(value))) { ctx.replacements++; return REDACTED; }
      return value;
    }
    if (Array.isArray(value)) {
      if (shape !== "json" && !Array.isArray(shape)) blocked();
      return value.map((item) => walk(item, shape === "json" ? "json" : shape[0], ctx, depth + 1));
    }
    if (!value || typeof value !== "object" || Array.isArray(shape) || shape === "scalar") blocked();
    const output = Object.create(null);
    for (const [key, child] of Object.entries(value)) {
      ctx.check(key, depth);
      if (shape !== "json" && !Object.hasOwn(shape, key)) { ctx.omittedFields++; continue; }
      const safeKey = text(key, ctx, depth + 1);
      if (Object.hasOwn(output, safeKey)) blocked();
      if ((shape !== "json" && shape[key] === "boolean") || (typeof child === "boolean" && /^has[A-Z]/.test(key))) output[safeKey] = walk(child, "boolean", ctx, depth + 1);
      else if (isSensitiveKey(key)) { output[safeKey] = REDACTED; if (child !== REDACTED) ctx.replacements++; }
      else output[safeKey] = walk(child, shape === "json" ? "json" : shape[key], ctx, depth + 1);
    }
    return output;
  }
  function sanitize(value, shape = "json") {
    const ctx = context();
    if (Buffer.byteLength(JSON.stringify(value) ?? "") > maxBytes) blocked();
    learn(value, ctx);
    if (unavailable) blocked();
    const safe = walk(value, shape, ctx);
    // A second pass catches copies that preceded newly learned embedded secrets.
    const checked = walk(safe, shape, ctx);
    return { value: checked, stats: { policyVersion: 1, replacements: ctx.replacements, omittedFields: ctx.omittedFields } };
  }
  function toolResult(name, payload, isError = false, privacyContext) {
    try {
      const shape = isError ? ERROR_CONTRACT : Object.hasOwn(OUTPUT_CONTRACTS, name) ? OUTPUT_CONTRACTS[name] : undefined;
      if (!shape || !payload || typeof payload !== "object" || Array.isArray(payload)) blocked();
      const safe = sanitize(payload, shape);
      if (businessPrivacy) {
        const protectedBusiness = businessPrivacy.protect(name, safe.value, privacyContext);
        safe.value = protectedBusiness.value;
        safe.stats.replacements += protectedBusiness.replacements;
        safe.value = businessPrivacy.scrubKnown(safe.value, shape);
        safe.stats.businessPrivacy = businessPrivacy.metadata();
      }
      safe.value.outputGuard = safe.stats;
      return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify(safe.value, null, 2) }] };
    } catch {
      return { isError: true, content: [{ type: "text", text: JSON.stringify(GUARD_BLOCKED) }] };
    }
  }
  function serialize(message, { staticResult = false } = {}) {
    try {
      // The transport always checks the final envelope, before writing any bytes.
      // Field names in trusted tools/list schemas are definitions, not credentials.
      const safeId = businessPrivacy ? businessPrivacy.scrubKnown(sanitize(message.id).value) : sanitize(message.id).value;
      if (safeId !== message.id) blocked();
      const result = message.result;
      if (result && (Object.hasOwn(result, "content") || Object.hasOwn(result, "structuredContent"))) {
        if (Object.keys(message.result).some((key) => !["content", "isError"].includes(key))) blocked();
        if (!Array.isArray(message.result.content) || message.result.content.length !== 1) blocked();
        const content = message.result.content[0];
        if (content.type !== "text" || typeof content.text !== "string" || Object.keys(content).some((key) => !["type", "text"].includes(key))) blocked();
        const payload = JSON.parse(content.text);
        if (payload?.outputGuard?.policyVersion !== 1 && payload?.error?.code !== "OUTPUT_GUARD_BLOCKED") blocked();
      } else if (result !== undefined && !staticResult) {
        if (!result || typeof result !== "object" || Array.isArray(result)) blocked();
        const keys = Object.keys(result);
        const initialized = keys.length === 3 && keys.every((key) => ["protocolVersion", "capabilities", "serverInfo"].includes(key));
        const resources = keys.length === 1 && Array.isArray(result.resources) && result.resources.length === 0;
        if (keys.length && !initialized && !resources) blocked();
      }
      if (staticResult && (!Array.isArray(message.result?.tools) || Object.keys(message.result).length !== 1)) blocked();
      let safe = staticResult ? message : sanitize(message).value;
      if (businessPrivacy && !staticResult && !result?.content) safe = businessPrivacy.scrubKnown(safe);
      const body = JSON.stringify(safe);
      if (Buffer.byteLength(body) > maxBytes) blocked();
      return Buffer.from(body, "utf8");
    } catch {
      // Request IDs are transport correlation values, never upstream payloads.
      let id = typeof message.id === "number" && Number.isSafeInteger(message.id) ? message.id : null;
      if (secrets.has(String(id))) id = null;
      if (typeof message.id === "string" && message.id.length <= 128) {
        const ctx = { secrets };
        if (replacePatterns(message.id, ctx) === message.id) id = message.id;
      }
      return Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: JSON.stringify(GUARD_BLOCKED) }] } }));
    }
  }
  return { remember, sanitize, toolResult, serialize };
}
