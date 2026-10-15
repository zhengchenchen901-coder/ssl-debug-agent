// Reviewable one-time MongoDB account configuration for test-server only.
// No business documents, indexes, database servers or services are changed.
// This file is a draft; it has not been executed on test-server.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CONFIG = "/home/github/OD-Yennefer-BE-next/config.json";
const DRIVER = "/home/github/remote-debug-drivers/test-server/node_modules/mongodb";
const EXECUTION_PROFILE = "development";
const MANAGEMENT_PROFILE = "remote_debug_manager";
const SANDBOX = "remote_debug_agent";
const COLLECTION = "__remote_debug_bulk_receipts";
const MANAGER_USER = "rda_sandbox_manager_test_server";
const MANAGER_ROLE = "rda_sandbox_manager_test_server";
const EXECUTOR_ROLE = "rda_sandbox_executor_test_server";

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.keys(value).sort().reduce((out, key) => { out[key] = stable(value[key]); return out; }, {});
  return value;
}
function privilegeShape(privileges) {
  return privileges.map((entry) => ({ resource: stable(entry.resource), actions: entry.actions.slice().sort() })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function roleMatches(actual, expected) {
  return actual && actual.roles.length === 0 && JSON.stringify(privilegeShape(actual.privileges)) === JSON.stringify(privilegeShape(expected));
}
function parseUri(uri) {
  const match = /^(mongodb(?:\+srv)?:\/\/)([^/?#]+)(\/[^?#]*)?(\?[^#]*)?$/i.exec(uri || "");
  if (!match) fail("CONFIG_URI_INVALID");
  const hosts = match[2].slice(match[2].lastIndexOf("@") + 1);
  const query = new URLSearchParams((match[4] || "").slice(1));
  const mechanism = query.get("authMechanism");
  if (mechanism && !["SCRAM-SHA-1", "SCRAM-SHA-256"].includes(mechanism)) fail("UNSUPPORTED_AUTH_MECHANISM");
  return { prefix: match[1], hosts, query };
}
function managerUri(parts, password) {
  const query = new URLSearchParams(parts.query.toString());
  query.set("authSource", SANDBOX);
  return parts.prefix + encodeURIComponent(MANAGER_USER) + ":" + encodeURIComponent(password) + "@" + parts.hosts + "/" + SANDBOX + "?" + query.toString();
}
async function existingRole(db, role) {
  const result = await db.command({ rolesInfo: { role, db: SANDBOX }, showPrivileges: true });
  return result.roles[0] || null;
}
async function existingUser(db) {
  const result = await db.command({ usersInfo: { user: MANAGER_USER, db: SANDBOX }, showCredentials: false });
  return result.users[0] || null;
}
function managerUserMatches(user) {
  return user && user.roles.length === 1 && user.roles[0].role === MANAGER_ROLE && user.roles[0].db === SANDBOX;
}
function can(privileges, action, database) {
  return privileges.some((entry) => entry.actions.includes(action) && (entry.resource.anyResource === true || !entry.resource.cluster && entry.resource.collection === "" && ["", database].includes(entry.resource.db)));
}

(async () => {
  let client, managerClient, temporary;
  try {
    const canonical = fs.realpathSync(CONFIG);
    if (!canonical.startsWith("/home/github/")) fail("CONFIG_PATH_ESCAPES_APPROVED_ROOT");
    const stat = fs.lstatSync(canonical);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) fail("CONFIG_FILE_INVALID");
    const original = fs.readFileSync(canonical, "utf8");
    const originalHash = crypto.createHash("sha256").update(original).digest("hex");
    const config = JSON.parse(original);
    const profile = config[EXECUTION_PROFILE];
    if (!profile || typeof profile.url !== "string") fail("EXECUTION_PROFILE_MISSING");
    const parts = parseUri(profile.url);
    const driver = require(DRIVER);
    const MongoClient = driver.MongoClient || driver.default && driver.default.MongoClient;
    if (!MongoClient) fail("DRIVER_INVALID");
    client = new MongoClient(profile.url, { useNewUrlParser: true, useUnifiedTopology: true, serverSelectionTimeoutMS: 15000 });
    await client.connect();
    const authentication = await client.db("admin").command({ connectionStatus: 1, showPrivileges: true });
    const users = authentication.authInfo.authenticatedUsers;
    if (!users || users.length !== 1) fail("EXACT_AUTHENTICATED_EXECUTION_USER_REQUIRED");
    const executionUser = users[0];
    if (executionUser.user === MANAGER_USER) fail("EXECUTION_AND_MANAGER_USERS_MUST_DIFFER");
    const privileges = authentication.authInfo.authenticatedUserPrivileges || [];
    for (const [action, database] of [["createRole", SANDBOX], ["createUser", SANDBOX], ["grantRole", SANDBOX], ["grantRole", executionUser.db]]) {
      if (!can(privileges, action, database)) fail("EXISTING_CONNECTION_LACKS_ADMIN_AUTHORITY");
    }
    const sandbox = client.db(SANDBOX);
    const managerPrivileges = [{ resource: { db: SANDBOX, collection: COLLECTION }, actions: ["find", "remove"] }];
    const executorPrivileges = [
      { resource: { db: SANDBOX, collection: COLLECTION }, actions: ["find", "insert", "listIndexes", "createIndex"] },
      { resource: { db: SANDBOX, collection: "" }, actions: ["listCollections", "createCollection"] }
    ];
    const roles = [
      [MANAGER_ROLE, managerPrivileges, await existingRole(sandbox, MANAGER_ROLE)],
      [EXECUTOR_ROLE, executorPrivileges, await existingRole(sandbox, EXECUTOR_ROLE)]
    ];
    for (const [name, expected, actual] of roles) {
      if (actual && !roleMatches(actual, expected)) fail("EXISTING_ROLE_CONFLICT_" + name);
    }
    const user = await existingUser(sandbox);
    if (user && !managerUserMatches(user)) fail("EXISTING_MANAGER_USER_CONFLICT");
    const savedProfile = config[MANAGEMENT_PROFILE];
    if (savedProfile) {
      const candidate = parseUri(savedProfile.url);
      if (candidate.prefix.toLowerCase() !== parts.prefix.toLowerCase() || candidate.hosts.toLowerCase() !== parts.hosts.toLowerCase() || candidate.query.get("authSource") !== SANDBOX || candidate.query.get("replicaSet") !== parts.query.get("replicaSet")) fail("EXISTING_MANAGER_PROFILE_CONFLICT");
      const authority = /^mongodb(?:\+srv)?:\/\/([^/?#]+)/i.exec(savedProfile.url)[1];
      if (decodeURIComponent(authority.split("@")[0].split(":")[0]) !== MANAGER_USER) fail("EXISTING_MANAGER_PROFILE_USER_CONFLICT");
      if (user) {
        managerClient = new MongoClient(savedProfile.url, { useNewUrlParser: true, useUnifiedTopology: true, serverSelectionTimeoutMS: 15000 });
        await managerClient.connect(); await managerClient.close(); managerClient = null;
      }
    } else if (user) fail("EXISTING_USER_PASSWORD_UNKNOWN_DO_NOT_RESET");

    // All writes below are restricted to sandbox roles/users and one new
    // configuration entry. There is no collection/index or business-data write.
    const password = savedProfile ? null : crypto.randomBytes(32).toString("hex");
    const uri = savedProfile ? savedProfile.url : managerUri(parts, password);
    if (!savedProfile) {
      if (crypto.createHash("sha256").update(fs.readFileSync(canonical, "utf8")).digest("hex") !== originalHash) fail("CONFIG_CHANGED_DURING_PREFLIGHT");
      const suffix = crypto.randomBytes(8).toString("hex");
      const backup = canonical + ".before-rda-sandbox-" + suffix;
      fs.writeFileSync(backup, original, { flag: "wx", mode: 0o600 });
      config[MANAGEMENT_PROFILE] = { url: uri };
      temporary = path.join(path.dirname(canonical), ".rda-sandbox-config-" + suffix + ".tmp");
      const fd = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(config, null, 2) + "\n", "utf8");
        fs.fchownSync(fd, stat.uid, stat.gid); fs.fchmodSync(fd, stat.mode & 0o777); fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, canonical); temporary = null;
      const directoryFd = fs.openSync(path.dirname(canonical), "r");
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    }
    for (const [name, expected, actual] of roles) {
      if (!actual) await sandbox.command({ createRole: name, privileges: expected, roles: [] });
    }
    if (!user) {
      // On retry, reuse the password written by the first attempt; never rotate
      // an existing account and never print the credential.
      const authority = /^mongodb(?:\+srv)?:\/\/([^/?#]+)/i.exec(uri)[1];
      const encodedPassword = authority.split("@")[0].slice(authority.split("@")[0].indexOf(":") + 1);
      await sandbox.command({ createUser: MANAGER_USER, pwd: decodeURIComponent(encodedPassword), roles: [{ role: MANAGER_ROLE, db: SANDBOX }] });
    }
    const current = await client.db(executionUser.db).command({ usersInfo: { user: executionUser.user, db: executionUser.db }, showCredentials: false });
    if (!current.users[0]) fail("EXECUTION_USER_CHANGED");
    if (!current.users[0].roles.some((role) => role.role === EXECUTOR_ROLE && role.db === SANDBOX)) {
      await client.db(executionUser.db).command({ grantRolesToUser: executionUser.user, roles: [{ role: EXECUTOR_ROLE, db: SANDBOX }] });
    }
    managerClient = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, serverSelectionTimeoutMS: 15000 });
    await managerClient.connect();
    const managerStatus = await managerClient.db("admin").command({ connectionStatus: 1, showPrivileges: true });
    const effective = managerStatus.authInfo.authenticatedUserPrivileges || [];
    if (!effective.length || effective.some((entry) => entry.resource.db !== SANDBOX || entry.resource.collection !== COLLECTION || entry.actions.some((action) => !["find", "remove"].includes(action)))) fail("MANAGER_EFFECTIVE_PRIVILEGES_UNSAFE");
    process.stdout.write(JSON.stringify({ ok: true, instanceId: "test-server", sandboxDatabase: SANDBOX, managerUser: MANAGER_USER, managerRole: MANAGER_ROLE, executorRole: EXECUTOR_ROLE, executionUser, configurationProfile: MANAGEMENT_PROFILE, collectionsInitialized: false, nextStep: "initialize storage through the structured mutation tools after installing 2.3.0" }) + "\n");
  } catch (error) {
    process.stderr.write(JSON.stringify({ ok: false, code: error.code || "SANDBOX_ADMIN_SETUP_FAILED", note: "No credentials are printed. Inspect partial role/configuration changes before retry; matching objects are reusable." }) + "\n");
    process.exitCode = 1;
  } finally {
    if (temporary) try { fs.unlinkSync(temporary); } catch (_) {}
    if (managerClient) try { await managerClient.close(); } catch (_) {}
    if (client) try { await client.close(); } catch (_) {}
  }
})();
