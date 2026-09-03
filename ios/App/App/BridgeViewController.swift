import UIKit
import Capacitor

/// Local Capacitor bridge used by the App target.
/// App-target plugins are not auto-registered by Capacitor's package scanner,
/// so they must be registered explicitly after the bridge is created.
final class BridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(AegisKeychainPlugin())
        bridge?.registerPluginInstance(LibSignalPlugin())
        bridge?.registerPluginInstance(ContactsPlugin())
    }
}
