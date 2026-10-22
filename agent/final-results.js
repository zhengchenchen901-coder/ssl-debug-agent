import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createOutputGuard } from "../plugins/remote-debug-agent/output-guard.js";
import localAuth from "../plugins/remote-debug-agent/local-auth.cjs";
import { sanitizeFinalPublication } from "../plugins/remote-debug-agent/final-results.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const INSTANCE = /^[A-Za-z0-9_-]{1,64}$/;
const CATEGORIES = new Set(["results", "reports", "exports", "attachments"]);
const STATUSES = new Set(["completed", "partial", "failed", "cancelled"]);
const FORMATS = { json: "json", markdown: "md", text: "txt", csv: "csv", jsonl: "jsonl", html: "html", binary: "bin" };
const MAX_FILE = 4 * 1024 * 1024;
const MAX_TASK = 8 * 1024 * 1024;
const MAX_FILES = 32;
const MAX_TASKS = 10000;
const digest = (data) => createHash("sha256").update(data).digest("hex");
const fail = (code, statusCode = 400) => Object.assign(new Error(code), { code, statusCode, retriable: false });

function object(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw fail("FINAL_RESULT_INVALID");
}
function identity(instanceId, taskId) {
  if (instanceId !== null && (typeof instanceId !== "string" || !INSTANCE.test(instanceId)) || taskId !== undefined && (typeof taskId !== "string" || !UUID.test(taskId))) throw fail("FINAL_RESULT_INVALID");
}
function label(value, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw fail("FINAL_RESULT_INVALID");
  return value;
}
function page(offset = 0, limit = 20) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw fail("FINAL_RESULT_PAGE_INVALID");
}
function validateReferences(references) {
  object(references, ["operationIds", "jobId", "mutationId", "resourceTaskId"]);
  for (const [key, value] of Object.entries(references)) {
    if (key === "operationIds") {
      if (!Array.isArray(value) || value.length > 64 || value.some((id) => typeof id !== "string" || !UUID.test(id))) throw fail("FINAL_RESULT_INVALID");
    } else if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) throw fail("FINAL_RESULT_INVALID");
  }
}

// Only final deliverables enter this store. No task lifecycle or tool-response
// listener writes here. A caller must explicitly finalize the business task.
export class FinalResultStore {
  constructor({ root, sanitize, now = () => new Date(), maxFileBytes = MAX_FILE, maxTaskBytes = MAX_TASK } = {}) {
    if (!root || !path.isAbsolute(root) || path.resolve(root) === path.parse(path.resolve(root)).root) throw fail("FINAL_RESULT_ROOT_INVALID");
    this.root = path.resolve(root);
    this.stageRoot = path.join(path.dirname(this.root), `.${path.basename(this.root)}-final-staging`);
    this.sanitize = sanitize || ((value) => createOutputGuard().sanitize(value).value);
    this.now = now;
    this.maxFileBytes = maxFileBytes;
    this.maxTaskBytes = maxTaskBytes;
    this.queue = Promise.resolve();
  }

  async directory(directory, create = false) {
    let created = false;
    if (create) {
      try { await fs.mkdir(directory, { mode: 0o700 }); created = true; }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory() || typeof process.getuid === "function" && stat.uid !== process.getuid()) throw fail("FINAL_RESULT_PATH_REJECTED", 409);
    if (create && process.platform !== "win32") await fs.chmod(directory, 0o700);
    if (create && process.platform === "win32") localAuth.protectOrCheck(directory, true, true);
    if (created) await this.syncDirectory(path.dirname(directory));
    return directory;
  }

  async base(create = false) {
    // Canonicalize the configured parent (including OS aliases), but never follow
    // links at output/, in instance/task directories, or at a stored file.
    if (create) await fs.mkdir(path.dirname(this.root), { recursive: true, mode: 0o700 });
    const parent = await fs.realpath(path.dirname(this.root));
    if (this.parent && parent !== this.parent) throw fail("FINAL_RESULT_PATH_REJECTED", 409);
    this.parent = parent;
    return this.directory(this.root, create);
  }

  async tasksDirectory(instanceId, create = false) {
    identity(instanceId);
    let directory = await this.base(create);
    for (const segment of instanceId === null ? ["manager", "tasks"] : ["instances", instanceId, "tasks"]) {
      directory = await this.directory(path.join(directory, segment), create);
    }
    return directory;
  }

