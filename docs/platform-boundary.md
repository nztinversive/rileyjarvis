# Vector platform boundary

The React renderer and Realtime client depend on the typed `VectorPlatform` contract in `src/platform/types.ts`. The contract owns three runtime concerns:

- creating a short-lived Realtime credential;
- listing and executing platform-provided tool schemas;
- optionally subscribing to Remote Codex lifecycle events.

## Desktop adapter

`src/platform/electron.ts` adapts Electron's context-isolated preload bridge to `VectorPlatform`. The preload continues to expose `window.ricky` for compatibility in this phase, but that legacy name is contained at the adapter and global declaration boundary. Shared renderer code does not call the preload bridge directly.

Electron continues to provide the existing tool schemas and Remote Codex lifecycle subscription. When `remote_codex_start` is registered, the Realtime client preserves the desktop status message that Remote Codex is ready.

## Future iOS adapter

A Capacitor/iOS adapter can implement `VectorPlatform` and be selected in `src/platform/index.ts` without changing `App.tsx` or the Realtime client's tool execution flow. Mobile adapters may omit the optional Remote Codex capability and may return tool specs without `remote_codex_start`; Realtime voice startup remains valid in that configuration.

Phase 2 adds the credential-hosting boundary under `server/` without selecting a mobile runtime. A future iOS adapter will implement `createRealtimeCredential()` by sending an authenticated empty JSON request to `POST /api/realtime/session`, then pass the returned `{ value, expiresAt }` credential to the existing Realtime WebRTC client. The service owns the model, instructions, audio policy, credential TTL, safety identifier, and upstream OpenAI request; the adapter must not send those values.

Bootstrap bearer tokens currently map to server-owned opaque subjects. That is deliberately narrower than a final account system and must be replaced at the authentication interface by Sign in with Apple or another identity provider in a later phase. Capacitor scaffolding, native microphone/WebRTC integration, subscriptions, persistence, and remote tool execution remain deferred.

The Electron adapter and its local `realtime:create-token` handler are unchanged in Phase 2. Desktop credentials, tool schemas, Remote Codex, and local runtime behavior continue to use the existing context-isolated Electron flow.
