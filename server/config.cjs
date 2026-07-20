"use strict";

const DEFAULTS = Object.freeze({
  host: "127.0.0.1",
  port: 8787,
  requestMaxBytes: 1024,
  upstreamTimeoutMs: 10_000,
  rateLimitMax: 10,
  rateLimitWindowMs: 60_000,
});

class ConfigurationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ConfigurationError";
    this.code = code;
  }
}

function loadConfig(env = process.env) {
  return {
    nodeEnv: String(env.NODE_ENV || "production").trim(),
    host: nonEmpty(env.VECTOR_REALTIME_HOST) || DEFAULTS.host,
    port: integerInRange(env.VECTOR_REALTIME_PORT, DEFAULTS.port, 0, 65_535, "VECTOR_REALTIME_PORT"),
    apiKey: requiredSecret(env.OPENAI_API_KEY, "OPENAI_API_KEY"),
    safetyIdSecret: requiredSecret(env.VECTOR_SAFETY_ID_SECRET, "VECTOR_SAFETY_ID_SECRET", 32),
    authTokens: parseAuthTokens(env.VECTOR_AUTH_TOKENS_JSON),
    allowedOrigins: parseOrigins(env.VECTOR_ALLOWED_ORIGINS),
    requestMaxBytes: integerInRange(
      env.VECTOR_REQUEST_MAX_BYTES,
      DEFAULTS.requestMaxBytes,
      128,
      16_384,
      "VECTOR_REQUEST_MAX_BYTES",
    ),
    upstreamTimeoutMs: integerInRange(
      env.VECTOR_UPSTREAM_TIMEOUT_MS,
      DEFAULTS.upstreamTimeoutMs,
      250,
      30_000,
      "VECTOR_UPSTREAM_TIMEOUT_MS",
    ),
    rateLimitMax: integerInRange(
      env.VECTOR_RATE_LIMIT_MAX,
      DEFAULTS.rateLimitMax,
      1,
      1_000,
      "VECTOR_RATE_LIMIT_MAX",
    ),
    rateLimitWindowMs: integerInRange(
      env.VECTOR_RATE_LIMIT_WINDOW_MS,
      DEFAULTS.rateLimitWindowMs,
      1_000,
      3_600_000,
      "VECTOR_RATE_LIMIT_WINDOW_MS",
    ),
  };
}

function parseAuthTokens(raw) {
  if (!nonEmpty(raw)) {
    throw new ConfigurationError("missing_auth_tokens", "VECTOR_AUTH_TOKENS_JSON is required.");
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigurationError("invalid_auth_tokens", "VECTOR_AUTH_TOKENS_JSON must be valid JSON.");
  }

  if (!isPlainObject(parsed) || Object.keys(parsed).length === 0) {
    throw new ConfigurationError("invalid_auth_tokens", "VECTOR_AUTH_TOKENS_JSON must map subjects to bearer tokens.");
  }

  const seenTokens = new Set();
  return Object.entries(parsed).map(([rawSubject, rawToken]) => {
    const subject = String(rawSubject).trim();
    const token = typeof rawToken === "string" ? rawToken.trim() : "";
    if (!subject || subject.length > 128 || !/^[A-Za-z0-9._:@/-]+$/.test(subject)) {
      throw new ConfigurationError("invalid_auth_subject", "Authentication subjects must be non-empty opaque identifiers.");
    }
    if (token.length < 32) {
      throw new ConfigurationError("weak_auth_token", "Bootstrap bearer tokens must contain at least 32 characters.");
    }
    if (isPlaceholderSecret(token)) {
      throw new ConfigurationError("placeholder_auth_token", "Bootstrap bearer token placeholders must be replaced.");
    }
    if (seenTokens.has(token)) {
      throw new ConfigurationError("duplicate_auth_token", "Bootstrap bearer tokens must be unique per subject.");
    }
    seenTokens.add(token);
    return { subject, token };
  });
}

function parseOrigins(raw) {
  const origins = new Set();
  for (const value of String(raw || "").split(",")) {
    const origin = value.trim();
    if (!origin) continue;
    if (origin === "*") {
      throw new ConfigurationError("wildcard_origin", "VECTOR_ALLOWED_ORIGINS cannot contain a wildcard.");
    }
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new ConfigurationError("invalid_origin", "VECTOR_ALLOWED_ORIGINS contains an invalid origin.");
    }
    if (parsed.origin === "null" && !/^(capacitor|ionic):\/\//i.test(origin)) {
      throw new ConfigurationError("invalid_origin", "VECTOR_ALLOWED_ORIGINS contains an unsupported origin.");
    }
    origins.add(origin.replace(/\/$/, ""));
  }
  return origins;
}

function requiredSecret(value, name, minimumLength = 1) {
  const secret = nonEmpty(value);
  if (!secret) {
    throw new ConfigurationError(`missing_${name.toLowerCase()}`, `${name} is required.`);
  }
  if (secret.length < minimumLength) {
    throw new ConfigurationError(`weak_${name.toLowerCase()}`, `${name} must contain at least ${minimumLength} characters.`);
  }
  if (isPlaceholderSecret(secret)) {
    throw new ConfigurationError(`placeholder_${name.toLowerCase()}`, `${name} placeholder must be replaced.`);
  }
  return secret;
}

function isPlaceholderSecret(value) {
  return /^(?:your[_-].*[_-]here|replace-with-|change-me)/i.test(value);
}

function integerInRange(value, fallback, minimum, maximum, name) {
  if (!nonEmpty(value)) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ConfigurationError("invalid_number", `${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

module.exports = {
  ConfigurationError,
  DEFAULTS,
  loadConfig,
};
