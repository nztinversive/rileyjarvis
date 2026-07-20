# Vector iOS development

Phase 3 adds a Capacitor 8 iOS 15+ shell, a real `IOSVectorPlatform`, and a narrow Keychain bridge. It proves that the project builds for an iOS Simulator. It does not claim that Realtime voice works on a physical iPhone; microphone/WebRTC proof is Phase 5.

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

Phase 3 intentionally has no account or token-entry UI and does not create or request a real credential. An approved provisioning flow must pass its credential directly to:

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

`ios:open` performs a fresh build and sync before opening `ios/App/App.xcodeproj`. Select an iPhone Simulator and press Run. The first attempted voice connection triggers the microphone permission prompt described by `NSMicrophoneUsageDescription`.

## Physical device

Connect and trust the iPhone, then:

```bash
npm run ios:sync
npm run ios:open
```

In Xcode, select the App target, choose the developer team under Signing & Capabilities, select the paired device, and press Run. Provision the temporary bootstrap credential only through the native secure-storage boundary described above. Phase 3 does not enable background audio, subscriptions, remote tool execution, or final account authentication.

Running the shell on a device is not Phase 5 voice proof. Physical-device microphone permission, audio routing, interruption handling, WebRTC behavior, and an end-to-end Realtime call still require Phase 5 validation.

## Verification

The complete native compile check is:

```bash
npm run ios:verify
```

It runs the Vite build, Capacitor sync, and a generic iOS Simulator `xcodebuild` with code signing disabled. Generated web assets under `ios/App/App/public`, native build products, DerivedData, `xcuserdata`, and generated Capacitor config files are ignored and must not be committed.

The scaffold follows the current [Capacitor 8 iOS requirements](https://capacitorjs.com/docs/ios), [development workflow](https://capacitorjs.com/docs/basics/workflow), and [local iOS plugin registration](https://capacitorjs.com/docs/ios/custom-code).
