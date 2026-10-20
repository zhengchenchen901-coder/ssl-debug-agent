import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import vm from "node:vm";
import { normalizeServiceProfiles, serviceProfileHash, selectServiceProfile } from "../service-profiles.js";
import { serviceStartRuntime } from "../service-start-runtime.js";
import { buildServiceScript, runService, validateServiceRequest } from "../services.js";
import { InstanceRegistry } from "../instance-registry.js";
import { allowedPathsForSourceRoots, loadConfig, configFingerprint } from "../config.js";

const require = createRequire(import.meta.url);
const example = JSON.parse(fs.readFileSync(new URL("../../docs/examples/test-server-be-service.json", import.meta.url)));
const raw = () => structuredClone(example.profile);
const context = { id: "test-server", host: "8.209.81.113", port: 22, username: "root", allowedPaths: allowedPathsForSourceRoots() };
const normalize = (p = raw()) => normalizeServiceProfiles({ be: p }, context).be;
const invoke = vm.runInNewContext(`(${serviceStartRuntime.toString()})`, { require, Buffer, process, setTimeout });

test("profiles persist privately and never infer/copy another instance's configuration", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "service-registry-")); t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const registry = new InstanceRegistry({ cwd: dir, env: {} });
  registry.create({ id: "test-server", host: context.host, username: "root", privateKeyPath: "/key", serviceProfiles: { be: raw() } });
  registry.create({ id: "default", host: "untested.invalid", username: "app", privateKeyPath: "/other" });
  const untouched = structuredClone(registry.getInternal("default"));
  assert.deepEqual(untouched.serviceProfiles, {});
  assert.throws(() => registry.update("default", { serviceProfiles: { be: raw() } }), /target must match/);
  assert.throws(() => selectServiceProfile(untouched.serviceProfiles, { serviceId: "be" }), { code: "SERVICE_PROFILE_NOT_FOUND" });
  registry.update("test-server", { name: "test" });
  assert.deepEqual(registry.getInternal("default"), untouched);
  const reopened = new InstanceRegistry({ cwd: dir, env: {} });
  assert.deepEqual(reopened.get("test-server").serviceProfiles.be, normalize());
  assert.throws(() => reopened.update("test-server", { host: "other.invalid" }), /target must match/);
  if (process.platform !== "win32") assert.equal(fs.statSync(registry.registryPath).mode & 0o777, 0o600);
});

test("profile validation rejects commands, secrets, cluster, unsafe paths, duplicates and cross-instance bindings", () => {
  const mutations = [
    p => { p.entry = "ecosystem.config.js"; }, p => { p.entry = "backend.config.js"; }, p => { p.command = "sh"; }, p => { p.mode = "cluster"; }, p => { p.interpreter = "/bin/sh"; },
    p => { p.interpreter = "/home/github/node;id"; }, p => { p.envFiles = ["/home/github/$(id).env"]; },
    p => { p.envFiles = ["/etc/secrets.env"]; }, p => { p.cwd += "/../other"; }, p => { p.entry = "../index.js"; },
    p => { p.processes[0].env.DB_PASSWORD = "secret"; }, p => { p.processes[0].env.NODE_OPTIONS = "--require=evil"; },
    p => { p.processes[0].env.NODE_ENV = "development;id"; }, p => { p.processes[0].ports = [9999,9999]; },
    p => { p.processes[1].name = p.processes[0].name; }, p => { p.processes[1].ports = [9999]; },
    p => { p.processes[0].ports = [1234]; }, p => { p.processes[0].env.PORT = "9999x"; },
    p => { p.target.host = "another"; }, p => { p.instanceId = "default"; }, p => { p.target.port = 2222; },
    p => { p.pm2Path = "/home/github/custom-command"; }, p => { p.nodeVersion = "14.15.0"; },
    p => { p.stableMs = 0; }, p => { p.startupTimeoutMs = 120000; }, p => { p.enabled = "true"; },
  ];
  for (const mutate of mutations) { const p = raw(); mutate(p); assert.throws(() => normalize(p), { code: "INVALID_SERVICE_PROFILE" }); }
  assert.equal(normalize().mode, "fork");
  const profile = normalize();
  assert.throws(() => selectServiceProfile({ be: profile }, { serviceId: "be", profileHash: "0".repeat(64) }), { code: "SERVICE_PROFILE_STALE" });
  assert.throws(() => selectServiceProfile({ be: { ...profile, enabled: false } }, { serviceId: "be" }), { code: "SERVICE_START_DISABLED" });
  assert.throws(() => validateServiceRequest({ confirmation: "启动服务", cmd: "anything" }, "start"), { code: "SERVICE_INPUT_INVALID" });
  assert.throws(() => validateServiceRequest({}, "start"), { code: "SERVICE_START_AUTHORIZATION_REQUIRED" });
});

