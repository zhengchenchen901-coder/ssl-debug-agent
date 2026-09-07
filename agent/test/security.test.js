import assert from "node:assert/strict";
import test from "node:test";
import {
  ALLOWED_COMMANDS,
  assertPathAllowed,
  isPathAllowed,
  normalizeTimeoutMs,
  securityCapabilities,
  validateCommand,
} from "../security.js";

const security = {
  allowedPaths: ["/var/log", "/etc/nginx", "/home/app", "/root/.pm2", "/home/github"],
  defaultTimeoutMs: 10_000,
  maxTimeoutMs: 30_000,
};

test("allows whitelisted diagnostic commands", () => {
  assert.equal(validateCommand("netstat -tlnp", security).normalizedCommand, "netstat -tlnp");
  assert.equal(validateCommand("ps aux", security).normalizedCommand, "ps aux");
  assert.equal(validateCommand("mongodump --version", security).normalizedCommand, "mongodump --version");
  assert.equal(validateCommand("mongo --version", security).normalizedCommand, "mongo --version");
  assert.equal(validateCommand("mongosh --version", security).normalizedCommand, "mongosh --version");
  assert.equal(validateCommand("systemctl status mongod", security).normalizedCommand, "systemctl status mongod");
  assert.equal(
    validateCommand("systemctl --no-pager status nginx.service", security).normalizedCommand,
    "systemctl --no-pager status nginx.service",
  );
  assert.equal(validateCommand("nginx -t", security).normalizedCommand, "nginx -t");
  assert.equal(validateCommand("nginx -T", security).normalizedCommand, "nginx -T");
  assert.equal(validateCommand("which node", security).normalizedCommand, "which node");
  assert.equal(validateCommand("pm2 list", security).normalizedCommand, "pm2 list");
  assert.equal(validateCommand("pm2 describe api-server", security).normalizedCommand, "pm2 describe api-server");
  assert.equal(validateCommand("pm2 describe app-1", security).normalizedCommand, "pm2 describe app-1");
  assert.equal(validateCommand("pm2 env 1", security).normalizedCommand, "pm2 env 1");
  const tail = validateCommand("tail -n 100 /var/log/nginx/error.log", security);
  assert.equal(tail.normalizedCommand, "tail -n 100 /var/log/nginx/error.log");
  assert.deepEqual(tail.absolutePaths, ["/var/log/nginx/error.log"]);
});

test("publishes machine-readable capabilities from the enforced policy", () => {
  const capabilities = securityCapabilities({
    security: {
      ...security,
      sourceRoots: {
        be: "/home/github/app/current",
        h5: "/var/www/new_od_order",
      },
      defaultFileTimeoutMs: 20_000,
      maxFileTimeoutMs: 60_000,
      defaultReadMaxBytes: 256 * 1024,
      maxCommandOutputBytes: 1024 * 1024,
    },
    approvedCommands: { enabled: false, ttlMs: 1_000 },
  });

  assert.equal(capabilities.authority, "remote-debug-agent");
  assert.equal(capabilities.schemaVersion, 1);
  assert.match(capabilities.policyVersion, /^[a-f0-9]{64}$/);
  assert.deepEqual(capabilities.lifecycle.instanceRestart, {
    allowedFrom: ["stopped", "unhealthy"],
    runningBehavior: "no-op",
    transitionalBehavior: "reject",
  });
  assert.equal(capabilities.mongodb.readOnly, true);
  assert.ok(capabilities.mongodb.operations.includes("find"));
  assert.equal(capabilities.mongodb.maxLimit, 500);
  assert.ok(capabilities.mongodb.mutations.operations.includes("updateOne"));
  assert.ok(capabilities.mongodb.mutations.indexOperations.includes("createIndex"));
  assert.equal(capabilities.mongodb.mutations.rollback, true);
  assert.deepEqual(capabilities.logs.supportedCompression, ["none", "gzip", "tar-gzip"]);
  assert.equal(capabilities.logs.pagination, "cursor");
  assert.ok(capabilities.logs.categories.includes("pm2"));
  assert.equal(capabilities.commandReview.autoExecuteEnabled, false);
  assert.deepEqual(capabilities.commands.allowedExecutables, [...ALLOWED_COMMANDS]);
  assert.deepEqual(capabilities.paths.allowedRoots, security.allowedPaths);
  assert.deepEqual(capabilities.paths.sourceRoots, {
    be: "/home/github/app/current",
    h5: "/var/www/new_od_order",
  });
  assert.equal(capabilities.approvedCommands.enabled, false);
  for (const example of capabilities.commands.examples) {
    assert.doesNotThrow(() => validateCommand(example, security), example);
  }
});

