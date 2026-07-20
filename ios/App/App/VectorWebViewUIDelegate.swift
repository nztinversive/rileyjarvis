import WebKit

final class VectorWebViewUIDelegate: NSObject, WKUIDelegate {
    private weak var forwardingDelegate: WKUIDelegate?

    init(forwarding forwardingDelegate: WKUIDelegate?) {
        self.forwardingDelegate = forwardingDelegate
        super.init()
    }

    override func responds(to selector: Selector!) -> Bool {
        super.responds(to: selector) || (forwardingDelegate?.responds(to: selector) ?? false)
    }

    override func forwardingTarget(for selector: Selector!) -> Any? {
        if forwardingDelegate?.responds(to: selector) == true {
            return forwardingDelegate
        }
        return super.forwardingTarget(for: selector)
    }

    @available(iOS 15.0, *)
    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        let isTrustedAppFrame = frame.isMainFrame
            && origin.protocol == "capacitor"
            && origin.host == "localhost"
        decisionHandler(isTrustedAppFrame && type == .microphone ? .grant : .deny)
    }
}
