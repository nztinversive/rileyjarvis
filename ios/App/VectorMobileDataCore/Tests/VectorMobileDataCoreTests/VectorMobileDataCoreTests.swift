import Foundation
import XCTest
@testable import VectorMobileDataCore

final class VectorMobileDataCoreTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    func testCRUDPersistsAndSortsAcrossReload() throws {
        let store = VectorMobileDataStore(directoryURL: directory)
        let old = Date(timeIntervalSince1970: 1)
        let new = Date(timeIntervalSince1970: 2)
        _ = try store.addNote(text: "first", tags: ["work"], now: old, id: "note-0001")
        _ = try store.addNote(text: "second", tags: [], now: new, id: "note-0002")
        let record = try store.createRecord(collection: "tasks", title: "Draft", fields: ["done": .bool(false)], now: old, id: "record-0001")
        _ = try store.updateRecord(id: record.id, title: "Ready", fields: ["done": .bool(true)], now: new)
        _ = try store.saveArtifact(id: nil, title: "Plan", kind: "markdown", content: "# Plan", language: nil, now: new)

        let reloaded = VectorMobileDataStore(directoryURL: directory)
        let snapshot = try reloaded.snapshot().document
        XCTAssertEqual(snapshot.notes.map(\.id), ["note-0002", "note-0001"])
        XCTAssertEqual(snapshot.records.first?.title, "Ready")
        XCTAssertEqual(snapshot.records.first?.fields["done"], .bool(true))
        XCTAssertEqual(snapshot.savedArtifacts.first?.title, "Plan")
        XCTAssertEqual(try reloaded.searchRecords(collection: "tasks", query: "ready").count, 1)
    }

    func testDeleteRequiresConfirmation() throws {
        let store = VectorMobileDataStore(directoryURL: directory)
        let record = try store.createRecord(collection: "tasks", title: "Keep", fields: [:])
        XCTAssertThrowsError(try store.deleteRecord(id: record.id, confirmed: false)) {
            XCTAssertEqual($0 as? VectorMobileDataError, .confirmationRequired)
        }
        XCTAssertTrue(try store.deleteRecord(id: record.id, confirmed: true))
        XCTAssertFalse(try store.deleteRecord(id: record.id, confirmed: true))
    }

    func testConfirmedDeletionRejectsAnItemChangedWhilePromptWasOpen() throws {
        let store = VectorMobileDataStore(directoryURL: directory)
        let original = try store.addNote(text: "Review this", tags: [], now: Date(timeIntervalSince1970: 1), id: "note-0001")
        _ = try store.updateNote(id: original.id, text: "Changed after prompt", tags: nil, now: Date(timeIntervalSince1970: 2))

        XCTAssertThrowsError(try store.deleteNote(ifUnchanged: original)) {
            XCTAssertEqual($0 as? VectorMobileDataError, .itemChanged)
        }
        XCTAssertEqual(try store.snapshot().document.notes.first?.text, "Changed after prompt")
    }

    func testCorruptionIsPreservedBeforeRecoveryWrites() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let storeURL = directory.appendingPathComponent("vector-mobile-data.json")
        try Data("{broken".utf8).write(to: storeURL)
        let store = VectorMobileDataStore(directoryURL: directory)
        let snapshot = try store.snapshot()
        XCTAssertTrue(snapshot.document.notes.isEmpty)
        let recoveryName = try XCTUnwrap(snapshot.recoveredCorruptStore)
        let files = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        XCTAssertTrue(files.contains { $0.hasPrefix("vector-mobile-data.corrupt-") })
        XCTAssertFalse(FileManager.default.fileExists(atPath: storeURL.path))
        let recoveryURL = directory.appendingPathComponent(recoveryName)
        XCTAssertEqual(try String(contentsOf: recoveryURL, encoding: .utf8), "{broken")
        let relaunched = try VectorMobileDataStore(directoryURL: directory).snapshot()
        XCTAssertNil(relaunched.recoveredCorruptStore)
        XCTAssertEqual(
            try FileManager.default.contentsOfDirectory(atPath: directory.path).filter { $0.hasPrefix("vector-mobile-data.corrupt-") }.count,
            1
        )
        _ = try store.addNote(text: "Recovered", tags: [])
        XCTAssertNoThrow(try JSONSerialization.jsonObject(with: Data(contentsOf: storeURL)))
        XCTAssertEqual(try String(contentsOf: recoveryURL, encoding: .utf8), "{broken")
    }

    func testTransientReadFailureDoesNotQuarantineValidStore() throws {
        let store = VectorMobileDataStore(directoryURL: directory)
        _ = try store.addNote(text: "Keep protected data", tags: [], id: "note-0001")
        let storeURL = directory.appendingPathComponent("vector-mobile-data.json")
        enum SimulatedReadError: Error { case unavailable }
        var failNextRead = true
        let retryableStore = VectorMobileDataStore(directoryURL: directory) { url in
            if failNextRead {
                failNextRead = false
                throw SimulatedReadError.unavailable
            }
            return try Data(contentsOf: url)
        }

        XCTAssertThrowsError(try retryableStore.snapshot())
        XCTAssertTrue(FileManager.default.fileExists(atPath: storeURL.path))
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: directory.path).contains { $0.hasPrefix("vector-mobile-data.corrupt-") })

        XCTAssertEqual(try retryableStore.snapshot().document.notes.first?.text, "Keep protected data")
    }

    func testMalformedLanguageAndNestedRecordKeysUseRecoveryPath() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let storeURL = directory.appendingPathComponent("vector-mobile-data.json")
        let timestamp = "2026-07-20T12:00:00.000Z"
        let malformedDocuments = [
            "{\"schemaVersion\":1,\"notes\":[],\"records\":[],\"savedArtifacts\":[{\"id\":\"artifact-0001\",\"title\":\"Saved\",\"kind\":\"code\",\"content\":\"safe\",\"language\":\"\(String(repeating: "x", count: 33))\",\"createdAt\":\"\(timestamp)\",\"updatedAt\":\"\(timestamp)\"}]}",
            "{\"schemaVersion\":1,\"notes\":[],\"records\":[{\"id\":\"record-0001\",\"collection\":\"tasks\",\"title\":\"Nested\",\"fields\":{\"outer\":{\"\(String(repeating: "k", count: 81))\":true}},\"createdAt\":\"\(timestamp)\",\"updatedAt\":\"\(timestamp)\"}],\"savedArtifacts\":[]}",
        ]

        for source in malformedDocuments {
            try Data(source.utf8).write(to: storeURL, options: .atomic)
            let snapshot = try VectorMobileDataStore(directoryURL: directory).snapshot()
            XCTAssertNotNil(snapshot.recoveredCorruptStore)
            XCTAssertTrue(snapshot.document.notes.isEmpty)
            XCTAssertTrue(snapshot.document.records.isEmpty)
            XCTAssertTrue(snapshot.document.savedArtifacts.isEmpty)
        }
    }

    func testBoundsRejectOversizedContent() throws {
        let store = VectorMobileDataStore(directoryURL: directory)
        XCTAssertThrowsError(try store.addNote(text: String(repeating: "a", count: VectorMobileDataStore.maxTextBytes + 1), tags: []))
        XCTAssertThrowsError(try store.saveArtifact(id: nil, title: "Large", kind: "text", content: String(repeating: "a", count: VectorMobileDataStore.maxArtifactBytes + 1), language: nil))
    }

    func testRecordSizeUsesCompactSharedContractEncoding() throws {
        let store = VectorMobileDataStore(directoryURL: directory)
        let accepted = Dictionary(uniqueKeysWithValues: (0..<100).map {
            (String(format: "f%02d", $0), VectorJSONValue.string(String(repeating: "x", count: 150)))
        })
        XCTAssertNoThrow(try store.createRecord(collection: "tasks", title: "Compact", fields: accepted))

        let rejected = Dictionary(uniqueKeysWithValues: (0..<100).map {
            (String(format: "f%02d", $0), VectorJSONValue.string(String(repeating: "x", count: 155)))
        })
        XCTAssertThrowsError(try store.createRecord(collection: "tasks", title: "Too large", fields: rejected))
    }

    func testSharePayloadUsesPredictableSafeFilenameAndSelectedContentOnly() throws {
        let payload = try VectorSharePayloadBuilder.build(
            title: "Q3 Plan / Private",
            kind: "code",
            content: "let safe = true",
            language: "swift"
        )
        XCTAssertEqual(payload.filename, "q3-plan-private.swift")
        XCTAssertEqual(String(data: payload.data, encoding: .utf8), "let safe = true")
        XCTAssertFalse(String(data: payload.data, encoding: .utf8)!.contains("internal-id"))
    }

    func testConcurrentMutationsRemainAtomicAndReadable() throws {
        let store = VectorMobileDataStore(directoryURL: directory)
        DispatchQueue.concurrentPerform(iterations: 40) { index in
            do {
                _ = try store.addNote(text: "note \(index)", tags: [], id: String(format: "note-%04d", index))
            } catch {
                XCTFail("Concurrent mutation failed safely: \(error.localizedDescription)")
            }
        }
        let reloaded = VectorMobileDataStore(directoryURL: directory)
        XCTAssertEqual(try reloaded.snapshot().document.notes.count, 40)
        XCTAssertNoThrow(try JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("vector-mobile-data.json"))))
    }

    func testUnsupportedSchemaIsPreservedWithoutReset() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let storeURL = directory.appendingPathComponent("vector-mobile-data.json")
        let source = "{\"schema\\u0056ersion\":1e1,\"futureShape\":\"\(String(repeating: "x", count: VectorMobileDataStore.maxFileBytes + 1))\"}"
        try Data(source.utf8).write(to: storeURL)
        XCTAssertGreaterThan(try Data(contentsOf: storeURL).count, VectorMobileDataStore.maxFileBytes)
        let store = VectorMobileDataStore(directoryURL: directory)
        XCTAssertThrowsError(try store.snapshot()) { XCTAssertEqual($0 as? VectorMobileDataError, .unsupportedSchema) }
        XCTAssertThrowsError(try store.addNote(text: "Must not overwrite", tags: [])) {
            XCTAssertEqual($0 as? VectorMobileDataError, .unsupportedSchema)
        }
        XCTAssertEqual(try String(contentsOf: storeURL, encoding: .utf8), source)
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: directory.path).contains { $0.hasPrefix("vector-mobile-data.corrupt-") })
    }

    func testOversizedCurrentSchemaStillUsesRecoveryPath() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let storeURL = directory.appendingPathComponent("vector-mobile-data.json")
        let source = "{\"padding\":\"\(String(repeating: "x", count: VectorMobileDataStore.maxFileBytes))\",\"schemaVersion\":1}"
        try Data(source.utf8).write(to: storeURL)
        let store = VectorMobileDataStore(directoryURL: directory)
        let snapshot = try store.snapshot()
        XCTAssertNotNil(snapshot.recoveredCorruptStore)
        XCTAssertTrue(snapshot.document.notes.isEmpty)
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: directory.path).contains { $0.hasPrefix("vector-mobile-data.corrupt-") })
    }

    func testOversizedIndeterminateSchemaTokenIsPreservedReadOnly() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let storeURL = directory.appendingPathComponent("vector-mobile-data.json")
        let source = "{\"schemaVersion\":\(String(repeating: "9", count: 1_000)),\"padding\":\"\(String(repeating: "x", count: VectorMobileDataStore.maxFileBytes))\"}"
        try Data(source.utf8).write(to: storeURL)
        let store = VectorMobileDataStore(directoryURL: directory)
        XCTAssertThrowsError(try store.snapshot()) { XCTAssertEqual($0 as? VectorMobileDataError, .unsupportedSchema) }
        XCTAssertThrowsError(try store.addNote(text: "Must not overwrite", tags: [])) {
            XCTAssertEqual($0 as? VectorMobileDataError, .unsupportedSchema)
        }
        XCTAssertEqual(try String(contentsOf: storeURL, encoding: .utf8), source)
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: directory.path).contains { $0.hasPrefix("vector-mobile-data.corrupt-") })
    }

    func testReservedRecordFieldsAndUnsafeImagesFailClosed() throws {
        let store = VectorMobileDataStore(directoryURL: directory)
        let uppercaseHTTPS = try store.saveArtifact(id: nil, title: "Remote", kind: "image", content: "HTTPS://example.com/image.png", language: nil)
        XCTAssertEqual(uppercaseHTTPS.content, "HTTPS://example.com/image.png")
        XCTAssertThrowsError(try store.createRecord(collection: "tasks", title: "Unsafe", fields: ["__proto__": .object(["secret": .bool(true)])]))
        XCTAssertThrowsError(try store.saveArtifact(id: nil, title: "Local", kind: "image", content: "file:///private/image.png", language: nil))
        XCTAssertThrowsError(try store.saveArtifact(id: nil, title: "Credential", kind: "image", content: "https://token@example.com/image.png", language: nil))
        XCTAssertThrowsError(try store.saveArtifact(id: nil, title: "Signed", kind: "image", content: "https://example.com/image.png?token=secret", language: nil))
        XCTAssertThrowsError(try store.saveArtifact(id: nil, title: "Fragment", kind: "image", content: "https://example.com/image.png#secret", language: nil))
    }

    func testUpdatingMissingSavedArtifactDoesNotCreateADuplicate() throws {
        let store = VectorMobileDataStore(directoryURL: directory)
        XCTAssertThrowsError(try store.saveArtifact(id: "artifact-missing", title: "Missing", kind: "text", content: "Safe", language: nil)) {
            XCTAssertEqual($0 as? VectorMobileDataError, .notFound)
        }
        XCTAssertTrue(try store.snapshot().document.savedArtifacts.isEmpty)
    }

    func testFoundationNumbersAndBooleansRemainDistinct() throws {
        XCTAssertEqual(try VectorJSONValue.fromFoundation(NSNumber(value: 1)), .number(1))
        XCTAssertEqual(try VectorJSONValue.fromFoundation(NSNumber(value: 0)), .number(0))
        XCTAssertEqual(try VectorJSONValue.fromFoundation(NSNumber(value: true)), .bool(true))
    }

    func testNoteAndArtifactContentPreserveWhitespace() throws {
        let store = VectorMobileDataStore(directoryURL: directory)
        let note = try store.addNote(text: "  indented note\n", tags: [])
        let artifact = try store.saveArtifact(id: nil, title: "Code", kind: "code", content: "  let value = 1\n", language: "swift")
        XCTAssertEqual(note.text, "  indented note\n")
        XCTAssertEqual(artifact.content, "  let value = 1\n")
        let reloaded = try VectorMobileDataStore(directoryURL: directory).snapshot().document
        XCTAssertEqual(reloaded.notes.first?.text, "  indented note\n")
        XCTAssertEqual(reloaded.savedArtifacts.first?.content, "  let value = 1\n")
    }
}
