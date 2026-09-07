import { randomUUID } from "node:crypto";

export const API_VERSION = 2;

export const OPERATION_TIMEOUTS = Object.freeze({
  run: Object.freeze({ defaultMs: 30_000, maxMs: 120_000 }),
  file: Object.freeze({ defaultMs: 60_000, maxMs: 300_000 }),
  mongodb: Object.freeze({ defaultMs: 60_000, maxMs: 300_000 }),
  mongodbMutation: Object.freeze({ defaultMs: 120_000, maxMs: 600_000 }),
  approvedExecution: Object.freeze({ defaultMs: 300_000, maxMs: 900_000 }),
  approvedReview: Object.freeze({ defaultMs: 330_000, maxMs: 930_000 }),
  manager: Object.freeze({ defaultMs: 30_000, maxMs: 300_000 }),
});

function errorCause(cause) {
  if (!cause) {
    return undefined;
  }
  if (typeof cause === "string") {
    return { message: cause };
  }
  return {
    code: cause.code,
    message: cause.message || String(cause),
    layer: cause.layer,
    phase: cause.phase,
  };
}

export class OperationError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "OperationError";
    this.code = options.code || "OPERATION_FAILED";
    this.statusCode = options.statusCode || 500;
    this.operationId = options.operationId;
    this.layer = options.layer;
    this.phase = options.phase;
    this.retriable = Boolean(options.retriable);
    this.details = options.details;
    this.cause = errorCause(options.cause);
  }
}

export function operationError(message, options = {}) {
  return new OperationError(message, options);
}

export function normalizeTimeoutMs(value, policy) {
  if (value === undefined || value === null || value === "") {
    return policy.defaultMs;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw operationError("timeoutMs must be a positive integer", {
      code: "INVALID_OPERATION_TIMEOUT",
      statusCode: 400,
      layer: "operation",
      phase: "validation",
    });
  }
  return Math.min(parsed, policy.maxMs);
}

export function operationPolicy(pathName, config = {}) {
  if (pathName === "/run") {
    return {
      defaultMs: config.security?.defaultTimeoutMs || OPERATION_TIMEOUTS.run.defaultMs,
      maxMs: config.security?.maxTimeoutMs || OPERATION_TIMEOUTS.run.maxMs,
    };
  }
  if (
    pathName === "/read-file" ||
    pathName === "/list-dir" ||
    pathName === "/logs/list" ||
    pathName === "/logs/archive-members" ||
    pathName === "/logs/read"
  ) {
    return {
      defaultMs: config.security?.defaultFileTimeoutMs || OPERATION_TIMEOUTS.file.defaultMs,
      maxMs: config.security?.maxFileTimeoutMs || OPERATION_TIMEOUTS.file.maxMs,
    };
  }
  if (pathName === "/mongodb/query") {
    return {
      defaultMs: OPERATION_TIMEOUTS.mongodb.defaultMs,
      maxMs: OPERATION_TIMEOUTS.mongodb.maxMs,
    };
  }
  if (pathName.startsWith("/mongodb/mutations/")) {
    return {
      defaultMs: OPERATION_TIMEOUTS.mongodbMutation.defaultMs,
      maxMs: OPERATION_TIMEOUTS.mongodbMutation.maxMs,
    };
  }
  if (pathName === "/approved-command-drafts/execute") {
    return {
      defaultMs:
        config.approvedCommands?.executionTimeoutMs ||
        OPERATION_TIMEOUTS.approvedExecution.defaultMs,
      maxMs:
        config.approvedCommands?.maxExecutionTimeoutMs ||
        OPERATION_TIMEOUTS.approvedExecution.maxMs,
    };
  }
  if (pathName === "/approved-command-drafts/review") {
    const reviewTimeoutMs =
      config.commandReview?.reviewTimeoutMs ||
      OPERATION_TIMEOUTS.approvedReview.defaultMs - OPERATION_TIMEOUTS.approvedExecution.defaultMs;
    const executionDefaultMs =
      config.approvedCommands?.executionTimeoutMs ||
      OPERATION_TIMEOUTS.approvedExecution.defaultMs;
    const executionMaxMs =
      config.approvedCommands?.maxExecutionTimeoutMs ||
      OPERATION_TIMEOUTS.approvedExecution.maxMs;
    return {
      defaultMs: reviewTimeoutMs + executionDefaultMs,
      maxMs: reviewTimeoutMs + executionMaxMs,
    };
  }
  return OPERATION_TIMEOUTS.manager;
}

