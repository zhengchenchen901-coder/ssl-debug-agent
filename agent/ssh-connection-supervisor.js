import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { Client } from "ssh2";
import { ChannelScheduler } from "./channel-scheduler.js";
import { assertSshConfig } from "./config.js";
import {
  assertOperationActive,
  operationError,
  operationErrorForSignal,
  remainingOperationMs,
} from "./operation.js";

function nowIso(nowMs) {
  return new Date(nowMs).toISOString();
}

function authenticationFailure(error) {
  return (
    error?.level === "client-authentication" ||
    /authentication methods failed|authentication failure|permission denied/i.test(error?.message || "")
  );
}

export class SshConnectionSupervisor extends EventEmitter {
  constructor(config, options = {}) {
    super();
    this.config = config;
    this.ClientClass = options.ClientClass || Client;
    this.readFile = options.readFile || fs.readFile;
    this.now = options.now || (() => Date.now());
    this.random = options.random || Math.random;
    this.setTimeoutFn = options.setTimeout || setTimeout;
    this.clearTimeoutFn = options.clearTimeout || clearTimeout;
    const network = config.sshNetwork || {};
    this.keepaliveIntervalMs = network.keepaliveIntervalMs || 15_000;
    this.keepaliveCountMax = network.keepaliveCountMax ?? 3;
    this.reconnectBaseMs = network.reconnectBaseMs || 1_000;
    this.reconnectMaxMs = network.reconnectMaxMs || 30_000;
    this.reconnectJitter = network.reconnectJitter ?? 0.2;
    this.scheduler = options.scheduler || new ChannelScheduler({
      maxBusiness: network.maxBusinessChannels || 4,
      maxControl: network.maxControlChannels || 1,
      maxBackground: network.maxBackgroundChannels || 1,
      maxQueue: network.maxQueueLength || 100,
      backgroundStarvationMs: network.backgroundStarvationMs || 10_000,
      now: this.now,
    });
    this.state = "disconnected";
    this.client = null;
    this.connectPromise = null;
    this.reconnectTimer = null;
    this.generation = 0;
    this.reconnectAttempts = 0;
    this.nextRetryAt = null;
    this.connectedAt = null;
    this.lastActivityAt = null;
    this.lastError = null;
    this.authentication = {
      status: "unknown",
      lastSuccessAt: null,
      lastError: null,
    };
    this.hasConnected = false;
    this.stopping = false;
    this.activeChannels = new Map();
  }

  setState(state, event = {}) {
    this.state = state;
    if (event.error) {
      this.lastError = {
        code: event.error.code || "SSH_CONNECTION_ERROR",
        message: event.error.message || String(event.error),
        at: nowIso(this.now()),
      };
    }
    this.emit("state", this.snapshot());
  }

  async connectionOptions() {
    assertSshConfig(this.config);
    return {
      host: this.config.ssh.host,
      port: this.config.ssh.port,
      username: this.config.ssh.username,
      privateKey: await this.readFile(this.config.ssh.privateKeyPath, "utf8"),
      passphrase: this.config.ssh.passphrase,
      readyTimeout: this.config.ssh.readyTimeout,
      keepaliveInterval: this.keepaliveIntervalMs,
      keepaliveCountMax: this.keepaliveCountMax,
    };
  }

  async start() {
    await this.connectNow({ initial: true });
    return this.snapshot();
  }

