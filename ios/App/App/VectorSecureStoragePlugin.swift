import Capacitor
import Foundation
import Security

@objc(VectorSecureStoragePlugin)
public final class VectorSecureStoragePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VectorSecureStoragePlugin"
    public let jsName = "VectorSecureStorage"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "delete", returnType: CAPPluginReturnPromise)
    ]

    private let account = "bootstrap-session-credential"

    // This narrow bootstrap credential boundary is temporary. A later account phase
    // replaces the provisioning flow with Sign in with Apple without changing how
    // the Phase 3 adapter asks native secure storage for its bearer credential.
    private var baseQuery: [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: Bundle.main.bundleIdentifier ?? "com.rileyjarvis.vector",
            kSecAttrAccount: account
        ]
    }

    @objc public func get(_ call: CAPPluginCall) {
        var query = baseQuery
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            call.resolve(["value": NSNull()])
            return
        }
        guard status == errSecSuccess,
              let data = item as? Data,
              let value = String(data: data, encoding: .utf8) else {
            call.reject("Secure credential storage is unavailable.", "SECURE_STORAGE_READ_FAILED")
            return
        }
        call.resolve(["value": value])
    }

    @objc public func set(_ call: CAPPluginCall) {
        guard let value = call.getString("value"),
              !value.isEmpty,
              value.lengthOfBytes(using: .utf8) <= 4096,
              let data = value.data(using: .utf8) else {
            call.reject("A valid bootstrap credential is required.", "SECURE_STORAGE_INVALID_VALUE")
            return
        }

        let updates: [CFString: Any] = [
            kSecValueData: data,
            kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]
        let updateStatus = SecItemUpdate(baseQuery as CFDictionary, updates as CFDictionary)
        if updateStatus == errSecSuccess {
            call.resolve()
            return
        }
        guard updateStatus == errSecItemNotFound else {
            call.reject("Secure credential storage is unavailable.", "SECURE_STORAGE_WRITE_FAILED")
            return
        }

        var item = baseQuery
        updates.forEach { item[$0.key] = $0.value }
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else {
            call.reject("Secure credential storage is unavailable.", "SECURE_STORAGE_WRITE_FAILED")
            return
        }
        call.resolve()
    }

    @objc public func delete(_ call: CAPPluginCall) {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            call.reject("Secure credential storage is unavailable.", "SECURE_STORAGE_DELETE_FAILED")
            return
        }
        call.resolve()
    }
}
