import fs from "node:fs";
import { importHarness } from "./import-fixture.js";
const [root, requestFile, stage] = process.argv.slice(2);
if (!root || !fs.statSync(root).isDirectory()) throw Error("Disposable fixture root required");
const h = importHarness({ realFiles: root, fault: file => {
  if (stage === "closure" && file.endsWith("/execution-continuation.json") ||
      stage === "child" && file.endsWith("/manifest.json") && JSON.parse(fs.readFileSync(file)).executionContinuation)
    process.kill(process.pid, "SIGKILL");
} });
await h.run(JSON.parse(fs.readFileSync(requestFile)));
