import path from "node:path/posix";

export function normalizeLogProjects(value, allowedRoots, sourceRoots = {}) {
  if (typeof value === "string" && value) {
    try { value = JSON.parse(value); } catch { throw invalid("logProjects must be valid JSON"); }
  }
  const configured = value === undefined || value === null || value === "" ? {} : value;
  if (typeof configured !== "object" || Array.isArray(configured)) throw invalid("logProjects must be an object");
  if (Object.keys(configured).length > 20) throw invalid("at most 20 log projects are supported");
  const result = {};
  for (const [id, project] of Object.entries(configured)) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(id) || !project || typeof project !== "object") throw invalid("invalid log project");
    const directories = project.directories;
    if (!Array.isArray(directories) || !directories.length || directories.length > 8) throw invalid("each log project needs 1-8 directories");
    const normalize = (value) => {
      if (typeof value !== "string" || value.length > 4096 || !value.startsWith("/") || value.includes("\0")) throw invalid("log project paths must be absolute");
      const normalized = path.normalize(value).replace(/\/$/, "");
      if (!allowedRoots.some((root) => normalized === root || normalized.startsWith(`${root}/`))) throw invalid("log project path is outside approved roots");
      return normalized;
    };
    result[id] = {
      ...(project.root ? { root: normalize(project.root) } : {}),
      directories: [...new Set(directories.map(normalize))],
    };
  }
  for (const [id, root] of Object.entries(sourceRoots)) {
    if (!Object.hasOwn(result, id)) result[id] = { root, directories: [`${root}/logs`] };
  }
  return result;
}

function invalid(message) {
  const error = new Error(message);
  Object.assign(error, { code: "INVALID_LOG_PROJECTS", statusCode: 400 });
  return error;
}
