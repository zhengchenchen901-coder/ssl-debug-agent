import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { readRemoteFile, runSSH } from "../ssh.js";
import { SshConnectionSupervisor } from "../ssh-connection-supervisor.js";

function makeConfig() {
  return {
    ssh: {
      host: "example.test",
      port: 22,
      username: "app",
      privateKeyPath: "test-key",
      readyTimeout: 1_000,
    },
    sshNetwork: {},
    security: {
      allowedPaths: ["/var/log"],
      maxCommandOutputBytes: 1024 * 1024,
    },
  };
}

function successfulStream(stdout = "ok") {
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.signal = () => {};
  stream.close = () => stream.emit("close", 0);
  setImmediate(() => {
    stream.emit("data", Buffer.from(stdout));
    stream.emit("close", 0);
  });
  return stream;
}

test("exec and path validation reuse one persistent SSH transport", async () => {
  const config = makeConfig();
  let connectionCount = 0;
  let sftpCount = 0;

  class FakeClient extends EventEmitter {
    connect() {
      connectionCount += 1;
      setImmediate(() => this.emit("ready"));
    }

    sftp(callback) {
      sftpCount += 1;
      const sftp = new EventEmitter();
      sftp.realpath = (remotePath, done) => setImmediate(() => done(null, remotePath));
      sftp.end = () => sftp.emit("close");
      setImmediate(() => callback(null, sftp));
    }

    exec(command, callback) {
      setImmediate(() => callback(null, successfulStream(command)));
    }

    end() {}
  }

  const supervisor = new SshConnectionSupervisor(config, {
    ClientClass: FakeClient,
    readFile: async () => "key",
  });
  await supervisor.start();

  const first = await runSSH("tail -n 1 /var/log/app.log", {
    config,
    supervisor,
    remotePaths: ["/var/log/app.log"],
  });
  const second = await runSSH("uptime", { config, supervisor });
  assert.match(first.stdout, /tail -n 1/);
  assert.equal(second.stdout, "uptime");
  assert.equal(connectionCount, 1);
  assert.equal(sftpCount, 1);
  assert.equal(first.timing.connectionGeneration, second.timing.connectionGeneration);
  await supervisor.stop();
});

test("SSH exec forwards optional stdin and closes the channel", async () => {
  const config = makeConfig();
  let receivedStdin = "";

  class FakeClient extends EventEmitter {
    connect() {
      setImmediate(() => this.emit("ready"));
    }

    exec(_command, callback) {
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.signal = () => {};
      stream.end = (input) => {
        receivedStdin = Buffer.isBuffer(input) ? input.toString("utf8") : String(input);
        setImmediate(() => {
          stream.emit("data", Buffer.from("done"));
          stream.emit("close", 0);
        });
      };
      setImmediate(() => callback(null, stream));
    }

    end() {}
  }

  const supervisor = new SshConnectionSupervisor(config, {
    ClientClass: FakeClient,
    readFile: async () => "key",
  });
  await supervisor.start();

  try {
    const result = await runSSH("node", {
      config,
      supervisor,
      stdin: "read-only helper",
    });
    assert.equal(receivedStdin, "read-only helper");
    assert.equal(result.stdout, "done");
  } finally {
    await supervisor.stop();
  }
});

test("a command that prints output but never exits returns the real deadline error", async () => {
  const config = makeConfig();
  let receivedSignal;
  let channelClosed = false;

  class FakeClient extends EventEmitter {
    connect() {
      setImmediate(() => this.emit("ready"));
    }

    exec(_command, callback) {
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.signal = (value) => { receivedSignal = value; };
      stream.close = () => { channelClosed = true; };
      setImmediate(() => {
        callback(null, stream);
        stream.emit("data", Buffer.from('{"result":"already printed"}'));
      });
    }

    end() {}
  }

  const supervisor = new SshConnectionSupervisor(config, {
    ClientClass: FakeClient,
    readFile: async () => "key",
  });
  await supervisor.start();

  const keepAlive = setTimeout(() => {}, 1_000);
  try {
    await assert.rejects(
      runSSH("node query.js", { config, supervisor, timeoutMs: 20 }),
      (error) => error.code === "OPERATION_DEADLINE_EXCEEDED" && error.layer === "ssh",
    );
    assert.equal(receivedSignal, "TERM");
    assert.equal(channelClosed, true);
  } finally {
    clearTimeout(keepAlive);
    await supervisor.stop();
  }
});

test("SFTP retries once before data is returned", async () => {
  const config = makeConfig();
  let sftpCount = 0;

  class FakeClient extends EventEmitter {
    connect() {
      setImmediate(() => this.emit("ready"));
    }

    sftp(callback) {
      sftpCount += 1;
      if (sftpCount === 1) {
        setImmediate(() => callback(new Error("channel open failed")));
        return;
      }
      const sftp = new EventEmitter();
      sftp.realpath = (remotePath, done) => setImmediate(() => done(null, remotePath));
      sftp.stat = (_remotePath, done) => setImmediate(() => done(null, { size: 2 }));
      sftp.createReadStream = () => {
        const stream = new EventEmitter();
        stream.destroy = () => stream.emit("close");
        setImmediate(() => {
          stream.emit("data", Buffer.from("ok"));
          stream.emit("end");
        });
        return stream;
      };
      sftp.end = () => sftp.emit("close");
      setImmediate(() => callback(null, sftp));
    }

    end() {}
  }

  const supervisor = new SshConnectionSupervisor(config, {
    ClientClass: FakeClient,
    readFile: async () => "key",
  });
  await supervisor.start();
  const result = await readRemoteFile("/var/log/app.log", {
    config,
    supervisor,
    maxBytes: 100,
  });
  assert.equal(result.content, "ok");
  assert.equal(sftpCount, 2);
  await supervisor.stop();
});

test("SFTP does not retry after file data has been returned", async () => {
  const config = makeConfig();
  let sftpCount = 0;

  class FakeClient extends EventEmitter {
    connect() {
      setImmediate(() => this.emit("ready"));
    }

    sftp(callback) {
      sftpCount += 1;
      const sftp = new EventEmitter();
      sftp.realpath = (remotePath, done) => setImmediate(() => done(null, remotePath));
      sftp.stat = (_remotePath, done) => setImmediate(() => done(null, { size: 20 }));
      sftp.createReadStream = () => {
        const stream = new EventEmitter();
        stream.destroy = () => stream.emit("close");
        setImmediate(() => {
          stream.emit("data", Buffer.from("partial"));
          stream.emit("error", new Error("transport lost"));
        });
        return stream;
      };
      sftp.end = () => sftp.emit("close");
      setImmediate(() => callback(null, sftp));
    }

    end() {}
  }

  const supervisor = new SshConnectionSupervisor(config, {
    ClientClass: FakeClient,
    readFile: async () => "key",
  });
  await supervisor.start();
  await assert.rejects(
    readRemoteFile("/var/log/app.log", { config, supervisor, maxBytes: 100 }),
    (error) => error.code === "SSH_TRANSPORT_LOST",
  );
  assert.equal(sftpCount, 1);
  await supervisor.stop();
});