test("worker configuration and fingerprint include instance-bound profiles", () => {
  const env = { REMOTE_DEBUG_WORKER: "1", REMOTE_DEBUG_INSTANCE_ID: "test-server", REMOTE_DEBUG_HOST: context.host, REMOTE_DEBUG_USER: "root", REMOTE_DEBUG_SERVICE_PROFILES: JSON.stringify({ be: raw() }) };
  const a = loadConfig(env, os.tmpdir());
  assert.deepEqual(a.serviceProfiles.be, normalize());
  const b = loadConfig({ ...env, REMOTE_DEBUG_SERVICE_PROFILES: "{}" }, os.tmpdir());
  assert.notEqual(configFingerprint(a), configFingerprint(b));
});

async function fixture(t, options = {}) {
  const dir = fs.realpathSync(await fsp.mkdtemp(path.join(os.tmpdir(), "service-runtime-"))); t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const p = normalize(); p.stableMs = 3000; p.startupTimeoutMs = 5000;
  const mapped = value => path.join(dir, value);
  const put = (file, text = "") => { fs.mkdirSync(path.dirname(mapped(file)), { recursive: true }); fs.writeFileSync(mapped(file), text); };
  const mkdir = file => fs.mkdirSync(mapped(file), { recursive: true });
  const link = (file, target) => { fs.mkdirSync(path.dirname(mapped(file)), { recursive: true }); fs.symlinkSync(target.startsWith("/") ? mapped(target) : target, mapped(file)); };
  const release = `${p.releaseRoot}/releases/review-version`;
  mkdir(release); link(p.cwd, release); put(`${release}/index.js`); put(p.interpreter);
  mkdir(`${p.pm2Home}/logs`); put(p.pm2Path); put(`${p.pm2Home}/pm2.pid`, "80"); put("/proc/80/cmdline", "PM2 v6.0.14\0God Daemon\0");
  for (const file of p.envFiles) put(file, "DB_PASSWORD=NEVER_RETURN_THIS_SECRET\n");
  const opened = [];
  const virtualFS = { ...fs,
    realpathSync: file => fs.realpathSync(mapped(file)).slice(dir.length),
    statSync: file => fs.statSync(mapped(file)), existsSync: file => fs.existsSync(mapped(file)),
    accessSync: file => fs.accessSync(mapped(file)),
    openSync: (file, mode) => { opened.push(file); return fs.openSync(mapped(file), mode); },
    readdirSync: file => fs.readdirSync(mapped(file)), readlinkSync: file => fs.readlinkSync(mapped(file)),
    mkdirSync: (file, opts) => fs.mkdirSync(mapped(file), opts), rmdirSync: file => fs.rmdirSync(mapped(file)),
  };
  let time = 1000, pid = 100, lists = 0;
  const entries = [], calls = [], listeners = [];
  const updatePorts = () => {
    put("/proc/net/tcp", "sl local_address rem_address st tx_queue rx_queue tr tm retrnsmt inode\n" + listeners.map((x,i) => `${i}: 00000000:${x.port.toString(16).toUpperCase().padStart(4,"0")} 00000000:0000 0A 0 0 0 0 0 ${x.inode}`).join("\n"));
    put("/proc/net/tcp6", "sl local_address rem_address st tx_queue rx_queue tr tm retrnsmt inode\n");
  };
  const add = (proc, settings = {}) => {
    const n = ++pid;
    const args = p.envFiles.map(file => `--env-file=${file}`);
    const out = `${p.pm2Home}/logs/${proc.name.replace(/_/g,"-")}-out.log`;
    const entry = { name: proc.name, pid: n, pm2_env: { name: proc.name, status: "online", exec_mode: "fork_mode", pm_cwd: release, pm_exec_path: `${release}/index.js`, exec_interpreter: p.interpreter, node_version: p.nodeVersion, node_args: args, restart_time: 0, pm_uptime: 1, pm_out_log_path: out, ...proc.env, SECRET: "NEVER_RETURN_THIS_SECRET", ...settings } };
    entries.push(entry);
    link(`/proc/${n}/exe`, p.interpreter); link(`/proc/${n}/cwd`, release);
    put(`/proc/${n}/cmdline`, [p.interpreter, ...args, "/pm2/ProcessContainerFork.js"].join("\0"));
    put(`/proc/${n}/environ`, Object.entries({ ...proc.env, DB_PASSWORD: "NEVER_RETURN_THIS_SECRET" }).map(([k,v]) => `${k}=${v}`).join("\0"));
    mkdir(`/proc/${n}/fd`);
    for (const port of proc.ports) { const inode = String(port + n); listeners.push({ port, inode }); link(`/proc/${n}/fd/${port}`, `socket:[${inode}]`); }
    put(out, options.noMarker ? "not ready" : `2026-10-19 ${p.startupMarker}\n`); updatePorts();
    return entry;
  };
  updatePorts();
  const execFile = (file, args, opts, callback) => {
    calls.push({ file, args, opts });
    assert.equal(opts.shell, false);
    assert.equal(opts.env.NODE_OPTIONS, undefined);
    assert.equal(opts.env.NODE_PATH, undefined);
    if (file === p.interpreter) return callback(null, options.runtimeVersion || `v${p.nodeVersion}\n`);
    if (args[0] === "jlist") { lists++; options.onList?.({ lists, entries, listeners, put, updatePorts, p }); return callback(null, JSON.stringify(entries)); }
    if (args[0] === "save") return callback(options.saveFails ? new Error("NEVER_RETURN_THIS_SECRET") : null, "saved");
    assert.equal(args[0], "start");
    const name = args[args.indexOf("--name") + 1];
    if (options.startFails === name) return callback(new Error("NEVER_RETURN_THIS_SECRET"), "NEVER_RETURN_THIS_SECRET");
    const entry = add(p.processes.find(proc => proc.name === name), options.afterStart || {});
    if (options.startedHook) options.startedHook(entry, { put, updatePorts, listeners });
    callback(null, "NEVER_RETURN_THIS_SECRET");
  };
  const deps = { fs: virtualFS, execFile, now: () => time, sleep: async ms => { time += ms; }, env: { NODE_OPTIONS: "--require=secret", NODE_PATH: "/secret" } };
  const run = (action = "start") => invoke({ action, deadlineAt: 20000, allowedRoots: context.allowedPaths }, p, deps);
  return { p, deps, run, add, entries, calls, put, mkdir, listeners, updatePorts, opened, mapped, release };
}

