# Vector iOS development

Phase 4 adds an intentional mobile interface to the Capacitor 8 iOS 15+ shell. It proves the native presentation, navigation, safe-area layout, keyboard behavior, and interaction model in iPhone Simulators. It does not claim that Realtime voice works on a physical iPhone; microphone/WebRTC and audio-route proof remain Phase 5.

## Mobile navigation

Native iOS presents three bottom tabs:

- **Talk** centers the assistant, connection state, transcript status, one primary conversation control, and an optional typed-message composer.
- **Artifacts** gives text and image artifacts their own scrolling screen instead of relying on the desktop split pane. External links still pass through the iOS platform adapter and open only safe HTTPS URLs.
- **Activity** shows the locally available connection, mood, status, and conversation history.

The tab bar and header respect the top and bottom safe areas. Primary controls are at least 44 points, and the layout uses the dynamic viewport so the composer remains usable when the software keyboard is visible. Compact portrait phones and modern Dynamic Island phones are supported; landscape is usable but this phase does not claim iPad optimization.

Computer mode and Remote Codex are not available in the iOS navigation or capability boundary. Their existing Electron UI and behavior remain unchanged.

## Requirements

- macOS
- Node.js 22 or newer
- Xcode 26.0 or newer with the command-line tools selected
- An HTTPS deployment of the Phase 2 Realtime session service
- For a physical device, an Apple development team and a paired iPhone

Capacitor uses Swift Package Manager for this project. CocoaPods is not required. The app is named `Vector`, uses bundle identifier `com.rileyjarvis.vector`, serves the built Vite app from `dist`, and keeps the default `capacitor://localhost` WKWebView origin.

## Install and configure

Install the exact npm dependency graph:

```bash
npm ci
```

Create or update the ignored `.env.local` with the non-secret backend origin:

```dotenv
VITE_VECTOR_BACKEND_URL=https://your-vector-backend.example
```

The value must be an HTTPS origin without credentials, a path, query, or fragment. The backend must allow the `capacitor://localhost` origin when the request includes an origin. Do not put an OpenAI key or backend bearer credential in this file, the Capacitor config, an Xcode setting, `Info.plist`, or the web bundle.

## Bootstrap credential boundary

`VectorSecureStorage` stores one temporary bootstrap session credential as a generic-password Keychain item with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`. It has only `get`, `set`, and `delete` operations and has no Preferences fallback.

The iOS app intentionally has no account or token-entry UI and does not create or request a real credential. An approved provisioning flow must pass its credential directly to:

```ts
import { setIOSBootstrapCredential } from "./platform/capacitor";

await setIOSBootstrapCredential(credentialFromApprovedProvisioningFlow);
```

Sign out or credential revocation must call:

```ts
import { deleteIOSBootstrapCredential } from "./platform/capacitor";

await deleteIOSBootstrapCredential();
```

Those functions are exported from `src/platform/capacitor.ts`. Do not log the value, place it in a URL, persist it in JavaScript storage, or add it to source. Until the native boundary has been provisioned, Realtime startup fails closed with a missing-Keychain-credential message. Sign in with Apple replaces this temporary provisioning boundary in Phase 7.

## Simulator

Build the web app, sync native dependencies and assets, select a Simulator, and run:

```bash
npm run ios:run
```

For Xcode-driven development:

```bash
npm run ios:open
```

`ios:open` performs a fresh build and sync before opening `ios/App/App.xcodeproj`. Select an iPhone Simulator and press Run. Without an approved backend and Keychain bootstrap credential, the conversation control must report a clear error; this is expected and must not be treated as microphone or Realtime success.

### Simulator UI QA

Exercise at least one compact and one modern viewport, for example iPhone SE (3rd generation) and iPhone 17 Pro:

```bash
npm run ios:sync
xcrun simctl list devices available
npx cap run ios --target <SIMULATOR_UDID>
```

For a signing-disabled compile independent of an Xcode signing team:

```bash
xcodebuild \
  -project ios/App/App.xcodeproj \
  -scheme App \
  -configuration Debug \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO \
  build
```

On each representative device:

1. Open Talk, Artifacts, and Activity and confirm the tab selection and screen heading update.
2. Confirm the header, assistant, primary control, and tab bar avoid the notch/Dynamic Island, Home indicator, and all horizontal clipping.
3. Open the typed-message composer, focus the input, type text, and verify the focused control stays visible above the software keyboard.
4. Trigger the conversation control without provisioning and confirm an explicit error and retry state, not a false connected/listening state.
5. Rotate to landscape and confirm navigation and controls remain reachable.
6. Confirm there is no Computer or Remote Codex entry point.

Simulator screenshots and build products are QA evidence only and must not be committed.

## Physical device

Connect and trust the iPhone, then:

```bash
npm run ios:sync
npm run ios:open
```

In Xcode, select the App target, choose the developer team under Signing & Capabilities, select the paired device, and press Run. Provision the temporary bootstrap credential only through the native secure-storage boundary described above. Phase 4 does not enable background audio, subscriptions, remote tool execution, or final account authentication.

Running the shell on a device is not Phase 5 voice proof. Physical-device microphone permission, audio routing, interruption handling, WebRTC behavior, and an end-to-end Realtime call still require Phase 5 validation.

## Verification

The complete native compile check is:

```bash
npm run ios:verify
```

It runs the Vite build, Capacitor sync, and a generic iOS Simulator `xcodebuild` with code signing disabled. Generated web assets under `ios/App/App/public`, native build products, DerivedData, `xcuserdata`, and generated Capacitor config files are ignored and must not be committed.

The scaffold follows the current [Capacitor 8 iOS requirements](https://capacitorjs.com/docs/ios), [development workflow](https://capacitorjs.com/docs/basics/workflow), and [local iOS plugin registration](https://capacitorjs.com/docs/ios/custom-code).
