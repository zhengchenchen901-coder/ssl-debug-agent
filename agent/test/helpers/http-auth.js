export const TEST_AUTH_TOKEN = "a".repeat(64);
export const TEST_HOST_FINGERPRINT = "SHA256:" + "A".repeat(43);

export function fetch(url, options = {}) {
  return globalThis.fetch(url, { ...options, headers: { Authorization: `Bearer ${TEST_AUTH_TOKEN}`, ...options.headers } });
}
