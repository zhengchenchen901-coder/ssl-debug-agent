import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import test from "node:test";
import {
  listLogArchiveMembers,
  listLogs,
  readLog,
} from "../logs.js";
import { listRemoteDirPage } from "../ssh.js";

const ALLOWED_PATHS = ["/var/log", "/root/.pm2", "/home/github"];
const { SFTP } = createRequire(import.meta.url)("ssh2/lib/protocol/SFTP.js");

function operation() {
  const controller = new AbortController();
  return {
    operationId: "log-test-operation",
    timeoutMs: 30_000,
    deadlineAt: Date.now() + 30_000,
    signal: controller.signal,
  };
}

function tarHeader(name, size, type = "0") {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function tarArchive(entries) {
  const chunks = [];
  for (const entry of entries) {
    const content = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(entry.content || "", "utf8");
    chunks.push(tarHeader(entry.name, content.length, entry.type || "0"));
    chunks.push(content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

function makeSftp(files, directories) {
  const fileMap = new Map(Object.entries(files));
  const dirMap = new Map(Object.entries(directories));
  let handleId = 0;

  const sftp = new EventEmitter();
  sftp.realpath = (remotePath, callback) => {
    setImmediate(() => {
      if (fileMap.has(remotePath) || dirMap.has(remotePath) || ALLOWED_PATHS.includes(remotePath)) {
        callback(null, remotePath);
      } else {
        const error = new Error("No such file");
        error.code = 2;
        callback(error);
      }
    });
  };
  sftp.stat = (remotePath, callback) => {
    setImmediate(() => {
      if (fileMap.has(remotePath)) {
        callback(null, { size: fileMap.get(remotePath).length, mode: 0o100644, mtime: 1 });
        return;
      }
      if (dirMap.has(remotePath) || ALLOWED_PATHS.includes(remotePath)) {
        callback(null, { size: 4096, mode: 0o040755, mtime: 1 });
        return;
      }
      const error = new Error("No such file");
      error.code = 2;
      callback(error);
    });
  };
  sftp.createReadStream = (remotePath, options = {}) => {
    const content = fileMap.get(remotePath);
    if (!content) return Readable.from([]);
    const start = Number.isInteger(options.start) ? options.start : 0;
    const end = Number.isInteger(options.end) ? options.end + 1 : content.length;
    return Readable.from([content.subarray(start, Math.min(end, content.length))]);
  };
  sftp.opendir = (remotePath, callback) => {
    setImmediate(() => {
      if (!dirMap.has(remotePath)) {
        const error = new Error("No such directory");
        error.code = 2;
        callback(error);
        return;
      }
      callback(null, { id: ++handleId, entries: dirMap.get(remotePath), index: 0 });
    });
  };
  sftp.readdir = (handle, callback) => {
    setImmediate(() => {
      if (handle.index > 0) {
        const error = new Error("EOF");
        error.code = 1;
        callback(error);
        return;
      }
      handle.index += 1;
      callback(null, handle.entries);
    });
  };
  sftp.close = (_handle, callback) => setImmediate(() => callback(null));
  sftp.end = () => {};
  return sftp;
}

function makeSupervisor(sftp) {
  return {
    generation: 1,
    schedule: (_operation, callback) => callback({
      client: {
        sftp: (callback) => setImmediate(() => callback(null, sftp)),
      },
      queueMs: 0,
      connectMs: 0,
    }),
    registerChannel: () => () => {},
    waitUntilReady: async () => ({
      sftp: (callback) => setImmediate(() => callback(null, sftp)),
    }),
  };
}

// Use ssh2's actual ReadStream: ordinary Readable mocks do not model its
// asynchronous file CLOSE or errors emitted after the readable end event.
function makeAsyncClosingSftp(files, options = {}) {
  const sftp = makeSftp(files, {});
  const handles = new Map();
  const pending = new Map();
  const errors = [];
  let handleId = 0;
  let pendingAtEnd = 0;
  const later = (callback, run, delay = 1) => {
    const timer = setTimeout(() => {
      pending.delete(callback);
      run();
    }, delay);
    pending.set(callback, timer);
  };
  sftp.open = (remotePath, _flags, _mode, callback) => later(callback, () => {
    const handle = Buffer.from(String(++handleId));
    handles.set(handle, files[remotePath]);
    callback(null, handle);
  });
  sftp.read = (handle, buffer, offset, length, position, callback) => {
    options.onRead?.();
    later(callback, () => {
      const size = handles.get(handle).copy(buffer, offset, position, position + length);
      callback(null, size);
    }, options.readDelayMs || 1);
  };
  sftp.close = (handle, callback) => later(callback, () => {
    handles.delete(handle);
    callback(options.closeError || null);
  }, options.closeDelayMs || 20);
  sftp.createReadStream = (remotePath, streamOptions) => {
    const stream = SFTP.prototype.createReadStream.call(sftp, remotePath, streamOptions);
    if (options.observeErrors !== false) {
      stream.on("error", (error) => errors.push(error.message));
    }
    return stream;
  };
  sftp.end = () => {
    pendingAtEnd += pending.size;
    for (const [callback, timer] of pending) {
      clearTimeout(timer);
      pending.delete(callback);
      callback(new Error("No response from server"));
    }
    sftp.emit("close");
  };
  return { sftp, errors, pendingAtEnd: () => pendingAtEnd };
}

test("log reads close ssh2 file handles before ending the SFTP channel", async () => {
  const files = {
    "/var/log/plain.log": Buffer.from("first\nlast\n"),
    "/var/log/gzip.log.gz": gzipSync(Buffer.from("first\nlast\n")),
    "/var/log/archive.tar.gz": tarArchive([
      { name: "selected.log", content: "first\nlast\n" },
      { name: "later.log", content: "unused\n" },
    ]),
  };
  for (const path of Object.keys(files)) {
    const fixture = makeAsyncClosingSftp(files);
    const result = await readLog({
      config: config(), supervisor: makeSupervisor(fixture.sftp), operation: operation(),
      path, ...(path.endsWith("tar.gz") ? { memberPath: "selected.log" } : {}),
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(result.content, "first\nlast\n");
    assert.equal(fixture.pendingAtEnd(), 0, path);
    assert.deepEqual(fixture.errors, [], path);
  }
});

test("archive member listing closes an early-stopped ssh2 stream", async () => {
  const fixture = makeAsyncClosingSftp({
    "/var/log/archive.tar.gz": tarArchive([
      { name: "first.log", content: "first\n" },
      { name: "later.log", content: "later\n" },
    ]),
  });
  const result = await listLogArchiveMembers({
    config: config(), supervisor: makeSupervisor(fixture.sftp), operation: operation(),
    path: "/var/log/archive.tar.gz", limit: 1,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.members[0].name, "first.log");
  assert.equal(fixture.pendingAtEnd(), 0);
  assert.deepEqual(fixture.errors, []);
});

test("late ssh2 errors during cancellation stay within the log operation", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const fixture = makeAsyncClosingSftp({ "/var/log/plain.log": Buffer.from("first\nlast\n") }, {
    observeErrors: false,
    readDelayMs: 50,
    onRead: () => {
      if (cancelled) return;
      cancelled = true;
      setImmediate(() => controller.abort());
    },
  });
  await assert.rejects(readLog({
    config: config(), supervisor: makeSupervisor(fixture.sftp),
    operation: { ...operation(), signal: controller.signal }, path: "/var/log/plain.log",
  }), (error) => error.code === "OPERATION_CANCELLED");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(fixture.pendingAtEnd() > 0);
});

test("closing a stalled ssh2 stream respects the operation deadline", async () => {
  const fixture = makeAsyncClosingSftp({ "/var/log/plain.log": Buffer.from("first\nlast\n") }, {
    observeErrors: false, closeDelayMs: 200,
  });
  await assert.rejects(readLog({
    config: config(), supervisor: makeSupervisor(fixture.sftp),
    path: "/var/log/plain.log", timeoutMs: 30,
  }), (error) => error.code === "OPERATION_DEADLINE_EXCEEDED");
  await new Promise((resolve) => setImmediate(resolve));
});

test("ssh2 file close failures are returned as operation errors", async () => {
  const fixture = makeAsyncClosingSftp({ "/var/log/plain.log": Buffer.from("first\nlast\n") }, {
    observeErrors: false, closeError: new Error("remote CLOSE failed"),
  });
  await assert.rejects(readLog({
    config: config(), supervisor: makeSupervisor(fixture.sftp),
    operation: operation(), path: "/var/log/plain.log",
  }), (error) => error.code === "SSH_STREAM_CLOSE_FAILED" && error.phase === "sftp-stream-close");
  await new Promise((resolve) => setImmediate(resolve));
});

function config(sourceRoots = {}) {
  return {
    security: {
      allowedPaths: ALLOWED_PATHS,
      sourceRoots,
      defaultFileTimeoutMs: 30_000,
      maxFileTimeoutMs: 30_000,
    },
  };
}

function logFileEntries(names) {
  return names.map((name) => ({
    filename: name,
    attrs: { size: 10, mtime: 1, mode: 0o100644 },
  }));
}

test("reads plain logs from the newest lines and applies substring filtering", async () => {
  const sftp = makeSftp({
    "/var/log/app.log": Buffer.from("old\nINFO keep\nERROR match\nERROR newest\n"),
  }, {});
  const result = await readLog({
    config: config(),
    supervisor: makeSupervisor(sftp),
    operation: operation(),
    path: "/var/log/app.log",
    tailLines: 1,
    contains: "error",
  });

  assert.equal(result.compression, "none");
  assert.equal(result.content, "ERROR newest\n");
  assert.equal(result.matchedLines, 2);
  assert.equal(result.truncated, false);
});

test("decompresses a gzip log without returning compressed bytes", async () => {
  const sftp = makeSftp({
    "/var/log/app.log.gz": gzipSync(Buffer.from("first\nsecond\nthird\n")),
  }, {});
  const result = await readLog({
    config: config(),
    supervisor: makeSupervisor(sftp),
    operation: operation(),
    path: "/var/log/app.log.gz",
    tailLines: 2,
  });

  assert.equal(result.compression, "gzip");
  assert.equal(result.content, "second\nthird\n");
  assert.ok(result.compressedBytes > 0);
});

test("lists and reads regular members from tar.gz archives", async () => {
  const archive = tarArchive([
    { name: "2026-09-01-info.log", content: "info\n" },
    { name: "2026-09-01-error.log", content: "old\nERROR latest\n" },
    { name: "links/current.log", content: "ignored", type: "2" },
  ]);
  const sftp = makeSftp({ "/home/github/app-logs.tar.gz": archive }, {});
  const supervisor = makeSupervisor(sftp);

  const members = await listLogArchiveMembers({
    config: config(),
    supervisor,
    operation: operation(),
    path: "/home/github/app-logs.tar.gz",
  });
  assert.equal(members.compression, "tar-gzip");
  assert.deepEqual(members.members.map((entry) => entry.name), [
    "2026-09-01-info.log",
    "2026-09-01-error.log",
    "links/current.log",
  ]);
  assert.equal(members.members[2].readable, false);

  const result = await readLog({
    config: config(),
    supervisor,
    operation: operation(),
    path: "/home/github/app-logs.tar.gz",
    memberPath: "2026-09-01-error.log",
    contains: "error",
  });
  assert.equal(result.compression, "tar-gzip");
  assert.equal(result.memberPath, "2026-09-01-error.log");
  assert.equal(result.content, "ERROR latest\n");
});

test("requires a safe archive member path and rejects traversal", async () => {
  const archive = tarArchive([{ name: "safe.log", content: "ok\n" }]);
  const sftp = makeSftp({ "/home/github/app-logs.tar.gz": archive }, {});
  const supervisor = makeSupervisor(sftp);

  await assert.rejects(
    readLog({
      config: config(),
      supervisor,
      operation: operation(),
      path: "/home/github/app-logs.tar.gz",
    }),
    (error) => error.code === "ARCHIVE_MEMBER_REQUIRED",
  );
  await assert.rejects(
    readLog({
      config: config(),
      supervisor,
      operation: operation(),
      path: "/home/github/app-logs.tar.gz",
      memberPath: "../safe.log",
    }),
    (error) => error.code === "ARCHIVE_MEMBER_PATH_NOT_ALLOWED",
  );
});

test("reports unsupported compression and malformed gzip as structured errors", async () => {
  const xzMagic = Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);
  const sftp = makeSftp({
    "/var/log/eipp.log.xz": xzMagic,
    "/var/log/broken.log.gz": Buffer.from("not gzip"),
  }, {});
  const supervisor = makeSupervisor(sftp);

  await assert.rejects(
    readLog({
      config: config(),
      supervisor,
      operation: operation(),
      path: "/var/log/eipp.log.xz",
    }),
    (error) => error.code === "UNSUPPORTED_COMPRESSION",
  );
  await assert.rejects(
    readLog({
      config: config(),
      supervisor,
      operation: operation(),
      path: "/var/log/broken.log.gz",
    }),
    (error) => error.code === "LOG_DECOMPRESSION_FAILED",
  );
});

test("lists log sources with a bounded page and cursor", async () => {
  const directories = {
    "/var/log": [
      { filename: "error.log", attrs: { size: 10, mtime: 1, mode: 0o100644 } },
      { filename: "syslog.1.gz", attrs: { size: 20, mtime: 2, mode: 0o100644 } },
      { filename: "nginx", attrs: { size: 4096, mtime: 1, mode: 0o040755 } },
    ],
    "/var/log/nginx": logFileEntries(["access.log", "error.log"]),
    "/root/.pm2": logFileEntries(["pm2.log"]),
    "/root/.pm2/logs": logFileEntries(["api-out-1.log", "api-error-1.log", "api-old.log"]),
    "/home/github": [{ filename: "app", attrs: { size: 4096, mtime: 1, mode: 0o040755 } }],
    "/home/github/app": [{ filename: "logs", attrs: { size: 4096, mtime: 1, mode: 0o040755 } }],
    "/home/github/app/logs": logFileEntries(["application.log"]),
  };
  const files = {
    "/var/log/error.log": Buffer.from("error\n"),
    "/var/log/syslog.1.gz": gzipSync(Buffer.from("syslog\n")),
    "/var/log/nginx/access.log": Buffer.from("access\n"),
    "/var/log/nginx/error.log": Buffer.from("error\n"),
    "/root/.pm2/pm2.log": Buffer.from("pm2\n"),
    "/root/.pm2/logs/api-out-1.log": Buffer.from("out\n"),
    "/root/.pm2/logs/api-error-1.log": Buffer.from("err\n"),
    "/root/.pm2/logs/api-old.log": Buffer.from("old\n"),
    "/home/github/app/logs/application.log": Buffer.from("app\n"),
  };
  const sftp = makeSftp(files, directories);
  const first = await listLogs({
    config: config(),
    supervisor: makeSupervisor(sftp),
    operation: operation(),
    category: "pm2",
    limit: 2,
  });
  assert.equal(first.entries.length, 2);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);
  const second = await listLogs({
    config: config(),
    supervisor: makeSupervisor(sftp),
    operation: operation(),
    category: "pm2",
    limit: 2,
    cursor: first.nextCursor,
  });
  assert.equal(second.entries.length, 2);
  assert.equal(second.hasMore, false);
});

test("SFTP directory pages stop after the requested batch and resume by offset", async () => {
  const directories = {
    "/root/.pm2/logs": logFileEntries(["one.log", "two.log", "three.log"]),
  };
  const files = {
    "/root/.pm2/logs/one.log": Buffer.from("one\n"),
    "/root/.pm2/logs/two.log": Buffer.from("two\n"),
    "/root/.pm2/logs/three.log": Buffer.from("three\n"),
  };
  const sftp = makeSftp(files, directories);
  const first = await listRemoteDirPage("/root/.pm2/logs", {
    config: config(),
    supervisor: makeSupervisor(sftp),
    operation: operation(),
    offset: 0,
    limit: 2,
  });
  assert.deepEqual(first.entries.map((entry) => entry.name), ["one.log", "two.log"]);
  assert.equal(first.hasMore, true);

  const second = await listRemoteDirPage("/root/.pm2/logs", {
    config: config(),
    supervisor: makeSupervisor(sftp),
    operation: operation(),
    offset: 2,
    limit: 2,
  });
  assert.deepEqual(second.entries.map((entry) => entry.name), ["three.log"]);
  assert.equal(second.hasMore, false);
});
