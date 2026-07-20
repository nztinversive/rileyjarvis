import Capacitor
import Foundation
import Security

enum VectorSecureCredentialStoreError: Error {
    case invalidValue
    case readFailed
    case writeFailed
    case deleteFailed
}

enum VectorSecureCredentialStore {
    private static let account = "bootstrap-session-credential"

    private static var baseQuery: [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: Bundle.main.bundleIdentifier ?? "com.rileyjarvis.vector",
            kSecAttrAccount: account
        ]
    }

    static func read() throws -> String? {
        var query = baseQuery
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess,
              let data = item as? Data,
              let value = String(data: data, encoding: .utf8) else {
            throw VectorSecureCredentialStoreError.readFailed
        }
        return value
    }

#if DEBUG
    static func write(_ value: String) throws {
        guard !value.isEmpty,
              value.lengthOfBytes(using: .utf8) <= 4096,
              let data = value.data(using: .utf8) else {
            throw VectorSecureCredentialStoreError.invalidValue
        }

        let updates: [CFString: Any] = [
            kSecValueData: data,
            kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]
        let updateStatus = SecItemUpdate(baseQuery as CFDictionary, updates as CFDictionary)
        if updateStatus == errSecSuccess {
            return
        }
        guard updateStatus == errSecItemNotFound else {
            throw VectorSecureCredentialStoreError.writeFailed
        }

        var item = baseQuery
        updates.forEach { item[$0.key] = $0.value }
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else {
            throw VectorSecureCredentialStoreError.writeFailed
        }
    }
#endif

    static func delete() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw VectorSecureCredentialStoreError.deleteFailed
        }
    }
}

@objc(VectorSecureStoragePlugin)
public final class VectorSecureStoragePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VectorSecureStoragePlugin"
    public let jsName = "VectorSecureStorage"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "delete", returnType: CAPPluginReturnPromise)
    ]

    // This narrow bootstrap credential boundary is temporary. A later account phase
    // replaces it with customer authentication. Release builds cannot provision.
    @objc public func get(_ call: CAPPluginCall) {
        do {
            let storedValue = try VectorSecureCredentialStore.read()
            call.resolve(["value": storedValue ?? NSNull()])
        } catch {
            call.reject("Secure credential storage is unavailable.", "SECURE_STORAGE_READ_FAILED")
        }
    }

    @objc public func delete(_ call: CAPPluginCall) {
        do {
            try VectorSecureCredentialStore.delete()
            call.resolve()
        } catch {
            call.reject("Secure credential storage is unavailable.", "SECURE_STORAGE_DELETE_FAILED")
        }
    }
}
