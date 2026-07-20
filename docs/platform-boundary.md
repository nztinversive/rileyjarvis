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

This boundary does not prescribe mobile authentication, credential hosting, native UI, or backend infrastructure. Those concerns remain deferred to later phases.
