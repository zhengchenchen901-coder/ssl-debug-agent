// Project-owned ESM -> CommonJS transform. Jest runs and instruments the real
// modules; no node:test subprocess or fabricated execution/coverage receipt.
const { transformSync, version } = require('esbuild');
const { createHash } = require('node:crypto');
module.exports = {
  getCacheKey(source, file, options) { return createHash('sha256').update(source).update(file).update(version).update(options.configString).update(String(options.instrument)).digest('hex'); },
  process(source, file) {
    const result = transformSync(source, { sourcefile: file, format: 'cjs', platform: 'node', target: 'node22', sourcemap: 'external', sourcesContent: true });
    return { code: result.code, map: JSON.parse(result.map) };
  },
};
