import { parentPort, workerData } from "node:worker_threads";
import { PrivacyStore } from "./privacy-store.js";
let store;
try { store = new PrivacyStore(workerData); parentPort.postMessage({ ready: true }); }
catch (error) { parentPort.postMessage({ failed: error.code || "BUSINESS_STORAGE_UNAVAILABLE" }); }
parentPort.on("message", ({ id, action, input }) => {
  try {
    if (!store) throw new Error();
    const result = action === "close" ? store.close() : store.execute(action, input);
    parentPort.postMessage({ id, result });
  } catch (error) { parentPort.postMessage({ id, error: error.code?.startsWith("BUSINESS_") ? error.code : "BUSINESS_STORAGE_UNAVAILABLE" }); }
});
