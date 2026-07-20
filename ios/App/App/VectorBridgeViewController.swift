import Capacitor

final class VectorBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(VectorSecureStoragePlugin())
    }
}
