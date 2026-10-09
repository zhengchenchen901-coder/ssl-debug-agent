// Bootstrap only: keep compatible with Node 14 and never modify global PATH/NVM.
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const childProcess = require("child_process");
const environment = require("./environment-report.cjs");

function probeNode(executable) {
  try {
    const result = childProcess.spawnSync(executable, ["--version"], {
      encoding: "utf8", timeout: 1500, maxBuffer: 4096, windowsHide: true,
    });
    return result.status === 0 ? result.stdout.trim().replace(/^v/, "") : null;
  } catch (_) { return null; }
}

function selectRuntime(pluginRoot, env, options) {
  options = options || {};
  const currentExecutable = options.currentExecutable || process.execPath;
  const currentVersion = options.currentVersion || process.versions.node;
  const home = options.home || os.homedir();
  const probe = options.probe || probeNode;
  const dataDir = environment.dataDirectory(env);
  const settings = environment.effectiveEnvironment(env, dataDir);
  const pkg = environment.readJson(path.join(pluginRoot, "package.json"));
  const manifest = environment.readJson(path.join(pluginRoot, "runtime", "agent", "runtime-manifest.json"));
  const requirement = manifest && manifest.node || pkg && pkg.engines && pkg.engines.node || "unknown";
  const override = settings.env.REMOTE_DEBUG_NODE_PATH;
  if (override) {
    let executable = path.resolve(override);
    try { executable = fs.realpathSync(executable); } catch (_) { /* report invalid override */ }
    const version = executable === currentExecutable ? currentVersion : probe(executable);
    // An explicit override is authoritative: report an invalid override instead of silently ignoring it.
    return { executable: executable, version: version, requirement: requirement, source: "explicit",
      compatible: Boolean(version && environment.compatibleNode(version, requirement)) };
  }
  if (environment.compatibleNode(currentVersion, requirement)) {
    return { executable: currentExecutable, version: currentVersion, requirement: requirement,
      source: "current", compatible: true };
  }

  const candidates = [];
  const seen = new Set([currentExecutable]);
  function add(executable, source) {
    try { executable = fs.realpathSync(executable); } catch (_) { return; }
    if (!seen.has(executable) && fs.existsSync(executable) && candidates.length < 32) {
      seen.add(executable); candidates.push({ executable: executable, source: source });
    }
  }
  const binary = process.platform === "win32" ? "node.exe" : "node";
  const pathKey = Object.keys(env).find(function (key) { return key.toLowerCase() === "path"; });
  String(pathKey ? env[pathKey] : "").split(path.delimiter).filter(Boolean).slice(0, 16).forEach(function (directory) {
    add(path.resolve(directory, binary), "PATH");
  });
  const roots = process.platform === "win32"
    ? [env.NVM_HOME, env.NVM_SYMLINK].filter(Boolean)
    : [path.join(env.NVM_DIR || path.join(home, ".nvm"), "versions", "node")];
  roots.forEach(function (root) {
    add(path.join(root, binary), "NVM");
    let versions = [];
    try { versions = fs.readdirSync(root).filter(function (name) {
      return /^v?\d+\.\d+\.\d+$/.test(name) && environment.compatibleNode(name, requirement);
    }); } catch (_) { return; }
    versions.sort(function (a, b) {
      const left = a.replace(/^v/, "").split(".").map(Number);
      const right = b.replace(/^v/, "").split(".").map(Number);
      return right[0] - left[0] || right[1] - left[1] || right[2] - left[2];
    }).forEach(function (version) {
      add(path.join(root, version, process.platform === "win32" ? "" : "bin", binary), "NVM");
    });
  });
  const deadline = Date.now() + 8000;
  for (const candidate of candidates) {
    if (Date.now() >= deadline) break;
    const version = probe(candidate.executable);
    if (version && environment.compatibleNode(version, requirement)) {
      return Object.assign(candidate, { version: version, requirement: requirement, compatible: true });
    }
  }
  return { executable: currentExecutable, version: currentVersion, requirement: requirement,
    source: "unavailable", compatible: false };
}

function relaunch(executable, script, args, env, source) {
  const childEnv = Object.assign({}, env, {
    REMOTE_DEBUG_BOOTSTRAP_NODE_PATH: process.execPath,
    REMOTE_DEBUG_BOOTSTRAP_NODE_VERSION: process.versions.node,
    REMOTE_DEBUG_NODE_SELECTION_SOURCE: source,
  });
  const pathKey = Object.keys(childEnv).find(function (key) { return key.toLowerCase() === "path"; }) || "PATH";
  childEnv[pathKey] = path.dirname(executable) + path.delimiter + (childEnv[pathKey] || "");
  return new Promise(function (resolve, reject) {
    const child = childProcess.spawn(executable, [script].concat(args), {
      env: childEnv, stdio: "inherit", windowsHide: true,
    });
    const onInterrupt = function () { child.kill("SIGINT"); };
    const onTerminate = function () { child.kill("SIGTERM"); };
    process.on("SIGINT", onInterrupt); process.on("SIGTERM", onTerminate);
    function clean() {
      process.removeListener("SIGINT", onInterrupt); process.removeListener("SIGTERM", onTerminate);
    }
    child.once("error", function (error) { clean(); reject(error); });
    child.once("exit", function (code, signal) {
      clean(); resolve(code === null ? 128 + (signal === "SIGINT" ? 2 : signal === "SIGTERM" ? 15 : 1) : code);
    });
  });
}

module.exports = { selectRuntime, relaunch, probeNode };
