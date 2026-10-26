import { PrivacyStore } from "../../privacy-store.js";
process.on("message", input => {
  const store = new PrivacyStore({ directory: input.directory, key: Buffer.from(input.key, "hex"),
    fault: boundary => { if (boundary === input.boundary) process.kill(process.pid, "SIGKILL"); } });
  store.execute(input.action, input.args);
  process.exit(98);
});
