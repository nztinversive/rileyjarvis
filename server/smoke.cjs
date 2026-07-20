"use strict";

const assert = require("node:assert/strict");
const { once } = require("node:events");
const { createVectorRealtimeServer } = require("./app.cjs");

const authToken = "local-smoke-token-with-at-least-32-chars";
const config = {
  apiKey: "test-only-openai-key-never-sent-to-openai",
  safetyIdSecret: "test-only-safety-secret-at-least-32-chars",
  authTokens: [{ subject: "local-smoke", token: authToken }],
  allowedOrigins: new Set(["http://127.0.0.1:5173"]),
  requestMaxBytes: 1024,
  upstreamTimeoutMs: 100,
  rateLimitMax: 5,
  rateLimitWindowMs: 60_000,
};

const server = createVectorRealtimeServer({
  config,
  fetchFn: async (_url, options) => {
    assert.equal(options.method, "POST");
    assert.match(options.headers["OpenAI-Safety-Identifier"], /^[a-f0-9]{64}$/);
    return new Response(JSON.stringify({ value: "ek_test_smoke", expires_at: 2_000_000_000 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
  logger: { info() {}, warn() {}, error() {} },
});

async function main() {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok", service: "vector-realtime-session" });

  const unauthorized = await fetch(`${baseUrl}/api/realtime/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(unauthorized.status, 401);

  const authenticated = await fetch(`${baseUrl}/api/realtime/session`, {
    method: "POST",
    headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(authenticated.status, 200);
  assert.deepEqual(await authenticated.json(), { value: "ek_test_smoke", expiresAt: 2_000_000_000 });

  console.log("server smoke passed: health=200 unauthenticated=401 authenticated=200 fake_upstream=true");
}

main()
  .finally(() => server.close())
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "server smoke failed");
    process.exitCode = 1;
  });