export function normalizeOperationEnvelope(payload = {}, policy, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const timeoutMs = normalizeTimeoutMs(payload.timeoutMs, policy);
  const suppliedDeadline = Number.parseInt(payload.deadlineAt, 10);
  const maximumDeadline = nowMs + policy.maxMs;
  const deadlineAt = Number.isInteger(suppliedDeadline)
    ? Math.min(suppliedDeadline, maximumDeadline)
    : nowMs + timeoutMs;
  const suppliedOperationId =
    typeof payload.operationId === "string" ? payload.operationId.trim() : "";
  const operationId = suppliedOperationId.slice(0, 128) || randomUUID();

  return {
    operationId,
    timeoutMs,
    deadlineAt,
  };
}

export function remainingOperationMs(operation, nowMs = Date.now()) {
  return Math.max(0, Number(operation?.deadlineAt || 0) - nowMs);
}

export function assertOperationActive(operation, signal, options = {}) {
  if (signal?.aborted) {
    throw operationErrorForSignal(signal, operation, options);
  }
  if (remainingOperationMs(operation) <= 0) {
    throw operationError("operation deadline exceeded", {
      code: "OPERATION_DEADLINE_EXCEEDED",
      statusCode: 408,
      operationId: operation?.operationId,
      layer: options.layer || "operation",
      phase: options.phase || "deadline",
      retriable: false,
    });
  }
}

export function operationErrorForSignal(signal, operation, options = {}) {
  const reason = signal?.reason;
  if (reason?.code === "OPERATION_DEADLINE_EXCEEDED") {
    return reason;
  }
  if (reason?.code === "OPERATION_CANCELLED") {
    return reason;
  }
  return operationError(reason?.message || "operation cancelled", {
    code: "OPERATION_CANCELLED",
    statusCode: 499,
    operationId: operation?.operationId,
    layer: options.layer || "operation",
    phase: options.phase || "cancel",
    retriable: false,
    cause: reason,
  });
}

export function createOperationController(operation, parentSignal, options = {}) {
  const controller = new AbortController();
  const layer = options.layer || "operation";
  const abortFromParent = () => {
    if (!controller.signal.aborted) {
      controller.abort(operationErrorForSignal(parentSignal, operation, {
        layer,
        phase: options.cancelPhase || "upstream-cancel",
      }));
    }
  };

  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }

  const remainingMs = remainingOperationMs(operation);
  const deadlineTimer = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(operationError("operation deadline exceeded", {
        code: "OPERATION_DEADLINE_EXCEEDED",
        statusCode: 408,
        operationId: operation.operationId,
        layer,
        phase: options.deadlinePhase || "deadline",
        retriable: false,
      }));
    }
  }, remainingMs);
  deadlineTimer.unref?.();

  return {
    controller,
    signal: controller.signal,
    cleanup() {
      clearTimeout(deadlineTimer);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

export function operationErrorPayload(error, fallback = {}) {
  return {
    code: error?.code || fallback.code || "REMOTE_DEBUG_ERROR",
    message: error?.message || fallback.message || "remote debug operation failed",
    operationId: error?.operationId || fallback.operationId,
    layer: error?.layer || fallback.layer,
    phase: error?.phase || fallback.phase,
    retriable: Boolean(error?.retriable),
    cause: error?.cause,
  };
}
