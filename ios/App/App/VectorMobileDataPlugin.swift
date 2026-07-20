import Capacitor
import Foundation
import UIKit

@objc(VectorMobileDataPlugin)
public final class VectorMobileDataPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VectorMobileDataPlugin"
    public let jsName = "VectorMobileData"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "confirmDeletion", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "createNote", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateNote", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteNote", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "createRecord", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "searchRecords", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateRecord", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteRecord", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveArtifact", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteArtifact", returnType: CAPPluginReturnPromise)
    ]

    private lazy var store: VectorMobileDataStore = {
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Vector", isDirectory: true)
        return VectorMobileDataStore(directoryURL: root)
    }()
    private let operationQueue = DispatchQueue(label: "com.rileyjarvis.vector.mobile-data-plugin", qos: .userInitiated)
    private var confirmationInProgress = false

    @objc public func list(_ call: CAPPluginCall) {
        perform(call) { call.resolve(try self.storeDictionary()) }
    }

    @objc public func confirmDeletion(_ call: CAPPluginCall) {
        do {
            let kind = try required(call.getString("kind"), label: "Item type")
            let summary = try required(call.getString("summary"), label: "Item summary")
            guard kind.count <= 32, summary.count <= 240 else {
                throw VectorMobileDataError.invalid("Deletion confirmation is too long.")
            }
            DispatchQueue.main.async { [weak self] in
                guard let self, let presenter = self.bridge?.viewController else {
                    call.reject("Deletion confirmation is unavailable.", "CONFIRMATION_UNAVAILABLE")
                    return
                }
                guard !self.confirmationInProgress, presenter.presentedViewController == nil else {
                    call.reject("Another confirmation is already active.", "CONFIRMATION_IN_PROGRESS")
                    return
                }
                self.confirmationInProgress = true
                let alert = UIAlertController(
                    title: "Delete \(kind)?",
                    message: summary,
                    preferredStyle: .alert
                )
                let finish: (Bool) -> Void = { confirmed in
                    alert.dismiss(animated: !UIAccessibility.isReduceMotionEnabled) {
                        self.confirmationInProgress = false
                        call.resolve(["confirmed": confirmed])
                    }
                }
                alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in
                    finish(false)
                })
                alert.addAction(UIAlertAction(title: "Delete", style: .destructive) { _ in
                    finish(true)
                })
                presenter.present(alert, animated: true)
            }
        } catch let error as VectorMobileDataError {
            call.reject(error.localizedDescription, errorCode(error))
        } catch {
            call.reject("Deletion confirmation is unavailable.", "CONFIRMATION_UNAVAILABLE")
        }
    }

    @objc public func createNote(_ call: CAPPluginCall) {
        perform(call) {
            try self.ensureReadyForMutation()
            _ = try self.store.addNote(
                text: self.required(call.getString("text"), label: "Note"),
                tags: call.getArray("tags", String.self) ?? []
            )
            call.resolve(try self.storeDictionary())
        }
    }

    @objc public func updateNote(_ call: CAPPluginCall) {
        perform(call) {
            try self.ensureReadyForMutation()
            _ = try self.store.updateNote(
                id: self.required(call.getString("id"), label: "Note ID"),
                text: call.getString("text"),
                tags: call.getArray("tags", String.self)
            )
            call.resolve(try self.storeDictionary())
        }
    }

    @objc public func deleteNote(_ call: CAPPluginCall) {
        perform(call) {
            try self.ensureReadyForMutation()
            guard try self.store.deleteNote(id: self.required(call.getString("id"), label: "Note ID")) else {
                throw VectorMobileDataError.notFound
            }
            call.resolve(try self.storeDictionary())
        }
    }

    @objc public func createRecord(_ call: CAPPluginCall) {
        perform(call) {
            try self.ensureReadyForMutation()
            _ = try self.store.createRecord(
                collection: self.required(call.getString("collection"), label: "Collection"),
                title: self.required(call.getString("title"), label: "Title"),
                fields: try self.jsonFields(call.getObject("data"))
            )
            call.resolve(try self.storeDictionary())
        }
    }

    @objc public func searchRecords(_ call: CAPPluginCall) {
        perform(call) {
            let records = try self.store.searchRecords(
                collection: self.required(call.getString("collection"), label: "Collection"),
                query: call.getString("query") ?? "",
                limit: min(max(call.getInt("limit") ?? 20, 1), 100)
            )
            call.resolve(["records": try self.recordValues(records)])
        }
    }

    @objc public func updateRecord(_ call: CAPPluginCall) {
        perform(call) {
            try self.ensureReadyForMutation()
            _ = try self.store.updateRecord(
                id: self.required(call.getString("id"), label: "Record ID"),
                title: call.getString("title"),
                fields: call.getObject("data").map { try self.jsonFields($0) }
            )
            call.resolve(try self.storeDictionary())
        }
    }

    @objc public func deleteRecord(_ call: CAPPluginCall) {
        perform(call) {
            try self.ensureReadyForMutation()
            guard try self.store.deleteRecord(
                id: self.required(call.getString("id"), label: "Record ID"),
                confirmed: true
            ) else { throw VectorMobileDataError.notFound }
            call.resolve(try self.storeDictionary())
        }
    }

    @objc public func saveArtifact(_ call: CAPPluginCall) {
        perform(call) {
            try self.ensureReadyForMutation()
            _ = try self.store.saveArtifact(
                id: call.getString("id"),
                title: self.required(call.getString("title"), label: "Title"),
                kind: self.required(call.getString("kind"), label: "Kind"),
                content: self.required(call.getString("content"), label: "Artifact"),
                language: call.getString("language")
            )
            call.resolve(try self.storeDictionary())
        }
    }

    @objc public func deleteArtifact(_ call: CAPPluginCall) {
        perform(call) {
            try self.ensureReadyForMutation()
            guard try self.store.deleteArtifact(
                id: self.required(call.getString("id"), label: "Artifact ID"),
                confirmed: true
            ) else { throw VectorMobileDataError.notFound }
            call.resolve(try self.storeDictionary())
        }
    }

    private func perform(_ call: CAPPluginCall, operation: @escaping () throws -> Void) {
        operationQueue.async {
            do {
                try operation()
            } catch let error as VectorMobileDataError {
                call.reject(error.localizedDescription, self.errorCode(error))
            } catch {
                call.reject("Local data is unavailable.", "MOBILE_DATA_FAILED")
            }
        }
    }

    private func storeDictionary() throws -> [String: Any] {
        let snapshot = try store.snapshot()
        if let recovery = snapshot.recoveredCorruptStore {
            throw VectorMobileDataError.corruptStorePreserved(recovery)
        }
        let document = snapshot.document
        return [
            "version": document.schemaVersion,
            "notes": try value(document.notes),
            "records": try recordValues(document.records),
            "artifacts": try value(document.savedArtifacts)
        ]
    }

    private func ensureReadyForMutation() throws {
        if let recovery = try store.snapshot().recoveredCorruptStore {
            throw VectorMobileDataError.corruptStorePreserved(recovery)
        }
    }

    private func required(_ value: String?, label: String) throws -> String {
        guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw VectorMobileDataError.invalid("\(label) is required.")
        }
        return value
    }

    private func jsonFields(_ object: [String: Any]?) throws -> [String: VectorJSONValue] {
        guard case .object(let fields) = try VectorJSONValue.fromFoundation(object ?? [:]) else {
            throw VectorMobileDataError.invalid("Record data must be an object.")
        }
        return fields
    }

    private func value<T: Encodable>(_ value: T) throws -> Any {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(value))
    }

    private func value(_ value: [String: Any]) throws -> Any {
        guard JSONSerialization.isValidJSONObject(value) else {
            throw VectorMobileDataError.invalid("Unable to encode local data.")
        }
        return value
    }

    private func value(_ values: [[String: Any]]) throws -> Any {
        guard JSONSerialization.isValidJSONObject(values) else {
            throw VectorMobileDataError.invalid("Unable to encode local data.")
        }
        return values
    }

    private func recordValues(_ records: [VectorMobileRecord]) throws -> Any {
        try value(records.map { record in
            [
                "id": record.id,
                "collection": record.collection,
                "title": record.title,
                "data": try value(record.fields),
                "createdAt": record.createdAt,
                "updatedAt": record.updatedAt
            ] as [String: Any]
        })
    }

    private func errorCode(_ error: VectorMobileDataError) -> String {
        switch error {
        case .invalid: return "INVALID_ARGUMENT"
        case .notFound: return "NOT_FOUND"
        case .confirmationRequired: return "CONFIRMATION_REQUIRED"
        case .storageLimit: return "STORAGE_LIMIT"
        case .unsupportedSchema: return "UNSUPPORTED_SCHEMA"
        case .corruptStorePreserved: return "CORRUPT_STORE_PRESERVED"
        }
    }
}