  connectNow(options = {}) {
    if (this.stopping) {
      return Promise.reject(operationError("SSH supervisor is stopping", {
        code: "OPERATION_CANCELLED",
        statusCode: 499,
        layer: "ssh",
        phase: "connect",
      }));
    }
    if (this.state === "ready" && this.client) {
      return Promise.resolve(this.client);
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    if (this.reconnectTimer) {
      this.clearTimeoutFn(this.reconnectTimer);
      this.reconnectTimer = null;
      this.nextRetryAt = null;
    }

    this.connectPromise = this.performConnect(options)
      .finally(() => {
        this.connectPromise = null;
      });
    return this.connectPromise;
  }

  async performConnect(options = {}) {
    this.setState(this.hasConnected ? "reconnecting" : "connecting");
    let connectionOptions;
    try {
      connectionOptions = await this.connectionOptions();
    } catch (error) {
      this.recordConnectionFailure(error, options.initial);
      throw this.wrapConnectionError(error);
    }

    const client = new this.ClientClass();
    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        const fail = (error) => {
          if (settled) return;
          settled = true;
          client.removeListener("ready", ready);
          reject(error);
        };
        const ready = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        client.once("ready", ready);
        client.once("error", fail);
        client.once("close", () => fail(new Error("SSH transport closed before authentication")));
        client.connect(connectionOptions);
      });
    } catch (error) {
      client.end?.();
      this.recordConnectionFailure(error, options.initial);
      throw this.wrapConnectionError(error);
    }

    client.removeAllListeners("error");
    client.removeAllListeners("close");
    client.on("error", (error) => this.handleTransportFailure(client, error));
    client.on("close", () => this.handleTransportFailure(client, new Error("SSH transport closed")));
    client.on("end", () => this.handleTransportFailure(client, new Error("SSH transport ended")));

    this.client = client;
    this.generation += 1;
    this.reconnectAttempts = 0;
    this.nextRetryAt = null;
    this.connectedAt = nowIso(this.now());
    this.lastActivityAt = this.connectedAt;
    this.lastError = null;
    this.authentication = {
      status: "authenticated",
      lastSuccessAt: this.connectedAt,
      lastError: null,
    };
    this.hasConnected = true;
    this.setState("ready");
    return client;
  }

  wrapConnectionError(error, operationId) {
    const authFailed = authenticationFailure(error);
    return operationError(error?.message || "SSH connection failed", {
      code: authFailed ? "SSH_AUTH_FAILED" : "SSH_CONNECT_TIMEOUT",
      statusCode: authFailed ? 401 : 504,
      operationId,
      layer: "ssh",
      phase: authFailed ? "authentication" : "connect",
      retriable: !authFailed,
      cause: error,
    });
  }

  recordConnectionFailure(error, initial) {
    this.lastError = {
      code: authenticationFailure(error) ? "SSH_AUTH_FAILED" : "SSH_CONNECT_TIMEOUT",
      message: error?.message || "SSH connection failed",
      at: nowIso(this.now()),
    };
    if (authenticationFailure(error)) {
      this.authentication = {
        ...this.authentication,
        status: "failed",
        lastError: this.lastError,
      };
    }
    if (!initial && this.hasConnected && !this.stopping) {
      this.scheduleReconnect();
    } else {
      this.setState("disconnected", { error });
    }
  }

  handleTransportFailure(client, error) {
    if (this.stopping || this.client !== client) {
      return;
    }
    this.client = null;
    this.connectedAt = null;
    this.lastError = {
      code: "SSH_TRANSPORT_LOST",
      message: error?.message || "SSH transport lost",
      at: nowIso(this.now()),
    };
    this.setState("reconnecting", { error: this.lastError });
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.stopping || this.reconnectTimer) {
      return;
    }
    this.reconnectAttempts += 1;
    const exponential = Math.min(
      this.reconnectMaxMs,
      this.reconnectBaseMs * 2 ** Math.max(0, this.reconnectAttempts - 1),
    );
    const jitter = exponential * this.reconnectJitter * (this.random() * 2 - 1);
    const delayMs = Math.max(0, Math.round(exponential + jitter));
    this.nextRetryAt = nowIso(this.now() + delayMs);
    this.setState("backoff");
    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = null;
      this.nextRetryAt = null;
      this.connectNow({ initial: false }).catch(() => {
        this.scheduleReconnect();
      });
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  async waitUntilReady(operation) {
    assertOperationActive(operation, operation.signal, {
      layer: "ssh",
      phase: "connection-acquire",
    });
    if (this.state === "ready" && this.client) {
      return this.client;
    }
    if (!this.hasConnected && !this.connectPromise) {
      this.connectNow({ initial: false }).catch(() => {});
    } else if (this.hasConnected && !this.connectPromise && !this.reconnectTimer) {
      this.scheduleReconnect();
    }

    return new Promise((resolve, reject) => {
      const finish = (error, client) => {
        clearTimeout(timer);
        this.off("state", onState);
        operation.signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(client);
      };
      const onState = () => {
        if (this.state === "ready" && this.client) {
          finish(null, this.client);
        } else if (this.state === "closed" || this.state === "stopping") {
          finish(operationError("SSH supervisor is not available", {
            code: "OPERATION_CANCELLED",
            statusCode: 499,
            operationId: operation.operationId,
            layer: "ssh",
            phase: "connection-acquire",
          }));
        }
      };
      const onAbort = () => finish(operationErrorForSignal(operation.signal, operation, {
        layer: "ssh",
        phase: "connection-acquire",
      }));
      const timer = setTimeout(() => finish(operationError("operation deadline exceeded while waiting for SSH", {
        code: "OPERATION_DEADLINE_EXCEEDED",
        statusCode: 408,
        operationId: operation.operationId,
        layer: "ssh",
        phase: "connection-acquire",
      })), remainingOperationMs(operation));
      timer.unref?.();
      this.on("state", onState);
      operation.signal?.addEventListener("abort", onAbort, { once: true });
      onState();
    });
  }

  schedule(operation, task, options = {}) {
    return this.scheduler.schedule(operation, async ({ queueMs, priority }) => {
      const connectStartedAt = this.now();
      const client = await this.waitUntilReady(operation);
      const connectMs = Math.max(0, this.now() - connectStartedAt);
      this.lastActivityAt = nowIso(this.now());
      return task({
        client,
        queueMs,
        connectMs,
        priority,
        connectionGeneration: this.generation,
      });
    }, options);
  }

  registerChannel(channel, operation) {
    this.activeChannels.set(channel, operation);
    const cleanup = () => this.activeChannels.delete(channel);
    channel.once?.("close", cleanup);
    return cleanup;
  }

  snapshot() {
    const scheduler = this.scheduler.snapshot();
    const overall = this.stopping || this.state === "closed"
      ? "stopped"
      : this.state === "ready"
        ? "healthy"
        : this.hasConnected
          ? "degraded"
          : "unhealthy";
    return {
      overall,
      transport: {
        status: this.state,
        generation: this.generation,
        reconnectCount: Math.max(0, this.generation - 1),
        connectedAt: this.connectedAt,
        lastActivityAt: this.lastActivityAt,
        reconnectAttempts: this.reconnectAttempts,
        nextRetryAt: this.nextRetryAt,
        lastError: this.lastError,
      },
      authentication: { ...this.authentication },
      target: {
        status: this.state === "ready" ? "reachable" : this.hasConnected ? "degraded" : "unknown",
        lastCheckedAt: this.connectedAt,
        lastError: this.lastError,
      },
      operations: {
        ...scheduler,
        activeChannels: this.activeChannels.size,
      },
    };
  }

  async stop(reason = "worker stopped") {
    if (this.stopping || this.state === "closed") {
      return;
    }
    this.stopping = true;
    this.setState("stopping");
    if (this.reconnectTimer) {
      this.clearTimeoutFn(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.scheduler.close(reason);
    for (const [channel] of this.activeChannels.entries()) {
      try {
        channel.signal?.("TERM");
      } catch {
        // Some SSH servers do not support signals.
      }
      this.setTimeoutFn(() => {
        try {
          channel.close?.();
        } catch {
          // The transport may already be closed.
        }
      }, 500).unref?.();
    }
    this.client?.end?.();
    this.client = null;
    this.setState("closed");
  }
}
