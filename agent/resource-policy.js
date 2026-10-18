export const RESOURCE_TERMINAL = new Set(["completed", "partial", "stopped", "failed", "cancelled", "interrupted", "expired"]);
export const RESOURCE_PROFILES = Object.freeze({
  control: { bulk: false, cpuMilliCores: 50, memoryBytes: 32 * 1048576 },
  diagnostic: { bulk: false, cpuMilliCores: 100, memoryBytes: 64 * 1048576 },
  file_read: { bulk: false, cpuMilliCores: 100, memoryBytes: 64 * 1048576 },
  mongo_read: { bulk: false, cpuMilliCores: 150, memoryBytes: 128 * 1048576 },
  mongo_write: { bulk: false, cpuMilliCores: 150, memoryBytes: 128 * 1048576 },
  discovery: { bulk: false, cpuMilliCores: 50, memoryBytes: 64 * 1048576 },
  log_search: { bulk: true, cpuMilliCores: 200, memoryBytes: 192 * 1048576 },
  mongo_bulk: { bulk: true, cpuMilliCores: 400, memoryBytes: 512 * 1048576 },
});
export const RESOURCE_DEFAULTS = Object.freeze({
  cpuMilliCores: 1000, protectedCpuMilliCores: 200, controlCpuMilliCores: 50,
  memoryBytes: 1024 * 1048576, protectedMemoryBytes: 256 * 1048576,
  readBytesPerSecond: 8 * 1048576, processBytesPerSecond: 16 * 1048576,
  transferBytesPerSecond: 4 * 1048576, protectedTransferBytesPerSecond: 2 * 1048576, controlTransferBytesPerSecond: 1048576,
  protectedReadBytesPerSecond: 1048576, protectedProcessBytesPerSecond: 1048576,
  sampleIntervalMs: 5000, sampleTtlMs: 20000, memoryHeadroomRatio: 0.1,
});
export function normalizeResourcePolicy(value) {
  if (value === undefined || value === "") return { ...RESOURCE_DEFAULTS, domains: {} };
  let input;
  try { input = typeof value === "string" ? JSON.parse(value) : value; } catch { throw new Error("invalid REMOTE_DEBUG_RESOURCE_POLICY"); }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid resource policy");
  for (const [key, number] of Object.entries(input)) {
    if (key === "domains") {
      if (!number || typeof number !== "object" || Array.isArray(number) || Object.entries(number).some(([id, domain]) => !/^[a-z][a-z0-9_-]{0,63}$/.test(id) || typeof domain !== "string" || !/^[a-zA-Z0-9._-]{1,128}$/.test(domain))) throw new Error("invalid resource domains");
    } else if (!Object.hasOwn(RESOURCE_DEFAULTS, key) || !Number.isFinite(number) || number <= 0 || (key !== "memoryHeadroomRatio" && !Number.isInteger(number))) throw new Error(`invalid resource policy: ${key}`);
  }
  const result = { ...RESOURCE_DEFAULTS, ...input, domains: input.domains || {} };
  if (result.cpuMilliCores > 64000 || result.protectedCpuMilliCores + result.controlCpuMilliCores >= result.cpuMilliCores
    || result.protectedMemoryBytes >= result.memoryBytes || result.memoryBytes > 64 * 1024 ** 3
    || result.protectedReadBytesPerSecond >= result.readBytesPerSecond || result.protectedProcessBytesPerSecond >= result.processBytesPerSecond
    || result.controlTransferBytesPerSecond >= result.protectedTransferBytesPerSecond || result.protectedTransferBytesPerSecond >= result.transferBytesPerSecond
    || result.sampleIntervalMs < 1000 || result.sampleIntervalMs > 60000 || result.sampleTtlMs < result.sampleIntervalMs * 2
    || result.sampleTtlMs > 120000 || result.memoryHeadroomRatio > 0.5) throw new Error("invalid resource policy capacity/reserves");
  return result;
}
