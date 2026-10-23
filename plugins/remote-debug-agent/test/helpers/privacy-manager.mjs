// Disposable subprocess fixture: real authenticated Manager and storage Worker,
// with its remote transport restricted to a parent-owned loopback HTTP fixture.
import { createManagerApp } from "../../../../agent/server.js";
import { InstanceRegistry } from "../../../../agent/instance-registry.js";
import { loadConfig } from "../../../../agent/config.js";
import { PrivacyService } from "../../../../agent/privacy-service.js";
import { createRequire } from "node:module";
import http from "node:http";
import path from "node:path";
import localAuth from "../../local-auth.cjs";

process.once("message", async ({ root, port, backend, key, bundled }) => {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(backend)) throw new Error("Loopback fixture only");
  const registry = new InstanceRegistry({ cwd: root, env: {}, registryPath: path.join(root, "instances.json") });
  if (!registry.getInternal("isolated")) registry.create({ id: "isolated", name: "Disposable", host: "fixture.invalid", username: "fixture", privateKeyPath: "/fixture",
    hostKeyFingerprints: ["SHA256:" + "A".repeat(43)], mongodb: { enabled: true, database: "business", configPath: "/home/app/config.json", driverPath: "/home/app/node_modules/mongodb", configProfile: "fixture", uriKey: "url" } });
  const config = loadConfig({}, root); config.agent = { host: "127.0.0.1", port }; config.runtime.statePath = path.join(root, ".runtime", "state.json");
  const workerManager = { publicInstances: () => registry.list(), callInstance: async (id, route, payload) => {
    const response = await fetch(backend + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (result.__crashAfterRemote) process.kill(process.pid, "SIGKILL");
    return { instanceId: id, ...result };
  } };
  const runtime = bundled ? createRequire(import.meta.url)(path.resolve(import.meta.dirname, "../../runtime/agent/server.cjs")) : { createManagerApp };
  const service = new PrivacyService({ directory: path.join(root, ".private", "business"), ...(key ? { key: Buffer.from(key, "hex") } : {}),
    ...(bundled ? { workerPath: path.resolve(import.meta.dirname, "../../runtime/agent/privacy-worker.cjs") } : {}) });
  const app = runtime.createManagerApp({ config, registry, workerManager, privacyService: service,
    authToken: localAuth.readAuthToken(localAuth.resolveAuthFile(root)) });
  const server = http.createServer(app);
  server.listen(port, "127.0.0.1", () => process.send({ ready: true, port: server.address().port }));
  process.on("disconnect", () => process.exit());
});
