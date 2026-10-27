import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { PrivacyStore } from "../../privacy-store.js";
import { privacyRequest, humanRiskRequest } from "../../privacy-service.js";
import { businessTargetScope } from "../../../plugins/remote-debug-agent/business-privacy.js";
import { importPreparePayload, prepareRequestDigest } from "../../../plugins/remote-debug-agent/prepare-protocol.js";
import { importConfig, importHarness } from "./import-fixture.js";
export const importWire = value => JSON.parse(JSON.stringify(importPreparePayload(value)));
export function importRiskFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rda-import-risk-")); fs.chmodSync(root, 0o700);
  const directory = path.join(root, "private"), key = randomBytes(32), h = options.harness || importHarness();
  const instance = { id: "isolated", host: "fixture.invalid", enabled: true, mongodb: importConfig }, origin = "http://127.0.0.1:49998";
  const scope = businessTargetScope(origin, instance, "test");
  let now = Date.now(), store = new PrivacyStore({ directory, key, now: () => options.liveClock ? Date.now() : now });
  const auth = store.execute("create");
  const original = importWire({ instanceId: instance.id, database: "test", importId: "original-import", collection: "members", batchSize: 2,
    documents: [{ _id: "synthetic-a", nested: { z: 1, a: 2 } }, { _id: "synthetic-b", value: 2 }, { _id: "synthetic-c", value: 3 }], purpose: "disposable import" });
  options.editOriginal?.(original);
  const call = (action, input = {}) => store.execute(action, { auth, scope, ...input });
  // Historical imports did not retain importId in identity. The keyed request
  // still binds every original byte, independently of that missing metadata.
  const old = call("intent", { route: "/mongodb/imports/prepare", request: original, identity: { instanceId: instance.id } });
  const candidate = { ...structuredClone(original), importId: "replacement-import" }, requests = [];
  const service = { call: async (action, input) => store.execute(action, input) };
  const requestOptions = { instance: id => id === instance.id ? instance : undefined, origin, dispatch: async (_id, route, request) => {
    requests.push(route);
    const modes = { "/mongodb/imports/review": "import_review", "/mongodb/imports/retire": "import_retire", "/mongodb/imports/recover-prepare": "import_recover" };
    const body = route === "/mongodb/imports/prepare" ? { ...request, kind: "import_plan", mode: "prepare" } : { ...request, mode: modes[route] };
    if (!body.mode) throw Error("Unexpected isolated route " + route);
    return { ok: true, ...await h.run(body) };
  } };
  const pub = input => privacyRequest(service, { action: "disposition", auth, scope, ...input }, requestOptions);
  const parent = () => pub({ mode: "prepare", id: old.id, originalRequest: original });
  const prepare = async (replacementRequest = candidate, extra = {}) => { const p = await parent(); return pub({ mode: "prepare_risk", dispositionId: p.dispositionId, reviewHash: p.reviewHash,
    originalRequest: original, replacementRequest, ...extra }); };
  const approve = plan => store.execute("human_risk_approve", { riskPlanId: plan.riskPlanId, instanceId: instance.id, targetScope: scope,
    reviewHash: plan.reviewHash, confirmation: plan.confirmation, actor: { username: "synthetic-admin", sessionId: "synthetic-session", verifiedAt: options.liveClock ? Date.now() : now } });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, directory, key, h, instance, origin, scope, auth, original, candidate, old, call, service, requestOptions, pub, parent, prepare, approve, requests,
    create: plan => pub({ mode: "create_replacement", riskPlanId: plan.riskPlanId, reviewHash: plan.reviewHash }),
    human: (action, input) => humanRiskRequest(service, action, input, requestOptions.instance),
    inspect: plan => call("inspect_risk_replacement", { riskPlanId: plan.riskPlanId }),
    get store() { return store; }, get now() { return now; }, advance: ms => now += ms,
    reopen: () => { store.close(); store = new PrivacyStore({ directory, key, now: () => options.liveClock ? Date.now() : now }); }, digest: prepareRequestDigest };
}
