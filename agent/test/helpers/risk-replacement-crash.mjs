import { PrivacyStore } from "../../privacy-store.js";
process.on("message", input => {
  const store = new PrivacyStore({ directory: input.directory, key: Buffer.from(input.key, "hex"), fenceAuthority: input.fenceAuthority,
    fault: boundary => { if (boundary === input.boundary) process.kill(process.pid, "SIGKILL"); } });
  store.execute("create_risk_replacement", { auth: input.auth, scope: input.scope, riskPlanId: input.plan.riskPlanId, reviewHash: input.plan.reviewHash });
});
