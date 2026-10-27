import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildMongoMutationScript } from '../mongodb-mutations.js';
import { importRiskFixture } from './helpers/import-risk-fixture.js';

// Runs the production serialized remote helper in a separate Node process with
// real files/fsync/rename. Only the chosen fs operation is faulted; no MongoDB
// connection or owner authentication is involved in this control-only helper.
function execute(script, fault) {
  const prelude = `const fs = require('fs'), p = require('path');
const fault = ${JSON.stringify(fault || {})}; let hit = false; const descriptors = new Map();
const open = fs.openSync; fs.openSync = function(file,...args) { const fd = open.call(this,file,...args); descriptors.set(fd,String(file)); return fd; };
const rename = fs.renameSync; fs.renameSync = function(from,to) {
  if (!hit && p.basename(to) === fault.file && fault.when === 'before-rename') { hit = true; if(fault.kill)process.kill(process.pid,'SIGKILL'); throw Object.assign(Error('injected filesystem interruption'),{code:'EIO'}); }
  const result = rename.call(this,from,to);
  if (!hit && p.basename(to) === fault.file && fault.when === 'after-rename') { hit = true; if(fault.kill)process.kill(process.pid,'SIGKILL'); throw Object.assign(Error('injected filesystem interruption'),{code:'EIO'}); }
  return result;
};
const sync = fs.fsyncSync; fs.fsyncSync = function(fd) {
  if (!hit && fault.when === 'parent-sync' && descriptors.get(fd) === fault.directory) { hit=true; throw Object.assign(Error('injected directory sync failure'),{code:'EIO'}); }
  return sync.call(this,fd);
};\n`;
  return spawnSync(process.execPath, ['--input-type=commonjs'], { input: prelude + script, encoding: 'utf8', timeout: 20000 });
}
const controlFiles = root => fs.readdirSync(root, { recursive: true }).filter(n => n.endsWith('.json')).sort();
for (const fault of [
  { file: 'retirement.json', when: 'before-rename' },
  { file: 'retirement.json', when: 'after-rename' },
  { file: 'import-retirement.json', when: 'after-rename' },
  { file: 'lineage.json', when: 'after-rename' },
  { file: 'import-lineage.json', when: 'after-rename' },
  { when: 'parent-sync' },
]) test(`remote control I/O interruption ${fault.file || 'parent'} ${fault.when} is exact-retryable and preserves closure`, async t => {
  fs.mkdirSync('/tmp/remote-debug-agent', { recursive: true });
  const root = fs.mkdtempSync('/tmp/remote-debug-agent/import-control-fault-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = importRiskFixture(t), p = f.approve(await f.prepare());
  const handoff = f.call('risk_handoff_context', { riskPlanId: p.riskPlanId, reviewHash: p.reviewHash });
  const request = { mode: 'import_retire', ...handoff.request };
  const script = buildMongoMutationScript(request, { ...f.instance.mongodb, rollbackRoot: root });
  const failed = execute(script, { ...fault, directory: root });
  assert.equal(failed.status, 1); assert.match(failed.stdout, /EIO/);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='operation'").get().n, 1);
  const before = new Map(controlFiles(root).map(file => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
  const retry = execute(script); assert.equal(retry.status, 0, retry.stderr); assert.match(retry.stdout, /terminated_unknown/);
  for (const [file, body] of before) assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), body);
  assert.equal(controlFiles(root).length, 6);
  const different = buildMongoMutationScript({ ...request, replacementImportId: 'competing-import' }, { ...f.instance.mongodb, rollbackRoot: root });
  assert.match(execute(different).stdout, /MONGODB_IMPORT_RETIREMENT_CONFLICT/);
  assert.equal(f.h.state.insert, 0);
});
for (const file of ['retirement.json', 'lineage.json', 'import-lineage.json']) test(`remote SIGKILL after ${file} retains files and lock; no age-based unlock or replacement`, async t => {
  fs.mkdirSync('/tmp/remote-debug-agent', { recursive: true });
  const root = fs.mkdtempSync('/tmp/remote-debug-agent/import-control-kill-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = importRiskFixture(t), p = f.approve(await f.prepare());
  const handoff = f.call('risk_handoff_context', { riskPlanId: p.riskPlanId, reviewHash: p.reviewHash });
  const script = buildMongoMutationScript({ mode: 'import_retire', ...handoff.request }, { ...f.instance.mongodb, rollbackRoot: root });
  const killed = execute(script, { file, when: 'after-rename', kill: true }); assert.equal(killed.signal, 'SIGKILL');
  const saved = new Map(controlFiles(root).map(name => [name, fs.readFileSync(path.join(root, name), 'utf8')]));
  const lock = path.join(root, 'import-control-lock', '.lock'); fs.utimesSync(lock, new Date(0), new Date(0));
  const retry = execute(script); assert.equal(retry.status, 1); assert.match(retry.stdout, /MONGODB_MUTATION_BUSY/);
  for (const [name, body] of saved) assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), body);
  assert.equal(f.h.state.insert, 0);
});