function noSecrets(result, fixture) {
  assert.ok(!JSON.stringify(result).includes("NEVER_RETURN_THIS_SECRET"));
  assert.ok(fixture.p.envFiles.every(file => !fixture.opened.includes(file)), "env-file content is never opened");
  assert.ok(!fixture.calls.some(call => ["delete", "restart", "reload"].includes(call.args[0])));
}

test("fixed fork template verifies both real PIDs/ports/env/runtime and saves only after stable readiness", async t => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.status, "healthy"); assert.equal(result.persisted, true);
  assert.equal(result.verified.length, 2); assert.equal(result.started.length, 2);
  for (const call of f.calls.filter(call => call.args[0] === "start")) {
    assert.equal(call.args[1], `${f.release}/index.js`);
    assert.equal(call.args[call.args.indexOf("--interpreter") + 1], f.p.interpreter);
    assert.equal(call.args[call.args.indexOf("--node-args") + 1], f.p.envFiles.map(file => `--env-file=${file}`).join(" "));
    assert.ok(!call.args.includes("--env"));
  }
  assert.equal(f.calls.at(-1).args[0], "save");
  noSecrets(result, f);
});

test("healthy repeat start and inspect are idempotent; missing inspect never starts or saves", async t => {
  const f = await fixture(t);
  assert.equal((await f.run("inspect")).status, "missing");
  assert.equal(f.calls.filter(c => c.args[0] === "start").length, 0);
  f.add(f.p.processes[0]); f.add(f.p.processes[1]); f.calls.length = 0;
  for (const action of ["start", "inspect"]) {
    const result = await f.run(action); assert.equal(result.status, "healthy"); assert.equal(result.unchanged, true); noSecrets(result, f);
  }
  assert.ok(f.calls.every(call => call.args[0] !== "start" && call.args[0] !== "save"));
});

