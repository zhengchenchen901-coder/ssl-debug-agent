// Runs through the structured tool's fixed SSH stdin helper, on remote Node 12+.
// Keep the entire runtime independent of local imports and never emit credentials.
export async function sandboxAccessRuntime(request, config, marker) {
  const fs = require("fs"), path = require("path"), crypto = require("crypto");
  const URLSearchParams = require("url").URLSearchParams;
  const collection = "__remote_debug_bulk_receipts";
  let client, managerClient, plan, lockFd, lockPath, temporary;
  function fail(code) { const error = new Error(code); error.safeCode = code; throw error; }
  function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") return Object.keys(value).sort().reduce(function (out, key) { out[key] = stable(value[key]); return out; }, {});
    return value;
  }
  function hash(value) { return crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex"); }
  function textHash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
  const publicConfig = Object.assign({}, config); delete publicConfig.managementPassword;
  const scope = hash(publicConfig);
  const managerUser = "rda_sandbox_manager_" + scope.slice(0, 16);
  const managerRole = "rda_sandbox_manager", executorRole = "rda_sandbox_executor";
  const managerPrivileges = [{ resource: { db: config.sandboxDatabase, collection }, actions: ["find", "remove"] }];
  const executorPrivileges = [
    { resource: { db: config.sandboxDatabase, collection }, actions: ["find", "insert", "listIndexes", "createIndex"] },
    { resource: { db: config.sandboxDatabase, collection: "" }, actions: ["listCollections", "createCollection"] },
  ];
  function shape(privileges) {
    return privileges.map(function (entry) { return { resource: stable(entry.resource), actions: entry.actions.slice().sort() }; }).sort(function (a, b) { return JSON.stringify(a).localeCompare(JSON.stringify(b)); });
  }
  function can(privileges, action, database) {
    return privileges.some(function (entry) { return entry.actions.includes(action) && (entry.resource.anyResource === true || !entry.resource.cluster && entry.resource.collection === "" && ["", database].includes(entry.resource.db)); });
  }
  function regular(file, privateFile) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file || stat.size > (privateFile ? 65536 : 4 * 1024 * 1024) || privateFile && ((stat.mode & 0o077) || stat.uid !== process.getuid())) fail("SANDBOX_SETUP_FILE_UNSAFE");
    return stat;
  }
  function directory(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(dir) !== dir || (stat.mode & 0o077) || stat.uid !== process.getuid()) fail("SANDBOX_SETUP_STORAGE_UNSAFE");
  }
  function atomic(file, value, owner) {
    const suffix = crypto.randomBytes(8).toString("hex");
    temporary = file + "." + suffix + ".tmp";
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n", "utf8");
      if (owner) fs.fchownSync(fd, owner.uid, owner.gid);
      fs.fchmodSync(fd, 0o600); fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file); temporary = null;
    const directoryFd = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  }
  function uriParts(uri) {
    const match = /^(mongodb(?:\+srv)?:\/\/)([^/?#]+)(\/[^?#]*)?(\?[^#]*)?$/i.exec(uri || "");
    if (!match) fail("SANDBOX_SETUP_URI_INVALID");
    const query = new URLSearchParams((match[4] || "").slice(1));
    const mechanism = query.get("authMechanism");
    if (mechanism && !["SCRAM-SHA-1", "SCRAM-SHA-256"].includes(mechanism) || query.has("authMechanismProperties")) fail("SANDBOX_SETUP_AUTH_MECHANISM_UNSUPPORTED");
    if (["authSource", "replicaSet", "authMechanism"].some(function (key) { return query.getAll(key).length > 1; })) fail("SANDBOX_SETUP_URI_INVALID");
    return { prefix: match[1].toLowerCase(), hosts: match[2].slice(match[2].lastIndexOf("@") + 1).toLowerCase(), authority: match[2], query };
  }
  function cluster(parts) { return hash({ prefix: parts.prefix, hosts: parts.hosts, replicaSet: parts.query.get("replicaSet") }); }
  function credential(parts) {
    const authority = parts.authority.slice(0, parts.authority.lastIndexOf("@"));
    const colon = authority.indexOf(":");
    if (colon < 1) fail("SANDBOX_SETUP_URI_INVALID");
    return { user: decodeURIComponent(authority.slice(0, colon)), password: decodeURIComponent(authority.slice(colon + 1)) };
  }
  function desiredUri(parts) {
    const query = new URLSearchParams(parts.query.toString()); query.set("authSource", config.sandboxDatabase);
    return parts.prefix + encodeURIComponent(managerUser) + ":" + encodeURIComponent(config.managementPassword) + "@" + parts.hosts + "/" + config.sandboxDatabase + "?" + query.toString();
  }
  function getKey(value, key) { return key.split(".").reduce(function (item, part) { return item == null ? undefined : item[part]; }, value); }
  const driver = require(config.driverPath), MongoClient = driver.MongoClient || driver.default && driver.default.MongoClient;
  async function connect(uri) {
    const connection = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, serverSelectionTimeoutMS: 15000 });
    try { await connection.connect(); return connection; } catch (error) { try { await connection.close(); } catch (_) {} throw error; }
  }
  async function preflight() {
    if (!["/home/app/", "/home/github/"].some(function (root) { return config.configPath.startsWith(root); }) || config.receiptsCollection !== collection) fail("SANDBOX_SETUP_SCOPE_INVALID");
    const stat = regular(config.configPath, false);
    const original = fs.readFileSync(config.configPath, "utf8"), fileConfig = JSON.parse(original);
    const source = getKey(fileConfig[config.configProfile], config.uriKey), parts = uriParts(source);
    if (!client) client = await connect(source);
    const build = await client.db("admin").command({ buildInfo: 1 });
    const topology = await client.db("admin").command({ isMaster: 1 });
    const version = String(build.version || ""), major = Number(version.split(".")[0]);
    if (!Number.isInteger(major) || major < 4 || Number(topology.maxWireVersion) < 7) fail("SANDBOX_SETUP_SERVER_UNSUPPORTED");
    const environment = { serverVersion: version, maxWireVersion: topology.maxWireVersion, deployment: topology.msg === "isdbgrid" ? "sharded" : topology.setName ? "replicaSet" : "standalone", replicaSet: topology.setName || null,
      transactionsSupported: !!topology.setName || topology.msg === "isdbgrid" && Number(topology.maxWireVersion) >= 8 };
    const authentication = await client.db("admin").command({ connectionStatus: 1, showPrivileges: true });
    const users = authentication.authInfo.authenticatedUsers;
    if (!users || users.length !== 1 || users[0].user === managerUser) fail("SANDBOX_SETUP_EXECUTION_USER_INVALID");
    const executionUser = users[0], privileges = authentication.authInfo.authenticatedUserPrivileges || [];
    for (const item of [["createRole", config.sandboxDatabase], ["createUser", config.sandboxDatabase], ["grantRole", config.sandboxDatabase], ["grantRole", executionUser.db]]) {
      if (!can(privileges, item[0], item[1])) fail("SANDBOX_SETUP_ADMIN_AUTHORITY_REQUIRED");
    }
    const db = client.db(config.sandboxDatabase), roles = [];
    for (const item of [[managerRole, managerPrivileges], [executorRole, executorPrivileges]]) {
      const result = await db.command({ rolesInfo: { role: item[0], db: config.sandboxDatabase }, showPrivileges: true });
      const actual = result.roles[0] || null;
      if (actual && (actual.roles.length || hash(shape(actual.privileges)) !== hash(shape(item[1])))) fail("SANDBOX_SETUP_ROLE_CONFLICT");
      roles.push({ role: item[0], exists: !!actual });
    }
    const result = await db.command({ usersInfo: { user: managerUser, db: config.sandboxDatabase }, showCredentials: false });
    const user = result.users[0];
    if (user && (user.roles.length !== 1 || user.roles[0].db !== config.sandboxDatabase || user.roles[0].role !== managerRole)) fail("SANDBOX_SETUP_USER_CONFLICT");
    const ownership = { plugin: "remote-debug-agent", version: 1, scope };
    if (user && hash(user.customData || null) !== hash(ownership)) fail("SANDBOX_SETUP_ACCOUNT_NOT_OWNED");
    const saved = fileConfig[config.managementProfile];
    if (saved) {
      const candidate = uriParts(saved.url);
      if (cluster(candidate) !== cluster(parts) || candidate.query.get("authSource") !== config.sandboxDatabase || credential(candidate).user !== managerUser) fail("SANDBOX_SETUP_PROFILE_CONFLICT");
    }
    let credentialAlreadyCurrent = false;
    if (user) {
      // Recover an interrupted password rotation using only the latest value
      // configured for this instance; never read passwords from backups.
      try {
        managerClient = await connect(saved ? saved.url : desiredUri(parts));
        credentialAlreadyCurrent = !saved || credential(uriParts(saved.url)).password === config.managementPassword;
      }
      catch (_) {
        if (!saved) fail("SANDBOX_SETUP_EXISTING_PASSWORD_UNKNOWN");
        managerClient = await connect(desiredUri(parts)); credentialAlreadyCurrent = true;
      }
      await verifyManager();
      await managerClient.close(); managerClient = null;
    }
    const current = await client.db(executionUser.db).command({ usersInfo: executionUser, showCredentials: false });
    if (!current.users[0]) fail("SANDBOX_SETUP_EXECUTION_USER_INVALID");
    const grants = current.users[0].roles;
    const passwordChanged = !!user && !credentialAlreadyCurrent;
    if (passwordChanged && user && !can(privileges, "changePassword", config.sandboxDatabase)) fail("SANDBOX_SETUP_ADMIN_AUTHORITY_REQUIRED");
    const snapshot = { scope, configHash: textHash(original), configMode: stat.mode & 0o777, configOwner: { uid: stat.uid, gid: stat.gid }, clusterHash: cluster(parts), executionUser, executionRolesHash: hash(grants), roles, managerExists: !!user, profileExists: !!saved, passwordChanged, profileNeedsUpdate: !saved || credential(uriParts(saved.url)).password !== config.managementPassword, passwordConfigHash: textHash(request.setupId + ":" + config.managementPassword), environment,
      executorGranted: grants.some(function (role) { return role.role === executorRole && role.db === config.sandboxDatabase; }) };
    return { stat, original, fileConfig, parts, snapshot, saved };
  }
  async function verifyManager() {
    const result = await managerClient.db("admin").command({ connectionStatus: 1, showPrivileges: true });
    const users = result.authInfo.authenticatedUsers || [], privileges = result.authInfo.authenticatedUserPrivileges || [];
    if (users.length !== 1 || users[0].user !== managerUser || users[0].db !== config.sandboxDatabase || hash(shape(privileges)) !== hash(shape(managerPrivileges))) fail("SANDBOX_SETUP_MANAGER_PRIVILEGES_UNSAFE");
  }
  function summary(value) {
    return { setupId: value.setupId, planHash: value.planHash, status: value.status, expiresAt: value.expiresAt, instanceId: config.instanceId, sandboxDatabase: config.sandboxDatabase, collection,
      managerUser, managerRole, executorRole, executionUser: value.snapshot.executionUser, managementProfile: config.managementProfile, configPath: config.configPath, configModeAfter: "0600", backupMode: "0600", managerPrivileges, executorPrivileges, collectionsInitialized: false,
      environment: value.snapshot.environment, passwordReset: value.snapshot.passwordChanged,
      requiresConfirmation: true, confirmation: "确认配置沙盒", rollbackMode: "manual_account_management", existing: { roles: value.snapshot.roles, manager: value.snapshot.managerExists, profile: value.snapshot.profileExists, executorGranted: value.snapshot.executorGranted } };
  }
  try {
    directory(path.dirname(config.journalRoot)); directory(config.journalRoot);
    const planFile = path.join(config.journalRoot, request.setupId + ".json");
    if (request.action === "prepare") {
      const state = await preflight();
      plan = { version: 1, setupId: request.setupId, expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), snapshot: state.snapshot };
      plan.planHash = hash(plan); plan.status = "prepared";
      if (fs.existsSync(planFile)) fail("SANDBOX_SETUP_PLAN_EXISTS");
      fs.writeFileSync(planFile, JSON.stringify(plan), { flag: "wx", mode: 0o600 });
    } else {
      if (request.confirmation !== "确认配置沙盒") fail("SANDBOX_SETUP_CONFIRMATION_REQUIRED");
      regular(planFile, true); plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
      const body = { version: plan.version, setupId: plan.setupId, expiresAt: plan.expiresAt, snapshot: plan.snapshot };
      if (plan.version !== 1 || plan.setupId !== request.setupId || plan.planHash !== request.planHash || hash(body) !== request.planHash || plan.snapshot.scope !== scope || plan.snapshot.passwordConfigHash !== textHash(request.setupId + ":" + config.managementPassword)) fail("SANDBOX_SETUP_PLAN_CONFLICT");
      if (plan.status !== "completed") {
        if (plan.status !== "prepared") fail("SANDBOX_SETUP_INSPECT_PARTIAL_CHANGES");
        if (!(Date.parse(plan.expiresAt) > Date.now())) fail("SANDBOX_SETUP_PLAN_EXPIRED");
        lockPath = config.configPath + ".rda-sandbox-access.lock";
        try { lockFd = fs.openSync(lockPath, "wx", 0o600); } catch (_) { fail("SANDBOX_SETUP_BUSY"); }
        const state = await preflight();
        if (hash(state.snapshot) !== hash(plan.snapshot)) fail("SANDBOX_SETUP_PLAN_CONFLICT");
        plan.status = "started"; atomic(planFile, plan);
        const password = config.managementPassword;
        const uri = desiredUri(state.parts);
        const sandbox = client.db(config.sandboxDatabase);
        for (const item of [[managerRole, managerPrivileges], [executorRole, executorPrivileges]]) {
          if (!plan.snapshot.roles.find(function (role) { return role.role === item[0]; }).exists) await sandbox.command({ createRole: item[0], privileges: item[1], roles: [] });
        }
        if (!plan.snapshot.managerExists) await sandbox.command({ createUser: managerUser, pwd: password, roles: [{ role: managerRole, db: config.sandboxDatabase }], customData: { plugin: "remote-debug-agent", version: 1, scope } });
        else if (state.snapshot.passwordChanged) await sandbox.command({ updateUser: managerUser, pwd: password });
        if (!plan.snapshot.executorGranted) await client.db(plan.snapshot.executionUser.db).command({ grantRolesToUser: plan.snapshot.executionUser.user, roles: [{ role: executorRole, db: config.sandboxDatabase }] });
        managerClient = await connect(uri); await verifyManager();
        // The latest credential remains in protected per-instance local config.
        // If this file write fails, a new prepare authenticates with that value.
        if (state.snapshot.profileNeedsUpdate) {
          if (textHash(fs.readFileSync(config.configPath, "utf8")) !== plan.snapshot.configHash) fail("SANDBOX_SETUP_PLAN_CONFLICT");
          const backup = config.configPath + ".before-rda-sandbox-" + request.setupId;
          fs.writeFileSync(backup, state.original, { flag: "wx", mode: 0o600 });
          state.fileConfig[config.managementProfile] = { url: uri };
          atomic(config.configPath, state.fileConfig, state.stat);
        } else if (state.stat.mode & 0o077) {
          // Tightening the file mode is part of the displayed plan.
          fs.chmodSync(config.configPath, 0o600);
        }
        plan.status = "completed"; atomic(planFile, plan);
      } else {
        const current = await preflight();
        if (!current.snapshot.managerExists || !current.snapshot.profileExists || !current.snapshot.executorGranted || current.snapshot.passwordChanged || current.snapshot.clusterHash !== plan.snapshot.clusterHash || hash(current.snapshot.executionUser) !== hash(plan.snapshot.executionUser)) fail("SANDBOX_SETUP_PLAN_CONFLICT");
      }
    }
    process.stdout.write(marker + JSON.stringify({ ok: true, data: summary(plan) }) + "\n");
  } catch (error) {
    if (plan && plan.status === "started") {
      plan.status = "partial";
      try { atomic(path.join(config.journalRoot, request.setupId + ".json"), plan); } catch (_) {}
    }
    process.stdout.write(marker + JSON.stringify({ ok: false, error: { code: error.safeCode || "SANDBOX_SETUP_FAILED" } }) + "\n");
    process.exitCode = 1;
  } finally {
    if (temporary) try { fs.unlinkSync(temporary); } catch (_) {}
    if (lockFd !== undefined) { try { fs.closeSync(lockFd); } catch (_) {} try { fs.unlinkSync(lockPath); } catch (_) {} }
    if (managerClient) try { await managerClient.close(); } catch (_) {}
    if (client) try { await client.close(); } catch (_) {}
  }
}
