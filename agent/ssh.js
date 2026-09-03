import { assertPathAllowed, normalizeRemotePath } from "./security.js";
import {
  OPERATION_TIMEOUTS,
  assertOperationActive,
  createOperationController,
  normalizeOperationEnvelope,
  operationError,
  operationErrorForSignal,
} from "./operation.js";

function createOutputCollector(limitBytes) {
  let output = "";
  let bytes = 0;
  let truncated = false;

  return {
    append(chunk) {
      if (truncated) return;
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const remaining = limitBytes - bytes;
      if (incoming.length > remaining) {
        output += incoming.subarray(0, Math.max(0, remaining)).toString("utf8");
        bytes = limitBytes;
        truncated = true;
        return;
      }
      output += incoming.toString("utf8");
      bytes += incoming.length;
    },
    value: () => output,
    isTruncated: () => truncated,
  };
}

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

function prepareOperation(options, policy) {
  if (options.operation) {
    return { operation: options.operation, cleanup: () => {} };
  }
  const envelope = normalizeOperationEnvelope(
    { timeoutMs: options.timeoutMs },
    policy,
  );
  const linked = createOperationController(envelope, options.signal, {
    layer: "ssh",
    deadlinePhase: "execution",
  });
  return {
    operation: { ...envelope, signal: linked.signal },
    cleanup: linked.cleanup,
  };
}

function openSftp(client, operation) {
  return new Promise((resolve, reject) => {
    assertOperationActive(operation, operation.signal, {
      layer: "ssh",
      phase: "sftp-open",
    });
    let settled = false;
    const finish = (error, sftp) => {
      if (settled) {
        sftp?.end?.();
        return;
      }
      settled = true;
      operation.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(sftp);
    };
    const onAbort = () => finish(operationErrorForSignal(operation.signal, operation, {
      layer: "ssh",
      phase: "sftp-open",
    }));
    operation.signal?.addEventListener("abort", onAbort, { once: true });
    client.sftp((error, sftp) => {
      if (operation.signal?.aborted) {
        sftp?.end?.();
        finish(operationErrorForSignal(operation.signal, operation, {
          layer: "ssh",
          phase: "sftp-open",
        }));
      } else if (error) {
        finish(operationError(error.message || "failed to open SFTP channel", {
          code: "SSH_CHANNEL_OPEN_FAILED",
          statusCode: 502,
          operationId: operation.operationId,
          layer: "ssh",
          phase: "sftp-open",
          retriable: true,
          cause: error,
        }));
      } else {
        finish(null, sftp);
      }
    });
  });
}

function sftpCall(sftp, method, args, operation, phase) {
  return new Promise((resolve, reject) => {
    assertOperationActive(operation, operation.signal, { layer: "ssh", phase });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      operation.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(result);
    };
    const onAbort = () => finish(operationErrorForSignal(operation.signal, operation, {
      layer: "ssh",
      phase,
    }));
    operation.signal?.addEventListener("abort", onAbort, { once: true });
    sftp[method](...args, (error, result) => {
      if (operation.signal?.aborted) {
        finish(operationErrorForSignal(operation.signal, operation, { layer: "ssh", phase }));
      } else if (error) {
        finish(operationError(error.message || `SFTP ${method} failed`, {
          code: "SSH_CHANNEL_OPEN_FAILED",
          statusCode: 502,
          operationId: operation.operationId,
          layer: "ssh",
          phase,
          retriable: true,
          cause: error,
        }));
      } else {
        finish(null, result);
      }
    });
  });
}

const sftpRealpath = (sftp, remotePath, operation) =>
  sftpCall(sftp, "realpath", [remotePath], operation, "sftp-realpath");
const sftpReaddir = (sftp, remotePath, operation) =>
  sftpCall(sftp, "readdir", [remotePath], operation, "sftp-readdir");
const sftpStat = (sftp, remotePath, operation) =>
  sftpCall(sftp, "stat", [remotePath], operation, "sftp-stat");

function matchingAllowedRoots(remotePath, allowedPaths) {
  const normalizedPath = normalizeRemotePath(remotePath);
  return allowedPaths.filter((allowedRoot) => {
    const normalizedRoot = normalizeRemotePath(allowedRoot);
    return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
  });
}

async function resolveCanonicalRemotePath(sftp, remotePath, operation, allowedPaths) {
  const normalizedPath = assertPathAllowed(remotePath, allowedPaths);
  const matchingRoots = matchingAllowedRoots(normalizedPath, allowedPaths);
  const canonicalRoots = [];

  for (const allowedRoot of matchingRoots) {
    canonicalRoots.push(await sftpRealpath(sftp, allowedRoot, operation));
  }

  const canonicalPath = await sftpRealpath(sftp, normalizedPath, operation);
  return assertPathAllowed(canonicalPath, canonicalRoots);
}

