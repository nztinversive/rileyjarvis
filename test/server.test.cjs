"use strict";

const assert = require("node:assert/strict");
const { once } = require("node:events");
const http = require("node:http");
const test = require("node:test");
const { createVectorRealtimeServer } = require("../server/app.cjs");
const { loadConfig } = require("../server/config.cjs");
const { createSafetyIdentifier } = require("../server/safety-id.cjs");
const { VECTOR_REALTIME_MODEL } = require("../server/session-config.cjs");

const STANDARD_API_KEY = "sk-test-standard-api-key-that-must-never-leak";
const AUTH_TOKEN = "authenticated-test-token-at-least-32-characters";
const SECOND_AUTH_TOKEN = "second-authenticated-token-at-least-32-characters";

function testConfig(overrides = {}) {
  return {
    apiKey: STANDARD_API_KEY,
    safetyIdSecret: "server-side-safety-secret-at-least-32-characters",
    authTokens: [
      { subject: "subject-alpha", token: AUTH_TOKEN },
      { subject: "subject-beta", token: SECOND_AUTH_TOKEN },
    ],
    allowedOrigins: new Set(["http://127.0.0.1:5173", "capacitor://localhost"]),
    requestMaxBytes: 128,
    upstreamTimeoutMs: 50,
    rateLimitMax: 5,
    rateLimitWindowMs: 60_000,
    ...overrides,
  };
}

async function withServer(options, callback) {
  const server = createVectorRealtimeServer({ logger: { info() {}, warn() {}, error() {} }, ...options });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  try {
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

function sessionRequest(baseUrl, options = {}) {
  return fetch(`${baseUrl}/api/realtime/session`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    body: options.body === undefined ? "{}" : options.body,
  });
}

function successfulUpstream(inspect = () => {}) {
  return async (url, options) => {
    inspect(url, options);
    return new Response(
      JSON.stringify({
        value: "ek_test_short_lived",
        expires_at: 2_000_000_000,
        session: { model: "ignored-server-field" },
        standard_key: STANDARD_API_KEY,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
}

function sendChunkedOversizedRequest(baseUrl) {
  const url = new URL("/api/realtime/session", baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          Authorization: `Bearer ${AUTH_TOKEN}`,
          "Content-Type": "application/json",
          "Transfer-Encoding": "chunked",
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    request.on("error", reject);
    request.write('{"padding":"');
    request.write("x".repeat(200));
    request.end('"}');
  });
}

test("health is secret-free and rejects unsupported methods", async () => {
  await withServer({ config: testConfig(), fetchFn: successfulUpstream() }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), { status: "ok", service: "vector-realtime-session" });
    assert.equal(text.includes(STANDARD_API_KEY), false);

    const invalidMethod = await fetch(`${baseUrl}/health`, { method: "POST" });
    assert.equal(invalidMethod.status, 405);
    assert.equal(invalidMethod.headers.get("allow"), "GET, OPTIONS");
  });
});

test("missing and invalid authentication fail closed", async () => {
  await withServer({ config: testConfig(), fetchFn: successfulUpstream() }, async (baseUrl) => {
    for (const authorization of [undefined, "Basic nope", "Bearer wrong-token-value-that-is-long-enough"]) {
      const headers = { "Content-Type": "application/json" };
      if (authorization) headers.Authorization = authorization;
      const response = await fetch(`${baseUrl}/api/realtime/session`, { method: "POST", headers, body: "{}" });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("www-authenticate"), 'Bearer realm="vector-realtime"');
    }
  });
});

test("production configuration rejects missing or weak secrets and wildcard CORS", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "production" }), /OPENAI_API_KEY is required/);
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        OPENAI_API_KEY: "configured",
        VECTOR_SAFETY_ID_SECRET: "short",
        VECTOR_AUTH_TOKENS_JSON: JSON.stringify({ subject: AUTH_TOKEN }),
      }),
    /VECTOR_SAFETY_ID_SECRET must contain at least 32 characters/,
  );
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        OPENAI_API_KEY: "configured",
        VECTOR_SAFETY_ID_SECRET: "configured-safety-secret-at-least-32-characters",
        VECTOR_AUTH_TOKENS_JSON: JSON.stringify({ subject: AUTH_TOKEN }),
        VECTOR_ALLOWED_ORIGINS: "*",
      }),
    /cannot contain a wildcard/,
  );
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        OPENAI_API_KEY: "configured",
        VECTOR_SAFETY_ID_SECRET: "configured-safety-secret-at-least-32-characters",
        VECTOR_AUTH_TOKENS_JSON: JSON.stringify({ subject: "replace-with-at-least-32-random-characters" }),
      }),
    /placeholders must be replaced/,
  );
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        OPENAI_API_KEY: "your_openai_api_key_here",
        VECTOR_SAFETY_ID_SECRET: "configured-safety-secret-at-least-32-characters",
        VECTOR_AUTH_TOKENS_JSON: JSON.stringify({ subject: AUTH_TOKEN }),
      }),
    /OPENAI_API_KEY placeholder must be replaced/,
  );
});

