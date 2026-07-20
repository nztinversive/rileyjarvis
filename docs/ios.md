# Vector iOS development

Phase 5 hardens the Capacitor 8 iOS 15+ app for physical-device Realtime voice: explicit microphone permission, native audio-session routing, bounded WebRTC setup, deterministic teardown, interruption and lifecycle handling, typed prompts, and a temporary DEBUG-only Keychain provisioning mechanism.

## Current proof status

As of July 19, 2026, the code-readiness lane has Simulator compile coverage, but no physical-iPhone voice proof exists. The current development machine reports:

- Xcode 26.6 (build 17F113) with iOS Simulator 26.4.1 and 26.5 destinations;
- no paired physical iPhone visible to Xcode or `devicectl`;
- no valid local Apple development signing identity or matching profile for `com.rileyjarvis.vector`;
- no discoverable HTTPS Phase 2 deployment, approved bootstrap token, or configured `VITE_VECTOR_BACKEND_URL`.

These are external proof blockers, not successful device evidence. Do not mark Phase 5 complete, make its pull request ready, or merge it until the physical checklist in this document passes on the exact reviewed commit. A signing-disabled Simulator build proves only that native code compiles.

## Security and session architecture

The iPhone never receives a standard OpenAI API key. The flow is:

1. A user taps **Start conversation**.
2. Native iOS requests microphone permission and activates a voice audio session.
3. WebKit creates one microphone stream.
4. The app reads one approved temporary bootstrap credential from `WhenUnlockedThisDeviceOnly` Keychain storage.
5. The app sends that bootstrap credential only to the HTTPS Phase 2 backend.
6. The backend authenticates the subject, applies rate limits and its server-owned Realtime policy, and uses its standard `OPENAI_API_KEY` to mint a short-lived client secret.
7. The app uses that client secret once to establish the WebRTC SDP connection, then clears its reference.

This follows OpenAI's [Realtime WebRTC guidance](https://developers.openai.com/api/docs/guides/realtime-webrtc): standard keys stay on the developer-controlled server, while the client uses a short-lived secret for WebRTC. The backend continues to own `gpt-realtime-2.1-mini`, instructions, voice, VAD, tools, reasoning, tracing, safety identifier, and TTL. The client sends no session-policy overrides.

Do not put a standard key or bootstrap credential in source, `.env.local`, an Xcode build setting, scheme environment variables, launch arguments, `Info.plist`, the Capacitor config, URLs, localStorage, Preferences, logs, screenshots, or committed files.

## Requirements

- macOS with Node.js 22.12 or newer
- Xcode 26.0 or newer with its command-line tools selected
- a paired, trusted physical iPhone visible as an Xcode run destination
- Developer Mode enabled on iOS 16 or newer
- an authorized Apple development team, identity, and profile for `com.rileyjarvis.vector`
- an HTTPS deployment of the Phase 2 service reachable from the phone
- an approved temporary backend bootstrap credential
- a server-side standard OpenAI key and policy configuration

The app uses bundle identifier `com.rileyjarvis.vector`, Swift Package Manager, and the default `capacitor://localhost` WKWebView origin. CocoaPods is not required. If the primary bundle identifier cannot be registered, choose and document an additive Debug-only identifier with the authorized team; do not change the Release identifier merely to bypass signing.

