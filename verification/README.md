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

## Import execution verification contract v2

`import-execution.test.js` adds actual Jest cases for server/collection
preconditions, UUID replacement rejection, explicit collection creation,
permission/concurrent-namespace rejection, safe abort and next same-intent
attempt, full evidence preservation, duplicate/network/write-concern diagnostics,
unknown abort/commit, legacy protection, exact preflight rejection continuation,
rollback and late claim/reconcile races. Four child-process SIGKILL scenarios
use actual disposable files; filesystem faults inject before rename. Child
MongoDB is still a synthetic transactional double: process/filesystem facts do
not establish Mongo commit durability. Neither missing files nor stale locks
are used as recovery proof. Both files are selected by bind-testflow.mjs; the
pilot uses a case pattern and the complete regression executes both files.

`agent/test/import-execution-mongo.e2e.mjs` is separate supplemental native
integration against an explicitly named disposable internal Docker fixture.
It reports the actual server build and configured driver's version, demonstrates
the old implicit-collection transaction behavior, then checks explicit empty
collection creation, a real unique-key server rejection/abort, exact next
attempt, idempotency and rollback. It is not formal TestFlow unit evidence.
Installed TestFlow's non-src coverage collection limitation remains unchanged.


## Independent execution risk contract v1

`execution-risk.test.js` exercises the actual protected store and serialized
fixed helper with disposable synthetic data, including .2 unknown execution,
legacy missing UUID, separate native-authority boundary, single child inside the
same import, immutable original preservation, lost replies/restart, expiry,
UUID drift, exact separate business confirmation and new-unknown replay denial.
The native suites additionally run independent administrator HTTP authentication,
real Manager/Worker HTTP and public MCP process, actual temporary filesystem
faults and browser UI. Native owner verification and Mongo/SSH remain explicit
doubles there. TestFlow unit results do not claim those native HTTP/browser
cases or real Mongo integration. Strict coverage for non-src roots remains a
known collector gap, reported separately from executed Jest assertions.

## Read-only import recovery contract v1

`import-recovery.test.js` uses disposable encrypted SQLite stores and the existing
synthetic remote helper. It verifies exact original context/target/operation/
import/digest binding, original prepared receipts and remote lost-reply recovery,
existing rejection evidence and archived attempts, unknown/no-intent/legacy
records, forbidden caller proof, bounded/ambiguous lookup, and unchanged SQLite
rows, links and pins. No real EJPOH input, live privacy database, SSH, business
MongoDB or installed plugin cache is used. The same TestFlow `jest-unit` network
isolation and exact-lock dependency image apply. Passed assertions do not prove
coverage of non-src source roots or real-world historical recovery outcomes.

## Missing intent independent risk contract v1

`orphan-risk.test.js` covers a separate `human-orphan-import-risk-v1` protocol
for records with no usable historical intent/receipt. Disposable encrypted SQLite
and the synthetic fixed Mongo helper verify exact original operation/import,
ordered input digest, explicit test-server/yennefer target and exact documents;
fresh approval expiry, immutable candidate, single consumption, restart, late
history, transactional faults, unknown replies, closed ordinary admissions,
reviewed batch identity, and separate execution/rollback confirmation. It never
claims that an unavailable receipt proves non-dispatch. Historical operation rows
are compared byte for byte, and no original intent or receipt is manufactured.

The independent administrator HTTP/native-verification boundary is exercised by
`plugins/remote-debug-agent/test/orphan-risk.test.js` in a separate disposable
network-none container, using actual public MCP and source/bundled Manager.
Its OS verification and Mongo/SSH are explicit doubles. Formal TestFlow unit
results remain separate from these HTTP/MCP/browser checks. Source coverage for
non-src roots remains a collector limitation; assertion success is not full
branch/path coverage. No live historical records or actual nine-item input is
part of these synthetic fixtures.

## Review input compatibility contract v2

`review-input.test.js` exercises a bounded inbound JSON validator independent of
output sanitization. Credential-shaped document fields and ordered original bytes
stay in encrypted review storage; output budgets and cross-document secret masking
remain enforced. Historical import identities up to 128 characters are review-only;
new preparation stays limited to 64 characters. The suite checks large input,
read/prepare idempotency, exact bounds, unsupported/getter/cycle rejection, output
withholding by digest and closed validation diagnostics. It uses synthetic data.
`plugins/remote-debug-agent/test/review-input.test.js` separately drives actual MCP,
Manager HTTP, protected worker, and independent administrator reads for five
synthetic shapes; it never dispatches prepare/execute/consume. Real business
objects in the existing production protection context are a separate acceptance
item; pure local validation and these tests do not establish their creation.
