import { createHash } from "node:crypto";
import { loadPrivacyKey } from "../../privacy-key.js";
process.once("message", ({ directory }) => {
  try {
    const key = loadPrivacyKey(directory);
    const digest = createHash("sha256").update(key).digest("hex"); key.fill(0);
    process.send({ ok: true, digest });
  } catch (error) { process.send({ ok: false, code: error.code }); }
  process.disconnect();
});
