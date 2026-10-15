# test-server 沙盒管理员配置：已取消，保留审查记录

用户已选择“使用结构化管理能力，暂不执行这份命令”。本草稿不再待执行；后续使用 2.3.0 的 `remote_debug_prepare_sandbox_access` / `remote_debug_configure_sandbox_access`，在 Dashboard 按实例配置管理密码，并对结构化计划单独确认。以下内容仅保留原审查证据，不构成执行授权。

本文件是经过审查的完整命令草稿，目前尚未在 test-server 执行。

目标：test-server（8.209.81.113）；原业务配置分组 development；业务默认数据库 yennefer。

拟执行改动：

- 在 remote_debug_agent 中创建/验证角色 rda_sandbox_manager_test_server，仅允许技术集合的 find/remove。
- 创建管理账户 rda_sandbox_manager_test_server；密码在服务器生成，仅保存到 remote_debug_manager 连接分组，不显示在命令或输出中。
- 创建/验证角色 rda_sandbox_executor_test_server，将其追加到 development 连接实际认证的 MongoDB 账户；范围只包含沙盒执行和初始化所需权限，不删除原角色。
- 在 /home/github/OD-Yennefer-BE-next/config.json 新增 remote_debug_manager 分组，生成仅所有者可读的配置备份并保持原文件属主和权限。已有分组保持原值。存在账户/角色/配置冲突时停止，不重置已有密码。
- 该步骤不初始化技术集合或 TTL 索引；账户设置后仍需升级到 2.3.0，再用结构化工具准备并确认存储初始化。

验证：独立、开启认证的本地 MongoDB 4.4 副本集中首次执行及重复执行通过；原业务配置保持完整；管理账户访问业务集合返回 Unauthorized；临时容器已清理。

草稿元数据：

- draftId: d092439c-bbd2-4af9-aa17-fb979d638033
- commandHash: 3458f070aac504d16f5e664c72581022c3e040b8d7c34b1fb75616705ca3d7ae
- commandCount: 1
- 失效时间（Asia/Shanghai）: 2026/10/14 20:02:46
- 审查结果: manual_review / static_policy_rejected

审查违规点（命令索引从 0 开始）：

- 命令 0；INVALID_COMMAND；级别 high；规则：命令必须是非空字符串且不超过长度限制；证据：cmd is too long
- 命令 0；COMMAND_SECRET_EXPOSURE；级别 critical；规则：命令不能直接携带密码、Token、API Key 或带认证信息的连接字符串；证据：node -e '// Reviewable one-time MongoDB account configuration for test-server only. // No business documents, indexes, database servers or services are changed. // This file is a draft; it has not been executed on test-server. "use strict"; const fs = require("fs"); const path = require("path"); const crypto = require("crypto");  const CONFIG = "/home/github/OD-Yennefer-BE-next/config.json"; const DRIVER = "/home/github/remote-debug-drivers/test-server/node_modules/mongodb"; const EXECUTION_PROFILE = "devel...

其中敏感信息标记来自源码变量赋值模式的静态检测；命令没有包含实际密码值。即便如此，自动审查没有授予执行权限。数据库技能要求使用结构化变更工具，账户/角色管理尚未有对应工具，因此执行该命令还需要用户明确授权此次管理员配置的命令通道例外。

完整命令：

```bash
node -e '// Reviewable one-time MongoDB account configuration for test-server only.
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
'
```

