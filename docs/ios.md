# Vector iOS development

Phase 6 builds on the Simulator-verified Phase 5 voice foundation with private native mobile data: durable notes, structured records, an intentional saved-artifact library, bounded Realtime data tools, and safe native sharing. The Phase 5 Voice preview disclosure remains unchanged because physical audio hardware proof is still deferred.

## Phase 6 local data and retention

The iOS store uses schema version 1 and lives in Vector's Application Support container, outside the web bundle. A serialized native boundary performs strict decoding, deterministic newest-first ordering, stable generated UUIDs, UTC timestamps, bounded count/field/file validation, atomic replacement writes, and complete file protection so the store is unavailable while the device is locked. It is excluded from device backups in this phase. There is no durable-data fallback to localStorage, Capacitor Preferences, `Info.plist`, URL parameters, or the repo.

Current limits are 200 notes, 200 records, 100 saved artifacts, a 2 MB store file, 12 tags per note, 16 KB structured data per record, and 64,000 shared-contract characters per saved artifact. Supported saved kinds are text, Markdown, code, table, notes, Mermaid, and credential-free HTTPS images. Loading/progress artifacts and local/data/file image sources are not saved. Realtime credentials, bootstrap tokens, API keys, SDP, microphone data, runtime logs, native paths, and full transcripts are never part of this contract. Activity remains session-scoped by default.

Artifacts now have Current and Saved views alongside browsable Notes and Records inside the existing Artifacts tab. Save is always explicit. Delete requires a confirmation interaction, and every Realtime-triggered deletion must also pass an item-specific native destructive alert before storage changes. Text, notes, and records share as selected sanitized content; secure images share as HTTPS links. The iOS share sheet treats cancellation as a normal result and creates no persistent export file.

If decoding fails, Vector preserves the damaged file as a protected recovery copy and reports a sanitized actionable error. Retrying starts a fresh in-memory library; the next successful write atomically creates a valid store without deleting the recovery copy. A newer unsupported schema is preserved and requires an app update rather than reset.

Phase 7 owns customer accounts and cloud synchronization. Until then, the library is local to this app installation and can be removed item by item or by uninstalling Vector.

## Simulator verification status

As of July 20, 2026, Phase 5 acceptance is intentionally limited to automated coverage and iPhone Simulator build/install/launch readiness. The current development machine provides Xcode 26.6 (build 17F113) with iOS 26.4 and 26.5 Simulator destinations.

This phase verifies source contracts, native compilation, secure boundaries, teardown/reconnect behavior through injected tests, and representative Simulator installation and launch. It does **not** verify:

- physical microphone capture reaches the model;
- remote audio is audible through an iPhone speaker, receiver, wired accessory, or Bluetooth route;
- real-device permission prompts, lock behavior, incoming interruptions, or route changes;
- development signing, installation, or launch on an iPhone;
- a live deployed backend, temporary token, or end-to-end Realtime session.

Simulator success must never be described as hardware voice proof. Those checks are deferred to the pre-release hardware gate below, targeted for Phase 8 or a dedicated follow-up. They do not block completion of the Simulator-readiness scope in Phase 5.

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

## Phase 5 requirements

- macOS with Node.js 22.12 or newer
- Xcode 26.0 or newer with its command-line tools selected
- at least one available iPhone Simulator runtime
- the repository's exact npm dependency graph

The app uses bundle identifier `com.rileyjarvis.vector`, Swift Package Manager, and the default `capacitor://localhost` WKWebView origin. CocoaPods is not required.

The deferred hardware gate additionally requires a paired iPhone, Developer Mode on iOS 16 or newer, an authorized signing team/profile, a reachable HTTPS backend, an approved temporary bootstrap credential, and server-side OpenAI key/policy configuration. Apple requires [Developer Mode for locally installed development apps](https://developer.apple.com/news/?id=r1sz7dke).

## Backend configuration for live and deferred hardware testing

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

This path is implemented and compile-verified in Phase 5, but provisioning and live use on an iPhone remain part of the deferred hardware gate. To provision an approved temporary credential:

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

## Implemented microphone and audio behavior

`NSMicrophoneUsageDescription` is present. The Start button is the only path that requests capture. Automated tests and native compilation verify that the implementation:

- requests microphone permission and reports denied or restricted access with Settings guidance;
- activates `AVAudioSession` as `playAndRecord` with `voiceChat`;
- configures the built-in speaker preference for hands-free voice while permitting Bluetooth HFP and wired routes;
- exposes only sanitized route classes such as speaker, receiver, wired headset, or Bluetooth;
- allows WKWebView microphone capture only for the exact main-frame `capacitor://localhost` origin and denies camera, combined capture, subframes, and other origins.

The app is designed to create one microphone track, one peer connection, one data channel, and one remote audio element per attempt. It never enables background audio or persistent recording.

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

These are verified implementation contracts, not observations of real iPhone audio hardware. Speaker audibility, Bluetooth/wired routing, echo behavior, physical interruption delivery, and microphone capture remain unverified until the deferred hardware gate.

## Install, sync, compile, and launch in Simulator

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

For representative UI coverage, install and launch the resulting Debug app on a current full-size iPhone Simulator and a compact iPhone Simulator. Confirm that Talk, Artifacts, and Activity render, Computer and Remote Codex remain absent, and the Talk screen is labeled **Voice preview**. In Artifacts, create/read/update/delete a note and record, search a record collection, save and remove a supported current artifact, terminate and relaunch to verify restoration, browse Saved, present and cancel the native share sheet, and confirm a rejected unsafe image or size limit fails clearly. Startup without backend provisioning must still fail closed.

Without a deployed backend and Keychain bootstrap credential, tapping Start must fail closed with a clear setup message. Simulator UI, compile success, installation, and launch prove only Simulator readiness—not microphone input, audible output, accessories, real interruptions, signing, or physical-iPhone behavior.

## Deferred pre-release physical-iPhone hardware gate

This gate is targeted for Phase 8 or a dedicated pre-release follow-up. It is required before presenting iOS voice as hardware-validated, enabling a production release, TestFlight distribution, or removing the in-app **Voice preview** disclosure. It is not part of Phase 5 Simulator-readiness acceptance.

Before the deferred run, confirm the device appears without recording its UDID:

```bash
xcrun devicectl list devices
xcodebuild \
  -project ios/App/App.xcodeproj \
  -scheme App \
  -showdestinations
```

In Xcode, select the App target, choose the authorized team under **Signing & Capabilities**, select the paired iPhone, and run the exact commit under review. Automatic signing may create or refresh the development profile.

Record only the device model, iOS version, app build, exact Git commit, date, and pass/fail outcomes. Do not retain screenshots, UDIDs, profiles, certificates, console archives, tokens, transcripts, or audio.

The same exact release candidate must pass all of the following:

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

Media- or lifecycle-affecting changes after this run invalidate the hardware evidence. Rerun the physical checklist on the new release candidate before removing preview status or releasing.

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
npm run native-data:test
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

Phase 6 does not add hardware voice proof, background audio, always-on recording, production accounts, analytics, push notifications, subscriptions, quotas, cloud sync, TestFlight, or App Store submission. Phase 7 customer authentication and synchronization remain explicitly deferred. Physical-iPhone voice proof remains assigned to Phase 8 or a dedicated pre-release follow-up.
