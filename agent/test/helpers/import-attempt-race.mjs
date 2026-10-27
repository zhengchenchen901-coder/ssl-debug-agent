import { PrivacyStore } from '../../privacy-store.js';
let store, action, args;
process.on('message', input => {
  if (input === 'run') {
    try { const record = store.execute(action, args); process.send({ ok: true, state: record.state }); }
    catch (error) { process.send({ ok: false, code: error.code }); }
    store.close(); process.disconnect(); return;
  }
  ({ action, args } = input);
  store = new PrivacyStore({ directory: input.directory, key: Buffer.from(input.key, 'hex') });
  process.send({ ready: true });
});
