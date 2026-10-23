// Portable dummy fixture exchange. These public test credentials are never used for SSH.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InstanceRegistry } from "../instance-registry.js";
import { MemoryStore } from "../memory-store.js";
import { InstanceTransfer } from "../instance-transfer.js";

const [action, directory] = process.argv.slice(2);
if (!["export", "import"].includes(action) || !directory) throw new Error("Usage: node test/instance-transfer-interop.mjs export|import <fixture-directory>");
const password = "public-interop-fixture-password";
const key = Buffer.from("PUBLIC INTEROP TEST KEY\r\n中文\n");
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rda-interop 中文 "));
try {
  const registry = new InstanceRegistry({ cwd, env: {} }), memoryStore = new MemoryStore({ cwd });
  const transfer = new InstanceTransfer({ registry, memoryStore });
  if (action === "export") {
    const keyFile = path.join(cwd, "原始 私钥"); fs.writeFileSync(keyFile, key);
    registry.create({ id: "interop", name: "跨系统测试", host: "interop.invalid", username: "fixture", privateKeyPath: keyFile, passphrase: "public-fixture-passphrase",
      sourceRoots: { app: "/home/github/fixture" }, hostKeyFingerprints: ["SHA256:" + "A".repeat(43)] });
    await memoryStore.upsertNote(registry.getInternal("interop"), { topic: "interop", summary: "public cross-platform fixture", facts: ["中文与 CRLF"] });
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${process.platform}.json`), JSON.stringify(await transfer.export("interop", password)) + "\n");
    console.log(JSON.stringify({ ok: true, action, platform: process.platform, syntheticDataOnly: true }));
  } else {
    const platforms = [];
    if (process.argv.includes("--require-both")) {
      assert.ok(fs.existsSync(path.join(directory, "win32.json")), "Windows fixture missing");
      assert.ok(fs.existsSync(path.join(directory, "darwin.json")), "macOS fixture missing");
    }
    for (const file of fs.readdirSync(directory).filter(file => /^(win32|darwin|linux)\.json$/.test(file))) {
      const platform = path.basename(file, ".json"), bundle = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"));
      const id = `from-${platform}`;
      await transfer.import(bundle, password, id, "Cross platform");
      const restored = new InstanceRegistry({ cwd, env: {} }).getInternal(id);
      assert.deepEqual(fs.readFileSync(restored.privateKeyPath), key);
      assert.equal(restored.passphrase, "public-fixture-passphrase"); assert.equal(restored.sourceRoots.app, "/home/github/fixture");
      assert.equal(new MemoryStore({ cwd }).ensureLoaded(id).sections.notes.interop.facts[0], "中文与 CRLF");
      platforms.push(platform);
    }
    assert.ok(platforms.length > 0, "no interop fixtures found");
    console.log(JSON.stringify({ ok: true, action, destinationPlatform: process.platform, sourcePlatforms: platforms }));
  }
} finally { fs.rmSync(cwd, { recursive: true, force: true }); }
