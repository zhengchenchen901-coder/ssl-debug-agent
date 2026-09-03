import posixPath from "node:path/posix";
import { StringDecoder } from "node:string_decoder";
import { createGunzip } from "node:zlib";
import {
  OPERATION_TIMEOUTS,
  assertOperationActive,
  createOperationController,
  normalizeOperationEnvelope,
  operationError,
  operationErrorForSignal,
} from "./operation.js";
import {
  createRemoteReadStream,
  resolveCanonicalRemotePath,
  sftpClose,
  sftpOpendir,
  sftpReaddirHandle,
  sftpStat,
  withSftp,
} from "./ssh.js";
import {
  LOG_CAPABILITIES,
  LOG_CATEGORIES,
  LOG_DEFAULT_SCAN_BYTES,
  LOG_MAX_ARCHIVE_SCAN_BYTES,
  LOG_MAX_COMPRESSED_SOURCE_BYTES,
  LOG_MAX_LIMIT,
  LOG_MAX_MEMBER_BYTES,
  LOG_MAX_PAX_BYTES,
  LOG_MAX_SCAN_BYTES,
  LOG_MAX_SCAN_ENTRIES,
  LOG_SUPPORTED_COMPRESSION,
  decodeLogCursor,
  encodeLogCursor,
  logInputError,
  normalizeArchiveMemberListOptions,
  normalizeArchiveMemberPath,
  normalizeLogListOptions,
  normalizeLogReadOptions,
} from "./log-policy.js";

const DIRECTORY_TYPE = 0o040000;
const REGULAR_TYPE = 0o100000;
const TAR_BLOCK_SIZE = 512;
const TAR_HEADER_CHECKSUM_START = 148;
const TAR_HEADER_CHECKSUM_END = 156;
const LOG_SOURCE_READ_LIMIT = LOG_MAX_COMPRESSED_SOURCE_BYTES;
const CONFIG_READ_LIMIT = 128 * 1024;
const HOME_GITHUB_SCAN_LIMIT = 256;
const NESTED_DIRECTORY_SCAN_LIMIT = 256;

const SYSTEM_LOG_NAMES = new Set([
  "alternatives.log",
  "auth.log",
  "boot.log",
  "btmp",
  "cloud-init.log",
  "cloud-init-output.log",
  "cloudinit-deploy.log",
  "dmesg",
  "dpkg.log",
  "ecsgo.log",
  "ecs_network_optimization.log",
  "faillog",
  "fontconfig.log",
  "kern.log",
  "lastlog",
  "syslog",
  "tallylog",
  "wtmp",
]);

const BINARY_SYSTEM_LOG_NAMES = new Set([
  "btmp",
  "faillog",
  "lastlog",
  "wtmp",
]);

const SOURCE_PRIORITY = Object.freeze({
  nginx: 0,
  pm2: 1,
  application: 2,
  system: 3,
});

function requireSupervisor(options) {
  if (!options?.supervisor) {
    throw operationError("SSH connection supervisor is required", {
      code: "SSH_SUPERVISOR_REQUIRED",
      statusCode: 500,
      layer: "ssh",
      phase: "configuration",
    });
  }
  return options.supervisor;
}

function prepareOperation(options) {
  if (options.operation) {
    return { operation: options.operation, cleanup: () => {} };
  }

  const envelope = normalizeOperationEnvelope(
    { timeoutMs: options.timeoutMs },
    OPERATION_TIMEOUTS.file,
  );
  const linked = createOperationController(envelope, options.signal, {
    layer: "ssh",
    deadlinePhase: "log-read",
  });
  return {
    operation: { ...envelope, signal: linked.signal },
    cleanup: linked.cleanup,
  };
}

function logRuntimeError(message, code, operation, phase = "log-read", details) {
  return operationError(message, {
    code,
    statusCode: 422,
    operationId: operation?.operationId,
    layer: "ssh",
    phase,
    retriable: false,
    details,
  });
}

function isTerminalOperationError(error) {
  return error?.code === "OPERATION_DEADLINE_EXCEEDED" || error?.code === "OPERATION_CANCELLED";
}

function isDirectoryMode(mode) {
  return (((Number(mode) || 0) & 0o170000) === DIRECTORY_TYPE);
}

function isRegularMode(mode) {
  const type = (Number(mode) || 0) & 0o170000;
  return type === 0 || type === REGULAR_TYPE;
}

function mapDirectoryEntry(entry) {
  return {
    name: entry.filename,
    longname: entry.longname,
    size: entry.attrs?.size,
    modifyTime: entry.attrs?.mtime,
    permissions: entry.attrs?.mode,
  };
}

function joinRemotePath(parent, child) {
  return `${String(parent || "").replace(/\/+$/, "")}/${String(child || "").replace(/^\/+/, "")}`;
}

function directoryEntryIsUsable(entry) {
  return entry && entry.filename !== "." && entry.filename !== "..";
}

async function readDirectoryPage(
  sftp,
  requestedPath,
  operation,
  allowedPaths,
  offset,
  limit,
  markProgress,
) {
  const canonicalPath = await resolveCanonicalRemotePath(
    sftp,
    requestedPath,
    operation,
    allowedPaths,
  );
  const handle = await sftpOpendir(sftp, canonicalPath, operation);
  const entries = [];
  let seen = 0;
  let hasMore = false;

  try {
    while (true) {
      assertOperationActive(operation, operation.signal, {
        layer: "ssh",
        phase: "sftp-readdir-handle",
      });
      const batch = await sftpReaddirHandle(sftp, handle, operation);
      if (batch === false) {
        break;
      }

      for (const entry of Array.isArray(batch) ? batch : []) {
        markProgress?.();
        if (!directoryEntryIsUsable(entry)) {
          continue;
        }
        if (seen < offset) {
          seen += 1;
          continue;
        }
        if (entries.length >= limit) {
          hasMore = true;
          break;
        }
        entries.push(mapDirectoryEntry(entry));
        seen += 1;
      }

      if (hasMore) {
        break;
      }
    }
  } finally {
    await sftpClose(sftp, handle, operation).catch(() => {});
  }

  return {
    path: canonicalPath,
    entries,
    hasMore,
  };
}

async function readDirectorySample(
  sftp,
  requestedPath,
  operation,
  allowedPaths,
  limit,
  markProgress,
) {
  try {
    return await readDirectoryPage(
      sftp,
      requestedPath,
      operation,
      allowedPaths,
      0,
      limit,
      markProgress,
    );
  } catch (error) {
    if (isTerminalOperationError(error)) throw error;
    return null;
  }
}

async function readStreamPrefix(stream, maxBytes, operation, markProgress) {
  const chunks = [];
  let total = 0;
  let stopped = false;

  try {
    for await (const rawChunk of stream) {
      assertOperationActive(operation, operation.signal, {
        layer: "ssh",
        phase: "sftp-prefix-read",
      });
      markProgress?.();
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      const remaining = maxBytes - total;
      if (remaining <= 0) {
        stopped = true;
        stream.destroy?.();
        break;
      }
      const piece = chunk.subarray(0, remaining);
      chunks.push(piece);
      total += piece.length;
      if (total >= maxBytes) {
        stopped = true;
        stream.destroy?.();
        break;
      }
    }
  } catch (error) {
    if (operation.signal?.aborted) {
      throw operationErrorForSignal(operation.signal, operation, {
        layer: "ssh",
        phase: "sftp-prefix-read",
      });
    }
    if (!stopped) {
      throw logRuntimeError(
        error.message || "failed to inspect log format",
        "LOG_PREFIX_READ_FAILED",
        operation,
        "sftp-prefix-read",
      );
    }
  }

  return Buffer.concat(chunks, total);
}

