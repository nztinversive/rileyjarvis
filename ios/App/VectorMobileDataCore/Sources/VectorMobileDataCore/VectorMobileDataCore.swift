import Foundation
import CoreFoundation

public enum VectorJSONValue: Codable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: VectorJSONValue])
    case array([VectorJSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([String: VectorJSONValue].self) { self = .object(value) }
        else if let value = try? container.decode([VectorJSONValue].self) { self = .array(value) }
        else { throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value") }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}

public struct VectorMobileNote: Codable, Equatable, Sendable {
    public let id: String
    public var text: String
    public var tags: [String]
    public let createdAt: String
    public var updatedAt: String
}

public struct VectorMobileRecord: Codable, Equatable, Sendable {
    public let id: String
    public var collection: String
    public var title: String
    public var fields: [String: VectorJSONValue]
    public let createdAt: String
    public var updatedAt: String
}

public struct VectorSavedArtifact: Codable, Equatable, Sendable {
    public let id: String
    public var title: String
    public var kind: String
    public var content: String
    public var language: String?
    public let createdAt: String
    public var updatedAt: String
}

public struct VectorMobileDataDocument: Codable, Equatable, Sendable {
    public var schemaVersion: Int
    public var notes: [VectorMobileNote]
    public var records: [VectorMobileRecord]
    public var savedArtifacts: [VectorSavedArtifact]

    public init(schemaVersion: Int = 1, notes: [VectorMobileNote] = [], records: [VectorMobileRecord] = [], savedArtifacts: [VectorSavedArtifact] = []) {
        self.schemaVersion = schemaVersion
        self.notes = notes
        self.records = records
        self.savedArtifacts = savedArtifacts
    }
}

public struct VectorMobileDataSnapshot: Sendable {
    public let document: VectorMobileDataDocument
    public let recoveredCorruptStore: String?
}

private struct VectorMobileDataVersionEnvelope: Decodable {
    let schemaVersion: Int
}

public enum VectorMobileDataError: LocalizedError, Equatable {
    case invalid(String)
    case notFound
    case confirmationRequired
    case itemChanged
    case storageLimit
    case unsupportedSchema
    case corruptStorePreserved(String)

    public var errorDescription: String? {
        switch self {
        case .invalid(let message): return message
        case .notFound: return "Item not found."
        case .confirmationRequired: return "Explicit confirmation is required."
        case .itemChanged: return "The selected item changed. Review it and confirm deletion again."
        case .storageLimit: return "Local storage limit reached."
        case .unsupportedSchema: return "This data was created by a newer Vector version."
        case .corruptStorePreserved: return "Local data was damaged. The original file was preserved for recovery."
        }
    }
}

public extension VectorJSONValue {
    static func fromFoundation(_ value: Any, depth: Int = 0) throws -> VectorJSONValue {
        guard depth <= 8 else { throw VectorMobileDataError.invalid("Record data is too deeply nested.") }
        if value is NSNull { return .null }
        if let number = value as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return .bool(number.boolValue) }
            guard number.doubleValue.isFinite else { throw VectorMobileDataError.invalid("Record data contains an invalid number.") }
            return .number(number.doubleValue)
        }
        if let value = value as? String { return .string(value) }
        if let value = value as? [Any] { return .array(try value.map { try fromFoundation($0, depth: depth + 1) }) }
        if let value = value as? [String: Any] {
            return .object(try value.reduce(into: [:]) { result, entry in
                guard !entry.key.isEmpty, entry.key.count <= 80,
                      !["__proto__", "prototype", "constructor"].contains(entry.key) else {
                    throw VectorMobileDataError.invalid("Record data contains a reserved or invalid field.")
                }
                result[entry.key] = try fromFoundation(entry.value, depth: depth + 1)
            })
        }
        throw VectorMobileDataError.invalid("Record data contains an unsupported value.")
    }
}

public final class VectorMobileDataStore: @unchecked Sendable {
    public static let schemaVersion = 1
    public static let maxFileBytes = 2_000_000
    public static let maxNotes = 200
    public static let maxRecords = 200
    public static let maxArtifacts = 100
    public static let maxTextBytes = 48_000
    public static let maxRecordBytes = 16_384
    public static let maxArtifactBytes = 256_000

    private let queue = DispatchQueue(label: "com.rileyjarvis.vector.mobile-data")
    private let directoryURL: URL
    private let storeURL: URL
    private let encoder: JSONEncoder
    private let decoder = JSONDecoder()
    private var loaded: VectorMobileDataDocument?
    private var recoveredCorruptStore: String?

    public init(directoryURL: URL) {
        self.directoryURL = directoryURL
        self.storeURL = directoryURL.appendingPathComponent("vector-mobile-data.json", isDirectory: false)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        self.encoder = encoder
    }

    public func snapshot() throws -> VectorMobileDataSnapshot {
        try queue.sync {
            let document = try loadLocked()
            let recovery = recoveredCorruptStore
            recoveredCorruptStore = nil
            return VectorMobileDataSnapshot(document: sorted(document), recoveredCorruptStore: recovery)
        }
    }

    @discardableResult
    public func addNote(text: String, tags: [String], now: Date = Date(), id: String = UUID().uuidString.lowercased()) throws -> VectorMobileNote {
        try queue.sync {
            let cleanText = try boundedContent(text, label: "Note", maxBytes: Self.maxTextBytes)
            guard tags.count <= 12 else { throw VectorMobileDataError.invalid("A note can have at most 12 tags.") }
            let cleanTags = try tags.map { try bounded($0, label: "Tag", maxBytes: 192) }
            var document = try loadLocked()
            guard document.notes.count < Self.maxNotes else { throw VectorMobileDataError.storageLimit }
            let timestamp = iso(now)
            let note = VectorMobileNote(id: id, text: cleanText, tags: cleanTags, createdAt: timestamp, updatedAt: timestamp)
            document.notes.append(note)
            try persistLocked(document)
            return note
        }
    }

    @discardableResult
    public func updateNote(id: String, text: String?, tags: [String]?, now: Date = Date()) throws -> VectorMobileNote {
        try queue.sync {
            var document = try loadLocked()
            guard let index = document.notes.firstIndex(where: { $0.id == id }) else { throw VectorMobileDataError.notFound }
            if let text { document.notes[index].text = try boundedContent(text, label: "Note", maxBytes: Self.maxTextBytes) }
            if let tags {
                guard tags.count <= 12 else { throw VectorMobileDataError.invalid("A note can have at most 12 tags.") }
                document.notes[index].tags = try tags.map { try bounded($0, label: "Tag", maxBytes: 192) }
            }
            document.notes[index].updatedAt = iso(now)
            let note = document.notes[index]
            try persistLocked(document)
            return note
        }
    }

    @discardableResult
    public func deleteNote(id: String) throws -> Bool {
        try queue.sync {
            var document = try loadLocked()
            let before = document.notes.count
            document.notes.removeAll { $0.id == id }
            guard document.notes.count != before else { return false }
            try persistLocked(document)
            return true
        }
    }

    @discardableResult
    public func deleteNote(ifUnchanged expected: VectorMobileNote) throws -> Bool {
        try queue.sync {
            var document = try loadLocked()
            guard let index = document.notes.firstIndex(where: { $0.id == expected.id }) else { return false }
            guard document.notes[index] == expected else { throw VectorMobileDataError.itemChanged }
            document.notes.remove(at: index)
            try persistLocked(document)
            return true
        }
    }

    @discardableResult
    public func createRecord(collection: String, title: String, fields: [String: VectorJSONValue], now: Date = Date(), id: String = UUID().uuidString.lowercased()) throws -> VectorMobileRecord {
        try queue.sync {
            let cleanCollection = try bounded(collection, label: "Collection", maxBytes: 256)
            let cleanTitle = try bounded(title, label: "Title", maxBytes: 640)
            try validateFields(fields)
            var document = try loadLocked()
            guard document.records.count < Self.maxRecords else { throw VectorMobileDataError.storageLimit }
            let timestamp = iso(now)
            let record = VectorMobileRecord(id: id, collection: cleanCollection, title: cleanTitle, fields: fields, createdAt: timestamp, updatedAt: timestamp)
            document.records.append(record)
            try persistLocked(document)
            return record
        }
    }

    public func searchRecords(collection: String, query: String, limit: Int = 100) throws -> [VectorMobileRecord] {
        try queue.sync {
            let cleanCollection = try bounded(collection, label: "Collection", maxBytes: 256)
            let cleanQuery = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard cleanQuery.lengthOfBytes(using: .utf8) <= 640 else {
                throw VectorMobileDataError.invalid("Search query is too large.")
            }
            let document = try loadLocked()
            return sorted(document).records.filter { record in
                guard record.collection == cleanCollection else { return false }
                guard !cleanQuery.isEmpty else { return true }
                let fieldText = (try? String(data: encoder.encode(record.fields), encoding: .utf8)) ?? ""
                return record.title.lowercased().contains(cleanQuery) || fieldText.lowercased().contains(cleanQuery)
            }.prefix(max(1, min(limit, 100))).map { $0 }
        }
    }

    @discardableResult
    public func updateRecord(id: String, title: String?, fields: [String: VectorJSONValue]?, now: Date = Date()) throws -> VectorMobileRecord {
        try queue.sync {
            var document = try loadLocked()
            guard let index = document.records.firstIndex(where: { $0.id == id }) else { throw VectorMobileDataError.notFound }
            if let title { document.records[index].title = try bounded(title, label: "Title", maxBytes: 640) }
            if let fields {
                try validateFields(fields)
                document.records[index].fields.merge(fields) { _, new in new }
            }
            document.records[index].updatedAt = iso(now)
            let record = document.records[index]
            try persistLocked(document)
            return record
        }
    }

    @discardableResult
    public func deleteRecord(id: String, confirmed: Bool) throws -> Bool {
        guard confirmed else { throw VectorMobileDataError.confirmationRequired }
        return try queue.sync {
            var document = try loadLocked()
            let before = document.records.count
            document.records.removeAll { $0.id == id }
            guard document.records.count != before else { return false }
            try persistLocked(document)
            return true
        }
    }

    @discardableResult
    public func deleteRecord(ifUnchanged expected: VectorMobileRecord) throws -> Bool {
        try queue.sync {
            var document = try loadLocked()
            guard let index = document.records.firstIndex(where: { $0.id == expected.id }) else { return false }
            guard document.records[index] == expected else { throw VectorMobileDataError.itemChanged }
            document.records.remove(at: index)
            try persistLocked(document)
            return true
        }
    }

    @discardableResult
    public func saveArtifact(id: String?, title: String, kind: String, content: String, language: String?, now: Date = Date()) throws -> VectorSavedArtifact {
        try queue.sync {
            let cleanTitle = try bounded(title, label: "Title", maxBytes: 640)
            let cleanKind = try validateArtifactKind(kind)
            let cleanContent = try boundedContent(content, label: "Artifact", maxBytes: Self.maxArtifactBytes)
            let cleanLanguage = try language.map(validateLanguage)
            var document = try loadLocked()
            let timestamp = iso(now)
            if let id {
                guard let index = document.savedArtifacts.firstIndex(where: { $0.id == id }) else {
                    throw VectorMobileDataError.notFound
                }
                document.savedArtifacts[index].title = cleanTitle
                document.savedArtifacts[index].kind = cleanKind
                document.savedArtifacts[index].content = cleanContent
                document.savedArtifacts[index].language = cleanLanguage
                document.savedArtifacts[index].updatedAt = timestamp
                let artifact = document.savedArtifacts[index]
                try persistLocked(document)
                return artifact
            }
            guard document.savedArtifacts.count < Self.maxArtifacts else { throw VectorMobileDataError.storageLimit }
            let artifact = VectorSavedArtifact(
                id: UUID().uuidString.lowercased(),
                title: cleanTitle,
                kind: cleanKind,
                content: cleanContent,
                language: cleanLanguage,
                createdAt: timestamp,
                updatedAt: timestamp
            )
            document.savedArtifacts.append(artifact)
            try persistLocked(document)
            return artifact
        }
    }

    @discardableResult
    public func deleteArtifact(id: String, confirmed: Bool) throws -> Bool {
        guard confirmed else { throw VectorMobileDataError.confirmationRequired }
        return try queue.sync {
            var document = try loadLocked()
            let before = document.savedArtifacts.count
            document.savedArtifacts.removeAll { $0.id == id }
            guard document.savedArtifacts.count != before else { return false }
            try persistLocked(document)
            return true
        }
    }

    @discardableResult
    public func deleteArtifact(ifUnchanged expected: VectorSavedArtifact) throws -> Bool {
        try queue.sync {
            var document = try loadLocked()
            guard let index = document.savedArtifacts.firstIndex(where: { $0.id == expected.id }) else { return false }
            guard document.savedArtifacts[index] == expected else { throw VectorMobileDataError.itemChanged }
            document.savedArtifacts.remove(at: index)
            try persistLocked(document)
            return true
        }
    }

    private func loadLocked() throws -> VectorMobileDataDocument {
        if let loaded { return loaded }
        try prepareDirectory()
        guard FileManager.default.fileExists(atPath: storeURL.path) else {
            let document = VectorMobileDataDocument()
            loaded = document
            return document
        }
        let values = try storeURL.resourceValues(forKeys: [.fileSizeKey])
        if (values.fileSize ?? 0) > Self.maxFileBytes {
            if let probedSchemaVersion = try probeSchemaVersionLocked(), probedSchemaVersion != Self.schemaVersion {
                throw VectorMobileDataError.unsupportedSchema
            }
            return try recoverCorruptStoreLocked()
        }
        do {
            let data = try Data(contentsOf: storeURL)
            let envelope = try decoder.decode(VectorMobileDataVersionEnvelope.self, from: data)
            guard envelope.schemaVersion <= Self.schemaVersion else {
                throw VectorMobileDataError.unsupportedSchema
            }
            let decoded = try decoder.decode(VectorMobileDataDocument.self, from: data)
            let document = try migrate(decoded)
            try validate(document)
            loaded = document
            return document
        } catch VectorMobileDataError.unsupportedSchema {
            throw VectorMobileDataError.unsupportedSchema
        } catch {
            return try recoverCorruptStoreLocked()
        }
    }

    private func probeSchemaVersionLocked() throws -> Int? {
        let handle = try FileHandle(forReadingFrom: storeURL)
        defer { try? handle.close() }
        var depth = 0
        var inString = false
        var escaped = false
        var expectingTopLevelKey = false
        var capturingTopLevelKey = false
        var topLevelKeyOverflowed = false
        var keyBytes: [UInt8] = []
        var currentKeyIsSchemaVersion = false
        var waitingForSchemaValue = false
        var numberBytes: [UInt8] = []
        let maxKeyTokenBytes = 128
        let maxNumberTokenBytes = 64

        while let chunk = try handle.read(upToCount: 64 * 1024), !chunk.isEmpty {
            for byte in chunk {
                if inString {
                    if escaped {
                        if capturingTopLevelKey {
                            if keyBytes.count < maxKeyTokenBytes { keyBytes.append(byte) }
                            else { topLevelKeyOverflowed = true }
                        }
                        escaped = false
                        continue
                    }
                    if byte == 0x5C {
                        if capturingTopLevelKey {
                            if keyBytes.count < maxKeyTokenBytes { keyBytes.append(byte) }
                            else { topLevelKeyOverflowed = true }
                        }
                        escaped = true
                        continue
                    }
                    if byte == 0x22 {
                        inString = false
                        if capturingTopLevelKey {
                            if topLevelKeyOverflowed {
                                currentKeyIsSchemaVersion = false
                            } else {
                                let keyLiteral = Data([0x22] + keyBytes + [0x22])
                                currentKeyIsSchemaVersion = (try? decoder.decode(String.self, from: keyLiteral)) == "schemaVersion"
                            }
                            capturingTopLevelKey = false
                            expectingTopLevelKey = false
                        }
                        continue
                    }
                    if capturingTopLevelKey {
                        if keyBytes.count < maxKeyTokenBytes { keyBytes.append(byte) }
                        else { topLevelKeyOverflowed = true }
                    }
                    continue
                }

                if waitingForSchemaValue {
                    if numberBytes.isEmpty && (byte == 0x20 || byte == 0x09 || byte == 0x0A || byte == 0x0D) { continue }
                    if (0x30...0x39).contains(byte) || byte == 0x2D || byte == 0x2B || byte == 0x2E || byte == 0x45 || byte == 0x65 {
                        guard numberBytes.count < maxNumberTokenBytes else {
                            throw VectorMobileDataError.unsupportedSchema
                        }
                        numberBytes.append(byte)
                        continue
                    }
                    return numberBytes.isEmpty ? nil : try? decoder.decode(Int.self, from: Data(numberBytes))
                }

                switch byte {
                case 0x7B, 0x5B:
                    depth += 1
                    if depth == 1 { expectingTopLevelKey = true }
                case 0x7D, 0x5D:
                    if depth == 1, currentKeyIsSchemaVersion { return nil }
                    depth = max(0, depth - 1)
                case 0x2C:
                    if depth == 1 {
                        expectingTopLevelKey = true
                        currentKeyIsSchemaVersion = false
                    }
                case 0x3A:
                    if depth == 1, currentKeyIsSchemaVersion {
                        waitingForSchemaValue = true
                    }
                case 0x22:
                    inString = true
                    if depth == 1, expectingTopLevelKey {
                        capturingTopLevelKey = true
                        topLevelKeyOverflowed = false
                        keyBytes.removeAll(keepingCapacity: true)
                    }
                default:
                    continue
                }
            }
        }
        if waitingForSchemaValue, !numberBytes.isEmpty {
            return try? decoder.decode(Int.self, from: Data(numberBytes))
        }
        return nil
    }

    private func recoverCorruptStoreLocked() throws -> VectorMobileDataDocument {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        let backup = directoryURL.appendingPathComponent("vector-mobile-data.corrupt-\(formatter.string(from: Date()))-\(UUID().uuidString.lowercased()).json")
        try FileManager.default.copyItem(at: storeURL, to: backup)
        recoveredCorruptStore = backup.lastPathComponent
        let document = VectorMobileDataDocument()
        loaded = document
        return document
    }

    private func persistLocked(_ document: VectorMobileDataDocument) throws {
        try validate(document)
        try prepareDirectory()
        let data = try encoder.encode(sorted(document))
        guard data.count <= Self.maxFileBytes else { throw VectorMobileDataError.storageLimit }
        try data.write(to: storeURL, options: [.atomic])
#if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: storeURL.path)
#endif
        loaded = document
    }

    private func migrate(_ document: VectorMobileDataDocument) throws -> VectorMobileDataDocument {
        switch document.schemaVersion {
        case Self.schemaVersion:
            return document
        default:
            throw VectorMobileDataError.unsupportedSchema
        }
    }

    private func prepareDirectory() throws {
        try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
#if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: directoryURL.path)
#endif
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutableDirectory = directoryURL
        try? mutableDirectory.setResourceValues(values)
    }

    private func validate(_ document: VectorMobileDataDocument) throws {
        guard document.schemaVersion == Self.schemaVersion,
              document.notes.count <= Self.maxNotes,
              document.records.count <= Self.maxRecords,
              document.savedArtifacts.count <= Self.maxArtifacts else {
            throw VectorMobileDataError.storageLimit
        }
        for note in document.notes {
            _ = try boundedContent(note.text, label: "Note", maxBytes: Self.maxTextBytes)
            guard note.tags.count <= 12 else { throw VectorMobileDataError.storageLimit }
            for tag in note.tags { _ = try bounded(tag, label: "Tag", maxBytes: 192) }
            try validateID(note.id); try validateTimestamp(note.createdAt); try validateTimestamp(note.updatedAt)
        }
        for record in document.records {
            _ = try bounded(record.collection, label: "Collection", maxBytes: 256)
            _ = try bounded(record.title, label: "Title", maxBytes: 640)
            try validateFields(record.fields)
            try validateID(record.id); try validateTimestamp(record.createdAt); try validateTimestamp(record.updatedAt)
        }
        for artifact in document.savedArtifacts {
            _ = try bounded(artifact.title, label: "Title", maxBytes: 640)
            _ = try validateArtifactKind(artifact.kind)
            let content = try boundedContent(artifact.content, label: "Artifact", maxBytes: Self.maxArtifactBytes)
            if artifact.kind == "image" { try validateSecureImage(content) }
            if let language = artifact.language { _ = try validateLanguage(language) }
            try validateID(artifact.id); try validateTimestamp(artifact.createdAt); try validateTimestamp(artifact.updatedAt)
        }
        let ids = document.notes.map(\.id) + document.records.map(\.id) + document.savedArtifacts.map(\.id)
        guard Set(ids).count == ids.count else { throw VectorMobileDataError.invalid("Duplicate local item IDs are not allowed.") }
    }

    private func validateFields(_ fields: [String: VectorJSONValue]) throws {
        guard fields.count <= 100 else { throw VectorMobileDataError.invalid("Fields are too large.") }
        let data = try encoder.encode(fields)
        guard data.count <= Self.maxRecordBytes else { throw VectorMobileDataError.invalid("Fields are too large.") }
        for key in fields.keys {
            try validateFieldName(key)
        }
        for value in fields.values { try validateJSON(value, depth: 0) }
    }

    private func validateArtifactKind(_ value: String) throws -> String {
        let supported = ["text", "markdown", "code", "table", "notes", "mermaid", "image"]
        guard supported.contains(value) else { throw VectorMobileDataError.invalid("That artifact type cannot be saved on iOS.") }
        return value
    }

    private func validateLanguage(_ value: String) throws -> String {
        let clean = try bounded(value, label: "Language", maxBytes: 128)
        guard clean.count <= 32 else { throw VectorMobileDataError.invalid("Language is too large.") }
        return clean
    }

    private func validateFieldName(_ key: String) throws {
        _ = try bounded(key, label: "Field name", maxBytes: 320)
        guard key.count <= 80 else { throw VectorMobileDataError.invalid("Record data contains an invalid field name.") }
        guard !["__proto__", "prototype", "constructor"].contains(key) else { throw VectorMobileDataError.invalid("Record data contains a reserved field.") }
    }

    private func bounded(_ value: String, label: String, maxBytes: Int) throws -> String {
        let clean = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { throw VectorMobileDataError.invalid("\(label) is required.") }
        guard clean.lengthOfBytes(using: .utf8) <= maxBytes else { throw VectorMobileDataError.invalid("\(label) is too large.") }
        guard hasOnlySafeTextScalars(clean) else { throw VectorMobileDataError.invalid("\(label) contains unsupported control characters.") }
        return clean
    }

    private func boundedContent(_ value: String, label: String, maxBytes: Int) throws -> String {
        guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw VectorMobileDataError.invalid("\(label) is required.") }
        guard value.lengthOfBytes(using: .utf8) <= maxBytes else { throw VectorMobileDataError.invalid("\(label) is too large.") }
        guard hasOnlySafeTextScalars(value) else { throw VectorMobileDataError.invalid("\(label) contains unsupported control characters.") }
        return value
    }

    private func hasOnlySafeTextScalars(_ value: String) -> Bool {
        value.unicodeScalars.allSatisfy { scalar in
            scalar.value >= 32 || scalar == "\t" || scalar == "\n" || scalar == "\r"
        }
    }

    private func validateSecureImage(_ value: String) throws {
        guard let components = URLComponents(string: value), components.scheme == "https", components.host != nil, components.user == nil, components.password == nil, components.query == nil, components.fragment == nil else {
            throw VectorMobileDataError.invalid("Only secure HTTPS images can be saved on iOS.")
        }
    }

    private func validateID(_ value: String) throws {
        guard value.count >= 8, value.count <= 80, !value.contains("/") else { throw VectorMobileDataError.invalid("Local item ID is invalid.") }
    }

    private func validateTimestamp(_ value: String) throws {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard formatter.date(from: value) != nil else { throw VectorMobileDataError.invalid("Local timestamp is invalid.") }
    }

    private func validateJSON(_ value: VectorJSONValue, depth: Int) throws {
        guard depth <= 8 else { throw VectorMobileDataError.invalid("Record data is too deeply nested.") }
        switch value {
        case .number(let number): guard number.isFinite else { throw VectorMobileDataError.invalid("Record data contains an invalid number.") }
        case .array(let values): for item in values { try validateJSON(item, depth: depth + 1) }
        case .object(let values):
            for key in values.keys { try validateFieldName(key) }
            for item in values.values { try validateJSON(item, depth: depth + 1) }
        default: break
        }
    }

    private func sorted(_ document: VectorMobileDataDocument) -> VectorMobileDataDocument {
        var result = document
        result.notes.sort { $0.updatedAt == $1.updatedAt ? $0.id < $1.id : $0.updatedAt > $1.updatedAt }
        result.records.sort { $0.updatedAt == $1.updatedAt ? $0.id < $1.id : $0.updatedAt > $1.updatedAt }
        result.savedArtifacts.sort { $0.updatedAt == $1.updatedAt ? $0.id < $1.id : $0.updatedAt > $1.updatedAt }
        return result
    }

    private func iso(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}

public struct VectorSharePayload: Equatable, Sendable {
    public let filename: String
    public let data: Data
}

public enum VectorSharePayloadBuilder {
    public static func build(title: String, kind: String, content: String, language: String?) throws -> VectorSharePayload {
        let safeTitle = String(title.lowercased().map { character in
            character.isLetter || character.isNumber ? character : "-"
        }).replacingOccurrences(of: "-+", with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        let base = String((safeTitle.isEmpty ? "vector-artifact" : safeTitle).prefix(60))
        let ext: String
        switch kind {
        case "markdown": ext = "md"
        case "code": ext = safeCodeExtension(language)
        case "table", "notes": ext = "json"
        case "mermaid": ext = "mmd"
        default: ext = "txt"
        }
        guard !content.isEmpty, content.lengthOfBytes(using: .utf8) <= VectorMobileDataStore.maxArtifactBytes,
              let data = content.data(using: .utf8) else {
            throw VectorMobileDataError.invalid("Artifact cannot be shared.")
        }
        return VectorSharePayload(filename: "\(base).\(ext)", data: data)
    }

    private static func safeCodeExtension(_ language: String?) -> String {
        switch language?.lowercased() {
        case "swift": return "swift"
        case "typescript", "ts": return "ts"
        case "javascript", "js": return "js"
        case "json": return "json"
        case "python", "py": return "py"
        case "html": return "html"
        case "css": return "css"
        default: return "txt"
        }
    }
}
