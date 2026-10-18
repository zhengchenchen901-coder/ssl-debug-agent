import { Client } from "ssh2";
import { SshConnectionSupervisor } from "./ssh-connection-supervisor.js";

export function terminalSize(cols = 100, rows = 30) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 500 || rows < 2 || rows > 300) {
    throw Object.assign(new Error("终端尺寸无效。"), { code: "TERMINAL_SIZE_INVALID", statusCode: 400 });
  }
  return { cols, rows };
}

// One independent SSH transport per human terminal. No automatic command policy,
// retry or replay is applied to this interactive channel.
export function openManualTerminal(instance, options) {
  const client = new (options.ClientClass || Client)();
  const verifier = new SshConnectionSupervisor({ ssh: { ...instance, readyTimeout: 15_000 } });
  let stream;
  let closed = false;
  let size = terminalSize(options.cols, options.rows);
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(openTimer);
    stream?.destroy();
    client.destroy();
    options.onClose?.();
  };
  const fail = (code = "MANUAL_SSH_FAILED") => {
    if (closed) return;
    options.onError?.(code);
    close();
  };
  const openTimer = setTimeout(() => fail("MANUAL_SSH_TIMEOUT"), 30_000);
  openTimer.unref?.();
  client.on("error", () => fail(verifier.hostVerificationError?.code || "MANUAL_SSH_FAILED"));
  client.on("close", close);
  client.on("ready", () => {
    if (closed) return;
    const pty = { term: "xterm-256color", cols: size.cols, rows: size.rows };
    const open = options.command
      ? (callback) => client.exec(options.command, { pty }, callback)
      : (callback) => client.shell(pty, callback);
    open((error, channel) => {
      if (closed) { channel?.destroy(); return; }
      if (error) { fail("MANUAL_SHELL_FAILED"); return; }
      clearTimeout(openTimer);
      stream = channel;
      stream.on("data", (data) => options.onData(data));
      stream.stderr?.on("data", (data) => options.onData(data));
      stream.on("error", () => fail("MANUAL_SHELL_FAILED"));
      stream.on("close", close);
      options.onReady();
    });
  });
  verifier.connectionOptions().then((settings) => {
    if (!closed) client.connect(settings);
  }).catch((error) => fail(["SSH_HOST_KEY_REQUIRED", "SSH_HOST_KEY_MISMATCH"].includes(error.code) ? error.code : "MANUAL_SSH_CONFIG_INVALID"));
  return {
    close,
    write(data) {
      if (!closed && stream) {
        if (stream.writableLength > 1024 * 1024) throw Object.assign(new Error("远端输入缓冲已满，终端已断开。"), { code: "MANUAL_INPUT_OVERFLOW" });
        return stream.write(data);
      }
      return false;
    },
    resize(cols, rows) {
      size = terminalSize(cols, rows);
      if (!closed && stream) stream.setWindow(size.rows, size.cols, 0, 0);
    },
    pause() { stream?.pause(); stream?.stderr?.pause(); },
    resume() { stream?.resume(); stream?.stderr?.resume(); },
  };
}
