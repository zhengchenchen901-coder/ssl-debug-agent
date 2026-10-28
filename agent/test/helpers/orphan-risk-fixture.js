import { randomUUID } from "node:crypto";
import { importRiskFixture, importWire } from "./import-risk-fixture.js";
import { businessTargetScope } from "../../../plugins/remote-debug-agent/business-privacy.js";
import { privacyRequest } from "../../privacy-service.js";
export function orphanRiskFixture(t, options = {}) {
  const f = importRiskFixture(t, options);
  f.instance.id = "test-server";
  f.instance.mongodb = { ...f.instance.mongodb, database: "yennefer", allowedDatabases: ["yennefer"] };
  const run = f.h.run; f.h.run = (request, policy = f.instance.mongodb) => run(request, policy);
  const scope = businessTargetScope(f.origin, f.instance, "yennefer");
  const original = importWire({ ...f.original, instanceId: "test-server", database: "yennefer", importId: "orphan-original" });
  const candidate = { ...original, importId: "orphan-followup" }, originalOperationId = randomUUID();
  const pub = input => privacyRequest(f.service, { action: "disposition", auth: f.auth, scope, ...input }, f.requestOptions);
  const input = { mode: "prepare_orphan_risk", originalOperationId, importId: original.importId, requestDigest: f.digest(original),
    originalRequest: original, replacementRequest: candidate, reviewMemo: "合成缺回执记录；不证明历史未派发。" };
  return { ...f, original, candidate, scope, input, pub,
    get store() { return f.store; }, get now() { return f.now; },
    prepare: (extra = {}) => pub({ ...input, ...extra }),
    inspect: p => pub({ mode: "inspect_orphan_risk", riskPlanId: p.riskPlanId }),
    consume: p => pub({ mode: "consume_orphan_risk", riskPlanId: p.riskPlanId, reviewHash: p.reviewHash }),
    approve: p => f.store.execute("human_orphan_risk_approve", { riskPlanId: p.riskPlanId, instanceId: f.instance.id,
      targetScope: scope, reviewHash: p.reviewHash, confirmation: p.confirmation,
      actor: { username: "synthetic-independent-admin", sessionId: "synthetic-session", verifiedAt: options.liveClock ? Date.now() : f.now } }) };
}
