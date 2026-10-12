// Serialized into a fixed read-only Node helper and sent over SSH stdin.
// Keep all dependencies inside the function so the remote host needs only Node.
export async function remoteLogQuery(input) {
  const fs = require("fs");
  const path = require("path").posix;
  const zlib = require("zlib");
  const { StringDecoder } = require("string_decoder");
  const { Readable } = require("stream");
  const started = Date.now();
  const warnings = [];
  const files = [];
  let records = [];
  const retainedRecords = [];
  let retainedBytes = 0;
  const members = [];
  let archiveMembersScanned = 0;
  let memberListingStopped = false;
  let memberBytes = 0;
  let outputBytes = 0;
  let scannedBytes = 0;
  let expandedBytes = 0;
  let matchedLines = 0;
  let scannedLines = 0;
  let outputTruncated = false;
  let scanTruncated = false;
  let filesTruncated = false;
  let listingTruncated = false;
  let directoryEntries = 0;
  let warningsTruncated = false;
  function warn(value) {
    if (warnings.length < 100) warnings.push(value);
    else warningsTruncated = true;
  }
  const inside = (value, root) => value === root || value.startsWith(`${root}/`);
  const failure = (message, code) => Object.assign(new Error(message), { code });
  function active() {
    if (Date.now() >= input.deadlineAt) throw failure("log query deadline exceeded", "OPERATION_DEADLINE_EXCEEDED");
  }
  async function canonical(value) {
    const normalized = path.normalize(value);
    const roots = input.allowedRoots.filter((root) => inside(normalized, root));
    if (!roots.length) throw failure("path is outside approved roots", "PATH_NOT_ALLOWED");
    const resolvedRoots = [];
    for (const root of roots) resolvedRoots.push(await fs.promises.realpath(root));
    const resolved = await fs.promises.realpath(normalized);
    if (!resolvedRoots.some((root) => inside(resolved, root))) throw failure("symlink escapes approved roots", "PATH_NOT_ALLOWED");
    return resolved;
  }
  const dateIn = (name) => /\d{4}-\d{2}-\d{2}/.exec(name)?.[0];
  function fileMatches(name) {
    if (input.fileContains && !name.toLowerCase().includes(input.fileContains.toLowerCase())) return false;
    const date = dateIn(name);
    if ((input.dateFrom || input.dateTo) && (!date || (input.dateFrom && date < input.dateFrom) || (input.dateTo && date > input.dateTo))) return false;
    return true;
  }
  function logName(name) {
    return /\.log(?:\.\d+)?(?:\.gz)?$/i.test(name) || /\.(?:tar\.gz|tgz)$/i.test(name)
      || /^(?:syslog|messages|auth\.log)(?:\.\d+)?(?:\.gz)?$/i.test(name);
  }
  async function addFile(requested, directory) {
    active();
    const resolved = await canonical(requested);
    if (directory && !inside(resolved, directory)) throw failure("log symlink escapes the selected directory", "PATH_NOT_ALLOWED");
    const stats = await fs.promises.stat(resolved);
    if (!stats.isFile()) return;
    if (files.some((file) => file.path === resolved)) return;
    const compression = /\.(?:tar\.gz|tgz)$/i.test(resolved) ? "tar-gzip" : /\.gz$/i.test(resolved) ? "gzip" : "none";
    files.push({ path: resolved, name: path.basename(requested), size: stats.size, modifyTime: stats.mtimeMs, compression });
  }
  if (input.path) {
    if (/\.(?:bz2|xz|zip|tar)$/i.test(input.path)) throw failure("unsupported log compression", "UNSUPPORTED_COMPRESSION");
    if (/\/(?:btmp|wtmp|lastlog|faillog)(?:\.\d+)?(?:\.gz)?$/.test(input.path)) throw failure("binary log cannot be read as text", "BINARY_LOG_UNSUPPORTED");
    if (fileMatches(path.basename(input.path))) await addFile(input.path);
  } else {
    for (const directory of input.directories) {
      active();
      try {
        const resolved = await canonical(directory);
        const handle = await fs.promises.opendir(resolved);
        try {
          for await (const entry of handle) {
            active();
            if (++directoryEntries > input.maxDirectoryEntries) { listingTruncated = true; break; }
            if ((!entry.isFile() && !entry.isSymbolicLink()) || !logName(entry.name) || !fileMatches(entry.name)) continue;
            try { await addFile(path.join(directory, entry.name), resolved); }
            catch (error) {
              if (error.code === "OPERATION_DEADLINE_EXCEEDED") throw error;
              warn({ path: path.join(directory, entry.name), code: error.code, message: error.message });
            }
          }
        } finally { await handle.close().catch(() => {}); }
      } catch (error) {
        if (error.code === "OPERATION_DEADLINE_EXCEEDED") throw error;
        warn({ path: directory, code: error.code, message: error.message });
      }
    }
  }
  files.sort((a, b) => b.modifyTime - a.modifyTime || a.name.localeCompare(b.name));
  filesTruncated = files.length > input.maxFiles;
  const selected = files.slice(input.fileOffset, input.fileOffset + input.maxFiles);
  filesTruncated = input.fileOffset + selected.length < files.length;
  const inspectedFiles = selected.map((file) => ({ ...file }));
  if (input.mode === "files") return {
    mode: input.mode, projectId: input.projectId, files: inspectedFiles, warnings,
    hasMoreFiles: filesTruncated, nextFileOffset: filesTruncated ? input.fileOffset + selected.length : null,
    directoryListingTruncated: listingTruncated, warningsTruncated, durationMs: Date.now() - started,
  };

  function recordFields(line) {
    let outer, inner;
    try { outer = JSON.parse(line); } catch { /* plain text log */ }
    const message = typeof outer?.message === "string" ? outer.message : "";
    const bracketTime = /^\[([^\]]+)\]/.exec(message)?.[1];
    const brace = message.indexOf("{");
    if (brace >= 0) { try { inner = JSON.parse(message.slice(brace)); } catch { /* unstructured message */ } }
    inner ||= outer;
    const timestamp = inner?.timestamp || outer?.timestamp || bracketTime || /^\[?((?:\d{4}-\d{2}-\d{2})T[^\s\]]+)/.exec(line)?.[1];
    const scalar = (value, limit) => typeof value === "string" ? value.slice(0, limit) : undefined;
    return { timestamp: scalar(timestamp, 40), level: scalar(outer?.level || inner?.level, 32),
      route: scalar(inner?.path || inner?.route, 1024), method: scalar(inner?.method, 32) };
  }
  function match(line, fields) {
    if (input.contains && !(input.caseSensitive ? line : line.toLowerCase()).includes(input.caseSensitive ? input.contains : input.contains.toLowerCase())) return false;
    if (input.level && String(fields.level || "").toLowerCase() !== input.level) return false;
    if (input.route && fields.route !== input.route) return false;
    if (input.method && String(fields.method || "").toUpperCase() !== input.method) return false;
    const timestamp = Date.parse(fields.timestamp);
    if ((input.fromTime || input.toTime) && (!Number.isFinite(timestamp) || (input.fromTime && timestamp < Date.parse(input.fromTime)) || (input.toTime && timestamp > Date.parse(input.toTime)))) return false;
    return true;
  }
  function addRecord(line, file, lineNumber, memberPath, lineFromEnd) {
    scannedLines++;
    const fields = recordFields(line);
    if (!match(line, fields)) return;
    matchedLines++;
    const raw = Buffer.from(line);
    const shortened = raw.length > input.maxBytes;
    let text = shortened ? raw.subarray(0, input.maxBytes).toString("utf8").replace(/\uFFFD$/, "") : line;
    if (shortened) outputTruncated = true;
    const record = { file, ...(memberPath ? { memberPath } : {}), ...(lineNumber ? { lineNumber } : {}), ...(lineFromEnd ? { lineFromEnd } : {}), ...fields, text, ...(shortened ? { truncated: true } : {}) };
    records.push(record);
    outputBytes += Buffer.byteLength(text);
    while (records.length > input.limit || (outputBytes > input.maxBytes && records.length > 1)) {
      const removed = records.shift();
      outputBytes -= Buffer.byteLength(removed.text);
      outputTruncated = true;
    }
  }
  function lineConsumer(file, memberPath, discardFirstLine = false) {
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let oversized = false;
    let lineNumber = 0;
    return {
      write(chunk) {
        const text = decoder.write(chunk);
        let offset = 0;
        while (offset < text.length) {
          const end = text.indexOf("\n", offset);
          const piece = text.slice(offset, end < 0 ? text.length : end);
          if (!oversized) pending += piece;
          // Bound pathological records. Do not claim a truncated search line
          // matched: the query may occur in the omitted part.
          if (Buffer.byteLength(pending) > input.maxLineBytes) { oversized = true; pending = ""; }
          if (end < 0) break;
          lineNumber++;
          if (oversized) { scanTruncated = true; warn({ file, memberPath, lineNumber, code: "LOG_LINE_TOO_LARGE" }); }
          else if (!discardFirstLine || lineNumber > 1) addRecord(pending.replace(/\r$/, ""), file, lineNumber, memberPath);
          pending = ""; oversized = false; offset = end + 1;
        }
      },
      finish() {
        pending += decoder.end();
        if (oversized) { scanTruncated = true; return; }
        if (pending) {
          lineNumber++;
          if (!discardFirstLine || lineNumber > 1) addRecord(pending.replace(/\r$/, ""), file, lineNumber, memberPath);
        }
        if (discardFirstLine) for (const record of records) {
          record.lineFromEnd = lineNumber - record.lineNumber + 1;
          delete record.lineNumber;
        }
      },
    };
  }
  function allowedMember(name) {
    return name && path.normalize(name) !== "." && !name.startsWith("/") && !name.includes("\0") && !name.includes("\\") && !name.split("/").includes("..");
  }
  function memberMatches(name) {
    return (!input.memberPath || name === input.memberPath)
      && (!input.memberContains || name.toLowerCase().includes(input.memberContains.toLowerCase()));
  }
  // A bounded streaming tar parser. Never creates directories or writes files.
  function tarConsumer(file) {
    let header = Buffer.alloc(0), remaining = 0, padding = 0, consumer = null;
    let metadata = null, parts = [], pax = {}, globalPax = {}, longName = "";
    let done = false, selectedMember = false, foundMember = false;
    const number = (bytes) => {
      if (bytes[0] & 0x80) throw failure("unsupported tar numeric format", "LOG_ARCHIVE_INVALID");
      const value = bytes.toString("ascii").replace(/\0/g, "").trim();
      if (value && !/^[0-7]+$/.test(value)) throw failure("invalid tar number", "LOG_ARCHIVE_INVALID");
      const parsed = value ? parseInt(value, 8) : 0;
      if (!Number.isSafeInteger(parsed)) throw failure("invalid tar size", "LOG_ARCHIVE_INVALID");
      return parsed;
    };
    const field = (buffer, offset, size) => buffer.subarray(offset, offset + size).toString("utf8").replace(/\0.*$/, "");
    function endEntry() {
      consumer?.finish(); consumer = null;
      if (selectedMember && input.memberPath) done = true;
      selectedMember = false;
      if (metadata) {
        const buffer = Buffer.concat(parts);
        if (metadata === "L") longName = buffer.toString("utf8").replace(/\0.*$/, "");
        else if (metadata === "x" || metadata === "g") {
          const fields = {};
          for (let offset = 0; offset < buffer.length;) {
            const space = buffer.indexOf(32, offset);
            const length = Number(buffer.subarray(offset, space).toString());
            if (space < 0 || !Number.isInteger(length) || length <= space - offset + 1 || offset + length > buffer.length) throw failure("invalid PAX record", "LOG_ARCHIVE_INVALID");
            const record = buffer.subarray(space + 1, offset + length).toString("utf8");
            const equals = record.indexOf("=");
            if (equals < 1) throw failure("invalid PAX record", "LOG_ARCHIVE_INVALID");
            fields[record.slice(0, equals)] = record.slice(equals + 1).replace(/\n$/, "");
            offset += length;
          }
          if (metadata === "g") globalPax = { ...globalPax, ...fields }; else pax = fields;
        }
        parts = []; metadata = null;
      }
    }
    return {
      write(chunk) {
        let offset = 0;
        while (offset < chunk.length && !done) {
          if (remaining) {
            const size = Math.min(remaining, chunk.length - offset);
            const piece = chunk.subarray(offset, offset + size);
            if (metadata) parts.push(Buffer.from(piece));
            else if (consumer) {
              if (scannedBytes + size > input.maxScanBytes) { scanTruncated = true; return false; }
              scannedBytes += size; consumer.write(piece);
            }
            remaining -= size; offset += size;
            if (!remaining) endEntry();
          } else if (padding) {
            const size = Math.min(padding, chunk.length - offset); padding -= size; offset += size;
          } else {
            const needed = 512 - header.length;
            const piece = chunk.subarray(offset, offset + needed); offset += piece.length;
            header = Buffer.concat([header, piece]);
            if (header.length < 512) break;
            if (header.every((byte) => byte === 0)) { done = true; header = Buffer.alloc(0); break; }
            let checksum = 0;
            for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
            if (number(header.subarray(148, 156)) !== checksum) throw failure("invalid tar checksum", "LOG_ARCHIVE_INVALID");
            let name = field(header, 0, 100);
            const prefix = field(header, 345, 155); if (prefix) name = `${prefix}/${name}`;
            const type = field(header, 156, 1) || "0";
            const extended = { ...globalPax, ...pax };
            remaining = extended.size === undefined ? number(header.subarray(124, 136)) : Number(extended.size);
            if (!Number.isSafeInteger(remaining) || remaining < 0) throw failure("invalid tar member size", "LOG_ARCHIVE_INVALID");
            padding = (512 - remaining % 512) % 512;
            metadata = ["x", "g", "L", "K"].includes(type) ? type : null;
            if (metadata && remaining > 1024 * 1024) throw failure("tar metadata too large", "LOG_ARCHIVE_INVALID");
            if (!metadata) {
              name = extended.path || longName || name; pax = {}; longName = "";
              if (name.length > 4096) throw failure("archive member name exceeds the path limit", "LOG_ARCHIVE_INVALID");
              if (allowedMember(name)) name = path.normalize(name);
              if (input.mode === "members") {
                const index = archiveMembersScanned++;
                if (archiveMembersScanned > input.maxArchiveMembers) { scanTruncated = true; return false; }
                if (index >= input.memberOffset && (!input.memberPrefix || name.startsWith(input.memberPrefix))) {
                  const memberType = type === "0" ? "file" : type === "5" ? "directory" : type === "2" ? "symlink" : type === "1" ? "hardlink" : "special";
                  const readable = type === "0" && Boolean(allowedMember(name));
                  const member = { name, size: remaining, type: memberType, readable,
                    ...(readable ? {} : { readReason: "member must be a safe relative regular file" }) };
                  const bytes = Buffer.byteLength(JSON.stringify(member));
                  if (members.length && memberBytes + bytes > input.maxBytes) {
                    archiveMembersScanned--; memberListingStopped = true; done = true;
                  } else { members.push(member); memberBytes += bytes; }
                  if (members.length >= input.limit) { memberListingStopped = true; done = true; }
                }
              } else if (input.memberPath === name && (type !== "0" || !allowedMember(name))) throw failure("archive member must be a safe regular file", "ARCHIVE_MEMBER_NOT_READABLE");
              if (input.mode !== "members" && type === "0" && allowedMember(name) && (logName(name) || input.memberPath === name) && memberMatches(name)) {
                consumer = lineConsumer(file, name); selectedMember = true; foundMember = true;
              }
            }
            header = Buffer.alloc(0);
            if (!remaining) endEntry();
          }
        }
        return !(done && (input.memberPath || memberListingStopped));
      },
      finish() {
        if (done && input.memberPath) return;
        if (remaining || padding || header.length) throw failure("incomplete tar archive", "LOG_ARCHIVE_INVALID");
        if (input.memberPath && !foundMember) throw failure("archive member was not found", "ARCHIVE_MEMBER_NOT_FOUND");
      },
    };
  }
  const scannedFiles = [];
  for (const file of selected) {
    active();
    if (scannedBytes >= input.maxScanBytes || expandedBytes >= input.maxExpandedBytes) { scanTruncated = true; break; }
    if (input.mode === "latest" && retainedRecords.length >= input.limit) { scanTruncated = true; break; }
    records = []; outputBytes = 0;
    const before = scannedBytes;
    let rangeStart = 0;
    let fd;
    try {
      fd = await fs.promises.open(file.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const liveStats = await fd.stat();
      if (!liveStats.isFile()) throw failure("path is not a regular log file", "LOG_NOT_FILE");
      // Snapshot the file size; exclude bytes appended during this query.
      file.size = liveStats.size;
      const prefix = Buffer.alloc(8);
      const inspected = await fd.read(prefix, 0, Math.min(8, file.size), 0);
      if ((prefix[0] === 66 && prefix[1] === 90 && prefix[2] === 104)
        || (prefix[0] === 253 && prefix[1] === 55 && prefix[2] === 122)
        || (prefix[0] === 80 && prefix[1] === 75)) throw failure("unsupported log compression", "UNSUPPORTED_COMPRESSION");
      if (prefix[0] === 31 && prefix[1] === 139 && file.compression === "none") file.compression = "gzip";
      if (file.compression === "none" && prefix.subarray(0, inspected.bytesRead).includes(0)) throw failure("binary log cannot be read as text", "BINARY_LOG_UNSUPPORTED");
      if (input.mode === "latest" && file.compression === "none") {
        let position = file.size;
        let suffix = Buffer.alloc(0);
        while (position > 0 && scannedBytes < input.maxScanBytes) {
          active();
          const size = Math.min(32768, position, input.maxScanBytes - scannedBytes);
          position -= size;
          rangeStart = position;
          const buffer = Buffer.allocUnsafe(size);
          const read = await fd.read(buffer, 0, size, position);
          scannedBytes += read.bytesRead;
          if (read.bytesRead < size) warn({ path: file.path, code: "LOG_FILE_CHANGED", message: "file was truncated during the query" });
          suffix = Buffer.concat([buffer.subarray(0, read.bytesRead), suffix]);
          const newline = suffix.indexOf(10);
          const complete = position === 0 ? suffix : newline < 0 ? Buffer.alloc(0) : suffix.subarray(newline + 1);
          const lines = complete.toString("utf8").split("\n");
          if (lines[lines.length - 1] === "") lines.pop();
          if (lines.length >= input.limit || position === 0 || suffix.length >= input.maxLineBytes) {
            for (let i = Math.max(0, lines.length - input.limit); i < lines.length; i++) addRecord(lines[i].replace(/\r$/, ""), file.path, null, null, lines.length - i);
            if (position > 0) scanTruncated = true;
            break;
          }
        }
        if (position > 0) scanTruncated = true;
      } else {
        rangeStart = file.compression === "none" ? Math.max(0, file.size - (input.maxScanBytes - scannedBytes)) : 0;
        if (rangeStart > 0) scanTruncated = true;
        const source = Readable.from((async function* () {
          let position = rangeStart;
          while (position < file.size) {
            active();
            const buffer = Buffer.allocUnsafe(Math.min(65536, file.size - position));
            const read = await fd.read(buffer, 0, buffer.length, position);
            if (!read.bytesRead) { warn({ path: file.path, code: "LOG_FILE_CHANGED", message: "file was truncated during the query" }); break; }
            position += read.bytesRead;
            yield buffer.subarray(0, read.bytesRead);
          }
        })());
        let stream = source;
        let gunzip;
        let sourceError;
        if (file.compression !== "none") {
          gunzip = zlib.createGunzip();
          source.on("error", (error) => { sourceError = error; gunzip.destroy(error); });
          stream = source.pipe(gunzip);
        }
        const consumer = file.compression === "tar-gzip" ? tarConsumer(file.path) : lineConsumer(file.path, null, rangeStart > 0);
        let stopped = false;
        try {
          for await (const chunk of stream) {
            active();
            if (file.compression !== "none") {
              if (expandedBytes + chunk.length > input.maxExpandedBytes) { scanTruncated = true; stopped = true; break; }
              expandedBytes += chunk.length;
            }
            if (file.compression !== "tar-gzip") {
              if (scannedBytes + chunk.length > input.maxScanBytes) { scanTruncated = true; stopped = true; break; }
              scannedBytes += chunk.length;
            }
            if (consumer.write(chunk) === false) { stopped = true; break; }
          }
          if (!stopped) consumer.finish();
        } finally { source.destroy(); gunzip?.destroy(); }
        if (sourceError) throw sourceError;
      }
      scannedFiles.push({ path: file.path, scannedBytes: scannedBytes - before,
        ...(file.compression === "none" ? { startByte: rangeStart, endByte: file.size } : {}) });
    } catch (error) {
      if (error.code === "OPERATION_DEADLINE_EXCEEDED") throw error;
      if (input.path) throw error;
      warn({ path: file.path, code: error.code || "LOG_READ_FAILED", message: error.message });
    } finally {
      await fd?.close();
      for (const record of records.reverse()) {
        const bytes = Buffer.byteLength(record.text);
        if (retainedRecords.length >= input.limit || retainedBytes + bytes > input.maxBytes) { outputTruncated = true; continue; }
        retainedRecords.push(record); retainedBytes += bytes;
      }
    }
  }
  for (const file of inspectedFiles) {
    const live = selected.find((selectedFile) => selectedFile.path === file.path);
    file.size = live.size; file.compression = live.compression;
  }
  const complete = !memberListingStopped && !scanTruncated && !filesTruncated && !listingTruncated && !warnings.length && !warningsTruncated;
  return {
    mode: input.mode, projectId: input.projectId, files: inspectedFiles, scannedFiles,
    records: retainedRecords, content: retainedRecords.map((record) => record.text).join("\n") + (retainedRecords.length ? "\n" : ""),
    returnedLines: retainedRecords.length, matchedLines, scannedLines, scannedBytes, expandedBytes,
    outputBytes: retainedBytes, outputTruncated, scanTruncated, complete,
    coverage: complete ? "complete" : input.mode === "latest" && selected.every((file) => file.compression === "none") ? "tail" : "bounded",
    countsAreComplete: complete, hasMoreFiles: filesTruncated,
    nextFileOffset: filesTruncated ? input.fileOffset + selected.length : null,
    ...(input.mode === "members" ? { members, hasMoreMembers: memberListingStopped || scanTruncated,
      nextMemberOffset: memberListingStopped || scanTruncated ? archiveMembersScanned : null, memberBytes } : {}),
    directoryListingTruncated: listingTruncated, warningsTruncated, warnings, durationMs: Date.now() - started,
  };
}