async function readSmallTextFile(
  sftp,
  requestedPath,
  operation,
  allowedPaths,
  markProgress,
  maxBytes = CONFIG_READ_LIMIT,
) {
  const canonicalPath = await resolveCanonicalRemotePath(
    sftp,
    requestedPath,
    operation,
    allowedPaths,
  );
  const stats = await sftpStat(sftp, canonicalPath, operation);
  const size = Number(stats.size);
  if (Number.isFinite(size) && size > maxBytes) {
    throw logRuntimeError(
      `remote metadata file is larger than ${maxBytes} bytes`,
      "LOG_METADATA_TOO_LARGE",
      operation,
      "sftp-metadata-read",
    );
  }
  const stream = createRemoteReadStream(sftp, canonicalPath, {
    start: 0,
    end: Math.max(0, maxBytes - 1),
  });
  const prefix = await readStreamPrefix(stream, maxBytes, operation, markProgress);
  return { path: canonicalPath, content: prefix.toString("utf8") };
}

function errorIsMissing(error) {
  const code = error?.cause?.code || error?.code;
  return code === 2 || code === "ENOENT" || /no such file/i.test(error?.message || "");
}

function compressionForName(name) {
  const value = String(name || "").toLowerCase();
  if (value.endsWith(".tar.gz") || value.endsWith(".tgz")) return "tar-gzip";
  if (value.endsWith(".gz")) return "gzip";
  if (value.endsWith(".bz2")) return "bzip2";
  if (value.endsWith(".xz")) return "xz";
  if (value.endsWith(".zip")) return "zip";
  if (value.endsWith(".tar")) return "tar";
  return "none";
}

function magicCompression(prefix) {
  if (prefix.length >= 2 && prefix[0] === 0x1f && prefix[1] === 0x8b) return "gzip";
  if (prefix.length >= 3 && prefix[0] === 0x42 && prefix[1] === 0x5a && prefix[2] === 0x68) {
    return "bzip2";
  }
  if (
    prefix.length >= 6 &&
    prefix[0] === 0xfd && prefix[1] === 0x37 && prefix[2] === 0x7a &&
    prefix[3] === 0x58 && prefix[4] === 0x5a && prefix[5] === 0x00
  ) {
    return "xz";
  }
  if (prefix.length >= 2 && prefix[0] === 0x50 && prefix[1] === 0x4b) return "zip";
  return "none";
}

function detectCompression(name, prefix) {
  const byName = compressionForName(name);
  const byMagic = magicCompression(prefix);
  if (byMagic !== "none") {
    if (byName === "tar-gzip") return "tar-gzip";
    if (byName === "tar") return "tar";
    return byMagic;
  }
  return byName;
}

function supportedCompression(compression) {
  return LOG_SUPPORTED_COMPRESSION.includes(compression);
}

function binaryName(name) {
  const base = String(name || "")
    .toLowerCase()
    .replace(/\.(?:gz|bz2|xz|zip)$/i, "")
    .replace(/\.\d+$/i, "");
  return BINARY_SYSTEM_LOG_NAMES.has(base);
}

function likelyLogName(name, source) {
  const value = String(name || "");
  const compression = compressionForName(value);
  const base = value
    .replace(/\.tar\.gz$/i, "")
    .replace(/\.tgz$/i, "")
    .replace(/\.(?:gz|bz2|xz|zip)$/i, "");
  const rotatedBase = base.replace(/\.\d+$/i, "");

  if (source.includeAllFiles) return true;
  if (source.category === "pm2") return /\.log(?:\.\d+)?$/i.test(base) || base === "pm2.log";
  if (source.category === "nginx") return /(?:\.log|access|error)/i.test(base) || compression !== "none";
  if (/\.log(?:\.\d+)?$/i.test(base)) return true;
  return SYSTEM_LOG_NAMES.has(base) || SYSTEM_LOG_NAMES.has(rotatedBase);
}

function archiveEntryName(rawName) {
  const raw = String(rawName || "").replace(/\0.*$/, "");
  if (!raw || raw.includes("\\") || raw.startsWith("/")) {
    return { name: raw || ".", safe: false };
  }
  const normalized = posixPath.normalize(raw);
  if (
    normalized === "." || normalized === ".." || normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    return { name: normalized, safe: false };
  }
  return { name: normalized, safe: true };
}

function tarField(block, start, length) {
  const value = block.subarray(start, start + length);
  const zero = value.indexOf(0);
  return value.subarray(0, zero === -1 ? value.length : zero).toString("utf8");
}

function parseTarNumber(value) {
  const raw = Buffer.isBuffer(value)
    ? value
    : Buffer.from(String(value || ""), "utf8");
  if (raw.length === 0) return 0;
  if ((raw[0] & 0x80) !== 0) {
    throw new Error("base-256 tar numbers are not supported");
  }
  const text = raw.toString("ascii").replace(/\0/g, "").trim();
  if (!text) return 0;
  if (!/^\d+$/.test(text)) {
    throw new Error("invalid tar numeric field");
  }
  const parsed = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("tar numeric field is out of range");
  }
  return parsed;
}

function verifyTarChecksum(block) {
  const stored = parseTarNumber(block.subarray(TAR_HEADER_CHECKSUM_START, TAR_HEADER_CHECKSUM_END));
  if (!stored) return;
  let sum = 0;
  for (let index = 0; index < block.length; index += 1) {
    sum += index >= TAR_HEADER_CHECKSUM_START && index < TAR_HEADER_CHECKSUM_END
      ? 0x20
      : block[index];
  }
  if (sum !== stored) {
    throw new Error("tar header checksum mismatch");
  }
}

function parseTarHeader(block) {
  verifyTarChecksum(block);
  const name = tarField(block, 0, 100);
  const prefix = tarField(block, 345, 155);
  const typeFlag = tarField(block, 156, 1) || "0";
  return {
    rawName: prefix ? `${prefix}/${name}` : name,
    size: parseTarNumber(block.subarray(124, 136)),
    modifyTime: parseTarNumber(block.subarray(136, 148)),
    typeFlag,
    linkName: tarField(block, 157, 100),
  };
}

function tarEntryType(typeFlag) {
  if (typeFlag === "0" || typeFlag === "\0") return "file";
  if (typeFlag === "5") return "directory";
  if (typeFlag === "1") return "hardlink";
  if (typeFlag === "2") return "symlink";
  return "special";
}

function parsePaxHeaders(buffer) {
  const result = {};
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error("invalid PAX header length");
    const length = Number.parseInt(buffer.subarray(offset, space).toString("ascii"), 10);
    if (!Number.isInteger(length) || length <= 0 || offset + length > buffer.length) {
      throw new Error("invalid PAX header record");
    }
    const record = buffer.subarray(space + 1, offset + length).toString("utf8");
    const equals = record.indexOf("=");
    if (equals <= 0) throw new Error("invalid PAX header value");
    result[record.slice(0, equals)] = record.slice(equals + 1).replace(/\n$/, "");
    offset += length;
  }
  return result;
}

