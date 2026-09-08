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
        // Contacts is supplied by @capacitor-community/contacts via cap sync.
        // The duplicate app-local ContactsPlugin is excluded from the App target.
    }
}
