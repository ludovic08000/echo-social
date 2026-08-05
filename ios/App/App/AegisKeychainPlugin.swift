import Foundation
import Capacitor
import Security

/**
 * Device-bound storage for Aegis private-key records.
 *
 * `AfterFirstUnlockThisDeviceOnly` permits background message processing after
 * the first unlock while preventing iCloud Keychain sync and backup migration
 * to another physical device.
 */
@objc(AegisKeychainPlugin)
public class AegisKeychainPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AegisKeychainPlugin"
    public let jsName = "AegisKeychain"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise)
    ]

    private var service: String {
        let bundle = Bundle.main.bundleIdentifier ?? "fans.forsure.app"
        return "\(bundle).aegis.keychain.v1"
    }

    private func baseQuery(account: String) -> [CFString: Any] {
        return [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account
        ]
    }

    @objc func get(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("E2EE_NATIVE_KEYCHAIN_INVALID_KEY")
            return
        }

        var query = baseQuery(account: key)
        query[kSecReturnData] = kCFBooleanTrue
        query[kSecMatchLimit] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            call.resolve(["value": NSNull()])
            return
        }
        guard status == errSecSuccess,
              let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else {
            call.reject("E2EE_NATIVE_KEYCHAIN_READ_FAILED", String(status))
            return
        }
        call.resolve(["value": value])
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty,
              let value = call.getString("value"),
              let data = value.data(using: .utf8) else {
            call.reject("E2EE_NATIVE_KEYCHAIN_INVALID_VALUE")
            return
        }

        let query = baseQuery(account: key)
        let update: [CFString: Any] = [
            kSecValueData: data,
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        var status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var add = query
            add[kSecValueData] = data
            add[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(add as CFDictionary, nil)
        }
        guard status == errSecSuccess else {
            call.reject("E2EE_NATIVE_KEYCHAIN_WRITE_FAILED", String(status))
            return
        }
        call.resolve()
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("E2EE_NATIVE_KEYCHAIN_INVALID_KEY")
            return
        }
        let status = SecItemDelete(baseQuery(account: key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            call.reject("E2EE_NATIVE_KEYCHAIN_DELETE_FAILED", String(status))
            return
        }
        call.resolve()
    }
}
