import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

test("isolated bundle enforces profile/hash authorization and sends a standalone fixed helper", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rda-bundled-services-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pluginRoot = path.resolve(import.meta.dirname, "..");
  await fs.copyFile(path.join(pluginRoot, "runtime/agent/server.cjs"), path.join(root, "server.cjs"));
  const script = String.raw`
const assert = require("node:assert/strict"), http = require("node:http"), vm = require("node:vm"), path = require("node:path"), crypto = require("node:crypto");
const { createApp } = require("./server.cjs");
(async () => {
  const profile = { instanceId:"fixture", target:{host:"fixture.invalid",port:22,username:"ops"}, enabled:true,
    cwd:"/home/github/bundled-fixture",entry:"index.js",mode:"fork",interpreter:"/home/github/node20/bin/node",nodeVersion:"20.20.2",
    pm2Path:"/usr/local/bin/pm2",pm2Home:"/root/.pm2",envFiles:[],processes:[{name:"fixture",env:{NODE_ENV:"test"},ports:[9999]}],
    maxMemoryRestart:"2G",restartDelayMs:5000,stableMs:5000,startupTimeoutMs:60000,startupMarker:"READY",persist:true };
  const hash = crypto.createHash("sha256").update(JSON.stringify(profile)).digest("hex");
  const config = { instanceId:"fixture",agent:{host:"127.0.0.1",port:0},ssh:{host:"fixture.invalid",port:22,username:"ops"},
    security:{allowedPaths:["/home/github","/root/.pm2"]},serviceProfiles:{be:profile},audit:{logPath:path.resolve("audit.jsonl")} };
  let calls = 0;
  const app = createApp({ config,authToken:"a".repeat(64),runSSH:async (command,options) => {
    calls++; assert.equal(command,"node");
    let stdout = "";
    // Real isolated execution stops at a nonexistent local fixture path. No SSH
    // or PM2 executable is invoked. This detects bundled closure dependencies.
    await vm.runInNewContext(options.stdin,{require,Buffer,process,setTimeout,console:{log:line=>{stdout+=line+"\n";}}});
    return {exitCode:0,stdout};
  } });
  const server=http.createServer(app); await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const base="http://127.0.0.1:"+server.address().port;
  async function post(body){const res=await fetch(base+"/services/start",{method:"POST",headers:{Authorization:"Bearer "+"a".repeat(64),"Content-Type":"application/json"},body:JSON.stringify(body)});return {status:res.status,body:await res.json()};}
  try {
    const input={serviceId:"be",profileHash:hash,confirmation:"启动服务"};
    const denied=await post({...input,cmd:"id"}); assert.equal(denied.status,400); assert.equal(calls,0);
    const stale=await post({...input,profileHash:"b".repeat(64)}); assert.equal(stale.body.error.code,"SERVICE_PROFILE_STALE"); assert.equal(calls,0);
    const checked=await post(input); assert.equal(calls,1); assert.equal(checked.body.status,"blocked");
    assert.equal(checked.body.error.code,"SERVICE_FILESYSTEM_ENOENT");
    assert.equal(checked.body.phase,"paths");
    const cap=await (await fetch(base+"/api/capabilities",{headers:{Authorization:"Bearer "+"a".repeat(64)}})).json();
    assert.equal(cap.capabilities.services.arbitraryCommands,false); assert.deepEqual(cap.capabilities.services.modes,["fork"]);
    console.log("isolated bundled service helper and authorization verified");
  } finally { await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);process.exitCode=1;});
`;
  const result = spawnSync(process.execPath, ["-e", script], { cwd: root, env: { ...process.env, NODE_PATH: "" }, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /isolated bundled service helper/);
});