test("a healthy A plus missing B starts only B", async t => {
  const f = await fixture(t); f.add(f.p.processes[0]);
  const result = await f.run(); assert.equal(result.status, "healthy");
  assert.deepEqual(Array.from(result.started), [f.p.processes[1].name]);
});

for (const [label, settings, code] of [
  ["cluster Node14", { exec_mode: "cluster_mode", node_version: "14.15.0" }, "SERVICE_MODE_MISMATCH"],
  ["wrong version", { node_version: "14.15.0" }, "SERVICE_NODE_VERSION_MISMATCH"],
  ["wrong interpreter", { exec_interpreter: "/bin/node" }, "SERVICE_FILESYSTEM_ENOENT"],
  ["wrong cwd", { pm_cwd: "/root/.pm2" }, "SERVICE_PROCESS_PATH_CONFLICT"],
  ["wrong environment", { PORT: "9998" }, "SERVICE_ENV_MISMATCH"],
  ["missing node flags", { node_args: [] }, "SERVICE_NODE_ARGS_MISMATCH"],
  ["stopped existing", { status: "stopped" }, "SERVICE_EXISTING_PROCESS_UNHEALTHY"],
]) test(`existing ${label} refuses mutation`, async t => {
  const f = await fixture(t); f.add(f.p.processes[0], settings);
  const result = await f.run(); assert.equal(result.status, "blocked"); assert.equal(result.error.code, code);
  assert.ok(f.calls.every(c => c.args[0] !== "start" && c.args[0] !== "save")); noSecrets(result, f);
});

test("wrong runtime, stale lock and occupied port refuse any start", async t => {
  for (const variant of ["runtime", "lock", "port", "release", "daemon"]) {
    const f = await fixture(t, variant === "runtime" ? { runtimeVersion: "v14.15.0" } : {});
    if (variant === "lock") f.mkdir(`${f.p.pm2Home}/.remote-debug-service-start.lock`);
    if (variant === "port") { f.listeners.push({ port: 9999, inode: "999" }); f.updatePorts(); }
    if (variant === "release") f.p.cwd = "/home/github/other/current";
    if (variant === "daemon") f.put(`${f.p.pm2Home}/pm2.pid`, "90");
    const result = await f.run(); assert.equal(result.status, "blocked");
    assert.ok(f.calls.every(c => c.args[0] !== "start" && c.args[0] !== "save")); noSecrets(result, f);
  }
});

