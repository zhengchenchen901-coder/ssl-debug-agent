import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ManualOwnerVerification } from "../manual-owner-verification.js";

const nativeTest = { skip: process.platform === "win32" };
async function verifier(t, execute, raw = false) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rda-owner-prepare-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const runner = raw ? execute : (command, args, options) => {
    if (command === "/usr/bin/arch") {
      assert.equal(args[0], "-arm64");
      return execute(args[1], args.slice(2), options);
    }
    return execute(command, args, options);
  };
  return new ManualOwnerVerification(path.join(root, "native"), { platform: "darwin", architecture: "arm64", execute: runner });
}

test("compiler lookup failure is distinct from compilation errors", nativeTest, async (t) => {
  const calls = [];
  const owner = await verifier(t, async (_command, args) => {
    calls.push(args);
    throw Object.assign(new Error("lookup failure"), { code: 72, stderr: "private diagnostic" });
  });
  await assert.rejects(owner.prepare(), (error) => error.code === "OWNER_COMPILER_UNAVAILABLE" && !error.message.includes("private diagnostic"));
  assert.deepEqual(calls, [["--find", "swiftc"]]);
});

test("compiler exit, timeout and cancellation retain actionable error codes without raw diagnostics", nativeTest, async (t) => {
  for (const [failure, expected] of [
    [{ code: 1 }, "OWNER_HELPER_COMPILE_FAILED"],
    [{ code: null, killed: true }, "OWNER_HELPER_COMPILE_TIMEOUT"],
    [{ code: "ABORT_ERR", name: "AbortError" }, "OWNER_HELPER_CANCELLED"],
  ]) {
    const owner = await verifier(t, async (_command, args) => {
      if (args[0] === "--find") return { stdout: "/usr/bin/swiftc\n" };
      throw Object.assign(new Error("compiler error"), failure, { stderr: "sensitive compiler diagnostic" });
    });
    await assert.rejects(owner.verify(), (error) => error.code === expected && !error.message.includes("sensitive compiler diagnostic") && !error.message.includes("需要已安装"));
  }
});

test("preparation verifies availability, reuses its cache and never grants authentication", nativeTest, async (t) => {
  let compilations = 0, checks = 0, authentication = 0;
  const owner = await verifier(t, async (_command, args) => {
    if (args[0] === "--find") return { stdout: "/usr/bin/swiftc\n" };
    if (args[0] === "swiftc") { compilations++; fs.writeFileSync(args.at(-1), "test executable"); return { stdout: "" }; }
    if (args[0] === "--check") { checks++; return { stdout: JSON.stringify({ available: true }) }; }
    authentication++;
    return { stdout: JSON.stringify({ verified: true, nonce: args[0], uid: process.getuid() }) };
  });
  assert.equal((await owner.prepare()).prepared, true);
  assert.equal((await owner.prepare()).prepared, true);
  assert.equal(compilations, 1);
  assert.equal(checks, 2);
  assert.equal(authentication, 0);
  await owner.verify();
  assert.equal(authentication, 1);
});

test("concurrent preparation shares one compile and an unavailable native helper fails closed", nativeTest, async (t) => {
  let release, started;
  const began = new Promise((resolve) => { started = resolve; });
  let compilations = 0;
  const owner = await verifier(t, async (_command, args) => {
    if (args[0] === "--find") return { stdout: "/usr/bin/swiftc\n" };
    if (args[0] === "swiftc") {
      compilations++; started();
      await new Promise((resolve) => { release = resolve; });
      fs.writeFileSync(args.at(-1), "test executable");
      return { stdout: "" };
    }
    return { stdout: JSON.stringify({ available: false, verified: true }) };
  });
  const first = owner.prepare(), second = owner.prepare();
  const rejected = Promise.allSettled([first, second]);
  await began;
  assert.equal(compilations, 1);
  release();
  const results = await rejected;
  assert.ok(results.every((result) => result.status === "rejected" && result.reason.code === "OWNER_HELPER_CHECK_FAILED"));
  assert.equal(owner.preparing, null);
});

test("ARM and Rosetta processes explicitly pin the toolchain and owner helper to native ARM", nativeTest, async (t) => {
  for (const architecture of ["arm64", "x64"]) {
    const calls = [];
    const owner = await verifier(t, async (command, args) => {
      calls.push({ command, args });
      if (command === "/usr/sbin/sysctl") return { stdout: "1\n" };
      assert.equal(command, "/usr/bin/arch");
      assert.equal(args[0], "-arm64");
      const executable = args[1], parameters = args.slice(2);
      if (executable === "/usr/bin/xcrun") {
        if (parameters[0] === "--find") return { stdout: "/Library/Developer/CommandLineTools/usr/bin/swiftc\n" };
        assert.equal(parameters[0], "swiftc");
        fs.writeFileSync(parameters.at(-1), "native ARM helper");
        return { stdout: "" };
      }
      if (parameters[0] === "--check") return { stdout: JSON.stringify({ available: true }) };
      return { stdout: JSON.stringify({ verified: true, nonce: parameters[0], uid: process.getuid() }) };
    }, true);
    owner.architecture = architecture;
    const preparation = await owner.prepare();
    assert.equal(preparation.processArchitecture, architecture);
    assert.equal(preparation.nativeArchitecture, "arm64");
    await owner.verify();
    assert.equal(calls.filter((call) => call.command === "/usr/sbin/sysctl").length, architecture === "x64" ? 1 : 0);
    assert.equal(calls.filter((call) => call.command === "/usr/bin/arch").length, 4);
  }
});