Apple requires [Developer Mode for locally installed development apps](https://developer.apple.com/news/?id=r1sz7dke). Pair, trust, unlock, and enable Developer Mode before treating a device as available.

## Backend configuration

Deploy `server/` behind HTTPS and configure its secrets only in the deployment environment:

- `OPENAI_API_KEY`
- `VECTOR_SAFETY_ID_SECRET`
- `VECTOR_AUTH_TOKENS_JSON`
- `VECTOR_ALLOWED_ORIGINS`, including the exact `capacitor://localhost` origin

The server must not accept wildcard CORS, client-selected subjects, or client-selected Realtime policy. Confirm the secret-free health endpoint and exact preflight policy before building the device app:

```bash
curl -fsS https://your-vector-backend.example/health
curl -i -X OPTIONS \
  https://your-vector-backend.example/api/realtime/session \
  -H 'Origin: capacitor://localhost' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization,content-type'
```

Do not include a bearer credential in a shell history or diagnostic capture. An authorized operator should verify an authenticated session request through a secret-safe mechanism.

Create the ignored local file `.env.local` with the credential-free origin only:

```dotenv
VITE_VECTOR_BACKEND_URL=https://your-vector-backend.example
```

The value must be an HTTPS origin without credentials, path, query, or fragment.

## DEBUG-only bootstrap provisioning and revocation

The temporary developer provisioning UI is compiled only when Swift `DEBUG` is defined and is also disabled unless an explicit non-secret launch argument is present. Release builds contain no provisioning UI or Keychain write bridge. The runtime prompt uses a secure text field and writes directly to the device-only Keychain item without passing through JavaScript.

To provision an approved temporary credential:

1. Open `ios/App/App.xcodeproj`.
2. Choose **Product > Scheme > Edit Scheme > Run > Arguments**.
3. Add and enable the non-secret launch argument `-VectorEnableCredentialProvisioning`.
4. Build and run the Debug configuration on the trusted iPhone.
5. In the one-time **Development Credential** sheet, choose **Provision**.
6. Paste the approved temporary backend bootstrap credential into the secure field and choose **Store in Keychain**.
7. Stop the app, disable the launch argument, and relaunch before voice QA.

To revoke:

1. Remove the token from the backend's approved `VECTOR_AUTH_TOKENS_JSON` map first.
2. Re-enable `-VectorEnableCredentialProvisioning` for one Debug launch.
3. Choose **Revoke Credential** in the development sheet.
4. Stop the app and disable the launch argument again.

Local deletion does not revoke a still-valid server token; complete both steps. Relaunch with the argument to reopen the one-time sheet. Never record the credential value in proof notes.

Final customer authentication remains Phase 7 and must replace this temporary bootstrap boundary.

## Microphone and audio behavior

`NSMicrophoneUsageDescription` is present. The Start button is the only path that requests capture. The native flow:

- requests microphone permission and reports denied or restricted access with Settings guidance;
- activates `AVAudioSession` as `playAndRecord` with `voiceChat`;
- prefers the built-in speaker for hands-free voice while permitting Bluetooth HFP and wired routes;
- exposes only sanitized route classes such as speaker, receiver, wired headset, or Bluetooth;
- allows WKWebView microphone capture only for the exact main-frame `capacitor://localhost` origin and denies camera, combined capture, subframes, and other origins.

The app creates one microphone track, one peer connection, one data channel, and one remote audio element per attempt. It never enables background audio or persistent recording.

Disconnect stops all input tracks, closes the data and peer channels, aborts pending backend/SDP requests, removes network/media listeners, pauses and removes remote audio, closes the output meter, deactivates the native audio session, and permits a fresh connection attempt.

The app tears down without automatic reconnection when:

- the app enters the background;
- the device locks and protected data becomes unavailable;
- an audio interruption begins;
- an active headset or other output route becomes unavailable;
- iOS resets media services;
- the microphone track ends;
- the peer/data channel fails or closes;
- the network goes offline.

Foreground, unlock, route restoration, and interruption end never reacquire the microphone automatically. The user must tap Start again, which mints a fresh Realtime session.

## Install, sync, and Simulator compile

Install the exact dependency graph and sync native files:

```bash
npm ci
npm run ios:sync
```

Open Xcode:

```bash
npm run ios:open
```

The complete signing-disabled Simulator compile is:

```bash
npm run ios:verify
```

Without a deployed backend and Keychain bootstrap credential, tapping Start must fail closed with a clear setup message. Simulator UI, compile success, or a launched shell is not physical Realtime voice proof.

## Physical-iPhone build and proof

Before building, confirm the device appears without recording its UDID:

```bash
xcrun devicectl list devices
xcodebuild \
  -project ios/App/App.xcodeproj \
  -scheme App \
  -showdestinations
```

In Xcode, select the App target, choose the authorized team under **Signing & Capabilities**, select the paired iPhone, and run the exact commit under review. Automatic signing may create or refresh the development profile.

Record only the device model, iOS version, app build, exact Git commit, date, and pass/fail outcomes. Do not retain screenshots, UDIDs, profiles, certificates, console archives, tokens, transcripts, or audio.

The same exact commit must pass all of the following:

- [ ] first-run microphone grant begins only after tapping Start
- [ ] backend session issuance succeeds and the UI reaches connected state
- [ ] spoken user audio reaches the model
- [ ] remote model audio is audible on the expected speaker or selected accessory
- [ ] a sanitized transcript or status transition appears in Talk/Activity
- [ ] a typed prompt works in the same live session
- [ ] disconnect immediately stops capture and output
- [ ] reconnect creates a fresh backend credential and WebRTC session
- [ ] background/foreground returns disconnected and requires a user tap
- [ ] lock/unlock returns disconnected and requires a user tap
- [ ] one interruption or network-loss path fails safely and reconnects only after a user tap
- [ ] wired-headset or Bluetooth route behavior is observed when available, without duplicate output
- [ ] Artifacts and Activity remain usable during and after the session
- [ ] Computer and Remote Codex UI remain absent on iOS
- [ ] sanitized console inspection contains no SDP, authorization headers, credentials, keys, transcripts, or raw audio
- [ ] the temporary bootstrap credential is deleted locally and revoked server-side after proof

Media- or lifecycle-affecting changes after this run invalidate the proof. Rerun the physical checklist on the new head before review or merge.

## Troubleshooting

- **No bootstrap session credential is stored in Keychain:** provision the approved temporary token through the DEBUG-only sheet. Do not add it to `.env.local`.
- **Unable to reach the Realtime session service:** confirm the HTTPS origin is reachable from the phone and contains no path; then check deployment health.
- **Session service rejected the request:** verify server-side token approval and exact `capacitor://localhost` CORS without printing the token.
- **Microphone denied or restricted:** enable Vector under **Settings > Privacy & Security > Microphone** or check managed-device policy. iOS does not reprompt after denial.
- **No microphone / microphone busy:** disconnect other calls or recording apps, check the current route, and retry manually.
- **Realtime SDP rejected or timed out:** verify network access and backend-issued credential freshness; never log SDP or the ephemeral credential.
- **Remote audio unavailable:** check Silent Mode, volume, Control Center output, wired/Bluetooth route, and whether another audio session owns the route.
- **Headset unplug, interruption, lock, background, or media-service reset:** a safe disconnect is expected. Restore the condition and tap Start for a fresh session.
- **Device missing from Xcode:** unlock and trust it, enable Developer Mode, reconnect USB or trusted wireless pairing, and wait for Xcode device preparation.
- **Signing failure:** select an authorized team and allow automatic signing to refresh a development identity/profile. Do not commit team or profile identifiers.

## Verification before PR updates

Run:

```bash
npm ci
npm ls --all
npm test
npm run typecheck
npm run build
npm run server:test
npm run server:smoke
npm run ios:sync
npm run ios:verify
git diff --check
```

Also scan tracked changes, generated assets, bundle output, and captured logs for secrets and forbidden artifacts. Release verification must confirm the DEBUG provisioning marker is absent from the compiled Release app. Generated web assets under `ios/App/App/public`, native products, DerivedData, `xcuserdata`, screenshots, and runtime logs remain uncommitted.

## Deferred work

Phase 5 does not add background audio, always-on recording, production accounts, analytics, push notifications, subscriptions, quotas, cloud sync, TestFlight, or App Store submission. Phase 7 customer authentication remains explicitly deferred. The current repository contains no authoritative Phase 6 or Phase 8 contract, so those phases must be scoped separately rather than inferred here.
