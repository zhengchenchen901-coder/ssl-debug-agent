import assert from "node:assert/strict";
import test from "node:test";
import { ChannelScheduler } from "../channel-scheduler.js";

function operation(id, timeoutMs = 10_000) {
  const controller = new AbortController();
  return {
    operationId: id,
    deadlineAt: Date.now() + timeoutMs,
    signal: controller.signal,
    controller,
  };
}

function deferredTask(started, id) {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return {
    task: async () => {
      started.push(id);
      await promise;
      return id;
    },
    release,
  };
}

const turn = () => new Promise((resolve) => setImmediate(resolve));

test("scheduler enforces four business permits and a separate control permit", async () => {
  const scheduler = new ChannelScheduler();
  const started = [];
  const tasks = Array.from({ length: 6 }, (_, index) => deferredTask(started, index));
  const promises = tasks.slice(0, 5).map((item, index) =>
    scheduler.schedule(operation(`business-${index}`), item.task));
  const controlPromise = scheduler.schedule(
    operation("control"),
    tasks[5].task,
    { priority: "control" },
  );

  await turn();
  assert.equal(scheduler.snapshot().activeBusiness, 4);
  assert.equal(scheduler.snapshot().activeControl, 1);
  assert.equal(scheduler.snapshot().queued, 1);

  tasks[0].release();
  await promises[0];
  await turn();
  assert.ok(started.includes(4));

  for (const task of tasks.slice(1)) task.release();
  await Promise.all([...promises.slice(1), controlPromise]);
  assert.equal(scheduler.snapshot().active, 0);
});

test("scheduler preserves FIFO and gives a starved background request one opportunity", async () => {
  let nowMs = Date.now();
  const scheduler = new ChannelScheduler({
    maxBusiness: 1,
    maxBackground: 1,
    backgroundStarvationMs: 10_000,
    now: () => nowMs,
  });
  const started = [];
  const blocker = deferredTask(started, "blocker");
  const background = deferredTask(started, "background");
  const firstInteractive = deferredTask(started, "interactive-1");
  const secondInteractive = deferredTask(started, "interactive-2");

  const blockerPromise = scheduler.schedule(operation("blocker"), blocker.task);
  const backgroundPromise = scheduler.schedule(
    operation("background"),
    background.task,
    { priority: "background" },
  );
  const firstPromise = scheduler.schedule(operation("interactive-1"), firstInteractive.task);
  const secondPromise = scheduler.schedule(operation("interactive-2"), secondInteractive.task);
  await turn();

  nowMs += 10_001;
  blocker.release();
  await blockerPromise;
  await turn();
  assert.deepEqual(started.slice(0, 2), ["blocker", "background"]);

  background.release();
  await backgroundPromise;
  await turn();
  assert.equal(started[2], "interactive-1");
  firstInteractive.release();
  await firstPromise;
  await turn();
  assert.equal(started[3], "interactive-2");
  secondInteractive.release();
  await secondPromise;
});

test("scheduler rejects queue overflow and removes cancelled queued operations", async () => {
  const scheduler = new ChannelScheduler({ maxBusiness: 1, maxQueue: 1 });
  const started = [];
  const blocker = deferredTask(started, "blocker");
  const queued = operation("queued");
  const blockerPromise = scheduler.schedule(operation("blocker"), blocker.task);
  const queuedPromise = scheduler.schedule(queued, async () => "queued");

  await assert.rejects(
    scheduler.schedule(operation("overflow"), async () => "overflow"),
    (error) => error.code === "OPERATION_QUEUE_FULL",
  );
  queued.controller.abort(new Error("cancelled"));
  await assert.rejects(queuedPromise, (error) => error.code === "OPERATION_CANCELLED");
  assert.equal(scheduler.snapshot().queued, 0);

  blocker.release();
  await blockerPromise;
});
