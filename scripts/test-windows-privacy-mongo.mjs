// Creates only disposable containers and a dedicated loopback replica set.
// Run with local fixture image/driver paths; never loads user instance settings.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { once } from "node:events";
if (process.platform !== "win32") throw new Error("Native Windows runner required");
const driver = process.env.RDA_PRIVACY_TEST_DRIVER;
if (!driver || !path.isAbsolute(driver)) throw new Error("Absolute disposable-test MongoDB driver path required");
const suffix = randomBytes(6).toString("hex"), network = `rda-win-privacy-net-${suffix}`;
const mongo = `rda-win-privacy-mongo-${suffix}`, helper = `rda-win-privacy-${suffix}`;
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 60000 });
const owned = [];
try {
  docker("network", "create", network); owned.push(["network", "rm", network]);
  docker("run", "-d", "--name", mongo, "--network", network, "-p", "127.0.0.1::27017", process.env.RDA_PRIVACY_TEST_MONGO_IMAGE || "mongo:4.4.30", "--replSet", "rdaPrivacy", "--bind_ip_all"); owned.push(["rm", "-f", "-v", mongo]);
  for (let attempt = 0; ; attempt++) {
    try { docker("exec", mongo, "mongo", "--quiet", "--eval", `rs.initiate({_id:'rdaPrivacy',members:[{_id:0,host:'${mongo}:27017'}]})`); break; }
    catch { if (attempt > 30) throw new Error("Disposable MongoDB did not become ready"); await new Promise((r) => setTimeout(r, 500)); }
  }
  for (let attempt = 0; ; attempt++) {
    const ready = docker("exec", mongo, "mongo", "--quiet", "--eval", "db.isMaster().ismaster").trim();
    if (ready === "true") break;
    if (attempt > 60) throw new Error("Disposable replica set did not elect a primary"); await new Promise((r) => setTimeout(r, 500));
  }
  docker("run", "-d", "--name", helper, "--network", network, "--entrypoint", "node", process.env.RDA_PRIVACY_TEST_HELPER_IMAGE || "yj/od-yennefer-be:prod-like-local", "-e", "setInterval(()=>{},1000000)"); owned.push(["rm", "-f", "-v", helper]);
  const port = docker("port", mongo, "27017/tcp").trim().split(":").at(-1);
  let remoteDriver;
  if (process.env.RDA_PRIVACY_TEST_COPY_DRIVER === "1") {
    docker("exec", helper, "mkdir", "-p", "/tmp/rda-privacy-driver");
    docker("cp", path.dirname(driver), `${helper}:/tmp/rda-privacy-driver/node_modules`);
    remoteDriver = "/tmp/rda-privacy-driver/node_modules/mongodb";
  } else remoteDriver = docker("exec", helper, "node", "-e", "console.log(require.resolve('mongodb'))").trim();
  console.log("Dedicated replica set ready; native Windows MCP/credential tests starting.");
  const child = spawn(process.execPath, ["--test", "plugins/remote-debug-agent/test/business-privacy-mongo.e2e.mjs"], { stdio: "inherit", env: { ...process.env,
    RDA_PRIVACY_TEST_URI: `mongodb://127.0.0.1:${port}/?directConnection=true`, RDA_PRIVACY_TEST_CONTAINER: helper,
    RDA_PRIVACY_TEST_REMOTE_URI: `mongodb://${mongo}:27017/?directConnection=true`, RDA_PRIVACY_TEST_REMOTE_DRIVER: remoteDriver } });
  const [code] = await once(child, "exit"); process.exitCode = code ?? 1;
} finally {
  for (const args of owned.reverse()) { try { docker(...args); } catch { console.error("Disposable resource cleanup failed: " + args.at(-1)); process.exitCode = 1; } }
  console.log("Disposed this run's test containers and network.");
}
