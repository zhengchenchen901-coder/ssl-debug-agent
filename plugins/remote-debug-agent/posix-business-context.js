import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { selectContext, validateContext, contextFailure } from "./business-context.js";

// Dependency injection is local-only, so the macOS path can be verified on
// Windows without pretending Windows uid/mode semantics are POSIX semantics.
export function createPosixContextAdapter({ filesystem = fs, paths = path, platform = process.platform, getuid = () => process.getuid() } = {}) {
  function checkParents(filename) {
    for (let parent = paths.dirname(filename); parent !== paths.dirname(parent); parent = paths.dirname(parent)) {
      const stat = filesystem.lstatSync(parent);
      if (!stat.isDirectory() && !stat.isSymbolicLink()) throw contextFailure("BUSINESS_CONTEXT_DENIED");
      if (stat.isSymbolicLink()) {
        const expected = platform === "darwin" && { "/tmp": "/private/tmp", "/var": "/private/var" }[parent];
        if (!expected || filesystem.realpathSync(parent) !== expected) throw contextFailure("BUSINESS_CONTEXT_DENIED");
      }
    }
  }
  function privateStat(stat, directory = false) {
    if (stat.uid !== getuid() || (stat.mode & 0o077) || stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile())) {
      throw contextFailure("BUSINESS_CONTEXT_DENIED");
    }
  }
  function read(filename, origin, expectedId) {
    const before = filesystem.lstatSync(filename);
    privateStat(before);
    // Inspect the opened file too; a path replacement must not bypass the
    // owner/mode checks or redirect the read through a symbolic link.
    const fd = filesystem.openSync(filename, filesystem.constants.O_RDONLY | filesystem.constants.O_NOFOLLOW);
    try {
      const opened = filesystem.fstatSync(fd);
      privateStat(opened);
      if (before.ino !== opened.ino || before.dev !== opened.dev || opened.size > 16384) throw contextFailure("BUSINESS_CONTEXT_DENIED");
      const auth = validateContext(filesystem.readFileSync(fd, "utf8"), origin);
      if (expectedId && auth.contextId !== expectedId) throw contextFailure("BUSINESS_CONTEXT_DENIED");
      return auth;
    } finally { filesystem.closeSync(fd); }
  }
  return async function attachPosixContext(settings, origin, createAuth) {
    // Missing selection must have no filesystem or Manager side effects.
    const { filename, existingOnly, expectedId } = selectContext(settings, paths);
    let temporary;
    try {
      const directory = paths.join(settings.dataDir, ".private", "contexts");
      // Validate existing ancestors before mkdir can follow a user-created link.
      let ancestor = directory;
      while (!filesystem.existsSync(ancestor)) ancestor = paths.dirname(ancestor);
      checkParents(paths.join(ancestor, "placeholder"));
      filesystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
      privateStat(filesystem.lstatSync(directory), true);
      checkParents(filename);
      try { return read(filename, origin, expectedId); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (existingOnly) throw contextFailure("BUSINESS_CONTEXT_MISSING");
      }
      const auth = await createAuth();
      const content = JSON.stringify({ version: 1, origin, auth });
      validateContext(content, origin);
      temporary = filename + "." + randomUUID() + ".tmp";
      const fd = filesystem.openSync(temporary, "wx", 0o600);
      try { filesystem.writeFileSync(fd, content); filesystem.fsyncSync(fd); }
      finally { filesystem.closeSync(fd); }
      // Publish only a complete, flushed file, without overwriting a concurrent
      // creator. A losing creator reuses the winner's original identity.
      try { filesystem.linkSync(temporary, filename); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      filesystem.unlinkSync(temporary); temporary = undefined;
      const parent = filesystem.openSync(paths.dirname(filename), "r");
      try { filesystem.fsyncSync(parent); } finally { filesystem.closeSync(parent); }
      return read(filename, origin, expectedId);
    } catch (error) {
      if (error.code?.startsWith("BUSINESS_")) throw error;
      throw contextFailure("BUSINESS_CONTEXT_DENIED");
    } finally {
      if (temporary) {
        try { filesystem.unlinkSync(temporary); } catch { /* Never remove another creator's file or lock. */ }
      }
    }
  };
}

export const attachPosixContext = createPosixContextAdapter();
