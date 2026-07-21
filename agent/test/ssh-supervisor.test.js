import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { SshConnectionSupervisor } from "../ssh-connection-supervisor.js";

const config = {
  ssh: {
    host: "example.test",
    port: 22,
    username: "app",
    privateKeyPath: "test-key",
    readyTimeout: 1_000,
  },
  sshNetwork: {
    reconnectBaseMs: 1,
    reconnectMaxMs: 2,
    reconnectJitter: 0,
  },
};

function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error("condition was not met"));
      setTimeout(check, 2);
    };
    check();
  });
}

test("supervisor single-flights connection setup and rereads credentials on reconnect", async () => {
  const clients = [];
  const connectionOptions = [];
  let keyReads = 0;

  class FakeClient extends EventEmitter {
    constructor() {
      super();
      clients.push(this);
    }

    connect(options) {
      connectionOptions.push(options);
      setImmediate(() => this.emit("ready"));
    }

    end() {}
  }

  const supervisor = new SshConnectionSupervisor(config, {
    ClientClass: FakeClient,
    readFile: async () => `key-${++keyReads}`,
    random: () => 0.5,
  });

  const connected = await Promise.all([
    supervisor.connectNow({ initial: true }),
    supervisor.connectNow({ initial: true }),
    supervisor.connectNow({ initial: true }),
  ]);
  assert.equal(clients.length, 1);
  assert.ok(connected.every((client) => client === clients[0]));
  assert.equal(connectionOptions[0].keepaliveInterval, 15_000);
  assert.equal(connectionOptions[0].keepaliveCountMax, 3);

  clients[0].emit("close");
  await waitFor(() => supervisor.state === "ready" && supervisor.generation === 2);
  assert.equal(clients.length, 2);
  assert.equal(keyReads, 2);
  assert.equal(connectionOptions[1].privateKey, "key-2");
  assert.equal(supervisor.snapshot().transport.reconnectCount, 1);
  await supervisor.stop();
});

test("supervisor shutdown cancels queued work and terminates active channels", async () => {
  class FakeClient extends EventEmitter {
    connect() {
      setImmediate(() => this.emit("ready"));
    }
    end() {}
  }
  const supervisor = new SshConnectionSupervisor(config, {
    ClientClass: FakeClient,
    readFile: async () => "key",
    setTimeout: (callback) => {
      callback();
      return { unref() {} };
    },
    clearTimeout: () => {},
  });
  await supervisor.start();

  const channel = new EventEmitter();
  let signal;
  let closed = false;
  channel.signal = (value) => { signal = value; };
  channel.close = () => { closed = true; };
  supervisor.registerChannel(channel, { operationId: "active" });

  await supervisor.stop("test shutdown");
  assert.equal(signal, "TERM");
  assert.equal(closed, true);
  assert.equal(supervisor.state, "closed");
});
