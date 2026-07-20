# Vector platform boundary

The React renderer and Realtime client depend on the typed `VectorPlatform` contract in `src/platform/types.ts`. The contract owns three runtime concerns:

- creating a short-lived Realtime credential;
- listing and executing platform-provided tool schemas;
- optionally subscribing to Remote Codex lifecycle events.

## Desktop adapter

`src/platform/electron.ts` adapts Electron's context-isolated preload bridge to `VectorPlatform`. The preload continues to expose `window.ricky` for compatibility in this phase, but that legacy name is contained at the adapter and global declaration boundary. Shared renderer code does not call the preload bridge directly.

Electron continues to provide the existing tool schemas and Remote Codex lifecycle subscription. When `remote_codex_start` is registered, the Realtime client preserves the desktop status message that Remote Codex is ready.

## iOS adapter

`src/platform/capacitor.ts` detects a native Capacitor iOS runtime before the Electron/browser fallback and composes the testable adapter in `src/platform/ios.ts`. The iOS adapter omits Remote Codex and exposes only display mode, iOS-safe artifacts, and the mobile capability menu. The adapter and session service both consume the canonical allowlist in `shared/ios-tool-specs.json`, so the service registers exactly those schemas when it issues the Realtime credential. Unknown and desktop-only tools return safe unsupported results; their absence does not block Realtime startup.

`createRealtimeCredential()` reads the temporary bootstrap bearer credential from the native `VectorSecureStorage` Keychain plugin and sends an authenticated empty JSON request to `POST /api/realtime/session`. The backend origin comes from the non-secret `VITE_VECTOR_BACKEND_URL` build setting and must be HTTPS. The adapter validates and returns only `{ value, expiresAt }`, bounds the request, sanitizes errors, and does not log either credential.

The service owns the model, instructions, audio policy, credential TTL, safety identifier, and upstream OpenAI request; the adapter sends none of those values. The short-lived Realtime credential exists in JavaScript only while the existing WebRTC connection is established. The iOS lifecycle boundary disconnects the session when the app becomes inactive, and no background audio mode is enabled.

Bootstrap bearer tokens currently map to server-owned opaque subjects. That is deliberately narrower than a final account system and must be replaced at the authentication interface by Sign in with Apple or another identity provider in a later phase. The native bridge provides Keychain `get`, `set`, and `delete` only; it never falls back to Preferences. Mobile navigation redesign, physical-device microphone/WebRTC proof, subscriptions, feature/data sync, and remote tool execution remain deferred.

The Electron adapter and its local `realtime:create-token` handler are unchanged in Phase 2. Desktop credentials, tool schemas, Remote Codex, and local runtime behavior continue to use the existing context-isolated Electron flow.
