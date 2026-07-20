"use strict";

const { buildRealtimeClientSecretRequest } = require("./session-config.cjs");

const OPENAI_REALTIME_CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";

class UpstreamError extends Error {
  constructor(code, status) {
    super(code);
    this.name = "UpstreamError";
    this.code = code;
    this.status = status;
  }
}

function createOpenAIRealtimeClient({ fetchFn = globalThis.fetch, timeoutMs, setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (typeof fetchFn !== "function") throw new TypeError("A fetch implementation is required.");

  return {
    async createCredential({ apiKey, safetyIdentifier }) {
      const controller = new AbortController();
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimer(() => {
          controller.abort();
          reject(new UpstreamError("upstream_timeout", 504));
        }, timeoutMs);
      });

      try {
        return await Promise.race([
          requestCredential({ fetchFn, apiKey, safetyIdentifier, signal: controller.signal }),
          timeout,
        ]);
      } catch (error) {
        if (error instanceof UpstreamError) throw error;
        throw new UpstreamError("upstream_unavailable", 502);
      } finally {
        if (timer) clearTimer(timer);
      }

    },
  };
}

async function requestCredential({ fetchFn, apiKey, safetyIdentifier, signal }) {
  const response = await fetchFn(OPENAI_REALTIME_CLIENT_SECRETS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": safetyIdentifier,
    },
    body: JSON.stringify(buildRealtimeClientSecretRequest()),
    signal,
  });

  if (!response || !response.ok) {
    throw new UpstreamError("upstream_rejected", response?.status === 429 ? 503 : 502);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new UpstreamError("invalid_upstream_response", 502);
  }

  const value = typeof payload?.value === "string" ? payload.value : "";
  const expiresAt = payload?.expires_at;
  if (!value || !Number.isInteger(expiresAt) || value.includes(apiKey)) {
    throw new UpstreamError("invalid_upstream_response", 502);
  }

  return { value, expiresAt };
}

module.exports = {
  OPENAI_REALTIME_CLIENT_SECRETS_URL,
  UpstreamError,
  createOpenAIRealtimeClient,
};
