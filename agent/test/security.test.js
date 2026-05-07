import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPathAllowed,
  isPathAllowed,
  normalizeTimeoutMs,
  validateCommand,
} from "../security.js";

const security = {
  allowedPaths: ["/var/log", "/etc/nginx", "/home/app"],
  defaultTimeoutMs: 10_000,
  maxTimeoutMs: 30_000,
};

test("allows whitelisted diagnostic commands", () => {
  assert.equal(validateCommand("netstat -tlnp", security).normalizedCommand, "netstat -tlnp");
  assert.equal(validateCommand("ps aux", security).normalizedCommand, "ps aux");
  const tail = validateCommand("tail -n 100 /var/log/nginx/error.log", security);
  assert.equal(tail.normalizedCommand, "tail -n 100 /var/log/nginx/error.log");
  assert.deepEqual(tail.absolutePaths, ["/var/log/nginx/error.log"]);
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

test("enforces allowed path roots", () => {
  assert.equal(isPathAllowed("/var/log/nginx/error.log", security.allowedPaths), true);
  assert.equal(isPathAllowed("/etc/nginx/nginx.conf", security.allowedPaths), true);
  assert.equal(isPathAllowed("/tmp/app.log", security.allowedPaths), false);
  assert.throws(() => assertPathAllowed("/etc/passwd", security.allowedPaths), /outside allowed/);
  assert.throws(() => validateCommand("cat /etc/passwd", security), /outside allowed/);
});

test("clamps command timeout", () => {
  assert.equal(normalizeTimeoutMs(undefined, security), 10_000);
  assert.equal(normalizeTimeoutMs(60_000, security), 30_000);
  assert.throws(() => normalizeTimeoutMs("nope", security), /positive integer/);
});
