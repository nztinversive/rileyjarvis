#if DEBUG
import UIKit

enum VectorDebugCredentialProvisioner {
    private static let launchArgument = "-VectorEnableCredentialProvisioning"
    private static var didPresent = false

    static func presentIfEnabled(from viewController: UIViewController) {
        guard !didPresent,
              ProcessInfo.processInfo.arguments.contains(launchArgument),
              viewController.presentedViewController == nil else {
            return
        }
        didPresent = true

        let actions = UIAlertController(
            title: "Development Credential",
            message: "Provision or revoke the device-only bootstrap credential.",
            preferredStyle: .actionSheet
        )
        actions.addAction(UIAlertAction(title: "Provision", style: .default) { _ in
            presentProvisionPrompt(from: viewController)
        })
        actions.addAction(UIAlertAction(title: "Revoke Credential", style: .destructive) { _ in
            revoke(from: viewController)
        })
        actions.addAction(UIAlertAction(title: "Cancel", style: .cancel))

        if let popover = actions.popoverPresentationController {
            popover.sourceView = viewController.view
            popover.sourceRect = CGRect(
                x: viewController.view.bounds.midX,
                y: viewController.view.bounds.maxY,
                width: 0,
                height: 0
            )
        }
        viewController.present(actions, animated: true)
    }

    private static func presentProvisionPrompt(from viewController: UIViewController) {
        let prompt = UIAlertController(
            title: "Provision Credential",
            message: "Paste the approved temporary backend bootstrap credential.",
            preferredStyle: .alert
        )
        prompt.addTextField { field in
            field.isSecureTextEntry = true
            field.autocapitalizationType = .none
            field.autocorrectionType = .no
            field.smartDashesType = .no
            field.smartQuotesType = .no
            field.textContentType = .oneTimeCode
        }
        prompt.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in
            prompt.textFields?.first?.text = nil
        })
        prompt.addAction(UIAlertAction(title: "Store in Keychain", style: .default) { _ in
            guard let field = prompt.textFields?.first,
                  let credential = field.text else {
                presentResult(
                    from: viewController,
                    title: "Not Provisioned",
                    message: "A valid credential is required."
                )
                return
            }
            field.text = nil
            do {
                try VectorSecureCredentialStore.write(credential)
                presentResult(
                    from: viewController,
                    title: "Provisioned",
                    message: "The device-only development credential is available."
                )
            } catch VectorSecureCredentialStoreError.invalidValue {
                presentResult(
                    from: viewController,
                    title: "Not Provisioned",
                    message: "A valid credential is required."
                )
            } catch {
                presentResult(
                    from: viewController,
                    title: "Not Provisioned",
                    message: "Secure credential storage is unavailable."
                )
            }
        })
        viewController.present(prompt, animated: true)
    }

    private static func revoke(from viewController: UIViewController) {
        do {
            try VectorSecureCredentialStore.delete()
            presentResult(
                from: viewController,
                title: "Revoked",
                message: "The device-only development credential was deleted."
            )
        } catch {
            presentResult(
                from: viewController,
                title: "Not Revoked",
                message: "Secure credential storage is unavailable."
            )
        }
    }

    private static func presentResult(
        from viewController: UIViewController,
        title: String,
        message: String
    ) {
        let result = UIAlertController(
            title: title,
            message: message,
            preferredStyle: .alert
        )
        result.addAction(UIAlertAction(title: "OK", style: .default))
        viewController.present(result, animated: true)
    }
}
#endif
