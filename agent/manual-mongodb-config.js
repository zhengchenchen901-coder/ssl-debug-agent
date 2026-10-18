import path from "node:path/posix";
import { manualError } from "./manual-auth.js";

// Separate from automatic business/sandbox connections; never copied to worker env.
export function normalizeManualMongo(value, existing) {
  if (value === undefined) return existing;
  if (value === null) return undefined;
  const fields = ["enabled", "configPath", "driverPath", "configProfile", "uriKey", "database", "mongoshPath", "nodePath"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !fields.includes(key))) {
    throw manualError("MANUAL_DB_CONFIG_INVALID", "人工数据库配置包含不支持的字段。");
  }
  const config = { enabled: false, configPath: "", driverPath: "", configProfile: "", uriKey: "url", database: "", mongoshPath: "mongosh", nodePath: "node", ...existing, ...value };
  if (typeof config.enabled !== "boolean") throw manualError("MANUAL_DB_CONFIG_INVALID", "启用状态无效。");
  for (const key of fields.slice(1)) {
    if (typeof config[key] !== "string" || config[key].length > (key.endsWith("Path") ? 4096 : 128) || /[\0\r\n]/.test(config[key])) {
      throw manualError("MANUAL_DB_CONFIG_INVALID", "人工数据库配置字段无效。");
    }
    config[key] = config[key].trim();
  }
  if (config.enabled) {
    for (const key of ["configPath", "driverPath"]) {
      if (!path.isAbsolute(config[key])) throw manualError("MANUAL_DB_CONFIG_INVALID", "配置与驱动需要远端绝对路径。");
    }
    for (const key of ["configProfile", "uriKey"]) {
      if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/.test(config[key]) || config[key].split(".").some((part) => ["__proto__", "constructor", "prototype"].includes(part))) {
        throw manualError("MANUAL_DB_CONFIG_INVALID", "请填写有效的配置分组及 URI 字段。");
      }
    }
    for (const key of ["nodePath", "mongoshPath"]) {
      if (!config[key] || (!path.isAbsolute(config[key]) && !/^[A-Za-z0-9_.-]+$/.test(config[key]))) throw manualError("MANUAL_DB_CONFIG_INVALID", "客户端需为命令名称或远端绝对路径。");
    }
  }
  return config;
}
