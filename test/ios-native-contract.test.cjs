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
  assert.match(plugin, /CAPPluginMethod\(name: "set"/);
  assert.match(plugin, /CAPPluginMethod\(name: "delete"/);
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
  assert.match(bridge, /secureStorage\.set/);
  assert.match(bridge, /secureStorage\.delete/);
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

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}
