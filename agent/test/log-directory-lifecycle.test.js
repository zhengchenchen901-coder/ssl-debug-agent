import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { remoteLogQuery } from "../log-query-remote.js";
import { LOG_QUERY_RUNTIME_SOURCE } from "../log-query-runtime-source.js";
import { normalizeLogQuery } from "../log-query.js";

const require = createRequire(import.meta.url);
const root = "/fixture/日志 空格";
const names = ["2026-10-23-a.log", "2026-10-23-b.log"];
const failure = (code) => Object.assign(new Error(code), { code });

// Keep the remote POSIX namespace separate from the host's temporary paths.
// This exercises real directory iteration on Windows and macOS alike.
async function fixture(t, behavior, scenario) {
  const directory = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "log-dir-lifecycle-")));
  t.after(async () => {
    for (const name of names) await fsp.unlink(path.join(directory, name));
    await fsp.rmdir(directory);
  });
  for (const name of names) await fsp.writeFile(path.join(directory, name), "sample\n");
  const localPath = (value) => path.join(directory, path.posix.relative(root, value));
  const state = { iteratorCloses: 0, manualCloses: 0, closed: false };
  const remoteFs = { ...fs, promises: {
    ...fs.promises,
    realpath: async (value) => {
      const resolved = await fsp.realpath(localPath(value));
      return path.posix.join(root, path.relative(directory, resolved).split(path.sep).join("/"));
    },
    stat: (value) => fsp.stat(localPath(value)),
    open: (value, flags) => fsp.open(localPath(value), flags),
    opendir: async (value) => {
      const handle = await fsp.opendir(localPath(value));
      return {
        async *[Symbol.asyncIterator]() {
          try {
            for await (const entry of handle) {
              yield entry;
              if (scenario === "read-error") throw failure("EIO");
            }
          } finally {
            state.iteratorCloses++;
            state.closed = true;
            if (scenario === "close-error") throw failure("EBADF");
          }
        },
        close() {
          state.manualCloses++;
          if (state.closed) {
            // Node 12 throws before returning a Promise; newer Node rejects it.
            if (behavior === "sync") throw failure("ERR_DIR_CLOSED");
            return Promise.reject(failure("ERR_DIR_CLOSED"));
          }
          return handle.close();
        },
      };
    },
  } };
  const config = { security: { allowedPaths: [root] }, logs: { projects: { be: { root, directories: [root] } } } };
  const input = { ...normalizeLogQuery({ projectId: "be", mode: "search" }, config), deadlineAt: Date.now() + 30_000 };
  if (scenario === "limit") input.maxDirectoryEntries = 1;
  return { input, state, remoteFs };
}

for (const [label, source] of [
  ["source", `const runRemoteLogQuery = ${remoteLogQuery.toString()};`],
  ["Node 12 generated helper", LOG_QUERY_RUNTIME_SOURCE],
]) {
  for (const behavior of ["sync", "promise"]) {
    for (const scenario of ["complete", "limit", "read-error", "close-error", "deadline"]) {
      test(`${label}: ${behavior} close behavior, ${scenario}`, async (t) => {
        const { input, state, remoteFs } = await fixture(t, behavior, scenario);
        // Expire only once iteration starts, so the iterator must clean up.
        class Clock extends Date {
          static now() { return scenario === "deadline" && iterationStarted ? input.deadlineAt : Date.now(); }
        }
        let iterationStarted = false;
        const openDirectory = remoteFs.promises.opendir;
        remoteFs.promises.opendir = async (value) => {
          const handle = await openDirectory(value);
          iterationStarted = true;
          return handle;
        };
        const context = vm.createContext({
          require: (name) => name === "fs" ? remoteFs : require(name),
          Buffer, Date: Clock,
        });
        vm.runInContext(`${source}\nglobalThis.query = runRemoteLogQuery;`, context);
        if (scenario === "deadline") {
          await assert.rejects(context.query(input), { code: "OPERATION_DEADLINE_EXCEEDED" });
        } else {
          const result = await context.query(input);
          const expected = scenario === "read-error" ? "EIO" : scenario === "close-error" ? "EBADF" : null;
          assert.deepEqual(Array.from(result.warnings, (warning) => warning.code), expected ? [expected] : []);
          assert.equal(result.files.length, scenario === "limit" || scenario === "read-error" ? 1 : 2);
          assert.equal(result.directoryListingTruncated, scenario === "limit");
          assert.equal(result.complete, scenario === "complete");
          assert.equal(result.countsAreComplete, scenario === "complete");
          assert.equal(result.matchedLines, result.files.length);
        }
        assert.equal(state.iteratorCloses, 1, "iteration must close the directory, including early exits");
        assert.equal(state.manualCloses, 0, "do not close an iterator-owned directory again");
      });
    }
  }
}
