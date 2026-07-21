import {
  assertOperationActive,
  operationError,
  operationErrorForSignal,
  remainingOperationMs,
} from "./operation.js";

const BACKGROUND_PRIORITIES = new Set(["background", "bulk"]);

function queuedCountByPriority(queue) {
  const result = { control: 0, interactive: 0, background: 0, bulk: 0 };
  for (const item of queue) {
    result[item.priority] = (result[item.priority] || 0) + 1;
  }
  return result;
}

export class ChannelScheduler {
  constructor(options = {}) {
    this.maxBusiness = options.maxBusiness || 4;
    this.maxControl = options.maxControl || 1;
    this.maxBackground = options.maxBackground || 1;
    this.maxQueue = options.maxQueue || 100;
    this.backgroundStarvationMs = options.backgroundStarvationMs || 10_000;
    this.now = options.now || (() => Date.now());
    this.queue = [];
    this.activeBusiness = 0;
    this.activeControl = 0;
    this.activeBackground = 0;
    this.activeOperations = new Map();
    this.closed = false;
  }

  schedule(operation, task, options = {}) {
    const priority = options.priority || "interactive";
    assertOperationActive(operation, operation.signal, {
      layer: "scheduler",
      phase: "enqueue",
    });
    if (this.closed) {
      return Promise.reject(operationError("SSH operation scheduler is closed", {
        code: "OPERATION_CANCELLED",
        statusCode: 499,
        operationId: operation.operationId,
        layer: "scheduler",
        phase: "enqueue",
      }));
    }
    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(operationError("SSH operation queue is full", {
        code: "OPERATION_QUEUE_FULL",
        statusCode: 503,
        operationId: operation.operationId,
        layer: "scheduler",
        phase: "enqueue",
        retriable: true,
      }));
    }

    return new Promise((resolve, reject) => {
      const item = {
        operation,
        task,
        priority,
        enqueuedAt: this.now(),
        resolve,
        reject,
        started: false,
        timer: null,
        onAbort: null,
      };
      item.onAbort = () => {
        if (item.started) {
          return;
        }
        this.removeQueuedItem(item);
        reject(operationErrorForSignal(operation.signal, operation, {
          layer: "scheduler",
          phase: "queue",
        }));
        this.pump();
      };
      operation.signal?.addEventListener("abort", item.onAbort, { once: true });
      item.timer = setTimeout(() => {
        if (item.started) {
          return;
        }
        this.removeQueuedItem(item);
        reject(operationError("operation deadline exceeded while waiting for an SSH channel", {
          code: "OPERATION_DEADLINE_EXCEEDED",
          statusCode: 408,
          operationId: operation.operationId,
          layer: "scheduler",
          phase: "queue",
        }));
        this.pump();
      }, remainingOperationMs(operation, this.now()));
      item.timer.unref?.();
      this.queue.push(item);
      this.pump();
    });
  }

  removeQueuedItem(item) {
    const index = this.queue.indexOf(item);
    if (index !== -1) {
      this.queue.splice(index, 1);
    }
    clearTimeout(item.timer);
    item.operation.signal?.removeEventListener("abort", item.onAbort);
  }

  canStart(item) {
    if (item.priority === "control") {
      return this.activeControl < this.maxControl;
    }
    if (this.activeBusiness >= this.maxBusiness) {
      return false;
    }
    if (BACKGROUND_PRIORITIES.has(item.priority)) {
      return this.activeBackground < this.maxBackground;
    }
    return true;
  }

  nextItem() {
    const nowMs = this.now();
    const control = this.queue.find((item) => item.priority === "control" && this.canStart(item));
    if (control) {
      return control;
    }

    const starvedBackground = this.queue.find(
      (item) =>
        BACKGROUND_PRIORITIES.has(item.priority) &&
        nowMs - item.enqueuedAt >= this.backgroundStarvationMs &&
        this.canStart(item),
    );
    if (starvedBackground) {
      return starvedBackground;
    }

    const interactive = this.queue.find(
      (item) => item.priority === "interactive" && this.canStart(item),
    );
    if (interactive) {
      return interactive;
    }

    return this.queue.find((item) => this.canStart(item));
  }

  pump() {
    if (this.closed) {
      return;
    }
    while (true) {
      const item = this.nextItem();
      if (!item) {
        return;
      }
      this.removeQueuedItem(item);
      this.startItem(item);
    }
  }

  startItem(item) {
    item.started = true;
    const background = BACKGROUND_PRIORITIES.has(item.priority);
    if (item.priority === "control") {
      this.activeControl += 1;
    } else {
      this.activeBusiness += 1;
      if (background) {
        this.activeBackground += 1;
      }
    }
    const queueMs = Math.max(0, this.now() - item.enqueuedAt);
    this.activeOperations.set(item.operation.operationId, {
      priority: item.priority,
      startedAt: this.now(),
      deadlineAt: item.operation.deadlineAt,
    });

    Promise.resolve()
      .then(() => {
        assertOperationActive(item.operation, item.operation.signal, {
          layer: "scheduler",
          phase: "start",
        });
        return item.task({ queueMs, priority: item.priority });
      })
      .then(item.resolve, item.reject)
      .finally(() => {
        this.activeOperations.delete(item.operation.operationId);
        if (item.priority === "control") {
          this.activeControl -= 1;
        } else {
          this.activeBusiness -= 1;
          if (background) {
            this.activeBackground -= 1;
          }
        }
        this.pump();
      });
  }

  close(reason = "scheduler closed") {
    this.closed = true;
    const queued = this.queue.splice(0);
    for (const item of queued) {
      clearTimeout(item.timer);
      item.operation.signal?.removeEventListener("abort", item.onAbort);
      item.reject(operationError(reason, {
        code: "OPERATION_CANCELLED",
        statusCode: 499,
        operationId: item.operation.operationId,
        layer: "scheduler",
        phase: "shutdown",
      }));
    }
  }

  snapshot() {
    return {
      active: this.activeOperations.size,
      activeBusiness: this.activeBusiness,
      activeControl: this.activeControl,
      activeBackground: this.activeBackground,
      queued: this.queue.length,
      queuedByPriority: queuedCountByPriority(this.queue),
      maxBusiness: this.maxBusiness,
      maxControl: this.maxControl,
      maxBackground: this.maxBackground,
      maxQueue: this.maxQueue,
    };
  }
}
