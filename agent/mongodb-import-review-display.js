import { createOutputGuard } from "../plugins/remote-debug-agent/output-guard.js";
import { prepareRequestDigest } from "../plugins/remote-debug-agent/prepare-protocol.js";

// Independent administrators see an output-safe projection. Original bytes and
// ordered digests stay in encrypted storage; a projection is never input proof.
export function importReviewDisplay(request) {
  let redacted = false, withheldDocuments = 0;
  const guard = createOutputGuard();
  const { documents: _documents, ...metadata } = request;
  try {
    // Learn across ALL documents before rendering the first. A secret stored in
    // a later document must also be hidden when echoed by an earlier document.
    guard.learnSecrets(metadata);
    for (const document of request.documents) guard.learnSecrets(document);
  } catch {
    return { orderedRequest: JSON.stringify({ displayUnavailable: true, requestDigest: prepareRequestDigest(request) }), redacted: true, withheldDocuments: request.documents.length };
  }
  const deadline = performance.now() + 1000;
  const documents = request.documents.map(document => {
    try {
      if (performance.now() > deadline) throw new Error("DISPLAY_BUDGET");
      const result = guard.sanitize(document);
      redacted ||= JSON.stringify(result.value) !== JSON.stringify(document);
      return result.value;
    } catch {
      redacted = true; withheldDocuments++;
      return { displayUnavailable: true, documentDigest: prepareRequestDigest({ document }) };
    }
  });
  const safe = guard.sanitize(metadata).value;
  redacted ||= JSON.stringify(safe) !== JSON.stringify(metadata);
  // Iterating the original field layout retains its order while replacing each
  // value with the safe projection. No original strings leave this function.
  return { orderedRequest: JSON.stringify(Object.fromEntries(Object.keys(request).map(key => [key, key === "documents" ? documents : safe[key]]))), redacted, withheldDocuments };
}