class TarReader {
  constructor(options = {}) {
    this.onEntry = options.onEntry;
    this.onData = options.onData;
    this.onEntryEnd = options.onEntryEnd;
    this.headerBuffer = Buffer.alloc(0);
    this.state = "header";
    this.current = null;
    this.remaining = 0;
    this.paddingRemaining = 0;
    this.specialParts = [];
    this.specialBytes = 0;
    this.pendingPax = {};
    this.globalPax = {};
    this.longName = "";
    this.longLink = "";
    this.visibleIndex = 0;
    this.done = false;
    this.stopped = false;
    this.stopAfterCurrent = false;
  }

  push(input) {
    let data = Buffer.isBuffer(input) ? input : Buffer.from(input);
    while (data.length > 0 && !this.done && !this.stopped) {
      if (this.state === "header") {
        const needed = TAR_BLOCK_SIZE - this.headerBuffer.length;
        if (data.length < needed) {
          this.headerBuffer = Buffer.concat([this.headerBuffer, data]);
          data = Buffer.alloc(0);
          break;
        }
        const block = this.headerBuffer.length === 0
          ? data.subarray(0, TAR_BLOCK_SIZE)
          : Buffer.concat([this.headerBuffer, data.subarray(0, needed)]);
        data = data.subarray(needed);
        this.headerBuffer = Buffer.alloc(0);
        if (block.every((value) => value === 0)) {
          this.done = true;
          break;
        }
        let header;
        try {
          header = parseTarHeader(block);
        } catch (error) {
          throw new Error(`invalid tar header: ${error.message}`);
        }
        this.remaining = header.size;
        this.paddingRemaining = (TAR_BLOCK_SIZE - (header.size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
        const special = new Set(["x", "g", "L", "K"]).has(header.typeFlag);
        this.specialParts = [];
        this.specialBytes = 0;
        if (special && header.size > LOG_MAX_PAX_BYTES) {
          throw new Error("tar metadata entry is too large");
        }
        if (special) {
          this.current = { header, special: true };
        } else {
          const pax = { ...this.globalPax, ...this.pendingPax };
          this.pendingPax = {};
          let entrySize = header.size;
          if (pax.size !== undefined) {
            const parsedSize = Number(pax.size);
            if (!Number.isSafeInteger(parsedSize) || parsedSize < 0) {
              throw new Error("invalid PAX size");
            }
            entrySize = parsedSize;
          }
          let entryModifyTime = header.modifyTime;
          if (pax.mtime !== undefined) {
            const parsedMtime = Number(pax.mtime);
            if (!Number.isFinite(parsedMtime) || parsedMtime < 0) {
              throw new Error("invalid PAX mtime");
            }
            entryModifyTime = Math.floor(parsedMtime);
          }
          this.remaining = entrySize;
          this.paddingRemaining = (TAR_BLOCK_SIZE - (entrySize % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
          let rawName = header.rawName;
          if (this.longName) {
            rawName = this.longName;
            this.longName = "";
          }
          const rawLinkName = this.longLink || header.linkName;
          this.longLink = "";
          if (pax.path) rawName = pax.path;
          const named = archiveEntryName(rawName);
          const entry = {
            name: named.name,
            safeName: named.safe,
            size: entrySize,
            modifyTime: entryModifyTime,
            type: tarEntryType(header.typeFlag),
            linkName: rawLinkName,
            readable: named.safe && tarEntryType(header.typeFlag) === "file",
            index: this.visibleIndex,
          };
          this.visibleIndex += 1;
          this.current = { header, entry, special: false };
          this.onEntry?.(entry, this);
        }
        this.state = this.remaining > 0 ? "body" : "padding";
        if (this.remaining === 0 && this.paddingRemaining === 0) {
          this.finishCurrentEntry();
        }
        continue;
      }

      if (this.state === "body") {
        const take = Math.min(this.remaining, data.length);
        const piece = data.subarray(0, take);
        data = data.subarray(take);
        this.remaining -= take;
        if (this.current.special) {
          this.specialBytes += piece.length;
          if (this.specialBytes > LOG_MAX_PAX_BYTES) {
            throw new Error("tar metadata entry is too large");
          }
          this.specialParts.push(piece);
        } else if (this.current.entry?.readable || this.onData) {
          const shouldStop = this.onData?.(this.current.entry, piece, this) === true;
          if (shouldStop) {
            this.stopped = true;
            break;
          }
        }
        if (this.remaining === 0) {
          this.state = "padding";
          if (this.paddingRemaining === 0) {
            this.finishCurrentEntry();
          }
        }
        continue;
      }

      if (this.state === "padding") {
        const take = Math.min(this.paddingRemaining, data.length);
        data = data.subarray(take);
        this.paddingRemaining -= take;
        if (this.paddingRemaining === 0) {
          this.finishCurrentEntry();
        }
      }
    }
    return this.stopped;
  }

  finishCurrentEntry() {
    const current = this.current;
    if (!current) return;
    if (current.special) {
      const payload = Buffer.concat(this.specialParts, this.specialBytes);
      if (current.header.typeFlag === "x") {
        this.pendingPax = { ...this.pendingPax, ...parsePaxHeaders(payload) };
      } else if (current.header.typeFlag === "g") {
        this.globalPax = { ...this.globalPax, ...parsePaxHeaders(payload) };
      } else if (current.header.typeFlag === "L") {
        this.longName = payload.toString("utf8").replace(/\0.*$/, "").replace(/\n$/, "");
      } else if (current.header.typeFlag === "K") {
        this.longLink = payload.toString("utf8").replace(/\0.*$/, "").replace(/\n$/, "");
      }
    } else {
      this.onEntryEnd?.(current.entry, this);
    }
    this.current = null;
    this.specialParts = [];
    this.specialBytes = 0;
    this.state = "header";
    this.remaining = 0;
    this.paddingRemaining = 0;
    if (this.stopAfterCurrent) {
      this.stopped = true;
    }
  }

  finish() {
    if (this.stopped || this.done) return;
    if (this.state === "header" && this.headerBuffer.length === 0) {
      throw new Error("tar archive is missing the end-of-archive marker");
    }
    throw new Error("tar archive ended in the middle of an entry");
  }
}

class LineCollector {
  constructor(options) {
    this.tailLines = options.tailLines;
    this.maxBytes = options.maxBytes;
    this.contains = options.contains || "";
    this.caseSensitive = options.caseSensitive;
    this.needle = this.caseSensitive ? this.contains : this.contains.toLowerCase();
    this.discardFirstLine = Boolean(options.discardFirstLine);
    this.decoder = new StringDecoder("utf8");
    this.pending = "";
    this.currentParts = [];
    this.currentStoredBytes = 0;
    this.currentMatched = false;
    this.currentTruncated = false;
    this.matchTail = "";
    this.hasProcessedLine = false;
    this.lines = [];
    this.outputBytes = 0;
    this.outputTruncated = false;
    this.totalLines = 0;
    this.matchedLines = 0;
    this.lineMaxBytes = Math.max(1, this.maxBytes - 1);
  }

  normalize(value) {
    return this.caseSensitive ? value : value.toLowerCase();
  }

  appendPart(value) {
    if (!value) return;
    const bytes = Buffer.from(value, "utf8");
    const remaining = this.lineMaxBytes - this.currentStoredBytes;
    if (remaining <= 0) {
      this.currentTruncated = true;
      return;
    }
    if (bytes.length <= remaining) {
      this.currentParts.push(value);
      this.currentStoredBytes += bytes.length;
      return;
    }
    this.currentParts.push(bytes.subarray(0, remaining).toString("utf8"));
    this.currentStoredBytes = this.lineMaxBytes;
    this.currentTruncated = true;
  }

  updateMatch(value) {
    if (!this.needle) return;
    const normalized = this.normalize(value);
    const combined = `${this.matchTail}${normalized}`;
    if (combined.includes(this.needle)) {
      this.currentMatched = true;
    }
    this.matchTail = combined.slice(-Math.max(0, this.needle.length - 1));
  }

  resetCurrent() {
    this.currentParts = [];
    this.currentStoredBytes = 0;
    this.currentMatched = false;
    this.currentTruncated = false;
    this.matchTail = "";
  }

  addLine(terminated) {
    this.totalLines += 1;
    const line = {
      text: this.currentParts.join(""),
      terminated,
      truncated: this.currentTruncated,
    };
    const discard = this.discardFirstLine && !this.hasProcessedLine;
    this.hasProcessedLine = true;
    if (!discard && (!this.needle || this.currentMatched)) {
      this.matchedLines += 1;
      const lineBytes = Buffer.byteLength(line.text, "utf8") + (line.terminated ? 1 : 0);
      this.lines.push(line);
      this.outputBytes += lineBytes;
      if (line.truncated) this.outputTruncated = true;
      while (this.lines.length > this.tailLines) {
        const removed = this.lines.shift();
        this.outputBytes -= Buffer.byteLength(removed.text, "utf8") + (removed.terminated ? 1 : 0);
      }
      while (this.outputBytes > this.maxBytes && this.lines.length > 1) {
        const removed = this.lines.shift();
        this.outputBytes -= Buffer.byteLength(removed.text, "utf8") + (removed.terminated ? 1 : 0);
        this.outputTruncated = true;
      }
      if (this.outputBytes > this.maxBytes && this.lines.length === 1) {
        const only = this.lines[0];
        if (only.terminated) {
          only.terminated = false;
          this.outputBytes -= 1;
        }
        this.outputTruncated = true;
      }
    }
    this.resetCurrent();
  }

  consumeText(text) {
    this.pending += text;
    while (true) {
      const newline = this.pending.indexOf("\n");
      if (newline < 0) {
        this.appendPart(this.pending);
        this.updateMatch(this.pending);
        this.pending = "";
        break;
      }
      const line = this.pending.slice(0, newline).replace(/\r$/, "");
      this.appendPart(line);
      this.updateMatch(line);
      this.addLine(true);
      this.pending = this.pending.slice(newline + 1);
    }
  }

  write(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.consumeText(this.decoder.write(buffer));
  }

  finish() {
    this.consumeText(this.decoder.end());
    if (this.pending.length > 0 || this.currentStoredBytes > 0 || this.currentMatched) {
      this.addLine(false);
    }
    return {
      content: this.lines.map((line) => `${line.text}${line.terminated ? "\n" : ""}`).join(""),
      totalLines: this.totalLines,
      matchedLines: this.needle ? this.matchedLines : this.totalLines,
      truncated: this.outputTruncated,
    };
  }
}

function streamFailure(error, operation, phase, code = "LOG_STREAM_READ_FAILED") {
  if (error?.code === "OPERATION_DEADLINE_EXCEEDED" || error?.code === "OPERATION_CANCELLED") {
    return error;
  }
  return operationError(error?.message || "remote log stream failed", {
    code,
    statusCode: 502,
    operationId: operation?.operationId,
    layer: "ssh",
    phase,
    retriable: true,
    cause: error,
  });
}

async function consumePlainStream(
  stream,
  collector,
  operation,
  maxScanBytes,
  markProgress,
) {
  let scannedBytes = 0;
  let scanTruncated = false;
  let stopped = false;
  try {
    for await (const rawChunk of stream) {
      assertOperationActive(operation, operation.signal, { layer: "ssh", phase: "log-read" });
      markProgress?.();
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      const remaining = maxScanBytes - scannedBytes;
      if (remaining <= 0) {
        scanTruncated = true;
        stopped = true;
        stream.destroy?.();
        break;
      }
      const piece = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      collector.write(piece);
      scannedBytes += piece.length;
      if (piece.length < chunk.length || scannedBytes >= maxScanBytes) {
        scanTruncated = true;
        stopped = true;
        stream.destroy?.();
        break;
      }
    }
  } catch (error) {
    if (operation.signal?.aborted) {
      throw operationErrorForSignal(operation.signal, operation, { layer: "ssh", phase: "log-read" });
    }
    if (!stopped) throw streamFailure(error, operation, "log-read");
  }
  return { scannedBytes, scanTruncated, final: collector.finish() };
}

async function consumeGunzip(
  source,
  operation,
  markProgress,
  onChunk,
) {
  const gunzip = createGunzip();
  let sourceBytes = 0;
  let stopRequested = false;
  let sourceFailure = null;
  const onAbort = () => {
    stopRequested = true;
    source.destroy?.();
    gunzip.destroy?.();
  };
  const onSourceData = (chunk) => {
    sourceBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
    markProgress?.();
  };
  const onSourceError = (error) => {
    sourceFailure = error;
    if (!gunzip.destroyed) gunzip.destroy(error);
  };

  operation.signal?.addEventListener("abort", onAbort, { once: true });
  source.on("data", onSourceData);
  source.once("error", onSourceError);
  source.pipe(gunzip);
  try {
    for await (const rawChunk of gunzip) {
      assertOperationActive(operation, operation.signal, { layer: "ssh", phase: "log-decompress" });
      const shouldStop = onChunk(Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk));
      if (shouldStop) {
        stopRequested = true;
        source.destroy?.();
        gunzip.destroy?.();
        break;
      }
    }
  } catch (error) {
    if (operation.signal?.aborted) {
      throw operationErrorForSignal(operation.signal, operation, { layer: "ssh", phase: "log-decompress" });
    }
    if (!stopRequested) {
      if (error?.code?.startsWith?.("LOG_")) throw error;
      if (sourceFailure) throw streamFailure(sourceFailure, operation, "sftp-read");
      throw logRuntimeError(
        error.message || "gzip decompression failed",
        "LOG_DECOMPRESSION_FAILED",
        operation,
        "log-decompress",
      );
    }
  } finally {
    operation.signal?.removeEventListener("abort", onAbort);
    source.off("data", onSourceData);
    source.off("error", onSourceError);
  }
  return { sourceBytes, stopped: stopRequested };
}

async function sniffRemoteFile(sftp, canonicalPath, stats, operation, markProgress) {
  const size = Number(stats.size);
  const maxPrefix = Number.isFinite(size) ? Math.min(8, Math.max(0, size)) : 8;
  if (maxPrefix === 0) return Buffer.alloc(0);
  const stream = createRemoteReadStream(sftp, canonicalPath, {
    start: 0,
    end: maxPrefix - 1,
  });
  return readStreamPrefix(stream, maxPrefix, operation, markProgress);
}

async function inspectRemoteFile(sftp, requestedPath, operation, allowedPaths, markProgress) {
  const canonicalPath = await resolveCanonicalRemotePath(
    sftp,
    requestedPath,
    operation,
    allowedPaths,
  );
  const stats = await sftpStat(sftp, canonicalPath, operation);
  if (isDirectoryMode(stats.mode)) {
    throw logInputError("path must refer to a log file, not a directory", "LOG_NOT_FILE");
  }
  const prefix = await sniffRemoteFile(sftp, canonicalPath, stats, operation, markProgress);
  const compression = detectCompression(canonicalPath, prefix);
  return { canonicalPath, stats, prefix, compression };
}

function logEntryFromRaw(source, rawEntry) {
  const name = rawEntry.name;
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    return null;
  }
  const compression = compressionForName(name);
  if (!likelyLogName(name, source)) return null;
  const entryPath = source.kind === "file" ? source.path : joinRemotePath(source.path, name);
  if (source.kind !== "file" && source.excludePaths?.has(entryPath)) return null;
  const unsupported = !supportedCompression(compression);
  const binary = compression === "none" && binaryName(name);
  const readable = !unsupported && !binary && isRegularMode(rawEntry.permissions);
  return {
    name,
    path: entryPath,
    category: source.category,
    source: source.source,
    size: rawEntry.size,
    modifyTime: rawEntry.modifyTime,
    permissions: rawEntry.permissions,
    compression,
    kind: compression === "tar-gzip" ? "archive" : "log",
    isArchive: compression === "tar-gzip",
    readable,
    readReason: readable
      ? undefined
      : unsupported
        ? "compression format is not supported"
        : binary
          ? "binary system log is not supported"
          : "entry is not a regular file",
  };
}

async function addDirectorySource(sftp, sources, seen, warnings, requestedPath, category, source, config, operation, required = false, includeAllFiles = false) {
  try {
    const canonicalPath = await resolveCanonicalRemotePath(
      sftp,
      requestedPath,
      operation,
      config.security.allowedPaths,
    );
    const stats = await sftpStat(sftp, canonicalPath, operation);
    if (!isDirectoryMode(stats.mode)) return false;
    const key = canonicalPath;
    const existing = seen.get(key);
    if (existing) {
      if ((SOURCE_PRIORITY[category] ?? 99) < (SOURCE_PRIORITY[existing.category] ?? 99)) {
        existing.category = category;
        existing.source = source;
        existing.includeAllFiles = includeAllFiles;
      }
      return true;
    }
    const item = {
      kind: "directory",
      path: canonicalPath,
      requestedPath,
      category,
      source,
      includeAllFiles,
    };
    seen.set(key, item);
    sources.push(item);
    return true;
  } catch (error) {
    if (isTerminalOperationError(error)) throw error;
    if (required) {
      warnings.push({
        path: requestedPath,
        code: error.code || "LOG_SOURCE_UNAVAILABLE",
        message: error.message || "log source is unavailable",
      });
    }
    return false;
  }
}

async function addFileSource(sftp, sources, seen, requestedPath, category, source, config, operation) {
  try {
    const canonicalPath = await resolveCanonicalRemotePath(
      sftp,
      requestedPath,
      operation,
      config.security.allowedPaths,
    );
    const stats = await sftpStat(sftp, canonicalPath, operation);
    if (isDirectoryMode(stats.mode)) return false;
    const key = `${category}:${canonicalPath}`;
    if (seen.has(key)) return true;
    const item = {
      kind: "file",
      path: canonicalPath,
      requestedPath,
      category,
      source,
      stats,
    };
    seen.set(key, item);
    sources.push(item);
    return true;
  } catch (error) {
    if (isTerminalOperationError(error)) throw error;
    return false;
  }
}

function parsePm2Dump(content) {
  try {
    const parsed = JSON.parse(content);
    const apps = Array.isArray(parsed) ? parsed : parsed?.apps;
    if (!Array.isArray(apps)) return [];
    return apps
      .filter((app) => app && typeof app === "object")
      .map((app) => ({
        name: typeof app.name === "string" ? app.name.slice(0, 128) : "pm2-app",
        cwd: typeof app.pm_cwd === "string" ? app.pm_cwd : "",
        outLog: typeof app.pm_out_log_path === "string" ? app.pm_out_log_path : "",
        errorLog: typeof app.pm_err_log_path === "string" ? app.pm_err_log_path : "",
      }));
  } catch {
    return [];
  }
}

function parseNginxLogPaths(content) {
  const paths = [];
  for (const rawLine of String(content || "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "");
    const match = /^\s*(?:access_log|error_log)\s+([^\s;]+)/i.exec(line);
    if (!match || match[1] === "off" || !match[1].startsWith("/")) continue;
    paths.push(match[1]);
  }
  return paths;
}

async function discoverNginxFiles(sftp, sources, seen, warnings, config, operation, markProgress) {
  const configDirectories = [
    "/etc/nginx",
    "/etc/nginx/conf.d",
    "/etc/nginx/sites-enabled",
    "/etc/nginx/sites-available",
  ];
  const files = new Set(["/etc/nginx/nginx.conf"]);
  for (const directory of configDirectories) {
    const sample = await readDirectorySample(
      sftp,
      directory,
      operation,
      config.security.allowedPaths,
      256,
      markProgress,
    );
    for (const entry of sample?.entries || []) {
      if (!isDirectoryMode(entry.permissions)) {
        files.add(joinRemotePath(sample.path, entry.name));
      }
    }
  }

  for (const configPath of files) {
    try {
      const configFile = await readSmallTextFile(
        sftp,
        configPath,
        operation,
        config.security.allowedPaths,
        markProgress,
      );
      for (const logPath of parseNginxLogPaths(configFile.content)) {
        await addFileSource(
          sftp,
          sources,
          seen,
          logPath,
          "nginx",
          `nginx:${configFile.path}`,
          config,
          operation,
        );
      }
    } catch (error) {
      if (isTerminalOperationError(error)) throw error;
      if (!errorIsMissing(error)) {
        warnings.push({
          path: configPath,
          code: error.code || "NGINX_CONFIG_READ_FAILED",
          message: error.message || "failed to inspect nginx configuration",
        });
      }
    }
  }
}

async function discoverHomeGithubSources(sftp, sources, seen, config, operation, markProgress) {
  const top = await readDirectorySample(
    sftp,
    "/home/github",
    operation,
    config.security.allowedPaths,
    HOME_GITHUB_SCAN_LIMIT,
    markProgress,
  );
  if (!top) return;

  for (const entry of top.entries) {
    if (!isDirectoryMode(entry.permissions)) continue;
    const childPath = joinRemotePath(top.path, entry.name);
    await addDirectorySource(
      sftp,
      sources,
      seen,
      [],
      `${childPath}/logs`,
      "application",
      `application:${childPath}`,
      config,
      operation,
      false,
      true,
    );
    const nested = await readDirectorySample(
      sftp,
      childPath,
      operation,
      config.security.allowedPaths,
      NESTED_DIRECTORY_SCAN_LIMIT,
      markProgress,
    );
    for (const nestedEntry of nested?.entries || []) {
      if (!isDirectoryMode(nestedEntry.permissions)) continue;
      if ([".git", ".cursor", ".idea", "node_modules", "dist", "src", "public", "releases", ".tmp"].includes(nestedEntry.name)) {
        if (nestedEntry.name !== "dbscripts_results") continue;
      }
      const nestedPath = joinRemotePath(childPath, nestedEntry.name);
      if (nestedEntry.name === "dbscripts_results") {
        await addDirectorySource(
          sftp,
          sources,
          seen,
          [],
          nestedPath,
          "application",
          `application:${nestedPath}`,
          config,
          operation,
          false,
          true,
        );
        continue;
      }
      await addDirectorySource(
        sftp,
        sources,
        seen,
        [],
        `${nestedPath}/logs`,
        "application",
        `application:${nestedPath}`,
        config,
        operation,
        false,
        true,
      );
    }
  }
}

async function discoverLogSources(sftp, config, operation, category, markProgress) {
  const categories = category === "all" ? [...LOG_CATEGORIES] : [category];
  const sources = [];
  const seen = new Map();
  const warnings = [];
  const wants = (value) => categories.includes(value);
  const allowedPaths = config.security.allowedPaths;

  let varLogSample;
  if (wants("system")) {
    await addDirectorySource(
      sftp,
      sources,
      seen,
      warnings,
      "/var/log",
      "system",
      "system:/var/log",
      config,
      operation,
      true,
    );
    varLogSample = await readDirectorySample(sftp, "/var/log", operation, allowedPaths, 256, markProgress);
    for (const entry of varLogSample?.entries || []) {
      if (!isDirectoryMode(entry.permissions)) continue;
      await addDirectorySource(
        sftp,
        sources,
        seen,
        warnings,
        joinRemotePath(varLogSample.path, entry.name),
        "system",
        `system:${entry.name}`,
        config,
        operation,
      );
    }
  }

  if (wants("nginx")) {
    await addDirectorySource(
      sftp,
      sources,
      seen,
      warnings,
      "/var/log/nginx",
      "nginx",
      "nginx:/var/log/nginx",
      config,
      operation,
      true,
    );
    await discoverNginxFiles(sftp, sources, seen, warnings, config, operation, markProgress);
  }

  let pm2Apps = [];
  if (wants("pm2") || wants("application")) {
    if (wants("pm2")) {
      await addDirectorySource(
        sftp,
        sources,
        seen,
        warnings,
        "/root/.pm2/logs",
        "pm2",
        "pm2:/root/.pm2/logs",
        config,
        operation,
        true,
      );
      await addFileSource(
        sftp,
        sources,
        seen,
        "/root/.pm2/pm2.log",
        "pm2",
        "pm2:daemon",
        config,
        operation,
      );
    }
    try {
      const dump = await readSmallTextFile(
        sftp,
        "/root/.pm2/dump.pm2",
        operation,
        allowedPaths,
        markProgress,
        512 * 1024,
      );
      pm2Apps = parsePm2Dump(dump.content);
    } catch (error) {
      if (isTerminalOperationError(error)) throw error;
      pm2Apps = [];
    }
    for (const app of pm2Apps) {
      if (wants("pm2")) {
        await addFileSource(sftp, sources, seen, app.outLog, "pm2", `pm2:${app.name}:out`, config, operation);
        await addFileSource(sftp, sources, seen, app.errorLog, "pm2", `pm2:${app.name}:error`, config, operation);
      }
      if (wants("application") && app.cwd) {
        await addDirectorySource(
          sftp,
          sources,
          seen,
          warnings,
          `${app.cwd}/logs`,
          "application",
          `application:pm2:${app.name}`,
          config,
          operation,
          false,
          true,
        );
      }
    }
  }

  if (wants("application")) {
    await addDirectorySource(
      sftp,
      sources,
      seen,
      warnings,
      "/home/app/logs",
      "application",
      "application:/home/app",
      config,
      operation,
      false,
      true,
    );
    for (const [label, root] of Object.entries(config.security.sourceRoots || {})) {
      await addDirectorySource(
        sftp,
        sources,
        seen,
        warnings,
        `${root}/logs`,
        "application",
        `application:${label}`,
        config,
        operation,
        false,
        true,
      );
    }
    await addDirectorySource(
      sftp,
      sources,
      seen,
      warnings,
      "/home/github/DBScript/dbscripts_results",
      "application",
      "application:DBScript",
      config,
      operation,
      false,
      true,
    );
    await discoverHomeGithubSources(sftp, sources, seen, config, operation, markProgress);
  }

  sources.sort((left, right) => {
    const categoryOrder = (SOURCE_PRIORITY[left.category] ?? 99) - (SOURCE_PRIORITY[right.category] ?? 99);
    if (categoryOrder !== 0) return categoryOrder;
    const kindOrder = (left.kind === "file" ? 0 : 1) - (right.kind === "file" ? 0 : 1);
    if (kindOrder !== 0) return kindOrder;
    return left.path.localeCompare(right.path);
  });
  const exactPathsByCategory = new Map();
  for (const source of sources) {
    if (source.kind !== "file") continue;
    if (!exactPathsByCategory.has(source.category)) {
      exactPathsByCategory.set(source.category, new Set());
    }
    exactPathsByCategory.get(source.category).add(source.path);
  }
  for (const source of sources) {
    if (source.kind === "directory") {
      source.excludePaths = exactPathsByCategory.get(source.category) || new Set();
    }
  }
  return { sources, warnings };
}

function listFileSourceEntry(source) {
  const name = posixPath.basename(source.path);
  return logEntryFromRaw(source, {
    name,
    size: source.stats.size,
    modifyTime: source.stats.mtime,
    permissions: source.stats.mode,
  });
}

function listLogsResult(category, entries, nextCursor, warnings, scannedEntries, sourceCount) {
  return {
    category,
    entries,
    nextCursor,
    hasMore: Boolean(nextCursor),
    truncated: Boolean(nextCursor),
    warnings,
    scannedEntries,
    sourceCount,
  };
}

export async function listLogs(options = {}) {
  const supervisor = requireSupervisor(options);
  const normalized = normalizeLogListOptions(options);
  const prepared = prepareOperation(options);
  try {
    return await withSftp(supervisor, prepared.operation, async (sftp, markProgress) => {
      const discovery = await discoverLogSources(
        sftp,
        options.config,
        prepared.operation,
        normalized.category,
        markProgress,
      );
      const cursor = decodeLogCursor(normalized.cursor, "logs");
      if (cursor.sourceIndex > discovery.sources.length) {
        throw logInputError("cursor points past the discovered log sources", "INVALID_LOG_CURSOR");
      }
      const entries = [];
      const warnings = [...discovery.warnings];
      let sourceIndex = cursor.sourceIndex;
      let offset = cursor.offset;
      let scannedEntries = 0;
      let scanLimitReached = false;

      while (sourceIndex < discovery.sources.length && entries.length < normalized.limit) {
        const source = discovery.sources[sourceIndex];
        if (source.kind === "file") {
          if (offset === 0) {
            const entry = listFileSourceEntry(source);
            if (entry) entries.push(entry);
          }
          sourceIndex += 1;
          offset = 0;
          continue;
        }

        const pageLimit = Math.min(LOG_MAX_LIMIT, Math.max(100, normalized.limit * 2));
        let page;
        try {
          page = await readDirectoryPage(
            sftp,
            source.path,
            prepared.operation,
            options.config.security.allowedPaths,
            offset,
            pageLimit,
            markProgress,
          );
        } catch (error) {
          if (isTerminalOperationError(error)) throw error;
          warnings.push({
            path: source.path,
            code: error.code || "LOG_DIRECTORY_READ_FAILED",
            message: error.message || "failed to read log directory",
          });
          sourceIndex += 1;
          offset = 0;
          continue;
        }

        let nextOffset = offset;
        let pageExhausted = true;
        for (let index = 0; index < page.entries.length; index += 1) {
          const rawEntry = page.entries[index];
          const rawOffset = offset + index;
          nextOffset = rawOffset + 1;
          scannedEntries += 1;
          const entry = logEntryFromRaw(source, rawEntry);
          if (entry) {
            if (entries.length >= normalized.limit) {
              pageExhausted = false;
              break;
            }
            entries.push(entry);
            if (entries.length >= normalized.limit) {
              const hasUnconsumed = index + 1 < page.entries.length || page.hasMore;
              if (hasUnconsumed) {
                const nextCursor = encodeLogCursor({
                  kind: "logs",
                  sourceIndex,
                  offset: rawOffset + 1,
                });
                return listLogsResult(
                  normalized.category,
                  entries,
                  nextCursor,
                  warnings,
                  scannedEntries,
                  discovery.sources.length,
                );
              }
              sourceIndex += 1;
              offset = 0;
              pageExhausted = false;
              break;
            }
          }
          if (scannedEntries >= LOG_MAX_SCAN_ENTRIES) {
            scanLimitReached = true;
            pageExhausted = false;
            break;
          }
        }

        if (scanLimitReached) {
          const nextCursor = encodeLogCursor({
            kind: "logs",
            sourceIndex,
            offset: nextOffset,
          });
          return listLogsResult(
            normalized.category,
            entries,
            nextCursor,
            warnings,
            scannedEntries,
            discovery.sources.length,
          );
        }
        if (sourceIndex >= discovery.sources.length || entries.length >= normalized.limit) break;
        if (pageExhausted && page.hasMore) {
          offset = offset + page.entries.length;
          continue;
        }
        if (page.hasMore && !pageExhausted) {
          offset = nextOffset;
          continue;
        }
        sourceIndex += 1;
        offset = 0;
      }

      const nextCursor = sourceIndex < discovery.sources.length
        ? encodeLogCursor({ kind: "logs", sourceIndex, offset })
        : null;
      return listLogsResult(
        normalized.category,
        entries,
        nextCursor,
        warnings,
        scannedEntries,
        discovery.sources.length,
      );
    }, options);
  } finally {
    prepared.cleanup();
  }
}

function archiveMemberResult(entry) {
  return {
    name: entry.name,
    size: entry.size,
    modifyTime: entry.modifyTime,
    type: entry.type,
    linkName: entry.linkName || undefined,
    readable: entry.readable,
    readReason: entry.readable ? undefined : entry.safeName ? "only regular files can be read" : "member path is unsafe",
  };
}

async function readArchiveMembersFromSftp(sftp, requestedPath, options, operation, allowedPaths, markProgress) {
  const inspected = await inspectRemoteFile(sftp, requestedPath, operation, allowedPaths, markProgress);
  if (inspected.compression !== "tar-gzip") {
    if (!supportedCompression(inspected.compression)) {
      throw logInputError(
        `compression format is not supported: ${inspected.compression}`,
        "UNSUPPORTED_COMPRESSION",
      );
    }
    throw logInputError("path is not a .tar.gz or .tgz archive", "NOT_A_LOG_ARCHIVE");
  }
  const compressedSize = Number(inspected.stats.size);
  if (Number.isFinite(compressedSize) && compressedSize > LOG_SOURCE_READ_LIMIT) {
    throw logRuntimeError(
      `compressed log archive is larger than ${LOG_SOURCE_READ_LIMIT} bytes`,
      "LOG_SOURCE_TOO_LARGE",
      operation,
      "log-decompress",
    );
  }

  const cursor = decodeLogCursor(options.cursor, "archive-members");
  const members = [];
  let scanBytes = 0;
  let scanTruncated = false;
  let nextOffset = cursor.offset;
  let selectedStop = false;
  const reader = new TarReader({
    onEntry: (entry, parser) => {
      const matches = !options.prefix || (entry.safeName && entry.name.startsWith(options.prefix));
      const visibleIndex = entry.index;
      nextOffset = visibleIndex + 1;
      if (matches && members.length < options.limit && visibleIndex >= cursor.offset) {
        members.push(archiveMemberResult(entry));
        if (members.length >= options.limit) {
          parser.stopAfterCurrent = true;
          selectedStop = true;
        }
      }
    },
  });
  const source = createRemoteReadStream(sftp, inspected.canonicalPath, {
    start: 0,
    end: Math.max(0, compressedSize - 1),
  });
  await consumeGunzip(source, operation, markProgress, (chunk) => {
    const remaining = LOG_MAX_ARCHIVE_SCAN_BYTES - scanBytes;
    if (remaining <= 0) {
      scanTruncated = true;
      return true;
    }
    const piece = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    scanBytes += piece.length;
    const stopped = reader.push(piece);
    if (stopped) return true;
    if (piece.length < chunk.length || scanBytes >= LOG_MAX_ARCHIVE_SCAN_BYTES) {
      scanTruncated = true;
      return true;
    }
    return false;
  });
  try {
    reader.finish();
  } catch (error) {
    if (!selectedStop && !scanTruncated) {
      throw logRuntimeError(error.message, "LOG_ARCHIVE_INVALID", operation, "log-archive-parse");
    }
  }

  const hasMore = selectedStop || scanTruncated;
  return {
    path: inspected.canonicalPath,
    compression: inspected.compression,
    members,
    nextCursor: hasMore
      ? encodeLogCursor({ kind: "archive-members", sourceIndex: 0, offset: nextOffset })
      : null,
    hasMore,
    truncated: scanTruncated,
    scannedBytes: scanBytes,
  };
}

export async function listLogArchiveMembers(options = {}) {
  const supervisor = requireSupervisor(options);
  const normalized = normalizeArchiveMemberListOptions(options);
  const prepared = prepareOperation(options);
  try {
    return await withSftp(supervisor, prepared.operation, (sftp, markProgress) =>
      readArchiveMembersFromSftp(
        sftp,
        normalized.path,
        normalized,
        prepared.operation,
        options.config.security.allowedPaths,
        markProgress,
      ), options);
  } finally {
    prepared.cleanup();
  }
}

async function readLogFromSftp(sftp, normalized, config, operation, markProgress) {
  const inspected = await inspectRemoteFile(
    sftp,
    normalized.path,
    operation,
    config.security.allowedPaths,
    markProgress,
  );
  const { canonicalPath, stats, prefix } = inspected;
  const compression = inspected.compression;

  if (!supportedCompression(compression)) {
    throw logInputError(
      `compression format is not supported: ${compression}`,
      "UNSUPPORTED_COMPRESSION",
    );
  }
  if (compression === "tar-gzip" && !normalized.memberPath) {
    throw logInputError(
      "tar.gz logs require memberPath; list archive members first",
      "ARCHIVE_MEMBER_REQUIRED",
    );
  }
  if (compression !== "tar-gzip" && normalized.memberPath) {
    throw logInputError(
      "memberPath is only valid for tar.gz logs",
      "ARCHIVE_MEMBER_NOT_ALLOWED",
    );
  }
  if (compression === "none" && (binaryName(posixPath.basename(canonicalPath)) || prefix.includes(0))) {
    throw logInputError("binary system logs cannot be decoded as text", "BINARY_LOG_UNSUPPORTED");
  }

  const sourceSize = Number(stats.size);
  if (compression !== "none" && Number.isFinite(sourceSize) && sourceSize > LOG_SOURCE_READ_LIMIT) {
    throw logRuntimeError(
      `compressed log is larger than ${LOG_SOURCE_READ_LIMIT} bytes`,
      "LOG_SOURCE_TOO_LARGE",
      operation,
      "log-decompress",
    );
  }

  let scannedBytes = 0;
  let scanTruncated = false;
  let archiveScanTruncated = false;
  let archiveBytesScanned = 0;
  let matchedMember = false;
  let memberReadable = false;
  let memberNonRegular = false;

  if (compression === "none") {
    const maxScanBytes = normalized.contains ? LOG_MAX_SCAN_BYTES : LOG_DEFAULT_SCAN_BYTES;
    const start = Number.isFinite(sourceSize) ? Math.max(0, sourceSize - maxScanBytes) : 0;
    const end = Number.isFinite(sourceSize) && sourceSize > 0 ? sourceSize - 1 : undefined;
    const stream = createRemoteReadStream(sftp, canonicalPath, {
      start,
      ...(end === undefined ? {} : { end }),
    });
    const result = await consumePlainStream(
      stream,
      new LineCollector({ ...normalized, discardFirstLine: start > 0 }),
      operation,
      maxScanBytes,
      markProgress,
    );
    scannedBytes = result.scannedBytes;
    scanTruncated = result.scanTruncated || (Number.isFinite(sourceSize) && start > 0 && Boolean(normalized.contains));
    const content = result.final;
    return {
      path: canonicalPath,
      memberPath: undefined,
      compression,
      content: content.content,
      truncated: Boolean(content.truncated || scanTruncated),
      scannedTruncated: scanTruncated,
      scannedBytes,
      totalLines: content.totalLines,
      matchedLines: content.matchedLines,
    };
  }

  if (compression === "gzip") {
    const collector = new LineCollector(normalized);
    const stream = createRemoteReadStream(sftp, canonicalPath, {
      start: 0,
      end: Math.max(0, sourceSize - 1),
    });
    const result = await consumeGunzip(stream, operation, markProgress, (chunk) => {
      const remaining = LOG_MAX_SCAN_BYTES - scannedBytes;
      if (remaining <= 0) {
        scanTruncated = true;
        return true;
      }
      const piece = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      collector.write(piece);
      scannedBytes += piece.length;
      if (piece.length < chunk.length || scannedBytes >= LOG_MAX_SCAN_BYTES) {
        scanTruncated = true;
        return true;
      }
      return false;
    });
    const final = collector.finish();
    return {
      path: canonicalPath,
      compression,
      content: final.content,
      truncated: Boolean(final.truncated || scanTruncated),
      scannedTruncated: scanTruncated,
      scannedBytes,
      compressedBytes: result.sourceBytes,
      totalLines: final.totalLines,
      matchedLines: final.matchedLines,
    };
  }

  const collector = new LineCollector(normalized);
  const reader = new TarReader({
    onEntry: (entry) => {
      if (!entry.safeName || entry.name !== normalized.memberPath) return;
      matchedMember = true;
      if (entry.type === "file" && entry.readable) {
        memberReadable = true;
      } else {
        memberNonRegular = true;
      }
    },
    onData: (entry, chunk) => {
      if (!matchedMember || !memberReadable || entry.name !== normalized.memberPath) return false;
      const remaining = LOG_MAX_MEMBER_BYTES - scannedBytes;
      if (remaining <= 0) {
        scanTruncated = true;
        return true;
      }
      const piece = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      collector.write(piece);
      scannedBytes += piece.length;
      if (piece.length < chunk.length || scannedBytes >= LOG_MAX_MEMBER_BYTES) {
        scanTruncated = true;
        return true;
      }
      return false;
    },
    onEntryEnd: (entry, parser) => {
      if (matchedMember && entry.name === normalized.memberPath) {
        parser.stopAfterCurrent = true;
      }
    },
  });
  const stream = createRemoteReadStream(sftp, canonicalPath, {
    start: 0,
    end: Math.max(0, sourceSize - 1),
  });
  const archiveResult = await consumeGunzip(stream, operation, markProgress, (chunk) => {
    const remaining = LOG_MAX_ARCHIVE_SCAN_BYTES - archiveBytesScanned;
    if (remaining <= 0) {
      archiveScanTruncated = true;
      return true;
    }
    const piece = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    archiveBytesScanned += piece.length;
    const stopped = reader.push(piece);
    if (stopped) return true;
    if (piece.length < chunk.length || archiveBytesScanned >= LOG_MAX_ARCHIVE_SCAN_BYTES) {
      archiveScanTruncated = true;
      return true;
    }
    return false;
  });
  try {
    reader.finish();
  } catch (error) {
    if (!archiveScanTruncated && !reader.stopped) {
      throw logRuntimeError(error.message, "LOG_ARCHIVE_INVALID", operation, "log-archive-parse");
    }
  }
  if (!matchedMember) {
    if (archiveScanTruncated) {
      throw logRuntimeError(
        `archive scan exceeded ${LOG_MAX_ARCHIVE_SCAN_BYTES} bytes before finding member`,
        "LOG_ARCHIVE_SCAN_LIMIT",
        operation,
        "log-archive-parse",
      );
    }
    throw logInputError(
      `archive member was not found: ${normalized.memberPath}`,
      "ARCHIVE_MEMBER_NOT_FOUND",
    );
  }
  if (memberNonRegular || !memberReadable) {
    throw logInputError(
      `archive member is not a readable regular file: ${normalized.memberPath}`,
      "ARCHIVE_MEMBER_NOT_READABLE",
    );
  }
  const final = collector.finish();
  return {
    path: canonicalPath,
    memberPath: normalized.memberPath,
    compression,
    content: final.content,
    truncated: Boolean(final.truncated || scanTruncated || archiveScanTruncated),
    scannedTruncated: Boolean(scanTruncated || archiveScanTruncated),
    scannedBytes,
    archiveScannedBytes: archiveBytesScanned,
    compressedBytes: archiveResult.sourceBytes,
    totalLines: final.totalLines,
    matchedLines: final.matchedLines,
  };
}

export async function readLog(options = {}) {
  const supervisor = requireSupervisor(options);
  const normalized = normalizeLogReadOptions(options);
  const prepared = prepareOperation(options);
  try {
    return await withSftp(supervisor, prepared.operation, (sftp, markProgress) =>
      readLogFromSftp(
        sftp,
        normalized,
        options.config,
        prepared.operation,
        markProgress,
      ), options);
  } finally {
    prepared.cleanup();
  }
}

export {
  LOG_CAPABILITIES,
  LOG_CATEGORIES,
  normalizeArchiveMemberPath,
};
