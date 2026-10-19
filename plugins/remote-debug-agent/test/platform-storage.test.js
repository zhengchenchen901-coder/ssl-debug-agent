import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import localAuth from "../local-auth.cjs";
import environment from "../environment-report.cjs";

const require = createRequire(import.meta.url);
const modulePath = path.resolve(import.meta.dirname, "../local-auth.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rda-platform-storage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

for (const platform of ["darwin", "linux"]) {
  test(`${platform} preserves owner checks and 0700/0600 without loading Windows code`, () => {
    const entries = { directory: { uid: 501, mode: 0o755 }, file: { uid: 501, mode: 0o644 } };
    const calls = [];
    const fakeFs = {
      lstatSync(target) { return { ...entries[target], isSymbolicLink: () => false,
        isDirectory: () => target === "directory", isFile: () => target === "file" }; },
      statSync(target) { return entries[target]; },
      chmodSync(target, mode) { calls.push([target, mode]); entries[target].mode = mode; },
    };
    const sandbox = { module: { exports: {} }, process: { platform, getuid: () => 501 },
      require(name) {
        assert.notEqual(name, "./windows-storage.cjs");
        return name === "fs" ? fakeFs : require(name);
      } };
    vm.runInNewContext(fs.readFileSync(modulePath, "utf8"), sandbox);
    const auth = sandbox.module.exports;
    assert.throws(() => auth.protectOrCheck("file", false, false), { code: "LOCAL_AUTH_STORAGE_UNSAFE" });
    auth.protectOrCheck("directory", true, true);
    auth.protectOrCheck("file", false, true);
    auth.protectOrCheck("directory", true, false);
    auth.protectOrCheck("file", false, false);
    assert.deepEqual(calls, [["directory", 0o700], ["file", 0o600]]);
    entries.file.uid = 502;
    assert.throws(() => auth.protectOrCheck("file", false, true), { code: "LOCAL_AUTH_STORAGE_UNSAFE" });
    assert.equal(calls.length, 2, "must not chmod another user's file");
  });
}

test("Windows initializes and reuses private storage with an incompatible inherited module path", { skip: process.platform !== "win32" }, (t) => {
  const root = fixture(t);
  const code = 'const a=require(process.argv[1]);const f=a.resolveAuthFile(process.argv[2]);const token=a.ensureAuthToken(f);if(a.ensureAuthToken(f)!==token||a.readAuthToken(f)!==token)process.exit(1);console.log("ready");';
  const result = spawnSync(process.execPath, ["-e", code, modulePath, root], {
    env: { ...process.env, PSModulePath: path.join(root, "missing-powershell7-modules") },
    windowsHide: true, encoding: "utf8", timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "ready");
  assert.equal(result.stderr, "");
});

test("Windows rejects a credential accessible to Everyone", { skip: process.platform !== "win32" }, (t) => {
  const root = fixture(t), file = localAuth.resolveAuthFile(root);
  localAuth.ensureAuthToken(file);
  const executable = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
  const script = '$ErrorActionPreference="Stop";$item=New-Object IO.FileInfo($env:RDA_TEST_FILE);$acl=$item.GetAccessControl();$sid=New-Object Security.Principal.SecurityIdentifier("S-1-1-0");$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,"Read","Allow");$acl.AddAccessRule($rule);$item.SetAccessControl($acl)';
  const result = spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, RDA_TEST_FILE: file }, windowsHide: true, encoding: "utf8", timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.throws(() => localAuth.readAuthToken(file), { code: "LOCAL_AUTH_STORAGE_UNSAFE" });
});

test("preflight reports permission failure before MCP startup without touching credentials", (t) => {
  const root = fixture(t);
  const file = path.join(root, "existing-credential");
  fs.writeFileSync(file, "unchanged");
  t.mock.method(localAuth, "protectOrCheck", () => { throw Object.assign(new Error("sensitive internal detail"), { code: "LOCAL_AUTH_STORAGE_UNSAFE" }); });
  const report = environment.collectReport(path.resolve(import.meta.dirname, ".."), {
    REMOTE_DEBUG_DATA_DIR: root, REMOTE_DEBUG_AUTH_FILE: file, REMOTE_DEBUG_AGENT_URL: "https://example.test",
  });
  assert.equal(report.status, "failed");
  assert.equal(report.checks.find((c) => c.id === "private-storage").status, "fail");
  assert.doesNotMatch(JSON.stringify(report), /sensitive internal detail/);
  assert.equal(fs.readFileSync(file, "utf8"), "unchanged");
  assert.deepEqual(fs.readdirSync(path.join(root, ".runtime")), []);
});
