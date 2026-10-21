import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { prepareRequestDigest } from "./prepare-protocol.js";

function failure(code = "BUSINESS_STORAGE_UNAVAILABLE", intentId) {
  return Object.assign(new Error("Protected local state requires recovery or reconciliation. No uncertain write was replayed."), { code, retriable: false, intentId });
}
function refsIn(value, found = new Set()) {
  if (typeof value === "string" && /^rda_ref_v1_[a-f0-9]{48}$/.test(value)) found.add(value);
  else if (value && typeof value === "object") for (const child of Object.values(value)) refsIn(child, found);
  return [...found];
}
function replace(value, aliases) {
  if (typeof value === "string") return aliases[value] || value;
  if (Array.isArray(value)) return value.map((child) => replace(child, aliases));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replace(child, aliases)]));
  return value;
}
function taskIdentities(value, found = new Map()) {
  if (Array.isArray(value)) { for (const child of value) taskIdentities(child, found); }
  else if (value && typeof value === "object") {
    for (const field of ["jobId", "mutationId", "importId"]) if (typeof value[field] === "string") found.set(value[field], {
      id: value[field], status: value.status || "active", planHash: value.planHash,
      expires: Date.parse(value.rollbackExpiresAt || value.expiresAt || "") || undefined,
    });
    for (const [key, child] of Object.entries(value)) if (!["data", "differences", "sampleIds"].includes(key)) taskIdentities(child, found);
  }
  return [...found.values()];
}

