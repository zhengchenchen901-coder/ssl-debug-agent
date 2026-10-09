import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import runtime from "../node-runtime.cjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "node-selection-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, env: { REMOTE_DEBUG_DATA_DIR: root, PATH: "", NVM_DIR: path.join(root, ".nvm") },
    options: { currentExecutable: "/old/node", currentVersion: "14.21.3", home: root } };
}

test("compatible current Node is kept without probing another runtime", async (t) => {
  const { env, options } = await fixture(t);
  const selected = runtime.selectRuntime(pluginRoot, env, { ...options, currentVersion: "22.18.0",
    probe: () => { throw new Error("should not probe"); } });
  assert.equal(selected.source, "current");
  assert.equal(selected.executable, options.currentExecutable);
});

test("PATH selection uses the probed version and ignores incompatible runtimes", async (t) => {
  const { root, env, options } = await fixture(t);
  const first = path.join(root, "old"), second = path.join(root, "compatible");
  const binary = process.platform === "win32" ? "node.exe" : "node";
  for (const directory of [first, second]) {
    await fs.mkdir(directory); await fs.writeFile(path.join(directory, binary), "fixture");
  }
  const selected = runtime.selectRuntime(pluginRoot, { ...env, PATH: [first, second].join(path.delimiter) }, {
    ...options, probe: (executable) => executable.includes("compatible") ? "22.23.3" : "24.19.0",
  });
  assert.equal(selected.version, "22.23.3");
  assert.equal(selected.source, "PATH");
});

test("NVM chooses the latest compatible version without changing its default", { skip: process.platform === "win32" }, async (t) => {
  const { root, env, options } = await fixture(t);
  const versions = path.join(env.NVM_DIR, "versions/node");
  for (const version of ["v22.18.0", "v22.23.3", "v24.21.0"]) {
    const bin = path.join(versions, version, "bin");
    await fs.mkdir(bin, { recursive: true }); await fs.writeFile(path.join(bin, "node"), "fixture");
  }
  await fs.mkdir(path.join(env.NVM_DIR, "alias"));
  const alias = path.join(env.NVM_DIR, "alias/default"); await fs.writeFile(alias, "14.21.3");
  const selected = runtime.selectRuntime(pluginRoot, env, { ...options,
    probe: (executable) => path.basename(path.dirname(path.dirname(executable))).slice(1),
  });
  assert.equal(selected.version, "22.23.3");
  assert.equal(selected.source, "NVM");
  assert.equal(await fs.readFile(alias, "utf8"), "14.21.3");
});

test("invalid explicit Node is reported instead of ignored", async (t) => {
  const { env, options } = await fixture(t);
  const selected = runtime.selectRuntime(pluginRoot, { ...env, REMOTE_DEBUG_NODE_PATH: "/missing/node" }, {
    ...options, currentVersion: "22.23.3", probe: () => null,
  });
  assert.equal(selected.source, "explicit");
  assert.equal(selected.compatible, false);
});

test("an explicit symlink to the running Node resolves without a relaunch loop", { skip: process.platform === "win32" }, async (t) => {
  const { root, env } = await fixture(t);
  const link = path.join(root, "selected-node"); await fs.symlink(process.execPath, link);
  const selected = runtime.selectRuntime(pluginRoot, { ...env, REMOTE_DEBUG_NODE_PATH: link });
  assert.equal(selected.executable, process.execPath);
  assert.equal(selected.compatible, true);
});
