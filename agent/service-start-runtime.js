// Self-contained remote helper, serialized over authenticated SSH stdin. Node 14+
// can run this helper; the application interpreter is separately pinned to Node 20+.
export async function serviceStartRuntime(request, profile, dependencies) {
  const fs = dependencies?.fs || require("fs");
  const path = require("path").posix;
  const execFile = dependencies?.execFile || require("child_process").execFile;
  const now = dependencies?.now || Date.now;
  const sleep = dependencies?.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const baseEnv = { ...(dependencies?.env || process.env), PM2_HOME: profile.pm2Home };
  delete baseEnv.NODE_OPTIONS;
  delete baseEnv.NODE_PATH;
  const started = [], attempted = [], verified = [];
  let phase = "preflight", locked = false, cwd, script, interpreter;
  const lock = path.join(profile.pm2Home, ".remote-debug-service-start.lock");
  const deadline = Math.min(request.deadlineAt, now() + profile.startupTimeoutMs);
  const fail = (code) => { throw Object.assign(new Error(code), { serviceCode: code }); };
  const remaining = () => {
    const ms = deadline - now();
    if (ms < 50) fail("SERVICE_START_TIMEOUT");
    return ms;
  };
  const real = (file) => fs.realpathSync(file);
  const inside = (file, root) => file.startsWith(`${root}/`);
  const bounded = (file, max = 262144) => {
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(max + 1);
      let n = 0, read;
      do { read = fs.readSync(fd, buffer, n, buffer.length - n, n); n += read; } while (read && n < buffer.length);
      if (n > max) fail("SERVICE_EVIDENCE_TOO_LARGE");
      return buffer.subarray(0, n).toString("utf8");
    } finally { fs.closeSync(fd); }
  };
  const run = (file, args, env = baseEnv) => new Promise((resolve, reject) => {
    execFile(file, args, { env, cwd: profile.pm2Home, shell: false,
      timeout: Math.min(10000, remaining()), maxBuffer: 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
      // PM2 stderr/stdout and errors may contain application secrets. They are never
      // returned or interpolated into diagnostics, even when a command fails.
      if (error) reject(Object.assign(new Error("SERVICE_PM2_COMMAND_FAILED"), { serviceCode: "SERVICE_PM2_COMMAND_FAILED" }));
      else resolve(String(stdout));
    });
  });
  const pm2 = (args, env) => run(profile.pm2Path, args, env);
  const list = async () => {
    const output = await pm2(["jlist"]);
    let entries;
    try { entries = JSON.parse(output); } catch { fail("SERVICE_PM2_RESPONSE_INVALID"); }
    if (!Array.isArray(entries) || entries.length > 512) fail("SERVICE_PM2_RESPONSE_INVALID");
    return entries;
  };
  const resolveRelease = () => {
    const current = real(profile.cwd);
    if (profile.releaseRoot) {
      const root = real(profile.releaseRoot);
      if (root !== profile.releaseRoot || !inside(current, `${root}/releases`) || !/^\/[A-Za-z0-9_.+-]+$/.test(current.slice(`${root}/releases`.length))) fail("SERVICE_RELEASE_PATH_INVALID");
    } else if (current !== profile.cwd) fail("SERVICE_CWD_SYMLINK_REQUIRES_RELEASE_ROOT");
    return current;
  };
  const approved = (file) => {
    const resolved = real(file);
    if (!request.allowedRoots.some((root) => resolved === root || inside(resolved, root))) fail("SERVICE_CANONICAL_PATH_DENIED");
    return resolved;
  };
  const find = (entries, proc) => {
    const matches = entries.filter((entry) => entry.name === proc.name || entry.pm2_env?.name === proc.name);
    if (matches.length > 1) fail("SERVICE_DUPLICATE_PROCESS");
    return matches[0];
  };
  const nodeArgs = profile.envFiles.map((file) => `--env-file=${file}`);
  const checkIdentity = (entry, proc) => {
    const e = entry.pm2_env || {};
    if (e.exec_mode !== "fork_mode") fail("SERVICE_MODE_MISMATCH");
    if (real(e.pm_cwd) !== cwd || real(e.pm_exec_path) !== script || real(e.exec_interpreter) !== interpreter) fail("SERVICE_PROCESS_PATH_CONFLICT");
    const args = Array.isArray(e.node_args) ? e.node_args : typeof e.node_args === "string" ? e.node_args.split(/\s+/).filter(Boolean) : [];
    if (JSON.stringify(args) !== JSON.stringify(nodeArgs)) fail("SERVICE_NODE_ARGS_MISMATCH");
    if (e.node_version !== profile.nodeVersion) fail("SERVICE_NODE_VERSION_MISMATCH");
    for (const [key, value] of Object.entries(proc.env)) {
      if (String(e[key] ?? e.env?.[key]) !== value) fail("SERVICE_ENV_MISMATCH");
    }
    if (!Number.isSafeInteger(entry.pid) || entry.pid < 1) fail("SERVICE_PROCESS_NOT_RUNNING");
    if (!Number.isSafeInteger(e.restart_time) || e.restart_time < 0 || !Number.isSafeInteger(e.pm_uptime) || e.pm_uptime < 1) fail("SERVICE_PROCESS_METADATA_INVALID");
    if (real(`/proc/${entry.pid}/exe`) !== interpreter || real(`/proc/${entry.pid}/cwd`) !== cwd) fail("SERVICE_ACTUAL_PROCESS_MISMATCH");
    const actualArgs = bounded(`/proc/${entry.pid}/cmdline`).split("\0").filter(Boolean);
    if (nodeArgs.some((arg) => !actualArgs.includes(arg))) fail("SERVICE_NODE_ARGS_MISMATCH");
    const actualEnv = bounded(`/proc/${entry.pid}/environ`).split("\0");
    for (const [key, value] of Object.entries(proc.env)) if (!actualEnv.includes(`${key}=${value}`)) fail("SERVICE_ACTUAL_ENV_MISMATCH");
    if (actualEnv.some((item) => item.startsWith("NODE_OPTIONS=") && item !== "NODE_OPTIONS=")) fail("SERVICE_UNEXPECTED_NODE_OPTIONS");
    return { pid: entry.pid, restarts: e.restart_time, uptime: e.pm_uptime };
  };
  const sockets = () => {
    const result = [];
    for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      let text;
      try { text = bounded(file, 1024 * 1024); } catch (error) {
        if (file.endsWith("tcp6") && error.code === "ENOENT") continue;
        throw error;
      }
      for (const line of text.trim().split("\n").slice(1)) {
        const columns = line.trim().split(/\s+/);
        if (columns[3] === "0A") result.push({ port: parseInt(columns[1].split(":")[1], 16), inode: columns[9] });
      }
    }
    return result;
  };
  const portEvidence = (proc, pid, listeners) => {
    const owned = new Set();
    if (pid) {
      const files = fs.readdirSync(`/proc/${pid}/fd`);
      if (files.length > 16384) fail("SERVICE_EVIDENCE_TOO_LARGE");
      for (const file of files) {
        try {
          const match = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${pid}/fd/${file}`));
          if (match) owned.add(match[1]);
        } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    }
    return proc.ports.map((port) => {
      const matches = listeners.filter((listener) => listener.port === port);
      return { port, listening: matches.length > 0, owned: matches.length > 0 && matches.every((listener) => owned.has(listener.inode)) };
    });
  };
  const logPosition = (entry) => {
    const logPath = entry.pm2_env?.pm_out_log_path;
    if (typeof logPath !== "string") return null;
    let file;
    try { file = real(logPath); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    const root = real(path.join(profile.pm2Home, "logs"));
    if (!inside(file, root)) fail("SERVICE_LOG_PATH_CONFLICT");
    const stat = fs.statSync(file);
    if (!stat.isFile()) fail("SERVICE_LOG_PATH_CONFLICT");
    return { file, size: stat.size, ino: stat.ino };
  };
  const markerSeen = (entry, offset) => {
    const log = logPosition(entry);
    if (!log) return false;
    if (offset && (log.ino !== offset.ino || log.size < offset.size)) return false;
    const start = Math.max(offset ? offset.size : 0, log.size - 65536);
    const fd = fs.openSync(log.file, "r");
    try {
      const buffer = Buffer.alloc(Math.min(65536, Math.max(0, log.size - start)));
      const count = fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.subarray(0, count).toString("utf8").includes(profile.startupMarker);
    } finally { fs.closeSync(fd); }
  };
  const output = (status, extra = {}) => ({ status, phase, started: [...started], attempted: [...attempted], verified: [...verified],
    resolvedCwd: cwd, nodeVersion: profile.nodeVersion, mode: "fork", persisted: false, ...extra });
  try {
    remaining();
    phase = "paths";
    cwd = resolveRelease();
    if (!fs.statSync(cwd).isDirectory()) fail("SERVICE_CWD_INVALID");
    script = real(path.join(cwd, profile.entry));
    if (!inside(script, cwd) || !fs.statSync(script).isFile()) fail("SERVICE_ENTRY_PATH_INVALID");
    if (!/\.m?js$/.test(script) || /\.config\.m?js$/i.test(script) || /^ecosystem(?:\.|$)/i.test(path.basename(script))) fail("SERVICE_ENTRY_PATH_INVALID");
    interpreter = approved(profile.interpreter);
    if (real(profile.pm2Home) !== profile.pm2Home) fail("SERVICE_PM2_HOME_SYMLINK");
    fs.accessSync(interpreter, fs.constants.X_OK);
    fs.accessSync(profile.pm2Path, fs.constants.X_OK);
    phase = "runtime";
    const version = (await run(interpreter, ["--version"])).trim();
    if (version !== `v${profile.nodeVersion}`) fail("SERVICE_NODE_VERSION_MISMATCH");
    phase = "env-files";
    for (const file of profile.envFiles) {
      // Check readability/type only. Never open, copy or return env-file content.
      approved(file);
      if (!fs.statSync(file).isFile()) fail("SERVICE_ENV_FILE_INVALID");
      fs.accessSync(file, fs.constants.R_OK);
    }
    // jlist must not implicitly create a daemon during preflight/inspection.
    phase = "pm2-daemon";
    const daemon = Number(bounded(path.join(profile.pm2Home, "pm2.pid"), 32).trim());
    if (!Number.isSafeInteger(daemon) || daemon < 1 || !bounded(`/proc/${daemon}/cmdline`).includes("PM2")) fail("SERVICE_PM2_DAEMON_UNAVAILABLE");
    if (request.action === "start") {
      phase = "lock";
      try { fs.mkdirSync(lock, { mode: 0o700 }); locked = true; }
      catch (error) { if (error.code === "EEXIST") fail("SERVICE_START_BUSY"); throw error; }
    }
    phase = "process-preflight";
    let entries = await list();
    const missing = [], initial = new Map(), offsets = new Map();
    const listeners = sockets();
    for (const proc of profile.processes) {
      const entry = find(entries, proc);
      if (entry) {
        const identity = checkIdentity(entry, proc);
        if (entry.pm2_env.status !== "online") fail("SERVICE_EXISTING_PROCESS_UNHEALTHY");
        const evidence = portEvidence(proc, entry.pid, listeners);
        if (evidence.some((item) => !item.owned)) fail("SERVICE_PORT_OWNER_MISMATCH");
        initial.set(proc.name, identity);
      } else {
        if (portEvidence(proc, null, listeners).some((item) => item.listening)) fail("SERVICE_PORT_CONFLICT");
        // Refuse differently named registrations for the same entry+cwd, even if
        // their ports are not live. Starting could activate duplicate cron jobs.
        if (entries.some((item) => {
          if (profile.processes.some((p) => p.name === item.name)) return false;
          try { return real(item.pm2_env.pm_cwd) === cwd && real(item.pm2_env.pm_exec_path) === script; }
          catch { return false; }
        })) fail("SERVICE_UNEXPECTED_REGISTRATION");
        missing.push(proc);
      }
    }
    if (request.action === "inspect" && missing.length) return output("missing", { missing: missing.map((proc) => proc.name) });
    phase = "start";
    for (const proc of missing) {
      remaining();
      if (resolveRelease() !== cwd) fail("SERVICE_RELEASE_CHANGED");
      // Recheck the entire PM2 namespace/ports immediately before every mutation.
      entries = await list();
      if (find(entries, proc)) fail("SERVICE_CONCURRENT_PROCESS_CHANGE");
      if (portEvidence(proc, null, sockets()).some((item) => item.listening)) fail("SERVICE_PORT_CONFLICT");
      const logName = proc.name.replace(/_/g, "-");
      const guessedLog = path.join(profile.pm2Home, "logs", `${logName}-out.log`);
      if (fs.existsSync(guessedLog)) offsets.set(proc.name, { size: fs.statSync(guessedLog).size, ino: fs.statSync(guessedLog).ino });
      else offsets.set(proc.name, { size: 0 });
      attempted.push(proc.name);
      await pm2(["start", script, "--name", proc.name, "--cwd", cwd, "--interpreter", interpreter,
        ...(nodeArgs.length ? ["--node-args", nodeArgs.join(" ")] : []),
        "--max-memory-restart", profile.maxMemoryRestart, "--restart-delay", String(profile.restartDelayMs), "--time"], { ...baseEnv, ...proc.env });
      // A successful CLI return is only a mutation receipt, never readiness.
      started.push(proc.name);
    }
    phase = "verify";
    let healthySince = null;
    const identities = new Map(initial);
    while (true) {
      remaining();
      if (resolveRelease() !== cwd) fail("SERVICE_RELEASE_CHANGED");
      entries = await list();
      const listenersNow = sockets();
      let ready = true;
      verified.length = 0;
      for (const proc of profile.processes) {
        const entry = find(entries, proc);
        if (!entry) fail("SERVICE_PROCESS_DISAPPEARED");
        if (["errored", "stopped", "stopping"].includes(entry.pm2_env?.status)) fail("SERVICE_PROCESS_EXITED");
        if (entry.pm2_env?.status !== "online") { ready = false; continue; }
        if (!entry.pm2_env.node_version && started.includes(proc.name)) { ready = false; continue; }
        const identity = checkIdentity(entry, proc);
        const previous = identities.get(proc.name);
        if (previous && (previous.pid !== identity.pid || previous.restarts !== identity.restarts || previous.uptime !== identity.uptime)) fail("SERVICE_PROCESS_UNSTABLE");
        identities.set(proc.name, identity);
        if (!previous && identity.restarts !== 0) fail("SERVICE_PROCESS_UNSTABLE");
        const ports = portEvidence(proc, entry.pid, listenersNow);
        if (ports.some((item) => item.listening && !item.owned)) fail("SERVICE_PORT_OWNER_MISMATCH");
        const offset = offsets.get(proc.name);
        // A brand-new file has no previous inode; retain the first observed inode.
        if (offset && offset.ino === undefined) { const log = logPosition(entry); if (log) offset.ino = log.ino; }
        const marker = markerSeen(entry, offset);
        const healthy = ports.every((item) => item.owned) && marker;
        if (healthy) verified.push({ name: proc.name, pid: entry.pid, status: "online", restarts: identity.restarts,
          ports: ports.map((item) => item.port), startupMarkerSeen: true, interpreterVerified: true, environmentVerified: true });
        else ready = false;
      }
      if (ready) {
        if (healthySince === null) healthySince = now();
        if (now() - healthySince >= profile.stableMs) break;
      } else healthySince = null;
      await sleep(Math.min(500, remaining()));
    }
    phase = "complete";
    if (request.action === "start" && started.length && profile.persist) {
      // PM2 save snapshots the whole namespace. Do not save unrelated stopped/
      // errored registrations. Never save after partial startup or failed checks.
      if (entries.some((entry) => entry.pm2_env?.status !== "online")) return output("healthy", { persistenceWarning: "SERVICE_PM2_SAVE_SKIPPED_UNHEALTHY_NAMESPACE" });
      phase = "persist";
      await pm2(["save"]);
      phase = "complete";
      return output("healthy", { persisted: true });
    }
    return output("healthy", { unchanged: started.length === 0 });
  } catch (error) {
    const code = error.serviceCode || (["ENOENT", "EACCES", "EPERM", "ENOTDIR", "ELOOP"].includes(error.code) ? `SERVICE_FILESYSTEM_${error.code}` : "SERVICE_START_FAILED");
    return output(started.length ? "partial" : attempted.length ? "unknown" : "blocked", { error: { code }, recovery: "Inspect this exact instance before retrying. No processes were deleted or restarted; recovery requires separate authorization." });
  } finally {
    if (locked) { try { fs.rmdirSync(lock); } catch { /* fail closed on stale lock next time */ } }
  }
}
