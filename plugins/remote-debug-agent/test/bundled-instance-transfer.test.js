import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

test("isolated bundled manager downloads, previews and imports without source dependencies or remote calls", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rda-bundled-transfer-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.copyFile(new URL("../runtime/agent/server.cjs", import.meta.url), path.join(root, "server.cjs"));
  const script = String.raw`
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), http = require("node:http");
const { createManagerApp } = require("./server.cjs");
(async () => {
  const authToken = "b".repeat(64), password = "bundled-transfer-fixture-123", key = Buffer.from("bundled fixture key\r\n");
  const workerManager = { publicInstances: () => [], runtimeFor: () => ({ status: "stopped" }), callInstance: () => { throw new Error("remote calls forbidden"); } };
  const app = createManagerApp({ cwd: process.cwd(), env: {}, authToken, workerManager });
  fs.writeFileSync("fixture-key", key);
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  async function post(route, body) {
    const response = await fetch(base + route, { method: "POST", headers: { Authorization: "Bearer " + authToken, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  try {
    const created = await post("/api/instances", { id:"source",name:"Source",host:"fixture.invalid",username:"ops",privateKeyPath:path.resolve("fixture-key"),passphrase:"fixture-passphrase" });
    assert.equal(created.status,201);
    const exported = await post("/api/instances/source/export",{password}); assert.equal(exported.status,200);
    assert.match(exported.headers.get("content-disposition"),/attachment/);
    assert.ok(!JSON.stringify(exported.body).includes("fixture-passphrase"));
    const preview = await post("/api/instances/import/preview",{password,bundle:exported.body}); assert.equal(preview.status,200); assert.equal(preview.body.preview.hasPassphrase,true);
    const imported = await post("/api/instances/import",{password,bundle:exported.body,id:"copy",name:"Copy"}); assert.equal(imported.status,201); assert.equal(imported.body.runtime.status,"stopped");
    assert.deepEqual(fs.readFileSync(imported.body.instance.privateKeyPath),key);
    const stored = app.locals.registry.getInternal("copy"); assert.equal(stored.passphrase,"fixture-passphrase");
    assert.ok(!JSON.stringify(imported.body).includes("fixture-passphrase"));
    console.log("isolated bundled instance transfer verified");
  } finally { app.locals.resourceManager.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error=>{console.error(error);process.exitCode=1;});
`;
  const result = spawnSync(process.execPath, ["-e", script], { cwd: root, env: { ...process.env, NODE_PATH: "" }, encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /isolated bundled instance transfer verified/);
});
