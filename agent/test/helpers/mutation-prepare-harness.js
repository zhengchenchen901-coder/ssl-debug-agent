import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { runMongoMutation } from "../../mongodb-mutations.js";

// Runs the emitted Node-12 helper against a fake driver and disposable files.
// The path adapter cannot read a saved connection profile or business database.
export function mutationPrepareHarness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rda-prepare-fixture-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { enabled: true, writeEnabled: true, database: "business", allowedDatabases: ["business"],
    allowedCollections: ["orders"], configPath: "/home/app/config.json", driverPath: "/home/app/node_modules/mongodb",
    configProfile: "fixture", uriKey: "url", rollbackRoot: "/tmp/remote-debug-agent/prepare-fixture" };
  const state = { indexes: [{ name: "_id_", key: { _id: 1 } }], reads: 0, writes: 0, sshCalls: 0 };
  const translate = (file) => {
    if (typeof file === "number") return file;
    if (typeof file !== "string" || !file.startsWith(config.rollbackRoot + "/") && file !== config.rollbackRoot) throw Error("Unexpected fixture path");
    return root + file.slice(config.rollbackRoot.length);
  };
  const adapter = { constants: fs.constants };
  for (const method of ["existsSync", "lstatSync", "statSync", "mkdirSync", "chmodSync", "openSync", "unlinkSync", "readdirSync"]) {
    adapter[method] = (file, ...args) => fs[method](translate(file), ...args);
  }
  adapter.readFileSync = (file, ...args) => file === config.configPath ? JSON.stringify({ fixture: { url: "fixture-only" } }) : fs.readFileSync(translate(file), ...args);
  adapter.writeFileSync = (file, ...args) => fs.writeFileSync(translate(file), ...args);
  adapter.renameSync = (from, to) => fs.renameSync(translate(from), translate(to));
  adapter.closeSync = fs.closeSync;
  adapter.fsyncSync = fs.fsyncSync;
  class MongoClient {
    async connect() {}
    async close() {}
    db() { return { collection: () => ({
      listIndexes: () => ({ toArray: async () => { state.reads++; if (state.beforeRead) await state.beforeRead(); return structuredClone(state.indexes); } }),
      createIndex: async (key, options) => { state.writes++; state.indexes.push({ key, ...options }); if (state.afterWrite) await state.afterWrite(); },
    }) }; }
  }
  const require = (name) => {
    if (name === "fs") return adapter;
    if (name === "path") return path.posix;
    if (name === "crypto") return crypto;
    if (name === config.driverPath) return { MongoClient };
    throw Error("Unexpected fixture module");
  };
  require.resolve = () => { throw Error("No BSON dependency in fixture"); };
  const run = (input, policy = config) => runMongoMutation(input, { config: policy, runSSH: async (_command, { stdin }) => {
    state.sshCalls++;
    let stdout = "";
    const process = { pid: 123, exitCode: 0, stdout: { write: (chunk) => { stdout += chunk; } } };
    await new vm.Script(stdin).runInNewContext({ require, process, Buffer });
    if (state.dropReply) { state.dropReply = false; throw Object.assign(Error("Lost helper reply"), { code: "ECONNRESET" }); }
    return { stdout, stderr: "", exitCode: process.exitCode, timedOut: false };
  } });
  return { config, root, state, run };
}