  async readFile(file, maxBytes) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes) throw fail("FINAL_RESULT_PATH_REJECTED", 409);
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size > maxBytes) throw fail("FINAL_RESULT_PATH_REJECTED", 409);
      // Bound the actual read too, even if another local process grows the file.
      const buffer = Buffer.alloc(maxBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const result = await handle.read(buffer, length, buffer.length - length, length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > maxBytes) throw fail("FINAL_RESULT_TOO_LARGE", 413);
      return buffer.subarray(0, length);
    } finally { await handle.close(); }
  }

  normalize(input) {
    object(input, ["instanceId", "taskId", "title", "type", "status", "final", "references", "artifacts"]);
    identity(input.instanceId, input.taskId);
    if (!UUID.test(input.taskId) || input.final !== true || !STATUSES.has(input.status)) throw fail("FINAL_RESULT_NOT_FINAL");
    label(input.title, 160);
    if (input.type !== undefined && !/^[a-z][a-z0-9_-]{0,63}$/.test(input.type)) throw fail("FINAL_RESULT_INVALID");
    const references = input.references || {};
    validateReferences(references);
    if (!Array.isArray(input.artifacts) || !input.artifacts.length || input.artifacts.length > MAX_FILES) throw fail("FINAL_RESULT_INVALID");
    let totalBytes = 0;
    const artifacts = input.artifacts.map((item) => {
      object(item, ["category", "format", "name", "content", "encoding"]);
      if (!CATEGORIES.has(item.category) || !Object.hasOwn(FORMATS, item.format)) throw fail("FINAL_RESULT_INVALID");
      label(item.name, 120);
      if (/[\\/]/.test(item.name) || /^\.+$/.test(item.name)) throw fail("FINAL_RESULT_INVALID");
      let content, bytes, sha256;
      if (item.format === "binary") {
        if (item.encoding !== "base64" || typeof item.content !== "string") throw fail("FINAL_RESULT_INVALID");
        if (item.content.length > Math.ceil(this.maxFileBytes / 3) * 4) throw fail("FINAL_RESULT_TOO_LARGE", 413);
        if (/[^A-Za-z0-9+/=]/.test(item.content)) throw fail("FINAL_RESULT_INVALID");
        const decoded = Buffer.from(item.content, "base64");
        if (decoded.toString("base64") !== item.content) throw fail("FINAL_RESULT_INVALID");
        content = item.content; bytes = decoded.length; sha256 = digest(decoded);
      } else if (item.encoding !== undefined && item.encoding !== "utf8") throw fail("FINAL_RESULT_INVALID");
      else if (item.format === "json") {
        if (!Object.hasOwn(item, "content")) throw fail("FINAL_RESULT_INVALID");
        content = JSON.stringify(item.content, null, 2) + "\n";
      } else {
        if (typeof item.content !== "string") throw fail("FINAL_RESULT_INVALID");
        content = item.content;
        if (item.format === "jsonl") for (const line of content.split(/\r?\n/).filter(Boolean)) {
          try { JSON.parse(line); } catch { throw fail("FINAL_RESULT_INVALID"); }
        }
      }
      bytes ??= Buffer.byteLength(content);
      if (bytes > this.maxFileBytes || (totalBytes += bytes) > this.maxTaskBytes) throw fail("FINAL_RESULT_TOO_LARGE", 413);
      return { category: item.category, format: item.format, name: item.name, content, encoding: item.format === "binary" ? "binary" : "utf8", bytes, sha256: sha256 || digest(content) };
    });
    return { instanceId: input.instanceId, taskId: input.taskId, title: input.title, type: input.type || "task", status: input.status, references: { ...references }, artifacts, totalBytes };
  }

  publishFinalResult(input) {
    // Serialize metadata/capacity work inside the Manager. Immutable directories
    // also arbitrate concurrent publishers in different Manager processes.
    const result = this.queue.then(() => this.publish(input));
    this.queue = result.catch(() => {});
    return result;
  }

  async publish(input) {
    // Guard before preparing any on-disk content, including manifest labels.
    let safe;
    try { safe = sanitizeFinalPublication(input, this.sanitize); } catch (error) { if (error.code === "FINAL_RESULT_TOO_LARGE") throw error; throw fail("FINAL_RESULT_REDACTION_FAILED", 400); }
    const normalized = this.normalize(safe);
    const fingerprint = digest(JSON.stringify(normalized));
    const { instanceId, taskId } = normalized;
    const existing = await this.find(instanceId, taskId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw fail("FINAL_RESULT_CONFLICT", 409);
      for (const file of existing.files) await this.openArtifact(instanceId, taskId, file.artifactId);
      return { result: existing, duplicate: true };
    }
    const tasks = await this.tasksDirectory(instanceId, true);
    if ((await fs.readdir(tasks)).length >= MAX_TASKS) throw fail("FINAL_RESULT_CAPACITY", 507);
    await this.directory(this.stageRoot, true);
    const stage = await fs.mkdtemp(path.join(this.stageRoot, "publish-"));
    try {
      const files = [];
      for (const item of normalized.artifacts) {
        await this.directory(path.join(stage, item.category), true);
        const artifactId = randomUUID();
        const relativePath = `${item.category}/${artifactId}.${FORMATS[item.format]}`;
        await this.writeFile(path.join(stage, relativePath), item.encoding === "binary" ? Buffer.from(item.content, "base64") : item.content);
        files.push({ artifactId, category: item.category, format: item.format, encoding: item.encoding, name: item.name, relativePath, bytes: item.bytes, sha256: item.sha256 });
      }
      for (const category of new Set(files.map((file) => file.category))) await this.syncDirectory(path.join(stage, category));
      const manifest = { version: 1, taskId, instanceId, title: normalized.title, type: normalized.type, status: normalized.status,
        final: true, publishedAt: this.now().toISOString(), fingerprint, privacy: { credentials: "text_redacted", binary: "verbatim", policyVersion: 1 },
        references: normalized.references, totalBytes: normalized.totalBytes, files };
      await this.writeFile(path.join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
      await this.syncDirectory(stage);
      try { await fs.rename(stage, path.join(tasks, taskId)); }
      catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
        const winner = await this.getFinalResult(instanceId, taskId);
        if (winner.fingerprint !== fingerprint) throw fail("FINAL_RESULT_CONFLICT", 409);
        for (const file of winner.files) await this.openArtifact(instanceId, taskId, file.artifactId);
        return { result: winner, duplicate: true };
      }
      await this.syncDirectory(tasks);
      return { result: manifest, duplicate: false };
    } finally { await fs.rm(stage, { recursive: true, force: true }); }
  }

  async writeFile(file, content) {
    const handle = await fs.open(file, "wx", 0o600);
    try { await handle.writeFile(content, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    if (process.platform === "win32") localAuth.protectOrCheck(file, false, true);
  }
  async syncDirectory(directory) {
    if (process.platform === "win32") return;
    const handle = await fs.open(directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }

  async find(instanceId, taskId) {
    try { return await this.getFinalResult(instanceId, taskId); }
    catch (error) { if (error.code === "FINAL_RESULT_NOT_FOUND") return null; throw error; }
  }

  async getFinalResult(instanceId, taskId) {
    identity(instanceId, taskId);
    if (!UUID.test(taskId)) throw fail("FINAL_RESULT_INVALID");
    try {
      const tasks = await this.tasksDirectory(instanceId);
      const directory = await this.directory(path.join(tasks, taskId));
      const bytes = await this.readFile(path.join(directory, "manifest.json"), 128 * 1024);
      let manifest;
      try { manifest = JSON.parse(bytes.toString("utf8")); } catch { throw fail("FINAL_RESULT_CORRUPT", 409); }
      try {
        object(manifest, ["version", "taskId", "instanceId", "title", "type", "status", "final", "publishedAt", "fingerprint", "privacy", "references", "totalBytes", "files"]);
        label(manifest.title, 160);
        if (!/^[a-z][a-z0-9_-]{0,63}$/.test(manifest.type) || new Date(manifest.publishedAt).toISOString() !== manifest.publishedAt) throw fail("FINAL_RESULT_CORRUPT", 409);
        validateReferences(manifest.references);
        object(manifest.privacy, ["credentials", "binary", "policyVersion"]);
        if (manifest.privacy.credentials !== "text_redacted" || manifest.privacy.binary !== "verbatim" || manifest.privacy.policyVersion !== 1) throw fail("FINAL_RESULT_CORRUPT", 409);
      } catch { throw fail("FINAL_RESULT_CORRUPT", 409); }
      if (manifest.version !== 1 || manifest.taskId !== taskId || manifest.instanceId !== instanceId || manifest.final !== true || !STATUSES.has(manifest.status) ||
        !/^[a-f0-9]{64}$/.test(manifest.fingerprint || "") || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > MAX_FILES) throw fail("FINAL_RESULT_CORRUPT", 409);
      for (const file of manifest.files) {
        try { object(file, ["artifactId", "category", "format", "encoding", "name", "relativePath", "bytes", "sha256"]); label(file.name, 120); }
        catch { throw fail("FINAL_RESULT_CORRUPT", 409); }
        if (!UUID.test(file.artifactId) || !CATEGORIES.has(file.category) || !Object.hasOwn(FORMATS, file.format) ||
          file.encoding !== (file.format === "binary" ? "binary" : "utf8") ||
          /[\\/]/.test(file.name) ||
          file.relativePath !== `${file.category}/${file.artifactId}.${FORMATS[file.format]}` || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > this.maxFileBytes ||
          !/^[a-f0-9]{64}$/.test(file.sha256 || "")) throw fail("FINAL_RESULT_CORRUPT", 409);
      }
      if (new Set(manifest.files.map((file) => file.artifactId)).size !== manifest.files.length ||
        manifest.totalBytes !== manifest.files.reduce((total, file) => total + file.bytes, 0) || manifest.totalBytes > this.maxTaskBytes) throw fail("FINAL_RESULT_CORRUPT", 409);
      return manifest;
    } catch (error) { if (error.code === "ENOENT") throw fail("FINAL_RESULT_NOT_FOUND", 404); throw error; }
  }

  async listFinalResults({ instanceId, offset = 0, limit = 20 } = {}) {
    identity(instanceId); page(offset, limit);
    let entries;
    try { entries = await fs.readdir(await this.tasksDirectory(instanceId), { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return { results: [], total: 0, totalBytes: 0, unavailable: 0, nextOffset: null, outputDirectory: this.root }; throw error; }
    if (entries.length > MAX_TASKS) throw fail("FINAL_RESULT_CAPACITY", 507);
    const results = [];
    let unavailable = 0;
    for (const entry of entries) {
      if (!UUID.test(entry.name)) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) { unavailable++; continue; }
      try { results.push(await this.getFinalResult(instanceId, entry.name)); }
      catch (error) { if (["FINAL_RESULT_CORRUPT", "FINAL_RESULT_PATH_REJECTED", "FINAL_RESULT_NOT_FOUND"].includes(error.code)) unavailable++; else throw error; }
    }
    results.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.taskId.localeCompare(b.taskId));
    return { results: results.slice(offset, offset + limit), total: results.length, totalBytes: results.reduce((total, item) => total + item.totalBytes, 0), unavailable,
      nextOffset: offset + limit < results.length ? offset + limit : null, outputDirectory: this.root };
  }

  async openArtifact(instanceId, taskId, artifactId) {
    if (!UUID.test(artifactId)) throw fail("FINAL_RESULT_INVALID");
    const manifest = await this.getFinalResult(instanceId, taskId);
    const file = manifest.files.find((item) => item.artifactId === artifactId);
    if (!file) throw fail("FINAL_RESULT_NOT_FOUND", 404);
    const tasks = await this.tasksDirectory(instanceId);
    const task = await this.directory(path.join(tasks, taskId));
    await this.directory(path.join(task, file.category));
    let content;
    try { content = await this.readFile(path.join(task, file.relativePath), this.maxFileBytes); }
    catch (error) { if (error.code === "ENOENT") throw fail("FINAL_RESULT_CORRUPT", 409); throw error; }
    if (content.length !== file.bytes || digest(content) !== file.sha256) throw fail("FINAL_RESULT_CORRUPT", 409);
    return { file, content };
  }

  cleanupFinalResult(instanceId, taskId) {
    const result = this.queue.then(async () => {
      await this.getFinalResult(instanceId, taskId);
      const tasks = await this.tasksDirectory(instanceId);
      await this.directory(this.stageRoot, true);
      const trash = path.join(this.stageRoot, `delete-${randomUUID()}`);
      await fs.rename(path.join(tasks, taskId), trash);
      await this.syncDirectory(tasks);
      await fs.rm(trash, { recursive: true, force: true });
      return { taskId, removed: true };
    });
    this.queue = result.catch(() => {});
    return result;
  }
}
