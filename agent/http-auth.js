import path from "node:path";
import localAuth from "../plugins/remote-debug-agent/local-auth.cjs";

const PUBLIC_ASSETS = new Set(["/", "/favicon.ico", "/dashboard.html", "/dashboard.css", "/dashboard.js", "/output-preview.js", "/environment-report.js", "/admin-registration.js"]);

export function publicHealth(request, token, identity) {
  const nonce = request.headers["x-remote-debug-challenge"];
  return {
    ...identity,
    ...(/^[a-f0-9]{64}$/.test(nonce || "") ? { authProof: localAuth.healthProof(token, nonce, new URL(`http://${request.headers.host}`).origin) } : {}),
  };
}

export function installHttpAuth(app, config, options = {}) {
  const dataDir = path.dirname(path.dirname(config.runtime?.statePath || path.join(process.cwd(), ".runtime", "agent-state.json")));
  const filePath = config.auth?.filePath || localAuth.resolveAuthFile(dataDir);
  const token = options.authToken || (options.initializeAuth ? localAuth.ensureAuthToken(filePath) : localAuth.readAuthToken(filePath));
  if (!/^[a-f0-9]{64}$/.test(token)) throw localAuth.authError("valid HTTP authentication credentials are required");
  // Kept out of public state, activity, registry and audit data.
  app.locals.authToken = token;
  app.use((request, response, next) => {
    response.set("Cache-Control", "no-store");
    response.set("X-Content-Type-Options", "nosniff");
    response.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const fail = (status, code, message) => response.status(status).json({ ok: false, error: { code, message, retriable: false } });
    const port = request.socket.localPort;
    const host = request.headers.host;
    const listener = config.agent.host || "127.0.0.1";
    const allowedHosts = [`${listener.includes(":") ? `[${listener}]` : listener}:${port}`, `127.0.0.1:${port}`, `localhost:${port}`];
    if (port === 80) allowedHosts.push(listener.includes(":") ? `[${listener}]` : listener, "127.0.0.1", "localhost");
    if (!allowedHosts.includes(host)) {
      return fail(403, "LOCAL_ORIGIN_REJECTED", "request Host does not match the local listener");
    }
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== new URL(`http://${host}`).origin) {
      return fail(403, "LOCAL_ORIGIN_REJECTED", "request Origin must match the local listener");
    }
    if ((request.method === "GET" || request.method === "HEAD") && (request.path === "/health" || PUBLIC_ASSETS.has(request.path))) return next();
    const header = request.headers.authorization;
    if (!header) return fail(401, "LOCAL_AUTH_REQUIRED", "local access token is required");
    if (!localAuth.tokenMatches(header.startsWith("Bearer ") ? header.slice(7) : "", token)) {
      return fail(401, "LOCAL_AUTH_INVALID", "local access token is invalid");
    }
    next();
  });
}
