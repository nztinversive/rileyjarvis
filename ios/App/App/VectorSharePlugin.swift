import Capacitor
import UIKit

@objc(VectorSharePlugin)
public final class VectorSharePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VectorSharePlugin"
    public let jsName = "VectorShare"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "share", returnType: CAPPluginReturnPromise)
    ]

    @objc public func share(_ call: CAPPluginCall) {
        let title = sanitized(call.getString("title"), maximum: 160) ?? "Vector export"
        let text = sanitizedContent(call.getString("text"), maximum: 64_000)
        var items: [Any] = []
        var temporaryDirectory: URL?
        if let text {
            do {
                let directory = FileManager.default.temporaryDirectory
                    .appendingPathComponent("VectorExports", isDirectory: true)
                    .appendingPathComponent(UUID().uuidString, isDirectory: true)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let filename = safeFilename(call.getString("filename")) ?? "vector-export.txt"
                let file = directory.appendingPathComponent(filename, isDirectory: false)
                try Data(text.utf8).write(to: file, options: [.atomic, .completeFileProtection])
                temporaryDirectory = directory
                items.append(file)
            } catch {
                call.reject("The export file could not be prepared.", "SHARE_EXPORT_FAILED")
                return
            }
        }
        if let value = call.getString("url"), let components = URLComponents(string: value), components.scheme == "https", components.host != nil, components.user == nil, components.password == nil, let url = components.url {
            items.append(url)
        } else if call.getString("url") != nil {
            if let temporaryDirectory { try? FileManager.default.removeItem(at: temporaryDirectory) }
            call.reject("Only secure HTTPS links can be shared.", "SHARE_UNSUPPORTED")
            return
        }
        guard !items.isEmpty else {
            if let temporaryDirectory { try? FileManager.default.removeItem(at: temporaryDirectory) }
            call.reject("This item cannot be shared.", "SHARE_UNSUPPORTED")
            return
        }

        DispatchQueue.main.async { [weak self] in
            guard let self, let presenter = self.bridge?.viewController else {
                if let temporaryDirectory { try? FileManager.default.removeItem(at: temporaryDirectory) }
                call.reject("The share sheet is unavailable.", "SHARE_UNAVAILABLE")
                return
            }
            let controller = UIActivityViewController(activityItems: items, applicationActivities: nil)
            controller.title = title
            controller.excludedActivityTypes = [.assignToContact, .addToReadingList]
            controller.completionWithItemsHandler = { _, completed, _, _ in
                if let temporaryDirectory { try? FileManager.default.removeItem(at: temporaryDirectory) }
                call.resolve(["completed": completed])
            }
            if let popover = controller.popoverPresentationController {
                popover.sourceView = presenter.view
                popover.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.maxY - 1, width: 1, height: 1)
                popover.permittedArrowDirections = []
            }
            presenter.present(controller, animated: !UIAccessibility.isReduceMotionEnabled)
        }
    }

    private func sanitized(_ value: String?, maximum: Int) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= maximum, trimmed.unicodeScalars.allSatisfy({ $0.value >= 32 || $0 == "\n" || $0 == "\t" }) else { return nil }
        return trimmed
    }

    private func sanitizedContent(_ value: String?, maximum: Int) -> String? {
        guard let value,
              !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              value.count <= maximum,
              value.unicodeScalars.allSatisfy({ $0.value >= 32 || $0 == "\n" || $0 == "\r" || $0 == "\t" }) else { return nil }
        return value
    }

    private func safeFilename(_ value: String?) -> String? {
        guard let value, value.count <= 80,
              !value.hasPrefix("."),
              !value.contains("/"),
              !value.contains("\\"),
              value.range(of: #"^[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9]{1,8}$"#, options: .regularExpression) != nil else {
            return nil
        }
        return value
    }
}
