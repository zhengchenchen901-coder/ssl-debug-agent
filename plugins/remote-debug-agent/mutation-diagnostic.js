// Closed diagnostic vocabulary. Never copy errmsg, document keys, credentials,
// arbitrary object fields, error labels or stack traces from the driver.
export function mutationDiagnostic(input) {
  if (!input || typeof input !== 'object') return undefined;
  const phases = ['validation', 'connect', 'transaction_preflight', 'collection_preflight', 'collection_create', 'transaction_start', 'transaction_write', 'transaction_rollback', 'transaction_commit', 'transaction_abort'];
  const categories = ['write_concern', 'permission', 'duplicate_key', 'namespace', 'transaction_support', 'network', 'server', 'client_or_control'];
  return { phase: phases.includes(input.phase) ? input.phase : 'unknown', category: categories.includes(input.category) ? input.category : 'unknown',
    ...(['EACCES', 'EPERM', 'EIO', 'EROFS', 'ENOSPC', 'ELOOP', 'EINVAL', 'EMFILE', 'ENFILE', 'ENOTDIR'].includes(input.filesystemCode) ? { filesystemCode: input.filesystemCode } : {}),
    ...(Number.isSafeInteger(input.databaseCode) && input.databaseCode >= 0 && input.databaseCode <= 2147483647 ? { databaseCode: input.databaseCode } : {}),
    ...(Number.isSafeInteger(input.serverMaxWireVersion) && input.serverMaxWireVersion >= 0 && input.serverMaxWireVersion <= 10000 ? { serverMaxWireVersion: input.serverMaxWireVersion } : {}),
    ...(typeof input.driverVersion === 'string' && /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/.test(input.driverVersion) ? { driverVersion: input.driverVersion } : {}),
  };
}
