// Serialized into a dedicated SSH exec channel. Keep compatible with remote Node 12+.
// The protocol is structured NDJSON, independent of the interactive mongosh channel.
export function manualMongoRemote(config, shellFingerprint) {
  const fs = require("fs"), crypto = require("crypto");
  const fail = (code) => { const error = new Error(code); error.code = code; throw error; };
  function connection() {
    let file;
    try { file = JSON.parse(fs.readFileSync(config.configPath, "utf8")); } catch (_) { fail("MANUAL_DB_PROFILE_REQUIRED"); }
    const profile = file[config.configProfile];
    const uri = config.uriKey.split(".").reduce((current, key) => current && Object.prototype.hasOwnProperty.call(current, key) ? current[key] : undefined, profile);
    if (typeof uri !== "string" || !/^mongodb(?:\+srv)?:\/\//.test(uri)) fail("MANUAL_DB_PROFILE_REQUIRED");
    const database = config.database || profile.database || profile.databaseName || "";
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify([uri, database])).digest("hex");
    return { uri, database, fingerprint };
  }
  if (shellFingerprint) {
    // No URI/password in command arguments or browser assets. Do not invoke a login shell.
    try {
      const target = connection();
      if (target.fingerprint !== shellFingerprint) fail("MANUAL_DB_TARGET_CHANGED");
      const startup = 'db = connect(process.env.RDA_MANUAL_MONGO_URI); delete process.env.RDA_MANUAL_MONGO_URI; if (process.env.RDA_MANUAL_MONGO_DATABASE) db = db.getSiblingDB(process.env.RDA_MANUAL_MONGO_DATABASE); delete process.env.RDA_MANUAL_MONGO_DATABASE;';
      const child = require("child_process").spawn(config.mongoshPath, ["--nodb", "--norc", "--quiet", "--shell", "--eval", startup], {
        stdio: "inherit", env: Object.assign({}, process.env, { RDA_MANUAL_MONGO_URI: target.uri, RDA_MANUAL_MONGO_DATABASE: target.database }),
      });
      child.on("error", () => { process.stderr.write("\r\nMANUAL_DB_MONGOSH_REQUIRED: 请在远端安装兼容的 mongosh 并配置客户端路径。\r\n"); process.exitCode = 1; });
      child.on("exit", (code) => { process.exitCode = code || 0; });
      for (const signal of ["SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
    } catch (_) { process.stderr.write("\r\nMANUAL_DB_TARGET_CHANGED: 数据库配置不可用或已变化，请断开数据库后重新连接。\r\n"); process.exitCode = 1; }
    return;
  }
  let client, EJSON, target, cursor, pendingDocument, cursorKey, cursorKind, cursorDatabase, cursorCollection, cursorPageSize;
  let connected = false, closing = false;
  const encode = (value) => JSON.parse(EJSON.stringify(value, { relaxed: false }));
  const decode = (value) => EJSON.parse(JSON.stringify(value), { relaxed: false });
  const MAX_BYTES = 384 * 1024;
  const emit = (value) => {
    const line = JSON.stringify(value);
    if (Buffer.byteLength(line) > 512 * 1024) fail("MANUAL_DB_RESULT_LIMIT");
    process.stdout.write(line + "\n");
  };
  async function closeCursor() {
    if (cursor) await cursor.close().catch(() => {});
    cursor = null; cursorKey = null; pendingDocument = undefined;
  }
  async function close() {
    if (closing) return;
    closing = true;
    clearTimeout(idle);
    await closeCursor();
    if (client) await client.close().catch(() => {});
  }
  let idle = setTimeout(() => { close().finally(() => process.exit(0)); }, 90_000);
  function touch() { clearTimeout(idle); idle = setTimeout(() => { close().finally(() => process.exit(0)); }, 90_000); }
  async function page() {
    const data = [];
    let bytes = 0;
    while (data.length < cursorPageSize) {
      const document = pendingDocument !== undefined ? pendingDocument : await cursor.next();
      pendingDocument = undefined;
      if (document === null) break;
      const value = encode(document), size = Buffer.byteLength(JSON.stringify(value));
      if (size > MAX_BYTES) { await closeCursor(); fail("MANUAL_DB_DOCUMENT_LIMIT"); }
      if (bytes + size > MAX_BYTES) { pendingDocument = document; break; }
      data.push(value); bytes += size;
    }
    if (pendingDocument === undefined) pendingDocument = await cursor.next();
    const hasMore = pendingDocument !== null;
    const result = { data, hasMore, cursor: hasMore ? cursorKey : null, kind: cursorKind, database: cursorDatabase, collection: cursorCollection };
    if (!hasMore) await closeCursor();
    return result;
  }
  async function run(request) {
    if (request.operation === "connect") {
      if (connected) fail("MANUAL_DB_ALREADY_CONNECTED");
      target = connection();
      let driver;
      try { driver = require(config.driverPath); } catch (_) { fail("MANUAL_DB_DRIVER_REQUIRED"); }
      let bson = driver.BSON || driver;
      if (!bson.EJSON) { try { bson = require(require.resolve("bson", { paths: [config.driverPath] })); } catch (_) { /* checked below */ } }
      EJSON = bson.EJSON;
      if (!EJSON || typeof EJSON.parse !== "function") fail("MANUAL_DB_DRIVER_REQUIRED");
      client = new driver.MongoClient(target.uri, { serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000, socketTimeoutMS: 20000,
        maxPoolSize: 2, promoteValues: false, promoteLongs: false, appName: "rda-manual-workbench" });
      await client.connect();
      await client.db(target.database || "admin").command({ ping: 1 }, { maxTimeMS: 10000 });
      let users;
      try { users = (await client.db("admin").command({ connectionStatus: 1, showPrivileges: false })).authInfo.authenticatedUsers; }
      catch (_) { fail("MANUAL_DB_IDENTITY_REQUIRED"); }
      // Display only the authority and verified DB identity; never URI options or password.
      const authority = target.uri.replace(/^mongodb(?:\+srv)?:\/\//, "").split(/[/?]/)[0];
      const hosts = authority.slice(authority.lastIndexOf("@") + 1);
      connected = true;
      return { fingerprint: target.fingerprint, hosts, database: target.database || client.db().databaseName, users: users.map((user) => ({ user: user.user, db: user.db })),
        profile: config.configProfile, configPath: config.configPath };
    }
    if (!connected) fail("MANUAL_DB_NOT_CONNECTED");
    if (connection().fingerprint !== target.fingerprint) fail("MANUAL_DB_TARGET_CHANGED");
    if (request.operation === "check") return {};
    if (request.operation === "next") {
      if (!cursor || request.cursor !== cursorKey) fail("MANUAL_DB_CURSOR_EXPIRED");
      return page();
    }
    if (request.operation === "replaceOne") {
      await closeCursor();
      const original = decode(request.original), replacement = decode(request.replacement);
      if (!original || !replacement || !Object.prototype.hasOwnProperty.call(original, "_id") || EJSON.stringify(original._id, { relaxed: false }) !== EJSON.stringify(replacement._id, { relaxed: false })) fail("MANUAL_DB_ID_IMMUTABLE");
      // MongoDB document equality guards concurrent changes. objectToArray avoids the MongoDB 4.4 $$ROOT equality optimizer bug.
      const result = await client.db(request.database).collection(request.collection).replaceOne({ _id: original._id,
        $expr: { $eq: [{ $objectToArray: "$$ROOT" }, { $literal: Object.keys(original).map((key) => ({ k: key, v: original[key] })) }] } }, replacement, { upsert: false, maxTimeMS: 10000 });
      if (!result.acknowledged) fail("MANUAL_DB_WRITE_UNKNOWN");
      if (Number(result.matchedCount) !== 1) fail("MANUAL_DB_WRITE_CONFLICT");
      return { matchedCount: Number(result.matchedCount), modifiedCount: Number(result.modifiedCount) };
    }
    await closeCursor();
    cursorPageSize = request.pageSize;
    cursorKey = crypto.randomBytes(24).toString("hex"); cursorKind = request.operation;
    cursorDatabase = request.database; cursorCollection = request.collection;
    if (request.operation === "databases") {
      // listDatabases is an atomic server command. Apply a bounded reply on the server too.
      const listed = await client.db("admin").admin().listDatabases({ nameOnly: true, authorizedDatabases: true, maxTimeMS: 10000 });
      const names = listed.databases.filter((item) => item.name > (request.after || "")).sort((a, b) => a.name < b.name ? -1 : 1);
      const data = [], limit = request.pageSize;
      let bytes = 0;
      for (const item of names) {
        if (data.length >= limit) break;
        bytes += Buffer.byteLength(JSON.stringify(item));
        if (bytes > MAX_BYTES) break;
        data.push({ name: item.name });
      }
      return { data, hasMore: names.length > data.length, after: data.length ? data[data.length - 1].name : null };
    }
    if (request.operation === "collections") {
      cursor = client.db(request.database).listCollections({}, { nameOnly: true, authorizedCollections: true, batchSize: request.pageSize, maxTimeMS: 10000 });
    } else if (request.operation === "indexes") {
      cursor = client.db(request.database).collection(request.collection).listIndexes({ batchSize: request.pageSize, maxTimeMS: 10000 });
    } else if (request.operation === "find") {
      const sort = Object.assign({}, request.sort);
      if (!Object.prototype.hasOwnProperty.call(sort, "_id")) sort._id = 1;
      cursor = client.db(request.database).collection(request.collection).find(decode(request.filter), {
        sort, batchSize: request.pageSize, maxTimeMS: 10000, allowDiskUse: false,
      });
    } else fail("MANUAL_DB_OPERATION_INVALID");
    return page();
  }
  const lines = require("readline").createInterface({ input: process.stdin, crlfDelay: Infinity });
  let sequence = Promise.resolve(), queued = 0;
  lines.on("line", (line) => {
    if (Buffer.byteLength(line) > 1024 * 1024 || ++queued > 2) { close().finally(() => process.exit(1)); return; }
    sequence = sequence.then(async () => {
      let request;
      try {
        request = JSON.parse(line); touch();
        const result = await run(request);
        emit({ id: request.id, ok: true, result });
      } catch (error) {
        const code = error && /^MANUAL_DB_/.test(error.code) ? error.code : error && Number(error.code) === 13 ? "MANUAL_DB_PERMISSION_DENIED" : error && Number(error.code) === 18 ? "MANUAL_DB_AUTH_FAILED" : error && /BSON|EJSON/.test(error.name) ? "MANUAL_DB_BSON_INVALID" : "MANUAL_DB_REMOTE_FAILED";
        emit({ id: request && request.id, ok: false, error: { code, serverCode: Number.isInteger(Number(error.code)) ? Number(error.code) : undefined } });
        if (!connected || code === "MANUAL_DB_TARGET_CHANGED") { await close(); process.exitCode = 1; lines.close(); process.stdin.destroy(); }
      } finally { queued--; }
    }).catch(() => close().finally(() => process.exit(1)));
  });
  lines.on("close", () => { sequence.finally(close); });
  process.on("SIGTERM", () => close().finally(() => process.exit(0)));
  process.on("SIGHUP", () => close().finally(() => process.exit(0)));
}