function readStreamToBuffer(stream, maxBytes, operation, markProgress) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      operation.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks).subarray(0, maxBytes));
    };
    const onAbort = () => {
      stream.destroy();
      finish(operationErrorForSignal(operation.signal, operation, {
        layer: "ssh",
        phase: "sftp-read",
      }));
    };
    operation.signal?.addEventListener("abort", onAbort, { once: true });
    stream.on("data", (chunk) => {
      markProgress();
      chunks.push(chunk);
      total += chunk.length;
      if (total >= maxBytes) stream.destroy();
    });
    stream.on("error", (error) => finish(operationError(error.message || "SFTP read failed", {
      code: "SSH_TRANSPORT_LOST",
      statusCode: 502,
      operationId: operation.operationId,
      layer: "ssh",
      phase: "sftp-read",
      retriable: true,
      cause: error,
    })));
    stream.on("close", () => finish());
    stream.on("end", () => finish());
  });
}

async function withSftp(supervisor, operation, callback, options = {}) {
  return supervisor.schedule(operation, async (timing) => {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let progressed = false;
      let sftp;
      try {
        const client = attempt === 0
          ? timing.client
          : await supervisor.waitUntilReady(operation);
        sftp = await openSftp(client, operation);
        const unregister = supervisor.registerChannel(sftp, operation);
        const closeOnAbort = () => sftp.end?.();
        operation.signal?.addEventListener("abort", closeOnAbort, { once: true });
        try {
          const result = await callback(sftp, () => {
            progressed = true;
          });
          return {
            ...result,
            timing: {
              queueMs: timing.queueMs,
              connectMs: timing.connectMs,
              connectionGeneration: supervisor.generation,
            },
          };
        } finally {
          operation.signal?.removeEventListener("abort", closeOnAbort);
          unregister();
          sftp.end?.();
        }
      } catch (error) {
        lastError = error;
        if (
          attempt > 0 ||
          progressed ||
          operation.signal?.aborted ||
          !error?.retriable
        ) {
          throw error;
        }
      }
    }
    throw lastError;
  }, { priority: options.priority || "interactive" });
}

async function validateRemotePathsWithClient(client, remotePaths, config, operation, supervisor) {
  if (!remotePaths?.length) return [];
  const sftp = await openSftp(client, operation);
  const unregister = supervisor.registerChannel(sftp, operation);
  try {
    const canonicalPaths = [];
    for (const remotePath of remotePaths) {
      canonicalPaths.push(
        await resolveCanonicalRemotePath(
          sftp,
          remotePath,
          operation,
          config.security.allowedPaths,
        ),
      );
    }
    return canonicalPaths;
  } finally {
    unregister();
    sftp.end?.();
  }
}

function executeChannel(client, command, operation, options, supervisor) {
  const stdout = createOutputCollector(options.config.security.maxCommandOutputBytes);
  const stderr = createOutputCollector(options.config.security.maxCommandOutputBytes);
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    let settled = false;
    let streamRef;
    let unregister = () => {};
    let abortError;
    let forceCloseTimer;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(forceCloseTimer);
      operation.signal?.removeEventListener("abort", onAbort);
      unregister();
      if (error) reject(error);
      else resolve({
        ...result,
        executionMs: Math.max(0, Date.now() - startedAt),
      });
    };
    const onAbort = () => {
      abortError = operationErrorForSignal(operation.signal, operation, {
        layer: "ssh",
        phase: "exec",
      });
      if (!streamRef) {
        finish(abortError);
        return;
      }
      try {
        streamRef.signal?.("TERM");
      } catch {
        // Some SSH servers do not implement POSIX signals.
      }
      forceCloseTimer = setTimeout(() => {
        try {
          streamRef.close?.();
        } finally {
          finish(abortError);
        }
      }, 500);
      forceCloseTimer.unref?.();
    };

    operation.signal?.addEventListener("abort", onAbort, { once: true });
    client.exec(command, (error, stream) => {
      if (settled) {
        stream?.close?.();
        return;
      }
      if (error) {
        finish(operationError(error.message || "failed to open SSH exec channel", {
          code: "SSH_CHANNEL_OPEN_FAILED",
          statusCode: 502,
          operationId: operation.operationId,
          layer: "ssh",
          phase: "exec-open",
          retriable: true,
          cause: error,
        }));
        return;
      }
      streamRef = stream;
      unregister = supervisor.registerChannel(stream, operation);
      if (operation.signal?.aborted) {
        onAbort();
        return;
      }
      stream.on("data", (chunk) => {
        stdout.append(chunk);
        options.onStdout?.(chunk.toString("utf8"));
      });
      stream.stderr.on("data", (chunk) => {
        stderr.append(chunk);
        options.onStderr?.(chunk.toString("utf8"));
      });
      stream.on("error", (streamError) => finish(operationError(
        streamError.message || "SSH transport lost during command execution",
        {
          code: "SSH_TRANSPORT_LOST",
          statusCode: 502,
          operationId: operation.operationId,
          layer: "ssh",
          phase: "exec",
          retriable: false,
          cause: streamError,
        },
      )));
      stream.on("close", (code) => {
        if (abortError) {
          finish(abortError);
          return;
        }
        if (code === null || code === undefined) {
          finish(operationError("SSH transport closed before command exit status", {
            code: "SSH_TRANSPORT_LOST",
            statusCode: 502,
            operationId: operation.operationId,
            layer: "ssh",
            phase: "exec",
            retriable: false,
          }));
          return;
        }
        finish(null, {
          stdout: stdout.value(),
          stderr: stderr.value(),
          exitCode: code,
          timedOut: false,
          stdoutTruncated: stdout.isTruncated(),
          stderrTruncated: stderr.isTruncated(),
        });
      });

      if (options.stdin !== undefined && options.stdin !== null) {
        try {
          if (typeof stream.end !== "function") {
            throw new Error("SSH exec channel does not support stdin");
          }
          stream.end(options.stdin);
        } catch (stdinError) {
          finish(operationError(stdinError.message || "failed to write SSH stdin", {
            code: "SSH_STDIN_FAILED",
            statusCode: 502,
            operationId: operation.operationId,
            layer: "ssh",
            phase: "stdin",
            retriable: false,
            cause: stdinError,
          }));
        }
      }
    });
  });
}