test("rejects dangerous commands", () => {
  assert.throws(() => validateCommand("rm -rf /", security), /not whitelisted|dangerous/);
  assert.throws(() => validateCommand("sudo cat /etc/shadow", security), /not whitelisted|dangerous/);
  assert.throws(() => validateCommand("chmod 777 /home/app", security), /not whitelisted|dangerous/);
});

test("rejects shell injection and streaming tails", () => {
  assert.throws(() => validateCommand("ls /var/log; rm -rf /", security), /shell control/);
  assert.throws(() => validateCommand("grep error /var/log/app.log | cat", security), /shell control/);
  assert.throws(() => validateCommand("tail -f /var/log/app.log", security), /not supported/);
  assert.throws(() => validateCommand("ls", security), /requires at least one/);
  assert.throws(() => validateCommand("grep error", security), /requires at least one/);
  assert.throws(() => validateCommand("cat nginx/error.log", security), /relative or embedded/);
});

test("restricts newly allowed commands to read-only diagnostics", () => {
  assert.throws(
    () => validateCommand("mongodump --archive=/tmp/dump.archive", security),
    /only supports --version/,
  );
  assert.throws(() => validateCommand("systemctl restart nginx", security), /unsupported systemctl action/);
  assert.throws(() => validateCommand("systemctl status ssh", security), /unsupported systemctl unit/);
  assert.throws(() => validateCommand("nginx -s reload", security), /unsupported nginx argument/);
  assert.throws(() => validateCommand("pm2 restart app", security), /unsupported pm2 action/);
  assert.throws(() => validateCommand("pm2 delete app", security), /unsupported pm2 action/);
  assert.throws(() => validateCommand("pm2 logs app", security), /unsupported pm2 action/);
  assert.throws(() => validateCommand("pm2 env abc", security), /numeric process id/);
  assert.throws(() => validateCommand("pm2 describe", security), /requires exactly one/);
  assert.throws(() => validateCommand("pm2 list extra", security), /does not support additional/);
});

test("allows only explicitly recognized maintenance commands in approved mode", () => {
  assert.equal(
    validateCommand("systemctl --no-pager reload nginx.service", { ...security, mode: "approved" }).executionMode,
    "manual",
  );
  assert.equal(
    validateCommand("pm2 restart api-server", { ...security, mode: "approved" }).effect,
    "service_control",
  );
  assert.equal(
    validateCommand("nginx -s reload", { ...security, mode: "approved" }).riskLevel,
    "medium",
  );
  assert.throws(
    () => validateCommand("mongosh --eval db.members.updateOne", { ...security, mode: "approved" }),
    /not whitelisted|only supports --version|unsupported/i,
  );
});

test("enforces allowed path roots", () => {
  assert.equal(isPathAllowed("/var/log/nginx/error.log", security.allowedPaths), true);
  assert.equal(isPathAllowed("/etc/nginx/nginx.conf", security.allowedPaths), true);
  assert.equal(isPathAllowed("/root/.pm2/dump.pm2", security.allowedPaths), true);
  assert.equal(isPathAllowed("/home/github/app.log", security.allowedPaths), true);
  assert.equal(isPathAllowed("/tmp/app.log", security.allowedPaths), false);
  assert.throws(() => assertPathAllowed("/etc/passwd", security.allowedPaths), /outside allowed/);
  assert.throws(() => validateCommand("cat /etc/passwd", security), /outside allowed/);
});

test("clamps command timeout", () => {
  assert.equal(normalizeTimeoutMs(undefined, security), 10_000);
  assert.equal(normalizeTimeoutMs(60_000, security), 30_000);
  assert.throws(() => normalizeTimeoutMs("nope", security), /positive integer/);
});
