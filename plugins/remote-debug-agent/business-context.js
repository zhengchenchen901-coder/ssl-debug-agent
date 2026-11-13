import path from "node:path";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export function contextFailure(code) {
  const messages = {
    BUSINESS_CONTEXT_SELECTION_REQUIRED: "Select the original context: set REMOTE_DEBUG_PRIVACY_CONTEXT_FILE to its protected file, or REMOTE_DEBUG_PRIVACY_CONTEXT_ID to its exact context ID, then restart this MCP. For a new task only, select a new file path explicitly. See docs/business-privacy-storage.md. No context was created or operation replayed.",
    BUSINESS_CONTEXT_CHANGED: "Context selection changed after attachment. Restart this MCP with the intended context selection before continuing the original task.",
    BUSINESS_CONTEXT_MISSING: "The selected original context file is missing. Restore that exact protected file or correct the selection, then restart this MCP. Do not create a replacement for an existing task.",
    BUSINESS_CONTEXT_DENIED: "Selected context is invalid, inaccessible, or belongs to another Manager origin. Check the original file, current-user permissions and original Manager origin; no replacement was created.",
  };
  return Object.assign(new Error(messages[code] || messages.BUSINESS_CONTEXT_DENIED), { code, retriable: false });
}

// The stdio MCP handshake has no trusted per-call chat identity. Do not infer
// one from cwd, clientInfo, or inherited CODEX_THREAD_ID/SESSION_ID variables.
export function selectContext(settings, paths = path) {
  const file = settings.env.REMOTE_DEBUG_PRIVACY_CONTEXT_FILE;
  if (file) return { filename: paths.resolve(file), existingOnly: false };
  const id = settings.env.REMOTE_DEBUG_PRIVACY_CONTEXT_ID;
  if (!id) throw contextFailure("BUSINESS_CONTEXT_SELECTION_REQUIRED");
  if (!uuid.test(id)) throw contextFailure("BUSINESS_CONTEXT_DENIED");
  return { filename: paths.resolve(settings.dataDir, ".private", "contexts", id + ".json"), existingOnly: true, expectedId: id };
}

export function validateContext(content, origin) {
  try {
    const saved = JSON.parse(content);
    if (saved.version !== 1 || saved.origin !== origin || !uuid.test(saved.auth?.contextId || "") || !/^[a-f0-9]{64}$/.test(saved.auth?.capability || "")) throw new Error();
    return saved.auth;
  } catch { throw contextFailure("BUSINESS_CONTEXT_DENIED"); }
}
