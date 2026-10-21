import { PrivacyStore } from "../../privacy-store.js";
process.once("message", ({ directory, key, auth, scope, ref, boundary }) => {
  const store = new PrivacyStore({ directory, key: Buffer.from(key, "hex"), fault: (point) => { if (point === boundary) process.kill(process.pid, "SIGKILL"); } });
  store.execute("commit", { auth, scope, records: [{ ref, scope, value: "PRIVATE_CRASH_ATOMICITY" }], tasks: [{ id: "disposable-job" }], output: { _id: ref } });
  throw new Error("Crash fault did not trigger");
});