test("successful minting returns only the VectorPlatform credential fields", async () => {
  await withServer({ config: testConfig(), fetchFn: successfulUpstream() }, async (baseUrl) => {
    const response = await sessionRequest(baseUrl);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { value: "ek_test_short_lived", expiresAt: 2_000_000_000 });
    assert.equal(response.headers.get("cache-control"), "no-store");
  });
});

test("OpenAI payload is server-owned and allowlisted", async () => {
  let upstreamRequest;
  await withServer(
    {
      config: testConfig(),
      fetchFn: successfulUpstream((url, options) => {
        upstreamRequest = { url, options };
      }),
    },
    async (baseUrl) => {
      const response = await sessionRequest(baseUrl);
      assert.equal(response.status, 200);
    },
  );

  assert.equal(upstreamRequest.url, "https://api.openai.com/v1/realtime/client_secrets");
  assert.equal(upstreamRequest.options.headers.Authorization, `Bearer ${STANDARD_API_KEY}`);
  const body = JSON.parse(upstreamRequest.options.body);
  assert.deepEqual(Object.keys(body).sort(), ["expires_after", "session"]);
  assert.equal(body.expires_after.anchor, "created_at");
  assert.equal(body.expires_after.seconds, 600);
  assert.equal(body.session.type, "realtime");
  assert.equal(body.session.model, VECTOR_REALTIME_MODEL);
  assert.deepEqual(body.session.output_modalities, ["audio"]);
  assert.deepEqual(body.session.reasoning, { effort: "low" });
  assert.deepEqual(body.session.tools, []);
  assert.deepEqual(body.session.audio, {
    input: {
      turn_detection: {
        type: "semantic_vad",
        eagerness: "medium",
        create_response: true,
        interrupt_response: true,
      },
    },
    output: { voice: "cedar" },
  });
});

test("safety identifiers are stable, keyed, and privacy-preserving", async () => {
  const secret = testConfig().safetyIdSecret;
  const alpha = createSafetyIdentifier("subject-alpha", secret);
  assert.equal(alpha, createSafetyIdentifier("subject-alpha", secret));
  assert.notEqual(alpha, createSafetyIdentifier("subject-beta", secret));
  assert.notEqual(alpha, createSafetyIdentifier("subject-alpha", `${secret}-different`));
  assert.equal(alpha.includes("subject-alpha"), false);
  assert.match(alpha, /^[a-f0-9]{64}$/);

  const identifiers = [];
  await withServer(
    {
      config: testConfig(),
      fetchFn: successfulUpstream((_url, options) => identifiers.push(options.headers["OpenAI-Safety-Identifier"])),
    },
    async (baseUrl) => {
      assert.equal((await sessionRequest(baseUrl)).status, 200);
      assert.equal(
        (
          await sessionRequest(baseUrl, {
            headers: { Authorization: `Bearer ${SECOND_AUTH_TOKEN}` },
          })
        ).status,
        200,
      );
    },
  );
  assert.deepEqual(identifiers, [
    createSafetyIdentifier("subject-alpha", secret),
    createSafetyIdentifier("subject-beta", secret),
  ]);
});

test("rate limits are enforced per authenticated subject", async () => {
  let now = 1_000;
  await withServer(
    {
      config: testConfig({ rateLimitMax: 1, rateLimitWindowMs: 5_000 }),
      clock: () => now,
      fetchFn: successfulUpstream(),
    },
    async (baseUrl) => {
      assert.equal((await sessionRequest(baseUrl)).status, 200);
      const limited = await sessionRequest(baseUrl);
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get("retry-after"), "5");

      const otherSubject = await sessionRequest(baseUrl, {
        headers: { Authorization: `Bearer ${SECOND_AUTH_TOKEN}` },
      });
      assert.equal(otherSubject.status, 200);

      now += 5_000;
      assert.equal((await sessionRequest(baseUrl)).status, 200);
    },
  );
});

