# Vector Realtime session service

This service is the Phase 2 trust boundary for future native clients. It keeps the standard `OPENAI_API_KEY`, Realtime session policy, bootstrap identities, rate limiting, and safety-identifier secret on the server. Clients receive only `{ "value": "ek_...", "expiresAt": 123 }`.

## Endpoints

- `GET /health` returns a secret-free readiness response.
- `POST /api/realtime/session` requires `Authorization: Bearer <bootstrap-token>`, `Content-Type: application/json`, and an empty `{}` body. The authenticated token maps to a server-owned opaque subject; clients cannot choose their subject or Realtime session configuration.

Native clients that do not send an `Origin` header are accepted. Browser or Capacitor origins must be listed exactly in `VECTOR_ALLOWED_ORIGINS`; wildcards are rejected. A typical local list is `http://127.0.0.1:5173,capacitor://localhost`.

## Configuration and startup

Copy only placeholders from `.env.example` into an ignored `.env.local`, replace them locally, and never commit that file. The server refuses to bind when the OpenAI key, safety secret, or bootstrap token map is missing or invalid.

```bash
npm run server:start
```

For reload-on-change development:

```bash
npm run server:dev
```

The bootstrap token map is intentionally narrow and temporary:

```dotenv
VECTOR_AUTH_TOKENS_JSON={"opaque-local-subject":"replace-with-at-least-32-random-characters"}
```

Token comparison uses fixed-length digests and constant-time comparison. The mapped subject is used for the per-subject limiter and an HMAC-based `OpenAI-Safety-Identifier`; the raw subject is not sent to OpenAI. Replace `createBootstrapAuthenticator` with a verifier backed by Sign in with Apple or another identity provider in a later phase. Do not accept client-asserted subject headers as identity.

The included rate limiter is process-local and appropriate for a single service instance. A horizontally scaled deployment must inject a shared limiter before accepting production traffic across replicas.

## Trust boundary

The endpoint accepts no model, instructions, voice, audio, tools, or TTL fields. `server/session-config.cjs` owns the allowlisted GA payload sent to `POST /v1/realtime/client_secrets`, including the existing `gpt-realtime-2.1-mini` model, low reasoning, semantic VAD behavior, interrupt support, and `cedar` voice. Desktop-only tools remain in Electron and are not exposed by this service.

OpenAI permits a client using an ephemeral credential to establish the WebRTC call. Phase 3's iOS adapter will call this service through `VectorPlatform.createRealtimeCredential`, then use the returned short-lived value with `/v1/realtime/calls`. The standard key never enters the app bundle or the service response.

The official client-secret contract allows session configuration to be updated by the connecting client. This service is the source of the issued configuration and accepts no client overrides, but an ephemeral credential is not a cryptographic policy lock. Phase 3 must keep the adapter configuration-free and test that it sends no session update. If future threat modeling requires enforcement against a modified client, move WebRTC call establishment or server controls behind the backend rather than trusting the app bundle.

## Verification

```bash
npm run server:test
npm run server:smoke
```

Both commands use fake upstreams and require no credentials or network calls to OpenAI.
