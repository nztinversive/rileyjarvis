const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("the native Keychain plugin is narrow, device-only, and registered with Capacitor", () => {
  const plugin = read("ios/App/App/VectorSecureStoragePlugin.swift");
  const controller = read("ios/App/App/VectorBridgeViewController.swift");
  const storyboard = read("ios/App/App/Base.lproj/Main.storyboard");
  const project = read("ios/App/App.xcodeproj/project.pbxproj");
  const bridge = read("src/platform/capacitor.ts");
  const adapter = read("src/platform/ios.ts");

  assert.match(plugin, /CAPPlugin, CAPBridgedPlugin/);
  assert.match(plugin, /CAPPluginMethod\(name: "get"/);
  assert.match(plugin, /CAPPluginMethod\(name: "delete"/);
  assert.doesNotMatch(plugin, /CAPPluginMethod\(name: "set"/);
  assert.match(plugin, /kSecAttrAccessibleWhenUnlockedThisDeviceOnly/);
  assert.match(plugin, /SecItemCopyMatching/);
  assert.match(plugin, /SecItemUpdate/);
  assert.match(plugin, /SecItemAdd/);
  assert.match(plugin, /SecItemDelete/);
  assert.doesNotMatch(plugin, /UserDefaults|Preferences|localStorage/);
  assert.match(controller, /registerPluginInstance\(VectorSecureStoragePlugin\(\)\)/);
  assert.match(storyboard, /customClass="VectorBridgeViewController"/);
  assert.match(project, /VectorSecureStoragePlugin\.swift in Sources/);
  assert.match(project, /VectorBridgeViewController\.swift in Sources/);
  assert.match(adapter, /secureStorage\.get/);
  assert.match(bridge, /secureStorage\.delete/);
  assert.doesNotMatch(bridge, /secureStorage\.set/);
  assert.match(bridge, /App\.addListener\("pause"/);
  assert.match(bridge, /App\.addListener\("resume"/);
  assert.doesNotMatch(bridge, /appStateChange/);
});

test("the iOS project declares microphone purpose, secure defaults, and no background audio", () => {
  const info = read("ios/App/App/Info.plist");
  const project = read("ios/App/App.xcodeproj/project.pbxproj");
  const config = read("capacitor.config.ts");
  const vite = read("vite.config.ts");

  assert.match(info, /<key>NSMicrophoneUsageDescription<\/key>\s*<string>[^<]+<\/string>/);
  assert.doesNotMatch(info, /NSAppTransportSecurity|NSAllowsArbitraryLoads/);
  assert.doesNotMatch(info, /UIBackgroundModes|audio/);
  assert.match(project, /PRODUCT_BUNDLE_IDENTIFIER = com\.rileyjarvis\.vector;/);
  assert.match(project, /IPHONEOS_DEPLOYMENT_TARGET = 15\.0;/);
  assert.match(config, /appName: "Vector"/);
  assert.match(config, /webDir: "dist"/);
  assert.match(config, /contentInset: "automatic"/);
  assert.match(config, /iosScheme: "capacitor"/);
  assert.doesNotMatch(config, /allowNavigation|cleartext:\s*true/);
  assert.match(vite, /target: "safari15"/);
});

test("the native audio session plugin prepares voice chat and reports sanitized lifecycle events", () => {
  const plugin = read("ios/App/App/VectorAudioSessionPlugin.swift");
  const controller = read("ios/App/App/VectorBridgeViewController.swift");
  const project = read("ios/App/App.xcodeproj/project.pbxproj");

  assert.match(plugin, /jsName = "VectorAudioSession"/);
  assert.match(plugin, /CAPPluginMethod\(name: "prepare"/);
  assert.match(plugin, /CAPPluginMethod\(name: "deactivate"/);
  assert.match(plugin, /AVAudioApplication\.requestRecordPermission/);
  assert.match(plugin, /audioSession\.requestRecordPermission/);
  assert.match(plugin, /\.playAndRecord/);
  assert.match(plugin, /mode: \.voiceChat/);
  assert.match(plugin, /\.allowBluetooth/);
  assert.match(plugin, /\.defaultToSpeaker/);
  assert.match(plugin, /setActive\(false, options: \.notifyOthersOnDeactivation\)/);
  assert.match(plugin, /AVAudioSession\.interruptionNotification/);
  assert.match(plugin, /AVAudioSession\.routeChangeNotification/);
  assert.match(plugin, /AVAudioSession\.mediaServicesWereResetNotification/);
  assert.match(plugin, /protectedDataWillBecomeUnavailableNotification/);
  assert.match(plugin, /UIApplication\.didEnterBackgroundNotification/);
  assert.match(plugin, /preparationGeneration/);
  assert.match(plugin, /AUDIO_SESSION_PREPARE_CANCELLED/);
  assert.match(plugin, /generation == self\.preparationGeneration/);
  assert.match(plugin, /"stateChanged"/);
  assert.match(plugin, /"route-unavailable"/);
  assert.match(plugin, /"media-services-reset"/);
  assert.match(plugin, /"protected-data-unavailable"/);
  assert.doesNotMatch(plugin, /portName|print\(|CAPLog|NSLog/);
  assert.match(controller, /registerPluginInstance\(VectorAudioSessionPlugin\(\)\)/);
  assert.match(project, /VectorAudioSessionPlugin\.swift in Sources/);
});

test("WKWebView grants only trusted main-frame microphone capture", () => {
  const delegate = read("ios/App/App/VectorWebViewUIDelegate.swift");
  const controller = read("ios/App/App/VectorBridgeViewController.swift");
  const project = read("ios/App/App.xcodeproj/project.pbxproj");

  assert.match(delegate, /frame\.isMainFrame/);
  assert.match(delegate, /origin\.protocol == "capacitor"/);
  assert.match(delegate, /origin\.host == "localhost"/);
  assert.match(delegate, /type == \.microphone/);
  assert.match(delegate, /\? \.grant : \.deny/);
  assert.match(delegate, /forwardingTarget/);
  assert.match(controller, /VectorWebViewUIDelegate\(forwarding: webView\.uiDelegate\)/);
  assert.match(project, /VectorWebViewUIDelegate\.swift in Sources/);
});

test("temporary credential provisioning is launch-gated, DEBUG-only, and device-only", () => {
  const provisioner = read("ios/App/App/VectorDebugCredentialProvisioner.swift");
  const storage = read("ios/App/App/VectorSecureStoragePlugin.swift");
  const controller = read("ios/App/App/VectorBridgeViewController.swift");
  const project = read("ios/App/App.xcodeproj/project.pbxproj");

  assert.match(provisioner, /^#if DEBUG/);
  assert.match(provisioner, /-VectorEnableCredentialProvisioning/);
  assert.match(provisioner, /isSecureTextEntry = true/);
  assert.match(provisioner, /VectorSecureCredentialStore\.write\(credential\)/);
  assert.match(provisioner, /VectorSecureCredentialStore\.delete\(\)/);
  assert.doesNotMatch(provisioner, /UserDefaults|Preferences|localStorage|print\(|CAPLog|NSLog/);
  assert.match(storage, /kSecAttrAccessibleWhenUnlockedThisDeviceOnly/);
  assert.match(storage, /#if DEBUG\s+static func write/s);
  assert.doesNotMatch(storage, /CAPPluginMethod\(name: "set"/);
  assert.match(controller, /#if DEBUG\s+VectorDebugCredentialProvisioner\.presentIfEnabled/s);
  assert.match(project, /VectorDebugCredentialProvisioner\.swift in Sources/);
});

test("native mobile data is protected, atomic, bounded, recoverable, and registered", () => {
  const core = read("ios/App/VectorMobileDataCore/Sources/VectorMobileDataCore/VectorMobileDataCore.swift");
  const plugin = read("ios/App/App/VectorMobileDataPlugin.swift");
  const share = read("ios/App/App/VectorSharePlugin.swift");
  const controller = read("ios/App/App/VectorBridgeViewController.swift");
  const project = read("ios/App/App.xcodeproj/project.pbxproj");

  assert.match(core, /DispatchQueue\(label: "com\.rileyjarvis\.vector\.mobile-data"\)/);
  assert.match(core, /\.atomic/);
  assert.match(core, /FileProtectionType\.complete/);
  assert.match(core, /isExcludedFromBackup = true/);
  assert.match(core, /schemaVersion/);
  assert.match(core, /maxFileBytes/);
  assert.match(core, /corrupt-/);
  assert.match(core, /moveItem\(at: storeURL, to: backup\)/);
  assert.match(core, /readData: \{ try Data\(contentsOf: \$0\) \}/);
  assert.match(core, /let data = try readData\(storeURL\)\s+do \{/);
  assert.match(core, /contractEncoder\.encode\(fields\)/);
  assert.doesNotMatch(core + plugin, /UserDefaults|Preferences|localStorage/);
  assert.match(plugin, /jsName = "VectorMobileData"/);
  assert.match(plugin, /CAPPluginMethod\(name: "createNote"/);
  assert.match(plugin, /CAPPluginMethod\(name: "confirmDeletion"/);
  assert.match(plugin, /UIAlertController/);
  assert.match(plugin, /style: \.destructive/);
  assert.match(plugin, /confirmationInProgress/);
  assert.match(plugin, /presentedViewController == nil/);
  assert.match(plugin, /CONFIRMATION_IN_PROGRESS/);
  assert.match(plugin, /deleteNote\(ifUnchanged: item\)/);
  assert.match(plugin, /deleteRecord\(ifUnchanged: item\)/);
  assert.match(plugin, /deleteArtifact\(ifUnchanged: item\)/);
  assert.match(core, /case itemChanged/);
  assert.match(plugin, /alert\.dismiss\([\s\S]*?confirmationInProgress = false[\s\S]*?call\.resolve/);
  assert.match(plugin, /\{ \[weak alert\] confirmed in/);
  assert.match(plugin, /CAPPluginMethod\(name: "createRecord"/);
  assert.match(plugin, /CAPPluginMethod\(name: "saveArtifact"/);
  assert.match(share, /UIActivityViewController/);
  assert.match(share, /VectorExports/);
  assert.match(share, /override func load\(\)[\s\S]*?removeItem\(at: exportRoot\)/);
  assert.match(share, /shareInProgress/);
  assert.match(share, /SHARE_IN_PROGRESS/);
  assert.match(core, /components\.scheme\?\.lowercased\(\) == "https"/);
  assert.match(share, /components\.scheme\?\.lowercased\(\) == "https"/);
  assert.match(share, /\.completeFileProtection/);
  assert.match(share, /completionWithItemsHandler[\s\S]*?removeItem/);
  assert.match(controller, /registerPluginInstance\(VectorMobileDataPlugin\(\)\)/);
  assert.match(controller, /registerPluginInstance\(VectorSharePlugin\(\)\)/);
  assert.match(project, /VectorMobileDataCore\.swift in Sources/);
  assert.match(project, /VectorMobileDataPlugin\.swift in Sources/);
  assert.match(project, /VectorSharePlugin\.swift in Sources/);
  const library = read("src/components/MobileLibrary.tsx");
  const mobileShell = read("src/components/MobileAppShell.tsx");
  assert.match(library, /setEditDraft\(\{ id: item\.id, text: item\.text \}\)/);
  assert.match(library, /if \(saved\) setEditDraft\(null\)/);
  assert.match(library, /disabled=\{pending \|\| Boolean\(editDraft\)\}/);
  assert.doesNotMatch(library, /const \[editDraft, setEditDraft\] = useState/);
  assert.match(mobileShell, /useState<MobileNoteEditDraft \| null>\(null\)/);
  assert.match(mobileShell, /editDraft=\{noteEditDraft\}[\s\S]*?setEditDraft=\{setNoteEditDraft\}/);
  assert.doesNotMatch(library, /promptContentEdit/);
});

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}
