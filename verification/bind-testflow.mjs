// Bind only actual, hash-verified TestFlow assets to this versioned unit
// contract. This creates input metadata, never test results or coverage.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [assetsFile, output] = process.argv.slice(2);
if (!assetsFile || !output) throw Error('Usage: bind-testflow.mjs <test-assets.json> <bindings.json>');
function read(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (doc.storage !== 'testflow-shards-v1') return doc;
  const result = { ...doc.value };
  for (const [key, parts] of Object.entries(doc.arrays || {})) result[key] = parts.flatMap(part => {
    const filePath = path.resolve(path.dirname(file), part.file);
    if (!filePath.startsWith(path.dirname(path.resolve(file)) + path.sep)) throw Error('Unsafe asset shard');
    const bytes = fs.readFileSync(filePath); if (digest(bytes) !== part.hash) throw Error('Asset shard drift');
    const value = JSON.parse(bytes); return part.single ? [value.value ?? value] : value.items;
  });
  return result;
}
const inventory = read(path.resolve(assetsFile));
const ref = file => { const bytes = fs.readFileSync(path.join(root, file)); return { file, fileHash: digest(bytes), start: 0, end: bytes.toString('utf8').length }; };
const selections = ['verification/import-safety.test.js', 'verification/import-execution.test.js'].map(file => {
  const asset = inventory.assets.find(a => a.file === file && a.kind === 'test-file' && !a.disabled), input = ref(file);
  if (!asset || asset.fileHash !== input.fileHash || !asset.assertionIds.length) throw Error('Fixed unit asset/actual assertions missing or drifted');
  return { assetId: asset.id, assetFileHash: asset.fileHash, inputRefs: [input], stateRefs: [ref('agent/test/helpers/import-risk-fixture.js'), ref('agent/test/helpers/import-fixture.js')], assertionIds: asset.assertionIds };
});
const bindings = { schemaVersion: 1, projectId: 'ssl-debug-agent', basis: 'codex-source-review', reviewRef: 'verification/README.md: Import execution verification contract v2',
  unit: { isolation: 'file-process-no-services', contractVersion: 'import-execution-v2' }, selections };
fs.writeFileSync(output, JSON.stringify(bindings, null, 2) + '\n', { flag: 'wx' });
