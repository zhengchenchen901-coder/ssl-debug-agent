import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import windowsPrivacy from "./windows-privacy.cjs";

function denied() {
  return Object.assign(new Error("Protected local context is invalid or inaccessible."), { code: "BUSINESS_CONTEXT_DENIED", retriable: false });
}
function validate(content, origin) {
  try {
    const saved = JSON.parse(content);
    if (saved.version !== 1 || saved.origin !== origin || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(saved.auth?.contextId || "") || !/^[a-f0-9]{64}$/.test(saved.auth?.capability || "")) throw denied();
    return saved.auth;
  } catch { throw denied(); }
}

// FileShare.None serializes readers with a creator until its file has been
// flushed. CreateNew installs the private ACL before writing any capability.
export async function attachWindowsContext(settings, origin, createAuth) {
  const directory = path.join(settings.dataDir, ".private", "contexts");
  windowsPrivacy.prepareContext(directory);
  const configured = settings.env.REMOTE_DEBUG_PRIVACY_CONTEXT_FILE;
  let filename = configured ? path.resolve(configured) : path.join(directory, randomUUID() + ".json");
  const read = () => validate(windowsPrivacy.readContext(filename), origin);
  if (fs.existsSync(filename)) return read();
  const auth = await createAuth();
  const content = JSON.stringify({ version: 1, origin, auth });
  validate(content, origin);
  if (!configured) filename = path.join(directory, auth.contextId + ".json");
  if (!windowsPrivacy.createContext(filename, content)) return read();
  return auth;
}
