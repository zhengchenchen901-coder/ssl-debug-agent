import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { PrivacyStore } from "../../privacy-store.js";
import { privacyRequest, humanRiskRequest } from "../../privacy-service.js";
import { RISK_CONFIRMATION } from "../../mongodb-risk-replacement.js";
import { FENCE_COVERAGE, digest } from "../../mongodb-fence-authority.js";
import { businessTargetScope } from "../../../plugins/remote-debug-agent/business-privacy.js";
import { bulkPreparePayload } from "../../../plugins/remote-debug-agent/prepare-protocol.js";
import { bulkSandboxFixture } from "./bulk-sandbox-fixture.js";

export const wire = value => JSON.parse(JSON.stringify(bulkPreparePayload(value)));
export function riskReplacementFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rda-risk-replacement-")); fs.chmodSync(root, 0o700);
  const directory = path.join(root, "storage"), receiptDirectory = path.join(root, "authority-receipts"), trustFile = path.join(root, "authority.json");
  fs.mkdirSync(receiptDirectory, { mode: 0o700 });
  const pair = generateKeyPairSync("ed25519"), issuer = "isolated-fixture-authority";
  fs.writeFileSync(trustFile, JSON.stringify({ version: 1, issuer, boundaryType: "externally-enforced-legacy-retirement-v1", publicKey: pair.publicKey.export({ type: "spki", format: "pem" }) }), { mode: 0o600 });
  const h = bulkSandboxFixture(t), instance = { id: "isolated", host: "fixture.invalid", mongodb: h.config }, origin = "http://127.0.0.1:49999";
  const scope = businessTargetScope(origin, instance, "business"), key = randomBytes(32), fenceAuthority = { trustFile, receiptDirectory };
  let clock = Date.now(), store = new PrivacyStore({ directory, key, fenceAuthority, now: () => options.liveClock ? Date.now() : clock, riskPolicy: options.humanRisk ? undefined : "external-fence-v1", fault: options.fault });
  const auth = store.execute("create");
  const original = wire({ instanceId: instance.id, database: "business", jobId: "legacy-original", chunkIndex: 0, purpose: "isolated fixture", units: [
    { unitId: "one", operations: [
      { operation: "updateOne", collection: "orders", id: "order-1", expected: { count: { exists: true, value: 0 } }, update: { $inc: { count: 3 } } },
      { operation: "insertOne", collection: "orders", document: { _id: "compensation-1", remediation_job_id: "legacy-original", value: 3, restored_batches: [{ date: "2025-10-26", remaining: 3 }] } },
    ] },
  ] });
  options.editOriginal?.(original);
  const call = (action, input = {}) => store.execute(action, { auth, scope, ...input });
  const old = call("intent", { route: "/mongodb/bulk/prepare", request: original, identity: { instanceId: instance.id, jobId: original.jobId, chunkIndex: 0 } });
  const parent = call("prepare_disposition", { id: old.id, request: original, requestDigest: digest(original) });
  if (!options.humanRisk) call("quarantine_disposition", { dispositionId: parent.dispositionId, reviewHash: parent.reviewHash, confirmation: "确认隔离原意图" });
  const candidate = structuredClone(original); candidate.jobId = "approved-replacement"; candidate.units[0].operations[1].document.remediation_job_id = candidate.jobId;
  const prepare = (replacementRequest = candidate) => call("prepare_risk_replacement", { dispositionId: parent.dispositionId, reviewHash: parent.reviewHash, originalRequest: original, replacementRequest });
  const receiptPath = plan => path.join(receiptDirectory, plan.riskPlanId + ".json");
  const issue = (plan, overrides = {}, signingKey = pair.privateKey) => {
    const issuedAt = options.liveClock ? Date.now() : clock;
    const payload = { issuer, receiptId: "fixture-permanent-retirement", riskPlanId: plan.riskPlanId, challengeDigest: digest(plan.fenceChallenge), issuedAt, validUntil: issuedAt + 1800000,
      protection: "permanent", historicalOutcome: "unknown", inFlightTransactions: "terminal", restartSafe: true, legacyCredentialsRevoked: true,
      oldSessionsDrained: true, oldQueuesDrained: true, coverage: [...FENCE_COVERAGE], ...overrides };
    const receipt = { version: 1, payload, signature: sign(null, Buffer.from(JSON.stringify(payload)), signingKey).toString("base64") };
    fs.writeFileSync(receiptPath(plan), JSON.stringify(receipt), { mode: 0o600 }); return receipt;
  };
  const inspect = plan => call("inspect_risk_replacement", { riskPlanId: plan.riskPlanId });
  const approve = (plan, extra = {}) => store.execute("human_risk_approve", { riskPlanId: plan.riskPlanId, instanceId: instance.id, targetScope: scope,
    reviewHash: plan.reviewHash, confirmation: RISK_CONFIRMATION, actor: { username: "fixture-admin", sessionId: "fixture-human-session", verifiedAt: clock }, ...extra });
  const create = plan => call("create_risk_replacement", { riskPlanId: plan.riskPlanId, reviewHash: plan.reviewHash });
  const service = { call: async (action, input) => store.execute(action, input) };
  const requests = [];
  const requestOptions = { instance: id => id === instance.id ? instance : undefined, origin, dispatch: async (id, route, request) => {
    if (route === "/mongodb/bulk/job") return { ok: true, ...await h.run({ action: "get", jobId: request.jobId }) };
    requests.push(route);
    if (options.humanRisk && route === "/mongodb/bulk/retire") { const { operationId, timeoutMs, deadlineAt, ...body } = request; return { ok: true, ...await h.run({ action: "retire", ...body }) }; }
    if (options.humanRisk && route === "/mongodb/bulk/job") { return { ok: true, ...await h.run({ action: "get", jobId: request.jobId }) }; }
    if (route !== "/mongodb/bulk/prepare") throw Error("Unexpected fixture dispatch: " + route);
    const { operationId, timeoutMs, deadlineAt, ...chunk } = request;
    return { ok: true, ...await h.run({ action: "upload", chunk }) };
  } };
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, directory, key, fenceAuthority, trustFile, receiptDirectory, receiptPath, h, instance, origin, scope, auth, original, candidate, old, parent,
    call, prepare, issue, inspect, approve, create, service, requestOptions, requests,
    public: input => privacyRequest(service, { action: "disposition", auth, scope, ...input }, requestOptions),
    human: (action, input) => humanRiskRequest(service, action, input, requestOptions.instance),
    advance: n => clock += n, get now() { return clock; }, get store() { return store; },
    reopen: () => { store.close(); store = new PrivacyStore({ directory, key, fenceAuthority, riskPolicy: options.humanRisk ? undefined : "external-fence-v1", now: () => options.liveClock ? Date.now() : clock }); },
  };
}
