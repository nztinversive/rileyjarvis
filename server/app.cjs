"use strict";

const http = require("node:http");
const { createBootstrapAuthenticator } = require("./auth.cjs");
const { createOpenAIRealtimeClient, UpstreamError } = require("./openai.cjs");
const { createInMemoryRateLimiter } = require("./rate-limit.cjs");
const { createSafetyIdentifier } = require("./safety-id.cjs");

function createVectorRealtimeServer({
  config,
  fetchFn = globalThis.fetch,
  clock = Date.now,
  authenticator = createBootstrapAuthenticator(config.authTokens),
  rateLimiter = createInMemoryRateLimiter({ max: config.rateLimitMax, windowMs: config.rateLimitWindowMs, clock }),
  openAIClient = createOpenAIRealtimeClient({ fetchFn, timeoutMs: config.upstreamTimeoutMs }),
  logger = createSafeLogger(),
} = {}) {
  if (!config) throw new TypeError("Server configuration is required.");

  return http.createServer(async (request, response) => {
    try {
      await routeRequest({ request, response, config, authenticator, rateLimiter, openAIClient, clock, logger });
    } catch {
      logger.error("request_failed", { code: "internal_error" });
      sendError(response, 500, "internal_error", "The request could not be completed.");
    }
  });
}

async function routeRequest({ request, response, config, authenticator, rateLimiter, openAIClient, clock, logger }) {
  const pathname = new URL(request.url || "/", "http://vector.local").pathname;
  if (!applyCorsPolicy(request, response, config.allowedOrigins)) return;

  if (request.method === "OPTIONS") {
    handlePreflight(request, response, pathname);
    return;
  }

  if (pathname === "/health") {
    if (request.method !== "GET") {
      sendMethodNotAllowed(response, "GET, OPTIONS");
      return;
    }
    sendJson(response, 200, { status: "ok", service: "vector-realtime-session" });
    return;
  }

  if (pathname !== "/api/realtime/session") {
    sendError(response, 404, "not_found", "Route not found.");
    return;
  }

  if (request.method !== "POST") {
    sendMethodNotAllowed(response, "POST, OPTIONS");
    return;
  }

  if (!isJsonContentType(request.headers["content-type"])) {
    sendError(response, 415, "unsupported_media_type", "Content-Type must be application/json.");
    return;
  }

  const identity = await authenticator.authenticate(request);
  if (!identity || typeof identity.subject !== "string" || !identity.subject) {
    response.setHeader("WWW-Authenticate", 'Bearer realm="vector-realtime"');
    sendError(response, 401, "unauthorized", "Authentication is required.");
    return;
  }

  let body;
  try {
    body = await readJsonBody(request, config.requestMaxBytes);
  } catch (error) {
    const status = error.code === "request_too_large" ? 413 : 400;
    sendError(response, status, error.code, status === 413 ? "Request body is too large." : "Request body must be valid JSON.");
    return;
  }

  if (!isPlainObject(body) || Object.keys(body).length !== 0) {
    sendError(response, 400, "invalid_request", "The request body must be an empty JSON object.");
    return;
  }

  const rateLimit = await rateLimiter.consume(identity.subject);
  response.setHeader("X-RateLimit-Remaining", String(Math.max(0, rateLimit.remaining || 0)));
  if (!rateLimit.allowed) {
    const retryAfter = Math.max(1, Math.ceil((rateLimit.resetAt - clock()) / 1000));
    response.setHeader("Retry-After", String(retryAfter));
    sendError(response, 429, "rate_limited", "Too many Realtime session requests.");
    return;
  }

  try {
    const credential = await openAIClient.createCredential({
      apiKey: config.apiKey,
      safetyIdentifier: createSafetyIdentifier(identity.subject, config.safetyIdSecret),
    });
    sendJson(response, 200, credential);
  } catch (error) {
    const upstreamError = error instanceof UpstreamError ? error : new UpstreamError("upstream_unavailable", 502);
    logger.warn("realtime_session_failed", { code: upstreamError.code, status: upstreamError.status });
    sendError(
      response,
      upstreamError.status,
      upstreamError.code,
      upstreamError.status === 504 ? "The Realtime provider timed out." : "The Realtime provider is unavailable.",
    );
  }
}

function applyCorsPolicy(request, response, allowedOrigins) {
  const origin = typeof request.headers.origin === "string" ? request.headers.origin.replace(/\/$/, "") : "";
  if (!origin) return true;
  if (!allowedOrigins.has(origin)) {
    sendError(response, 403, "origin_not_allowed", "The request origin is not allowed.");
    return false;
  }
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  return true;
}

function handlePreflight(request, response, pathname) {
  const requestedMethod = String(request.headers["access-control-request-method"] || "").toUpperCase();
  const expectedMethod = pathname === "/health" ? "GET" : pathname === "/api/realtime/session" ? "POST" : "";
  if (!expectedMethod || requestedMethod !== expectedMethod) {
    sendError(response, 405, "method_not_allowed", "Method not allowed.");
    return;
  }

  const requestedHeaders = String(request.headers["access-control-request-headers"] || "")
    .split(",")
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);
  if (requestedHeaders.some((header) => !["authorization", "content-type"].includes(header))) {
    sendError(response, 403, "headers_not_allowed", "The requested headers are not allowed.");
    return;
  }

  response.statusCode = 204;
  response.setHeader("Access-Control-Allow-Methods", `${expectedMethod}, OPTIONS`);
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  response.setHeader("Access-Control-Max-Age", "600");
  response.end();
}

function readJsonBody(request, maximumBytes) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(request.headers["content-length"] || 0);
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
      reject(requestError("request_too_large"));
      request.resume();
      return;
    }

    let size = 0;
    let tooLarge = false;
    const chunks = [];
    request.on("data", (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > maximumBytes) {
        tooLarge = true;
        chunks.length = 0;
        reject(requestError("request_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(requestError("invalid_json"));
      }
    });
    request.on("error", () => reject(requestError("invalid_json")));
  });
}

function requestError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isJsonContentType(value) {
  return typeof value === "string" && /^application\/json(?:\s*;|$)/i.test(value);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function sendMethodNotAllowed(response, allow) {
  response.setHeader("Allow", allow);
  sendError(response, 405, "method_not_allowed", "Method not allowed.");
}

function sendError(response, status, code, message) {
  sendJson(response, status, { error: { code, message } });
}

function sendJson(response, status, payload) {
  if (response.writableEnded) return;
  const body = JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

function createSafeLogger(target = console) {
  return {
    info: (event, fields = {}) => target.info(JSON.stringify({ event, ...fields })),
    warn: (event, fields = {}) => target.warn(JSON.stringify({ event, ...fields })),
    error: (event, fields = {}) => target.error(JSON.stringify({ event, ...fields })),
  };
}

module.exports = {
  applyCorsPolicy,
  createSafeLogger,
  createVectorRealtimeServer,
  readJsonBody,
};
