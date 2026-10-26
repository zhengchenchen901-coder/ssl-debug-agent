import { PrivacyStore } from "../../privacy-store.js";
import { DISPOSITION_CONFIRMATION } from "../../mongodb-disposition.js";
process.on("message", input => {
  const store = new PrivacyStore({ directory: input.directory, key: Buffer.from(input.key, "hex"), fault: boundary => {
    if (boundary !== input.boundary) return;
    if (process.platform === "win32") { process.send({ boundary }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }
    else process.kill(process.pid, "SIGKILL");
  } });
  store.execute("quarantine_disposition", { auth: input.auth, scope: input.scope, dispositionId: input.plan.dispositionId,
    reviewHash: input.plan.reviewHash, confirmation: DISPOSITION_CONFIRMATION });
});