test("CLI success with cluster/wrong node/exited/foreign port or missing readiness is never healthy and never saved", async t => {
  const variants = [
    { afterStart: { exec_mode: "cluster_mode" } }, { afterStart: { node_version: "14.15.0" } },
    { afterStart: { status: "errored" } }, { noMarker: true },
    { startedHook: (_, f) => { f.listeners.push({ port: 9999, inode: "foreign" }); f.updatePorts(); } },
    { onList: ({ lists, entries }) => { if (lists > 4 && entries.length) entries[0].pm2_env.restart_time++; } },
    { startedHook: (entry, f) => { f.put(`/proc/${entry.pid}/environ`, "PORT=wrong\0"); } },
  ];
  for (const opts of variants) {
    const f = await fixture(t, opts); const result = await f.run();
    assert.equal(result.status, "partial"); assert.equal(result.persisted, false);
    assert.ok(!f.calls.some(c => c.args[0] === "save")); noSecrets(result, f);
  }
});

test("partial/uncertain start receipts preserve processes and never save or expose PM2 errors", async t => {
  for (const index of [0, 1]) {
    const f = await fixture(t, { startFails: raw().processes[index].name });
    const result = await f.run(); assert.equal(result.status, index ? "partial" : "unknown");
    assert.equal(result.started.length, index); assert.equal(result.attempted.length, index + 1);
    assert.ok(!f.calls.some(c => c.args[0] === "save")); noSecrets(result, f);
  }
});

test("old startup markers cannot certify newly started processes", async t => {
  const f = await fixture(t, { noMarker: true });
  for (const proc of f.p.processes) f.put(`${f.p.pm2Home}/logs/${proc.name.replace(/_/g,"-")}-out.log`, f.p.startupMarker);
  const result = await f.run(); assert.equal(result.status, "partial"); assert.equal(result.error.code, "SERVICE_START_TIMEOUT");
});

test("unrelated unhealthy PM2 registration prevents global save; save failure reports verified partial result", async t => {
  const f = await fixture(t); f.entries.push({ name: "unrelated", pm2_env: { status: "stopped" } });
  const result = await f.run(); assert.equal(result.status, "healthy"); assert.equal(result.persisted, false);
  assert.equal(result.persistenceWarning, "SERVICE_PM2_SAVE_SKIPPED_UNHEALTHY_NAMESPACE");
  const g = await fixture(t, { saveFails: true }); const failed = await g.run();
  assert.equal(failed.status, "partial"); assert.equal(failed.phase, "persist"); assert.equal(failed.verified.length, 2); noSecrets(failed, g);
});

test("serialized helper executes over stdin without shell interpolation; transport uncertainty never auto-replays", async t => {
  const f = await fixture(t);
  const config = { security: { allowedPaths: context.allowedPaths }, instanceId: "test-server", ssh: { host: context.host, port: 22, username: "root" }, serviceProfiles: { be: f.p } };
  const input = { serviceId: "be", profileHash: serviceProfileHash(f.p), confirmation: "启动服务" };
  let calls = 0;
  const runSSH = async (command, options) => {
    calls++; assert.equal(command, "node"); assert.equal(options.stdin, buildServiceScript("start", f.p, 19000, context.allowedPaths));
    let stdout = "";
    const customRequire = name => name === "fs" ? f.deps.fs : name === "child_process" ? { execFile: f.deps.execFile } : require(name);
    // Inject the clock via an internal test-only wrapper; production helper has no such input.
    const code = options.stdin.replace(serviceStartRuntime.toString(), `function(r,p) { return (${serviceStartRuntime.toString()})(r,p,__deps); }`);
    await vm.runInNewContext(code, { require: customRequire, Buffer, process, __deps: f.deps, console: { log: line => { stdout += line + "\n"; } } });
    return { exitCode: 0, stdout };
  };
  const result = await runService(input, { action: "start", config, operation: { deadlineAt: 20000 }, runSSH });
  assert.equal(result.status, "healthy"); assert.equal(calls, 1); noSecrets(result, f);
  await assert.rejects(runService(input, { action: "start", config, operation: { deadlineAt: 20000 }, runSSH: async () => { throw new Error("NEVER_RETURN_THIS_SECRET"); } }), { code: "SERVICE_START_OUTCOME_UNKNOWN" });
  await assert.rejects(runService({ ...input, cmd: "id" }, { action: "start", config }), { code: "SERVICE_INPUT_INVALID" });
});

