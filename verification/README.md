# Import safety verification contract v1

This directory adds genuine Jest unit cases for the installed TestFlow
`jest-unit` executor. It does not execute node:test inside Jest, fabricate
receipts, modify TestFlow, or replace the existing native regression suite.
The repository root package/lock describe verification dependencies only;
`agent/package.json` remains the application package.

`import-safety.test.js` checks unclaimed-attempt fencing and same-intent retry,
unknown dispatched attempts, Manager/worker policy mismatch before transport,
and human-approved import lineage, per-batch confirmation, idempotency and
rollback. `transform.cjs` only converts ESM modules to CommonJS with original
source maps; Jest instruments and executes the actual application modules.
The synthetic MongoDB VM is a double. OS identity verification, real SSH,
real MongoDB and deployed behavior are not proven by these unit cases.
The candidate request is JSON-normalized at the Jest boundary because Node's
host-realm structuredClone is intentionally rejected by the plain-object
output guard inside Jest's VM. Production guard policy is unchanged.

Use the installed TestFlow skill. Keep its workspace and generated bindings
outside the repository. Configure this project as `library` / `jest-unit`,
`unit.compile=none`, `jestConfig=verification/jest.config.cjs`,
`lockFile=package-lock.json`, and test roots `verification`, `agent`,
`plugins/remote-debug-agent`. Require exact-lock and a complete immutable
Node 22 dependency image. Build it with TestFlow build_dependencies from the
frozen root package/lock. No install scripts are needed.

Freeze uncommitted source and analyze. Select the exported `privacyRequest`
and `workerConfigFingerprint` entry IDs, with explicit change IDs for
`importPrepareRequest`, `WorkerManager.callInstance` and `PrivacyStore.execute`,
then graph and plan. Class methods and private functions are not accepted as
entry candidates by the installed scope tool. Generate bindings from that plan's actual test asset
inventory with `node verification/bind-testflow.mjs <test-assets.json>
<bindings.json>`. Review the generated fixed hashes and source ranges before
prepare. Prepare/execute a pilot, then separately prepare/execute the complete
four-case file. Read job evidence and target coverage independently. Re-freeze
and rebind if source changes. Never describe this unit suite as API/SSH/browser
or deployment acceptance, nor as full node:test execution support.

The native `agent/test/import-prepare-safety.test.js` adds independent SQLite
process races and SIGKILL boundaries. `import-control-fault.test.js` runs the
serialized remote helper with real temporary files/fsync/rename in separate
processes, injecting I/O errors or SIGKILL without any database connection.
A dead helper's unreclaimed exclusive lock remains a documented safety stop;
it is not automatically removed based on age or missing replies.

The installed execution collector currently filters coverage targets with a
hard-coded `src/` prefix (`dist/execution/execute.js`). This repository uses
`agent/` and `plugins/`; accepted testRoots do not fix that collection filter.
Formal Jest test results can pass while all strict target coverage remains
`source-coverage-missing`. Do not move/copy source or invent counters to hide
this gap. Generalized coverage-root support and native node:test execution
require changes to TestFlow outside this repository.
