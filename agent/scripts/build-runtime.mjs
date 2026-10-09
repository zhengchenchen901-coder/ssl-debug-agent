import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const agentDir = path.resolve(scriptDir, "..");
const projectRoot = path.resolve(agentDir, "..");
const pluginRoot = path.resolve(projectRoot, "plugins", "remote-debug-agent");
const outputDir = path.resolve(pluginRoot, "runtime", "agent");
const pluginManifestPath = path.resolve(
  pluginRoot,
  ".codex-plugin",
  "plugin.json",
);

const pluginManifest = JSON.parse(
  await fsp.readFile(pluginManifestPath, "utf8"),
);
const agentPackage = JSON.parse(
  await fsp.readFile(path.resolve(agentDir, "package.json"), "utf8"),
);
const pluginBaseVersion = pluginManifest.version.split("+", 1)[0];
if (agentPackage.version !== pluginBaseVersion) {
  throw new Error(
    `version mismatch: agent ${agentPackage.version}, plugin base ${pluginBaseVersion}`,
  );
}

const nativeFallbackPlugin = {
  name: "ssh2-native-fallback",
  setup(buildContext) {
    buildContext.onResolve({ filter: /sshcrypto\.node$/ }, (args) => ({
      path: args.path,
      external: true,
    }));
  },
};

async function bundle(entryPoint, outfile) {
  await build({
    entryPoints: [path.resolve(agentDir, entryPoint)],
    outfile: path.resolve(outputDir, outfile),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22.18",
    packages: "bundle",
    external: ["cpu-features"],
    plugins: [nativeFallbackPlugin],
    define: {
      "import.meta.url": "undefined",
    },
    minify: false,
    legalComments: "none",
    charset: "utf8",
    logLevel: "info",
  });
}

async function hashFile(filePath) {
  const contents = await fsp.readFile(filePath);
  return createHash("sha256").update(contents).digest("hex");
}

await fsp.rm(outputDir, { recursive: true, force: true });
await fsp.mkdir(outputDir, { recursive: true });

await bundle("server.js", "server.cjs");
await bundle("worker-entry.js", "worker-entry.cjs");
await fsp.cp(path.resolve(agentDir, "public"), path.resolve(outputDir, "public"), {
  recursive: true,
});

const artifactFiles = [
  "server.cjs",
  "worker-entry.cjs",
  "public/dashboard.css",
  "public/dashboard.html",
  "public/dashboard.js",
  "public/environment-report.js",
];
const hashes = {};
for (const relativePath of artifactFiles) {
  hashes[relativePath] = await hashFile(path.resolve(outputDir, relativePath));
}

const runtimeHash = createHash("sha256")
  .update(JSON.stringify(hashes))
  .digest("hex");
const manifest = {
  version: 1,
  pluginVersion: pluginManifest.version,
  runtimeId: `${agentPackage.version}:${runtimeHash}`,
  node: agentPackage.engines.node,
  server: "server.cjs",
  worker: "worker-entry.cjs",
  hashes,
};

await fsp.writeFile(
  path.resolve(outputDir, "runtime-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);

if (!fs.existsSync(path.resolve(outputDir, manifest.server))) {
  throw new Error("bundled manager entrypoint was not created");
}
if (!fs.existsSync(path.resolve(outputDir, manifest.worker))) {
  throw new Error("bundled worker entrypoint was not created");
}

console.log(`Built Remote Debug Agent runtime ${manifest.runtimeId}`);
