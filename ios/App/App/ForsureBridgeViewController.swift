import UIKit
import Capacitor

class ForsureBridgeViewController: CAPBridgeViewController {

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(ContactsPlugin())
    }
}
