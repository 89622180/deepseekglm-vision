import http from "node:http";
import { fileURLToPath } from "node:url";
import { loadConfig, isSupportedRouteMode } from "./config.js";
import { buildUpstreamRequest, decideRoute } from "./router.js";

const OPENAI_JSON_ENDPOINTS = new Set([
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/messages",
  "/v1/embeddings",
  "/v1/completions"
]);

function sendJson(res, statusCode, payload) {
  const data = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data)
  });
  res.end(data);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function responseHeadersFrom(upstreamHeaders) {
  const headers = {};
  upstreamHeaders.forEach((value, key) => {
    if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(key)) {
      headers[key] = value;
    }
  });
  return headers;
}

async function proxyJsonRequest(req, res, config, path) {
  const rawBody = await readRequestBody(req);
  let body;

  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    sendJson(res, 400, {
      error: {
        message: "Request body must be valid JSON.",
        type: "invalid_request_error"
      }
    });
    return;
  }

  let route;
  let upstream;
  try {
    route = decideRoute({ config, body, headers: new Headers(req.headers) });
    upstream = buildUpstreamRequest({
      originalPath: path.replace(/^\/v1\//, ""),
      body,
      headers: new Headers(req.headers),
      route
    });
  } catch (error) {
    sendJson(res, error.statusCode || 500, {
      error: {
        message: error.message,
        type: "middleware_config_error"
      }
    });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.upstreamTimeoutMs);

  try {
    const upstreamResponse = await fetch(upstream.url, {
      method: req.method,
      headers: upstream.headers,
      body: upstream.body,
      signal: controller.signal
    });

    res.writeHead(upstreamResponse.status, responseHeadersFrom(upstreamResponse.headers));
    if (upstreamResponse.body) {
      for await (const chunk of upstreamResponse.body) {
        res.write(chunk);
      }
    }
    res.end();
  } catch (error) {
    sendJson(res, 502, {
      error: {
        message: `Upstream request failed: ${error.message}`,
        type: "upstream_error"
      }
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function passthroughRequest(req, res, config, pathWithQuery) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.upstreamTimeoutMs);
  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.delete("content-length");
  headers.delete("connection");

  try {
    const upstreamPath = pathWithQuery.replace(/^\/v1\//, "");
    const upstreamResponse = await fetch(`${config.defaultBackendBaseUrl}/${upstreamPath}`, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : req,
      signal: controller.signal,
      duplex: "half"
    });
    res.writeHead(upstreamResponse.status, responseHeadersFrom(upstreamResponse.headers));
    if (upstreamResponse.body) {
      for await (const chunk of upstreamResponse.body) {
        res.write(chunk);
      }
    }
    res.end();
  } catch (error) {
    sendJson(res, 502, {
      error: {
        message: `Upstream request failed: ${error.message}`,
        type: "upstream_error"
      }
    });
  } finally {
    clearTimeout(timeout);
  }
}

export function createServer(config = loadConfig()) {
  if (!isSupportedRouteMode(config.routeMode)) {
    throw new Error(`Unsupported ROUTE_MODE: ${config.routeMode}`);
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const path = url.pathname;

    if (path === "/health") {
      sendJson(res, 200, { ok: true, routeMode: config.routeMode });
      return;
    }

    if (req.method === "POST" && OPENAI_JSON_ENDPOINTS.has(path)) {
      await proxyJsonRequest(req, res, config, path);
      return;
    }

    if (path.startsWith("/v1/")) {
      await passthroughRequest(req, res, config, `${path}${url.search}`);
      return;
    }

    sendJson(res, 404, {
      error: {
        message: "Not found.",
        type: "not_found"
      }
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const config = loadConfig();
  const server = createServer(config);
  server.listen(config.port, config.host, () => {
    console.log(`deepseekglm-vision listening on http://${config.host}:${config.port}`);
    console.log(`route mode: ${config.routeMode}`);
  });
}
