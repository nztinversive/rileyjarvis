# Vector platform boundary

The React renderer and Realtime client depend on the typed `VectorPlatform` contract in `src/platform/types.ts`. The contract owns these runtime concerns:

- creating a short-lived Realtime credential;
- listing and executing platform-provided tool schemas;
- optionally subscribing to Remote Codex lifecycle events;
- selecting a desktop or native-mobile presentation.
- optionally exposing native mobile data and share-sheet capabilities.

## Desktop adapter

`src/platform/electron.ts` adapts Electron's context-isolated preload bridge to `VectorPlatform`. The preload continues to expose `window.ricky` for compatibility in this phase, but that legacy name is contained at the adapter and global declaration boundary. Shared renderer code does not call the preload bridge directly.

Electron continues to provide the existing tool schemas and Remote Codex lifecycle subscription. When `remote_codex_start` is registered, the Realtime client preserves the desktop status message that Remote Codex is ready.

## iOS adapter

`src/platform/capacitor.ts` detects a native Capacitor iOS runtime before the Electron/browser fallback and composes the testable adapter in `src/platform/ios.ts`. The adapter sets `presentation: "native-mobile"` at that platform boundary. `App` uses that one reliable signal to select the responsive mobile shell; shared state, artifacts, and Realtime logic remain platform-neutral. The Electron adapter sets `presentation: "desktop"`, preserving its titlebar, modes, split panes, keyboard shortcuts, Computer controls, and Remote Codex lifecycle.

The iOS adapter omits Remote Codex and exposes display mode, iOS-safe artifacts, the versioned local-data capability, native sharing, and the mobile capability menu. The adapter and session service both consume the canonical allowlist in `shared/ios-tool-specs.json`, so the service registers the same bounded note, record, saved-artifact, display, and menu schemas the client can execute. Delete tools first require `confirmed: true`, then resolve the exact current item and require a native destructive-alert confirmation; the model flag alone cannot mutate storage. Results contain at most a bounded recent slice and never native paths or a complete unbounded database. Unknown and desktop-only tools return safe unsupported results. Computer mode, Remote Codex, image generation, web search, thumbnails, filesystem access, Project Cockpit, and arbitrary execution remain absent.

The optional `mobileData` capability maps to the narrow `VectorMobileData` Capacitor plugin. Its shared TypeScript contract is schema version 1. Native storage lives under the app's Application Support container, uses a serialized queue, atomic replacement writes, complete iOS file protection, deterministic ordering, stable UUIDs, UTC timestamps, strict JSON validation, fixed count/field/file limits, and protected corruption recovery. It has no Preferences, localStorage, plist, URL, or web-bundle fallback. The optional `nativeShare` capability maps to `UIActivityViewController` and exports only selected sanitized text or credential-free HTTPS links; cancellation resolves normally.

`createRealtimeCredential()` reads the temporary bootstrap bearer credential from the native `VectorSecureStorage` Keychain plugin and sends an authenticated empty JSON request to `POST /api/realtime/session`. The backend origin comes from the non-secret `VITE_VECTOR_BACKEND_URL` build setting and must be HTTPS. The adapter validates and returns only `{ value, expiresAt }`, bounds and cancels the request, sanitizes errors, and does not log either credential.

The service owns the model, instructions, audio policy, credential TTL, safety identifier, and upstream OpenAI request; the adapter sends none of those values. The short-lived Realtime credential exists in JavaScript only while the existing WebRTC connection is established. The iOS lifecycle boundary disconnects the session when the app becomes inactive, and no background audio mode is enabled.

The optional iOS `voiceSession` capability prepares microphone permission and the native voice-chat audio session before the backend mints a credential. Sanitized interruption, route, lock, and media-service events cross the bridge; the shared app tears down but never reconnects or reacquires capture without another user action. WKWebView capture is limited to microphone requests from the exact main-frame `capacitor://localhost` origin.

Bootstrap bearer tokens currently map to server-owned opaque subjects. That is deliberately narrower than a final account system and must be replaced at the authentication interface by Sign in with Apple or another identity provider in Phase 7. The runtime bridge provides Keychain `get` and `delete` only; a launch-argument-gated native provisioning sheet is compiled only in DEBUG and writes directly to `WhenUnlockedThisDeviceOnly` storage. There is no Preferences fallback or Release credential-write path. Physical microphone input, audible output, accessory routing, real interruptions, signing, and device behavior remain unverified and are deferred to Phase 8 or a dedicated pre-release hardware gate. Accounts, cloud sync, subscriptions, and remote execution remain deferred.

The Electron adapter and its local `realtime:create-token` handler remain unchanged. Desktop credentials, tool schemas, Remote Codex, and local runtime behavior continue to use the existing context-isolated Electron flow.