export async function checkSSHConnection(supervisor) {
  await supervisor.start();
  return true;
}

export async function runSSH(command, options) {
  const supervisor = requireSupervisor(options);
  const prepared = prepareOperation(options, OPERATION_TIMEOUTS.run);
  try {
    return await supervisor.schedule(prepared.operation, async (timing) => {
      const validationStartedAt = Date.now();
      await validateRemotePathsWithClient(
        timing.client,
        options.remotePaths || [],
        options.config,
        prepared.operation,
        supervisor,
      );
      const result = await executeChannel(
        timing.client,
        command,
        prepared.operation,
        options,
        supervisor,
      );
      return {
        ...result,
        timing: {
          queueMs: timing.queueMs,
          connectMs: timing.connectMs,
          validationMs: Math.max(0, Date.now() - validationStartedAt - result.executionMs),
          executionMs: result.executionMs,
          connectionGeneration: timing.connectionGeneration,
        },
      };
    }, { priority: options.priority || "interactive" });
  } finally {
    prepared.cleanup();
  }
}

export async function resolveRemotePaths(remotePaths, options) {
  const supervisor = requireSupervisor(options);
  const prepared = prepareOperation(options, OPERATION_TIMEOUTS.file);
  try {
    const result = await withSftp(supervisor, prepared.operation, async (sftp) => {
      const canonicalPaths = [];
      for (const remotePath of remotePaths) {
        canonicalPaths.push(
          await resolveCanonicalRemotePath(
            sftp,
            remotePath,
            prepared.operation,
            options.config.security.allowedPaths,
          ),
        );
      }
      return { canonicalPaths };
    }, options);
    return result.canonicalPaths;
  } finally {
    prepared.cleanup();
  }
}

export async function readRemoteFile(remotePath, options) {
  const supervisor = requireSupervisor(options);
  const prepared = prepareOperation(options, OPERATION_TIMEOUTS.file);
  try {
    return await withSftp(supervisor, prepared.operation, async (sftp, markProgress) => {
      const canonicalPath = await resolveCanonicalRemotePath(
        sftp,
        remotePath,
        prepared.operation,
        options.config.security.allowedPaths,
      );
      const stats = await sftpStat(sftp, canonicalPath, prepared.operation);
      const truncated = Number.isFinite(stats.size) && stats.size > options.maxBytes;
      const stream = sftp.createReadStream(canonicalPath, {
        start: 0,
        end: Math.max(0, options.maxBytes - 1),
      });
      const buffer = await readStreamToBuffer(
        stream,
        options.maxBytes,
        prepared.operation,
        markProgress,
      );
      return {
        path: canonicalPath,
        content: buffer.toString("utf8"),
        truncated,
      };
    }, options);
  } finally {
    prepared.cleanup();
  }
}

export async function listRemoteDir(remotePath, options) {
  const supervisor = requireSupervisor(options);
  const prepared = prepareOperation(options, OPERATION_TIMEOUTS.file);
  try {
    return await withSftp(supervisor, prepared.operation, async (sftp) => {
      const canonicalPath = await resolveCanonicalRemotePath(
        sftp,
        remotePath,
        prepared.operation,
        options.config.security.allowedPaths,
      );
      const entries = await sftpReaddir(sftp, canonicalPath, prepared.operation);
      return {
        path: canonicalPath,
        entries: entries.map((entry) => ({
          name: entry.filename,
          longname: entry.longname,
          size: entry.attrs?.size,
          modifyTime: entry.attrs?.mtime,
          permissions: entry.attrs?.mode,
        })),
      };
    }, options);
  } finally {
    prepared.cleanup();
  }
}

export function createSSHOperations(supervisor, defaults = {}) {
  const merge = (options = {}) => ({
    ...options,
    supervisor,
    priority: options.priority || defaults.priority || "interactive",
  });
  return {
    checkSSHConnection: () => checkSSHConnection(supervisor),
    runSSH: (command, options) => runSSH(command, merge(options)),
    resolveRemotePaths: (paths, options) => resolveRemotePaths(paths, merge(options)),
    readRemoteFile: (remotePath, options) => readRemoteFile(remotePath, merge(options)),
    listRemoteDir: (remotePath, options) => listRemoteDir(remotePath, merge(options)),
  };
}