export function createBusinessStorage({ privacy, guard, fetchJson }) {
  let attached, attaching, serial = Promise.resolve(), published = 0;
  async function rpc(settings, input, signal) {
    try {
      const { response, parsed } = await fetchJson(settings, "/api/private/business-storage", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
        timeoutMs: ["dispatch_prepare", "recover_operation"].includes(input.action)
          ? Math.max(1, Math.min(605000, (input.deadlineAt || Date.now() + 120000) - Date.now() + 5000)) : 25000, signal,
      });
      if (!response.ok || parsed.ok !== true || !parsed.result) throw failure(parsed.error?.code?.startsWith("BUSINESS_") ? parsed.error.code : undefined);
      return parsed.result;
    } catch (error) { throw failure(error.code?.startsWith("BUSINESS_") ? error.code : undefined); }
  }
  async function attach(settings) {
    const origin = new URL(settings.agentUrl).origin;
    if (attached) { if (attached.origin !== origin) throw failure("BUSINESS_CONTEXT_DENIED"); return; }
    if (attaching) return attaching;
    attaching = (async () => {
      const directory = path.join(settings.dataDir, ".private", "contexts");
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const configured = settings.env.REMOTE_DEBUG_PRIVACY_CONTEXT_FILE;
      let filename = configured ? path.resolve(configured) : path.join(directory, randomUUID() + ".json");
      for (let p = path.dirname(filename); p !== path.dirname(p); p = path.dirname(p)) if (fs.lstatSync(p).isSymbolicLink() && !(process.platform === "darwin" && ["/tmp", "/var"].includes(p))) throw failure("BUSINESS_CONTEXT_DENIED");
      let auth;
      const read = () => {
        const stat = fs.lstatSync(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.uid !== process.getuid?.()) throw failure("BUSINESS_CONTEXT_DENIED");
        const saved = JSON.parse(fs.readFileSync(filename, "utf8"));
        if (saved.origin !== origin) throw failure("BUSINESS_CONTEXT_DENIED");
        return saved.auth;
      };
      if (fs.existsSync(filename)) auth = read();
      else {
        auth = await rpc(settings, { action: "create" });
        if (!configured) filename = path.join(directory, auth.contextId + ".json");
        try {
          const fd = fs.openSync(filename, "wx", 0o600);
          try { fs.writeFileSync(fd, JSON.stringify({ version: 1, origin, auth })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
          const parent = fs.openSync(path.dirname(filename), "r"); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
        } catch (error) {
          if (error.code === "EEXIST") auth = read(); else throw failure("BUSINESS_CONTEXT_DENIED");
        }
      }
      guard.remember(auth.capability);
      await rpc(settings, { action: "attach", auth });
      attached = { origin, auth }; privacy.attach(auth.contextId);
    })().catch((error) => { attaching = undefined; throw error; });
    return attaching;
  }
  async function call(settings, input, signal) {
    await attach(settings);
    return rpc(settings, { ...input, auth: attached.auth }, signal);
  }
  return {
    // Cache changes and the final guard are serialized per MCP process. Other
    // MCP processes still deduplicate concurrently in the Manager transaction.
    async lock(signal) {
      let release, cancel;
      const next = new Promise((r) => { release = r; }), previous = serial; serial = next;
      try {
        const aborted = new Promise((_, reject) => { cancel = () => reject(signal.reason || failure()); signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) cancel(); });
        await Promise.race([previous, aborted]); return release;
      } catch (error) { previous.then(release); throw error; }
      finally { signal?.removeEventListener("abort", cancel); }
    },
    async prepare(settings, input, scope, signal) {
      await attach(settings);
      const refs = refsIn(input);
      if (refs.length) {
        if (!scope) throw failure("BUSINESS_REFERENCE_INVALID");
        const restored = await call(settings, { action: "resolve", scope, refs }, signal);
        privacy.hydrate(restored.records);
      }
      return refs;
    },
    async intent(settings, route, payload, scope, refs = [], signal) {
      if (!scope || ["/mongodb/query", "/mongodb/bulk/job", "/mongodb/bulk/jobs", "/mongodb/mutations/list"].includes(route)) return;
      // Make input mappings durable before a remote plan/job can refer to them.
      const checkpoint = await call(settings, { action: "commit", scope, records: privacy.pending().filter((record) => record.scope === scope), refs, tasks: taskIdentities(payload) }, signal);
      privacy.acknowledge(checkpoint.aliases);
      refs = [...new Set([...refs, ...Object.values(checkpoint.aliases)])];
      const { operationId, deadlineAt, timeoutMs, ...request } = guard.sanitize(payload).value;
      const identity = Object.fromEntries(["instanceId", "jobId", "mutationId", "planHash", "chunkIndex"].filter((field) => request[field] !== undefined).map((field) => [field, request[field]]));
      // pause/resume are explicitly requested state transitions. A completed
      // pause must not suppress a later pause after an intervening resume.
      const intent = await call(settings, { action: "intent", route, request, identity, scope, refs,
        ...(route === "/mongodb/mutations/prepare" ? { dispatchDigest: prepareRequestDigest(payload) } : {}),
        renew: route === "/mongodb/bulk/control" }, signal);
      if (intent.state === "uncertain") {
        if (intent.prepare) {
          const recovered = await call(settings, { action: "recover_operation", mode: "reconcile", scope, id: intent.id }, signal);
          if (recovered.state === "prepared") return { id: intent.id, state: "prepared", result: recovered.result };
          throw failure("BUSINESS_OPERATION_RECONCILIATION_REQUIRED", intent.id);
        }
        let evidence = { state: "unavailable" };
        try {
          const statusRoute = identity.jobId ? "/mongodb/bulk/job" : identity.mutationId ? "/mongodb/mutations/list" : undefined;
          if (statusRoute) {
            const result = await fetchJson(settings, statusRoute, { method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ instanceId: request.instanceId, ...(identity.jobId ? { jobId: identity.jobId } : {}) }), timeoutMs: 15000, signal });
            // Existing remote journal/lease/receipts remain authoritative. An
            // observation never changes an uncertain intent to replayable.
            evidence = guard.sanitize(result.parsed).value;
          }
          const reconciled = await call(settings, { action: "reconcile", scope, id: intent.id, result: evidence }, signal);
          if (reconciled.state === "complete") return { id: intent.id, ...reconciled };
        } catch { /* Remain uncertain and pinned. */ }
        throw failure("BUSINESS_OPERATION_RECONCILIATION_REQUIRED", intent.id);
      }
      return intent;
    },
    async dispatchPrepare(settings, intent, scope, request, operation) {
      try {
        return await call(settings, { action: "dispatch_prepare", id: intent.id, attempt: intent.prepare.attempt,
          scope, request, operationId: operation.operationId, deadlineAt: operation.deadlineAt, timeoutMs: request.timeoutMs }, operation.signal);
      } catch (error) { error.intentId = intent.id; throw error; }
    },
    async recover(settings, input, scope, operation) {
      return call(settings, { action: "recover_operation", id: input.intentId, mode: input.mode || "inspect", scope,
        operationId: operation.operationId, deadlineAt: operation.deadlineAt, timeoutMs: input.timeoutMs }, operation.signal);
    },
    async outcome(settings, intent, scope, result, signal) {
      if (intent) await call(settings, { action: "outcome", scope, id: intent.id, result: guard.sanitize(result).value }, signal);
    },
    async finish(settings, result, context = {}, input, intent, usedRefs = []) {
      const payload = JSON.parse(result.content[0].text);
      const records = privacy.pending();
      const scope = context.scope || records[0]?.scope;
      if (!scope) { if (records.length) throw failure(); return result; }
      const tasks = taskIdentities(payload);
      for (const task of taskIdentities(input)) if (!tasks.some((item) => item.id === task.id)) tasks.push(task);
      // Keep an intent's pins until its output and real task links commit. The
      // synthetic association can then expire under the rollback retention.
      if (intent) tasks.push({ id: "operation:" + intent.id, status: "completed" });
      const committed = await call(settings, { action: "commit", scope, records, refs: [...new Set([...refsIn(payload), ...usedRefs])], tasks, output: payload, deliveryId: randomUUID() });
      privacy.acknowledge(committed.aliases);
      const value = replace(payload, committed.aliases);
      context.deliveryId = committed.deliveryId;
      return { ...result, content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
    },
    async published(settings, context) {
      if (!context?.deliveryId) return;
      try {
        await call(settings, { action: "delivered", scope: context.scope, id: context.deliveryId });
        if (++published % 16 === 0) await call(settings, { action: "cleanup", limit: 100 });
      } catch { /* Prepared delivery stays recoverable; stdout is already sent. */ }
    },
  };
}
