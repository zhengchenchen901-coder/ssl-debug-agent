import fs from "node:fs/promises";
import { Client } from "ssh2";
import { assertSshConfig } from "./config.js";
import { assertPathAllowed } from "./security.js";

function createOutputCollector(limitBytes) {
  let output = "";
  let bytes = 0;
  let truncated = false;

  return {
    append(chunk) {
      if (truncated) {
        return;
      }

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
    value() {
      return output;
    },
    isTruncated() {
      return truncated;
    },
  };
}

async function buildConnectionOptions(config) {
  assertSshConfig(config);

  return {
    host: config.ssh.host,
    port: config.ssh.port,
    username: config.ssh.username,
    privateKey: await fs.readFile(config.ssh.privateKeyPath, "utf8"),
    passphrase: config.ssh.passphrase,
    readyTimeout: config.ssh.readyTimeout,
  };
}

async function connect(config) {
  const options = await buildConnectionOptions(config);

  return new Promise((resolve, reject) => {
    const client = new Client();

    const onError = (error) => {
      client.removeListener("ready", onReady);
      reject(error);
    };

    const onReady = () => {
      client.removeListener("error", onError);
      resolve(client);
    };

    client.once("error", onError);
    client.once("ready", onReady);
    client.connect(options);
  });
}

function openSftp(client) {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) reject(error);
      else resolve(sftp);
    });
  });
}

function sftpRealpath(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.realpath(remotePath, (error, canonicalPath) => {
      if (error) reject(error);
      else resolve(canonicalPath);
    });
  });
}

function sftpReaddir(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.readdir(remotePath, (error, entries) => {
      if (error) reject(error);
      else resolve(entries);
    });
  });
}

function sftpStat(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.stat(remotePath, (error, stats) => {
      if (error) reject(error);
      else resolve(stats);
    });
  });
}

function readStreamToBuffer(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).subarray(0, maxBytes));
    };

    stream.on("data", (chunk) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= maxBytes) {
        stream.destroy();
      }
    });
    stream.on("error", reject);
    stream.on("close", finish);
    stream.on("end", finish);
  });
}

export async function runSSH(command, options) {
  const { config, timeoutMs } = options;
  const onStdout = typeof options.onStdout === "function" ? options.onStdout : undefined;
  const onStderr = typeof options.onStderr === "function" ? options.onStderr : undefined;
  const client = await connect(config);
  const stdout = createOutputCollector(config.security.maxCommandOutputBytes);
  const stderr = createOutputCollector(config.security.maxCommandOutputBytes);

  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      let streamRef;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.end();
        resolve(result);
      };

      const timer = setTimeout(() => {
        if (streamRef) {
          streamRef.close();
        }
        finish({
          stdout: stdout.value(),
          stderr: stderr.value(),
          exitCode: null,
          timedOut: true,
          stdoutTruncated: stdout.isTruncated(),
          stderrTruncated: stderr.isTruncated(),
        });
      }, timeoutMs);

      client.exec(command, (error, stream) => {
        if (error) {
          clearTimeout(timer);
          reject(error);
          return;
        }

        streamRef = stream;
        stream.on("data", (chunk) => {
          stdout.append(chunk);
          onStdout?.(chunk.toString("utf8"));
        });
        stream.stderr.on("data", (chunk) => {
          stderr.append(chunk);
          onStderr?.(chunk.toString("utf8"));
        });
        stream.on("close", (code) => {
          finish({
            stdout: stdout.value(),
            stderr: stderr.value(),
            exitCode: code ?? null,
            timedOut: false,
            stdoutTruncated: stdout.isTruncated(),
            stderrTruncated: stderr.isTruncated(),
          });
        });
      });
    });
  } finally {
    client.end();
  }
}

async function withSftp(config, callback) {
  const client = await connect(config);
  try {
    const sftp = await openSftp(client);
    return await callback(sftp);
  } finally {
    client.end();
  }
}

export async function resolveRemotePaths(remotePaths, { config }) {
  return withSftp(config, async (sftp) => {
    const canonicalPaths = [];

    for (const remotePath of remotePaths) {
      const canonicalPath = await sftpRealpath(sftp, remotePath);
      canonicalPaths.push(assertPathAllowed(canonicalPath, config.security.allowedPaths));
    }

    return canonicalPaths;
  });
}

export async function readRemoteFile(remotePath, { config, maxBytes }) {
  return withSftp(config, async (sftp) => {
    const canonicalPath = await sftpRealpath(sftp, remotePath);
    assertPathAllowed(canonicalPath, config.security.allowedPaths);
    const stats = await sftpStat(sftp, canonicalPath);
    const truncated = Number.isFinite(stats.size) && stats.size > maxBytes;
    const stream = sftp.createReadStream(canonicalPath, {
      start: 0,
      end: Math.max(0, maxBytes - 1),
    });
    const buffer = await readStreamToBuffer(stream, maxBytes);

    return {
      path: canonicalPath,
      content: buffer.toString("utf8"),
      truncated,
    };
  });
}

export async function listRemoteDir(remotePath, { config }) {
  return withSftp(config, async (sftp) => {
    const canonicalPath = await sftpRealpath(sftp, remotePath);
    assertPathAllowed(canonicalPath, config.security.allowedPaths);
    const entries = await sftpReaddir(sftp, canonicalPath);

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
  });
}
