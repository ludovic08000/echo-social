import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        // Register custom plugins
        let bridge = (window?.rootViewController as? CAPBridgeViewController)?.bridge
        bridge?.registerPluginInstance(ContactsPlugin())
        return true
    }
}