test("same-name duplicates and unexpected registrations refuse any mutation", async t => {
  const f = await fixture(t); const entry = f.add(f.p.processes[0]); f.entries.push(structuredClone(entry));
  const duplicate = await f.run(); assert.equal(duplicate.error.code, "SERVICE_DUPLICATE_PROCESS");
  assert.ok(!f.calls.some(c => c.args[0] === "start"));
  const g = await fixture(t); const other = g.add(g.p.processes[0]);
  other.name = "Unconfigured"; other.pm2_env.name = "Unconfigured"; other.pm2_env.pm_cwd = g.p.cwd;
  other.pm2_env.pm_exec_path = `${g.p.cwd}/index.js`; g.listeners.length = 0; g.updatePorts();
  const conflict = await g.run(); assert.equal(conflict.error.code, "SERVICE_UNEXPECTED_REGISTRATION");
  assert.ok(!g.calls.some(c => c.args[0] === "start"));
});

test("simultaneous starts share a PM2-home lock and create no duplicate registrations", async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.run(), f.run()]);
  assert.equal(results.filter(result => result.status === "healthy").length, 1);
  assert.equal(results.filter(result => result.error?.code === "SERVICE_START_BUSY").length, 1);
  assert.equal(f.calls.filter(call => call.args[0] === "start").length, 2);
});

test("actual executable and canonical env-file symlink checks fail closed", async t => {
  const f = await fixture(t); const entry = f.add(f.p.processes[0]);
  f.put("/home/github/othernode");
  fs.unlinkSync(f.mapped(`/proc/${entry.pid}/exe`));
  fs.symlinkSync(f.mapped("/home/github/othernode"), f.mapped(`/proc/${entry.pid}/exe`));
  assert.equal((await f.run()).error.code, "SERVICE_ACTUAL_PROCESS_MISMATCH");
  const g = await fixture(t); g.put("/etc/unapproved.env", "NEVER_RETURN_THIS_SECRET");
  fs.unlinkSync(g.mapped(g.p.envFiles[0])); fs.symlinkSync(g.mapped("/etc/unapproved.env"), g.mapped(g.p.envFiles[0]));
  const denied = await g.run(); assert.equal(denied.error.code, "SERVICE_CANONICAL_PATH_DENIED"); noSecrets(denied, g);
});

test("entry symlink cannot turn direct JavaScript startup into ecosystem execution", async t => {
  const f = await fixture(t); f.put(`${f.release}/ecosystem.config.js`, "NEVER_EXECUTE");
  fs.unlinkSync(f.mapped(`${f.release}/index.js`));
  fs.symlinkSync(f.mapped(`${f.release}/ecosystem.config.js`), f.mapped(`${f.release}/index.js`));
  const result = await f.run(); assert.equal(result.error.code, "SERVICE_ENTRY_PATH_INVALID");
  assert.equal(f.calls.length, 0);
});

test("release switch during startup produces partial failure and no persistence", async t => {
  let f;
  f = await fixture(t, { onList: ({ lists }) => {
    if (lists === 3) {
      f.mkdir(`${f.p.releaseRoot}/releases/new-version`);
      fs.unlinkSync(f.mapped(f.p.cwd));
      fs.symlinkSync(f.mapped(`${f.p.releaseRoot}/releases/new-version`), f.mapped(f.p.cwd));
    }
  } });
  const result = await f.run(); assert.equal(result.status, "partial"); assert.equal(result.error.code, "SERVICE_RELEASE_CHANGED");
  assert.ok(!f.calls.some(call => call.args[0] === "save")); noSecrets(result, f);
});
