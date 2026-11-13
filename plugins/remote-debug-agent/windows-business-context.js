import fs from "node:fs";
import path from "node:path";
import windowsPrivacy from "./windows-privacy.cjs";
import { selectContext, validateContext, contextFailure } from "./business-context.js";

// FileShare.None serializes readers with a creator until its file has been
// flushed. CreateNew installs the private ACL before writing any capability.
export async function attachWindowsContext(settings, origin, createAuth) {
  const { filename, existingOnly, expectedId } = selectContext(settings);
  const directory = path.join(settings.dataDir, ".private", "contexts");
  windowsPrivacy.prepareContext(directory);
  const read = () => {
    const auth = validateContext(windowsPrivacy.readContext(filename), origin);
    if (expectedId && auth.contextId !== expectedId) throw contextFailure("BUSINESS_CONTEXT_DENIED");
    return auth;
  };
  if (fs.existsSync(filename)) return read();
  if (existingOnly) throw contextFailure("BUSINESS_CONTEXT_MISSING");
  const auth = await createAuth();
  const content = JSON.stringify({ version: 1, origin, auth });
  validateContext(content, origin);
  if (!windowsPrivacy.createContext(filename, content)) return read();
  return auth;
}
