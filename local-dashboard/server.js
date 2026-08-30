"use strict";

// The dashboard is intentionally a thin local control plane. The worker,
// account database, browser sessions and secrets stay on the VPS Control API.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { ControlApiClient } = require("./lib/apiClient");

const PORT = Number(process.env.PORT || 8890);
const CONTROL_API_URL = process.env.CONTROL_API_URL || "http://127.0.0.1:3010";
const CONTROL_API_TOKEN = process.env.CONTROL_API_TOKEN || "";
const DASHBOARD_USERNAME = process.env.DASHBOARD_USERNAME || "";
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "";
const DASHBOARD_AUTH_ENABLED = Boolean(DASHBOARD_USERNAME && DASHBOARD_PASSWORD);
const PUBLIC_DIR = path.resolve(__dirname, "public");
const client = new ControlApiClient({
  baseUrl: CONTROL_API_URL,
  token: CONTROL_API_TOKEN,
});

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function log(message) {
  console.log(`[account-dashboard] ${message}`);
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
  });
  res.end(data);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requestBasicCredentials(req) {
  const value = req.headers.authorization;
  if (typeof value !== "string") return null;
  const match = value.match(/^Basic\s+(.+)$/i);
  if (!match) return null;
  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

function isAuthorized(req) {
  if (!DASHBOARD_AUTH_ENABLED) return true;
  const credentials = requestBasicCredentials(req);
  return Boolean(
    credentials &&
      safeEqual(credentials.username, DASHBOARD_USERNAME) &&
      safeEqual(credentials.password, DASHBOARD_PASSWORD),
  );
}

function requireAuth(res) {
  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="Account Dashboard", charset="UTF-8"',
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end("Authentication required");
}

function readJsonBody(req, limitBytes = 5_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

async function forward(res, method, apiPath, body) {
  try {
    const data = await client.request(method, apiPath, { body });
    return sendJson(res, 200, data || {});
  } catch (error) {
    const status = error.statusCode || 502;
    const payload =
      error.body && typeof error.body === "object"
        ? { ...error.body }
        : { error: error.message || "VPS Control API unreachable" };
    if (status === 401) {
      payload.hint = "CONTROL_API_TOKEN must match the VPS API_TOKEN.";
    }
    return sendJson(res, status, payload);
  }
}

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method || "GET";

  if (pathname === "/api/health" && method === "GET") {
    try {
      const health = await client.get("/health");
      return sendJson(res, 200, {
        ok: true,
        reachable: true,
        controlApi: health,
        controlApiUrl: CONTROL_API_URL,
      });
    } catch (error) {
      return sendJson(res, error.statusCode || 502, {
        ok: false,
        reachable: false,
        controlApiUrl: CONTROL_API_URL,
        error: error.message,
      });
    }
  }

  if (pathname === "/api/accounts" && method === "GET") {
    return forward(res, "GET", "/accounts");
  }

  if (pathname === "/api/proxies" && method === "GET") {
    return forward(res, "GET", "/proxies");
  }

  if (pathname === "/api/proxies" && method === "POST") {
    return forward(res, "POST", "/proxies", await readJsonBody(req));
  }

  if (pathname === "/api/point-checks" && method === "GET") {
    return client
      .get("/accounts")
      .then(payload => sendJson(res, 200, {
        accounts: (payload.accounts || []).map(account => ({
          id: account.id,
          email: account.email,
          lastCheck: account.pointCheck || null
        }))
      }))
      .catch(error => sendJson(res, error.statusCode || 502, { error: error.message }));
  }

  if (pathname === "/api/point-checks" && method === "POST") {
    try {
      const body = await readJsonBody(req);
      const accountId = String(body?.accountId || "").trim();
      if (!accountId) return sendJson(res, 400, { error: "accountId is required." });
      const payload = await client.get("/accounts");
      const account = (payload.accounts || []).find(item => String(item.id) === accountId);
      if (!account) return sendJson(res, 404, { error: "Account is not available on the VPS." });
      return sendJson(
        res,
        200,
        await client.request("POST", `/accounts/${encodeURIComponent(account.email)}/points-check`, {
          body: {},
          timeoutMs: 900000,
        }),
      );
    } catch (error) {
      return sendJson(res, error.statusCode || 502, error.body || { error: error.message });
    }
  }

  if (pathname === "/api/accounts/import" && method === "POST") {
    return forward(res, "POST", "/accounts/import", await readJsonBody(req));
  }

  const proxyMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/proxy$/);
  if (proxyMatch && method === "PATCH") {
    return forward(
      res,
      "PATCH",
      `/accounts/${proxyMatch[1]}/proxy`,
      await readJsonBody(req),
    );
  }

  const statusMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/status$/);
  if (statusMatch && method === "PATCH") {
    return forward(
      res,
      "PATCH",
      `/accounts/${statusMatch[1]}/status`,
      await readJsonBody(req),
    );
  }

  if (pathname === "/api/accounts" && method === "DELETE") {
    return forward(res, "DELETE", "/accounts", await readJsonBody(req));
  }

  const proxyStatusMatch = pathname.match(/^\/api\/proxies\/([^/]+)\/status$/);
  if (proxyStatusMatch && method === "PATCH") {
    return forward(res, "PATCH", `/proxies/${proxyStatusMatch[1]}/status`, await readJsonBody(req));
  }

  const proxyDeleteMatch = pathname.match(/^\/api\/proxies\/([^/]+)$/);
  if (proxyDeleteMatch && method === "DELETE") {
    return forward(res, "DELETE", `/proxies/${proxyDeleteMatch[1]}`);
  }

  const accountMatch = pathname.match(/^\/api\/accounts\/([^/]+)$/);
  if (accountMatch && method === "DELETE") {
    return forward(res, "DELETE", `/accounts/${accountMatch[1]}`);
  }

  if (pathname === "/api/logs" && method === "GET") {
    return forward(res, "GET", "/logs?limit=100");
  }

  const controlMatch = pathname.match(/^\/api\/control\/(start|stop|restart)$/);
  if (controlMatch && method === "POST") {
    return forward(
      res,
      "POST",
      `/${controlMatch[1]}`,
      await readJsonBody(req),
    );
  }

  return sendJson(res, 404, { error: "Not found", path: pathname });
}

function serveStatic(res, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(PUBLIC_DIR, `.${requested}`);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    return sendJson(res, 403, { error: "Forbidden" });
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Not found");
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (!isAuthorized(req)) return requireAuth(res);
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    return handleApi(req, res, url).catch((error) => {
      log(`request failed: ${error.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: error.message });
    });
  }
  return serveStatic(res, url.pathname);
});

const HOST = process.env.HOST || "0.0.0.0";

server.listen(PORT, HOST, () => {
  log(`listening at http://${HOST}:${PORT}`);
  log(`VPS Control API: ${CONTROL_API_URL}${CONTROL_API_TOKEN ? " (token set)" : " (token missing)"}`);
  if (!CONTROL_API_TOKEN) log("warning: CONTROL_API_TOKEN is empty");
  if (!DASHBOARD_AUTH_ENABLED) log("warning: browser login is disabled");
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
