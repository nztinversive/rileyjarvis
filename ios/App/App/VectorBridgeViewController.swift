import Capacitor
import WebKit

final class VectorBridgeViewController: CAPBridgeViewController {
    private var vectorUIDelegate: VectorWebViewUIDelegate?

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(VectorSecureStoragePlugin())
        bridge?.registerPluginInstance(VectorAudioSessionPlugin())
        bridge?.registerPluginInstance(VectorMobileDataPlugin())
        bridge?.registerPluginInstance(VectorSharePlugin())

        if let webView {
            let delegate = VectorWebViewUIDelegate(forwarding: webView.uiDelegate)
            vectorUIDelegate = delegate
            webView.uiDelegate = delegate
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
#if DEBUG
        VectorDebugCredentialProvisioner.presentIfEnabled(from: self)
#endif
    }
}
