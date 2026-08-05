from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')

def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding='utf-8')

def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{path}: expected one match, found {count}')
    write(path, text.replace(old, new, 1))

write('ios/App/App/AegisKeychainPlugin.swift', r'''import Foundation
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
''')

replace_once(
    'src/lib/secureStore.ts',
    "import { Capacitor } from '@capacitor/core';\n",
    "import { Capacitor, registerPlugin } from '@capacitor/core';\n",
)

replace_once(
    'src/lib/secureStore.ts',
    "const CRITICAL_PREFIX = 'forsure.secure.v1:';\n",
    "type AegisKeychainBridge = {\n"
    "  get(options: { key: string }): Promise<{ value?: string | null }>;\n"
    "  set(options: { key: string; value: string }): Promise<void>;\n"
    "  remove(options: { key: string }): Promise<void>;\n"
    "};\n\n"
    "const AegisKeychain = registerPlugin<AegisKeychainBridge>('AegisKeychain');\n"
    "const CRITICAL_PREFIX = 'forsure.secure.v1:';\n",
)

replace_once(
    'src/lib/secureStore.ts',
    "function criticalKey(key: string): string {\n"
    "  return `${CRITICAL_PREFIX}${key}`;\n"
    "}\n",
    "function criticalKey(key: string): string {\n"
    "  return `${CRITICAL_PREFIX}${key}`;\n"
    "}\n\n"
    "function isIOSNative(): boolean {\n"
    "  return isSecureStoreNative() && Capacitor.getPlatform() === 'ios';\n"
    "}\n\n"
    "async function criticalPlatformGet(key: string): Promise<string | null> {\n"
    "  if (isIOSNative()) {\n"
    "    const result = await AegisKeychain.get({ key });\n"
    "    return typeof result?.value === 'string' ? result.value : null;\n"
    "  }\n"
    "  return rawSecureGet(key);\n"
    "}\n\n"
    "async function criticalPlatformSet(key: string, value: string): Promise<void> {\n"
    "  if (isIOSNative()) {\n"
    "    await AegisKeychain.set({ key, value });\n"
    "    return;\n"
    "  }\n"
    "  await SecureStoragePlugin.set({ key, value });\n"
    "}\n\n"
    "async function criticalPlatformRemove(key: string): Promise<void> {\n"
    "  if (isIOSNative()) {\n"
    "    await AegisKeychain.remove({ key });\n"
    "    return;\n"
    "  }\n"
    "  await rawSecureRemove(key);\n"
    "}\n",
)

replace_once(
    'src/lib/secureStore.ts',
    "    return await rawSecureGet(criticalKey(key));\n",
    "    return await criticalPlatformGet(criticalKey(key));\n",
)
replace_once(
    'src/lib/secureStore.ts',
    "    await SecureStoragePlugin.set({ key: criticalKey(key), value });\n",
    "    await criticalPlatformSet(criticalKey(key), value);\n",
)
replace_once(
    'src/lib/secureStore.ts',
    "    await rawSecureRemove(criticalKey(key));\n",
    "    await criticalPlatformRemove(criticalKey(key));\n",
)

write('src/lib/crypto/__tests__/iosNativeKeychainSwiftContract.test.ts', r'''import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('ios/App/App/AegisKeychainPlugin.swift', 'utf8');

describe('native iOS Aegis Keychain contract', () => {
  it('binds records to the physical device and disables backup migration', () => {
    expect(source).toContain('kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly');
    expect(source).toContain('kSecClassGenericPassword');
    expect(source).toContain('AegisKeychain');
  });

  it('does not log or return private values outside the requested read', () => {
    expect(source).not.toContain('print(');
    expect(source).not.toContain('NSLog');
    expect(source).not.toContain('kSecAttrSynchronizable');
  });
});
''')

print('native iOS Aegis Keychain plugin applied')
