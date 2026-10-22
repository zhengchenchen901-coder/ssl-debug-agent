import { FinalResultStore } from "./final-results.js";
import { createOutputGuard } from "../plugins/remote-debug-agent/output-guard.js";

const invalid = () => Object.assign(new Error("FINAL_RESULT_INVALID"), { code: "FINAL_RESULT_INVALID", statusCode: 400 });
function scope(request) {
  if (request.query.scope === "manager" && request.query.instanceId === undefined) return null;
  if (request.query.scope !== undefined || typeof request.query.instanceId !== "string") throw invalid();
  return request.query.instanceId;
}
function asyncRoute(handler) {
  return (request, response) => Promise.resolve().then(() => handler(request, response)).catch((error) => {
    // Never expose driver/OS messages, paths from failed writes, or submitted data.
    const code = /^FINAL_RESULT_[A-Z_]+$/.test(error.code || "") ? error.code : error.code === "ENOSPC" ? "FINAL_RESULT_DISK_FULL" : "FINAL_RESULT_STORAGE_FAILED";
    response.status(error.statusCode || (code === "FINAL_RESULT_DISK_FULL" ? 507 : 500)).json({ ok: false, error: { code, message: code, retriable: false } });
  });
}

export function installFinalResultRoutes(app, { root, registry, store } = {}) {
  const guard = createOutputGuard();
  function sanitize(input) {
    guard.remember(app.locals.authToken);
    for (const instance of registry.listInternal()) {
      guard.remember(instance.passphrase);
      guard.remember(instance.mongodb?.sandboxManagementPassword);
    }
    return guard.sanitize(input).value;
  }
  const results = store || new FinalResultStore({ root, sanitize });
  app.locals.finalResults = results;

  app.post("/api/final-results", asyncRoute(async (request, response) => {
    const { operationId: _operationId, deadlineAt: _deadlineAt, ...input } = request.body || {};
    // Explicit binding only: never place an unknown/deleted instance under a
    // different instance or silently fall back to the Manager/default instance.
    if (input.instanceId !== null && !registry.getInternal(input.instanceId)) throw Object.assign(invalid(), { code: "FINAL_RESULT_INSTANCE_NOT_FOUND", statusCode: 404 });
    const published = await results.publishFinalResult(input);
    response.status(published.duplicate ? 200 : 201).json({ ok: true, ...published });
  }));
  app.get("/api/final-results", asyncRoute(async (request, response) => {
    response.json({ ok: true, ...await results.listFinalResults({ instanceId: scope(request), offset: Number(request.query.offset || 0), limit: Number(request.query.limit || 20) }) });
  }));
  app.get("/api/final-results/:taskId", asyncRoute(async (request, response) => {
    response.json({ ok: true, result: await results.getFinalResult(scope(request), request.params.taskId) });
  }));
  app.delete("/api/final-results/:taskId", asyncRoute(async (request, response) => {
    response.json({ ok: true, ...await results.cleanupFinalResult(scope(request), request.params.taskId) });
  }));
  app.get("/api/final-results/:taskId/artifacts/:artifactId", asyncRoute(async (request, response) => {
    const { file, content } = await results.openArtifact(scope(request), request.params.taskId, request.params.artifactId);
    if (request.query.download === "1") {
      // Even HTML is delivered as a download, never executed on the Manager origin.
      response.attachment(file.format === "binary" ? file.name : `${file.name}.${{ markdown: "md", text: "txt" }[file.format] || file.format}`);
      response.type("application/octet-stream").send(content);
      return;
    }
    if (file.encoding === "binary") {
      response.json({ ok: true, file, content: "该附件请下载后查看。", truncated: false, previewAvailable: false });
      return;
    }
    const maxBytes = request.query.maxBytes === undefined ? 65536 : Number(request.query.maxBytes);
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 262144) throw invalid();
    response.json({ ok: true, file, content: content.subarray(0, maxBytes).toString("utf8"), truncated: content.length > maxBytes });
  }));
  return results;
}
