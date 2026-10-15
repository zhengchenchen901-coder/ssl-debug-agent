import fs from "node:fs/promises";
import path from "node:path";

function sandboxError(message, code = "SANDBOX_PATH_REJECTED") {
  return Object.assign(new Error(message), { code, statusCode: 400, retriable: false });
}

export function redactSandboxLog(value, depth = 0) {
  if (depth > 6) return "[bounded]";
  if (typeof value === "string") return value.replace(/(mongodb(?:\+srv)?:\/\/)[^@\s]+@/gi, "$1[redacted]@").replace(/((?:password|passphrase|token|secret|passwd|pwd)\s*[=:]\s*|--(?:token|password|secret)\s+)[^\s,;]+/gi, "$1[redacted]").slice(0, 2048);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactSandboxLog(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key, /password|passphrase|secret|token|credential|private.?key|before|document/i.test(key) ? "[redacted]" : redactSandboxLog(item, depth + 1)]));
  return value;
}

export async function inspectLocalSandbox(dataDir, instanceId, input) {
  if (!["status", "export"].includes(input.action)) throw sandboxError("local sandbox supports status and bounded audit export only", "SANDBOX_ACTION_INVALID");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(instanceId)) throw sandboxError("invalid instance id");
  const root = path.resolve(dataDir, ".remote-debug", "instances");
  const directory = path.join(root, instanceId);
  for (const item of [root, directory]) {
    try {
      const stat = await fs.lstat(item);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw sandboxError("local sandbox is not a regular directory");
    } catch (error) { if (error.code === "ENOENT") return { instanceId, initialized: false, files: [], bytes: 0, records: [] }; throw error; }
  }
  const relativeRoot = path.relative(await fs.realpath(dataDir), await fs.realpath(root));
  if (relativeRoot.startsWith("..") || path.isAbsolute(relativeRoot)) throw sandboxError("local sandbox root escapes the data directory");
  if (path.dirname(await fs.realpath(directory)) !== await fs.realpath(root)) throw sandboxError("instance directory escapes the local sandbox");
  const files = [];
  // Credentials and arbitrary configured external paths are deliberately excluded.
  for (const name of ["audit.jsonl", "memory.json"]) {
    const file = path.join(directory, name);
    try {
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink() || !stat.isFile()) throw sandboxError("sandbox file is not a regular file");
      files.push({ name, bytes: stat.size });
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  if (input.action === "status") return { instanceId, initialized: true, files, bytes: files.reduce((sum, file) => sum + file.bytes, 0), activeFilesRetained: true };
  if (input.action !== "export") throw sandboxError("local sandbox supports status and bounded audit export only", "SANDBOX_ACTION_INVALID");
  const metadata = files.find((file) => file.name === "audit.jsonl");
  if (!metadata) return { instanceId, records: [], scannedBytes: 0 };
  const start = Math.max(0, metadata.bytes - 65536);
  const handle = await fs.open(path.join(directory, metadata.name), "r");
  const buffer = Buffer.alloc(Math.min(metadata.bytes, 65536));
  try { await handle.read(buffer, 0, buffer.length, start); } finally { await handle.close(); }
  const lines = buffer.toString("utf8").split(/\r?\n/); if (start) lines.shift();
  const limit = Math.max(1, Math.min(100, Number.isInteger(input.limit) ? input.limit : 20));
  return { instanceId, scannedBytes: buffer.length, truncated: start > 0, records: lines.filter(Boolean).slice(-limit).map((line) => { try { return redactSandboxLog(JSON.parse(line)); } catch { return { error: "unparseable_record" }; } }) };
}