test("CORS accepts native clients and exact configured origins only", async () => {
  await withServer({ config: testConfig(), fetchFn: successfulUpstream() }, async (baseUrl) => {
    const nativeResponse = await sessionRequest(baseUrl);
    assert.equal(nativeResponse.status, 200);
    assert.equal(nativeResponse.headers.get("access-control-allow-origin"), null);

    const browserResponse = await sessionRequest(baseUrl, { headers: { Origin: "http://127.0.0.1:5173" } });
    assert.equal(browserResponse.status, 200);
    assert.equal(browserResponse.headers.get("access-control-allow-origin"), "http://127.0.0.1:5173");

    const capacitorPreflight = await fetch(`${baseUrl}/api/realtime/session`, {
      method: "OPTIONS",
      headers: {
        Origin: "capacitor://localhost",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, content-type",
      },
    });
    assert.equal(capacitorPreflight.status, 204);
    assert.equal(capacitorPreflight.headers.get("access-control-allow-origin"), "capacitor://localhost");

    const rejected = await sessionRequest(baseUrl, { headers: { Origin: "https://attacker.example" } });
    assert.equal(rejected.status, 403);
  });
});

test("request method, content type, JSON, schema, and size are validated", async () => {
  await withServer({ config: testConfig({ requestMaxBytes: 128 }), fetchFn: successfulUpstream() }, async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/api/realtime/session`)).status, 405);
    assert.equal(
      (
        await fetch(`${baseUrl}/api/realtime/session`, {
          method: "POST",
          headers: { Authorization: `Bearer ${AUTH_TOKEN}`, "Content-Type": "text/plain" },
          body: "{}",
        })
      ).status,
      415,
    );
    assert.equal((await sessionRequest(baseUrl, { body: "{" })).status, 400);
    assert.equal((await sessionRequest(baseUrl, { body: JSON.stringify({ model: "client-override" }) })).status, 400);
    assert.equal((await sessionRequest(baseUrl, { body: JSON.stringify({ padding: "x".repeat(200) }) })).status, 413);
    const chunked = await sendChunkedOversizedRequest(baseUrl);
    assert.equal(chunked.status, 413);
    assert.equal(JSON.parse(chunked.body).error.code, "request_too_large");
  });
});

test("upstream timeouts and failures map to safe errors", async () => {
  const cases = [
    {
      fetchFn: () => new Promise(() => {}),
      expectedStatus: 504,
      expectedCode: "upstream_timeout",
    },
    {
      fetchFn: async () => ({ ok: true, json: () => new Promise(() => {}) }),
      expectedStatus: 504,
      expectedCode: "upstream_timeout",
    },
    {
      fetchFn: async () => new Response("provider body with secret-looking details", { status: 500 }),
      expectedStatus: 502,
      expectedCode: "upstream_rejected",
    },
    {
      fetchFn: async () => new Response("not json", { status: 200 }),
      expectedStatus: 502,
      expectedCode: "invalid_upstream_response",
    },
  ];

  for (const entry of cases) {
    await withServer({ config: testConfig({ upstreamTimeoutMs: 10 }), fetchFn: entry.fetchFn }, async (baseUrl) => {
      const response = await sessionRequest(baseUrl);
      assert.equal(response.status, entry.expectedStatus);
      const payload = await response.json();
      assert.equal(payload.error.code, entry.expectedCode);
      assert.equal(JSON.stringify(payload).includes(STANDARD_API_KEY), false);
    });
  }
});

test("the standard API key is absent from responses and loggable errors", async () => {
  const logs = [];
  const logger = {
    info: (...values) => logs.push(values),
    warn: (...values) => logs.push(values),
    error: (...values) => logs.push(values),
  };

  await withServer(
    {
      config: testConfig(),
      logger,
      fetchFn: async () =>
        new Response(JSON.stringify({ error: { message: STANDARD_API_KEY } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
    },
    async (baseUrl) => {
      const response = await sessionRequest(baseUrl);
      assert.equal(response.status, 502);
      assert.equal((await response.text()).includes(STANDARD_API_KEY), false);
    },
  );

  assert.equal(JSON.stringify(logs).includes(STANDARD_API_KEY), false);

  await withServer(
    {
      config: testConfig(),
      logger,
      fetchFn: async () =>
        new Response(JSON.stringify({ value: STANDARD_API_KEY, expires_at: 2_000_000_000 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    },
    async (baseUrl) => {
      const response = await sessionRequest(baseUrl);
      assert.equal(response.status, 502);
      assert.equal((await response.text()).includes(STANDARD_API_KEY), false);
    },
  );
});
