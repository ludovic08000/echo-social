import Foundation
import Capacitor
import Security
import CryptoKit

/**
 * Aegis Continuity Enclave (ACE)
 *
 * The JavaScript API intentionally stays get/set/remove. On iOS, values are no
 * longer stored as plaintext Keychain payloads. A permanent P-256 private key
 * generated inside the Secure Enclave seals every private-key record with
 * ECIES (X9.63 SHA-256 + AES-GCM). WKWebView/IndexedDB remains reconstructible
 * cache only.
 *
 * Security invariants:
 * - The enclave private key is non-exportable and ThisDeviceOnly.
 * - Existing Ed25519/X25519 JWK records are sealed exactly as-is; no rotation.
 * - A sealed record never causes silent anchor regeneration.
 * - Legacy plaintext Keychain records migrate in place after decrypt readback.
 * - No Preferences, localStorage, iCloud sync, backup migration, or secret log.
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

    private let queue = DispatchQueue(label: "fans.forsure.aegis.continuity-enclave", qos: .userInitiated)
    private let sealedPrefix = Data("AEGIS-ACE1:".utf8)
    private let maximumValueBytes = 512 * 1024

    private struct SealedPayload: Codable {
        let version: Int
        let service: String
        let account: String
        let value: String
    }

    private struct SealedEnvelope: Codable {
        let version: Int
        let algorithm: String
        let anchorFingerprint: String
        let ciphertext: String
    }

    private enum ACEError: Error {
        case code(String)

        var message: String {
            switch self {
            case .code(let value): return value
            }
        }
    }

    private var service: String {
        let bundle = Bundle.main.bundleIdentifier ?? "fans.forsure.app"
        return "\(bundle).aegis.keychain.v1"
    }

    private var anchorTag: Data {
        Data("\(service).secure-enclave-anchor.v1".utf8)
    }

    private func baseQuery(account: String) -> [CFString: Any] {
        return [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account
        ]
    }

    private func validateKey(_ key: String?) throws -> String {
        guard let key, !key.isEmpty, key.utf8.count <= 512 else {
            throw ACEError.code("E2EE_NATIVE_KEYCHAIN_INVALID_KEY")
        }
        return key
    }

    private func readRaw(account: String) throws -> Data? {
        var query = baseQuery(account: account)
        query[kSecReturnData] = kCFBooleanTrue
        query[kSecMatchLimit] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw ACEError.code("E2EE_NATIVE_KEYCHAIN_READ_FAILED")
        }
        return data
    }

    private func writeRaw(account: String, data: Data) throws {
        let query = baseQuery(account: account)
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
            throw ACEError.code("E2EE_NATIVE_KEYCHAIN_WRITE_FAILED")
        }

        guard try readRaw(account: account) == data else {
            throw ACEError.code("E2EE_NATIVE_KEYCHAIN_READBACK_FAILED")
        }
    }

    private func deleteRaw(account: String) throws {
        let status = SecItemDelete(baseQuery(account: account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw ACEError.code("E2EE_NATIVE_KEYCHAIN_DELETE_FAILED")
        }
        guard try readRaw(account: account) == nil else {
            throw ACEError.code("E2EE_NATIVE_KEYCHAIN_DELETE_READBACK_FAILED")
        }
    }

    private func copyExistingAnchor() throws -> SecKey? {
        let query: [CFString: Any] = [
            kSecClass: kSecClassKey,
            kSecAttrApplicationTag: anchorTag,
            kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
            kSecReturnRef: kCFBooleanTrue as Any,
            kSecMatchLimit: kSecMatchLimitOne
        ]

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let result else {
            throw ACEError.code("E2EE_ENCLAVE_ANCHOR_READ_FAILED")
        }
        return (result as! SecKey)
    }

    private func createAnchor() throws -> SecKey {
        var accessError: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(
            kCFAllocatorDefault,
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            [.privateKeyUsage],
            &accessError
        ) else {
            throw ACEError.code("E2EE_ENCLAVE_ACCESS_CONTROL_FAILED")
        }

        let attributes: [CFString: Any] = [
            kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits: 256,
            kSecAttrTokenID: kSecAttrTokenIDSecureEnclave,
            kSecPrivateKeyAttrs: [
                kSecAttrIsPermanent: kCFBooleanTrue as Any,
                kSecAttrApplicationTag: anchorTag,
                kSecAttrAccessControl: access
            ]
        ]

        var keyError: Unmanaged<CFError>?
        guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &keyError) else {
            // A concurrent caller may have created it between query and creation.
            if let existing = try copyExistingAnchor() { return existing }
            throw ACEError.code("E2EE_ENCLAVE_ANCHOR_CREATE_FAILED")
        }
        return key
    }

    private func containsAnySealedRecord() throws -> Bool {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecReturnData: kCFBooleanTrue as Any,
            kSecMatchLimit: kSecMatchLimitAll
        ]

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return false }
        guard status == errSecSuccess else {
            throw ACEError.code("E2EE_NATIVE_KEYCHAIN_SCAN_FAILED")
        }

        if let records = result as? [Data] {
            return records.contains(where: { $0.starts(with: sealedPrefix) })
        }
        if let record = result as? Data {
            return record.starts(with: sealedPrefix)
        }
        throw ACEError.code("E2EE_NATIVE_KEYCHAIN_SCAN_FAILED")
    }

    private func anchorForWrite(existingRecord: Data?) throws -> SecKey {
        if let anchor = try copyExistingAnchor() { return anchor }

        // Losing an anchor while any sealed payload survives must never rotate
        // device identity silently. Explicit device recovery is required.
        let existingRecordIsSealed = existingRecord?.starts(with: sealedPrefix) == true
        let anySealedRecordExists = try containsAnySealedRecord()
        if existingRecordIsSealed || anySealedRecordExists {
            throw ACEError.code("E2EE_ENCLAVE_ANCHOR_MISSING")
        }
        return try createAnchor()
    }

    private func anchorFingerprint(_ privateKey: SecKey) throws -> String {
        guard let publicKey = SecKeyCopyPublicKey(privateKey) else {
            throw ACEError.code("E2EE_ENCLAVE_PUBLIC_KEY_FAILED")
        }
        var error: Unmanaged<CFError>?
        guard let external = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
            throw ACEError.code("E2EE_ENCLAVE_PUBLIC_KEY_FAILED")
        }
        return SHA256.hash(data: external).map { String(format: "%02x", $0) }.joined()
    }

    private func seal(value: String, account: String, existingRecord: Data?) throws -> Data {
        let valueData = Data(value.utf8)
        guard valueData.count <= maximumValueBytes else {
            throw ACEError.code("E2EE_NATIVE_KEYCHAIN_VALUE_TOO_LARGE")
        }

        let anchor = try anchorForWrite(existingRecord: existingRecord)
        guard let publicKey = SecKeyCopyPublicKey(anchor) else {
            throw ACEError.code("E2EE_ENCLAVE_PUBLIC_KEY_FAILED")
        }

        let payload = SealedPayload(
            version: 1,
            service: service,
            account: account,
            value: value
        )
        let plaintext = try JSONEncoder().encode(payload)
        let algorithm = SecKeyAlgorithm.eciesEncryptionCofactorX963SHA256AESGCM
        guard SecKeyIsAlgorithmSupported(publicKey, .encrypt, algorithm) else {
            throw ACEError.code("E2EE_ENCLAVE_ALGORITHM_UNAVAILABLE")
        }

        var encryptionError: Unmanaged<CFError>?
        guard let ciphertext = SecKeyCreateEncryptedData(
            publicKey,
            algorithm,
            plaintext as CFData,
            &encryptionError
        ) as Data? else {
            throw ACEError.code("E2EE_ENCLAVE_SEAL_FAILED")
        }

        let envelope = SealedEnvelope(
            version: 1,
            algorithm: "P256-ECIES-X963-SHA256-AESGCM",
            anchorFingerprint: try anchorFingerprint(anchor),
            ciphertext: ciphertext.base64EncodedString()
        )
        var stored = sealedPrefix
        stored.append(try JSONEncoder().encode(envelope))
        return stored
    }

    private func unseal(record: Data, account: String) throws -> String {
        guard record.starts(with: sealedPrefix) else {
            guard let legacy = String(data: record, encoding: .utf8) else {
                throw ACEError.code("E2EE_NATIVE_KEYCHAIN_CORRUPT")
            }
            return legacy
        }

        guard let anchor = try copyExistingAnchor() else {
            throw ACEError.code("E2EE_ENCLAVE_ANCHOR_MISSING")
        }

        let envelopeData = record.dropFirst(sealedPrefix.count)
        let envelope: SealedEnvelope
        do {
            envelope = try JSONDecoder().decode(SealedEnvelope.self, from: Data(envelopeData))
        } catch {
            throw ACEError.code("E2EE_ENCLAVE_ENVELOPE_CORRUPT")
        }

        guard envelope.version == 1,
              envelope.algorithm == "P256-ECIES-X963-SHA256-AESGCM",
              envelope.anchorFingerprint == (try anchorFingerprint(anchor)),
              let ciphertext = Data(base64Encoded: envelope.ciphertext) else {
            throw ACEError.code("E2EE_ENCLAVE_ENVELOPE_INVALID")
        }

        let algorithm = SecKeyAlgorithm.eciesEncryptionCofactorX963SHA256AESGCM
        guard SecKeyIsAlgorithmSupported(anchor, .decrypt, algorithm) else {
            throw ACEError.code("E2EE_ENCLAVE_ALGORITHM_UNAVAILABLE")
        }

        var decryptionError: Unmanaged<CFError>?
        guard let plaintext = SecKeyCreateDecryptedData(
            anchor,
            algorithm,
            ciphertext as CFData,
            &decryptionError
        ) as Data? else {
            throw ACEError.code("E2EE_ENCLAVE_UNSEAL_FAILED")
        }

        let payload: SealedPayload
        do {
            payload = try JSONDecoder().decode(SealedPayload.self, from: plaintext)
        } catch {
            throw ACEError.code("E2EE_ENCLAVE_PAYLOAD_CORRUPT")
        }

        guard payload.version == 1,
              payload.service == service,
              payload.account == account,
              Data(payload.value.utf8).count <= maximumValueBytes else {
            throw ACEError.code("E2EE_ENCLAVE_PAYLOAD_INVALID")
        }
        return payload.value
    }

    private func reject(_ call: CAPPluginCall, error: Error) {
        if let aceError = error as? ACEError {
            call.reject(aceError.message)
        } else {
            call.reject("E2EE_ENCLAVE_OPERATION_FAILED")
        }
    }

    @objc func get(_ call: CAPPluginCall) {
        queue.async { [weak self] in
            guard let self else { return }
            do {
                let account = try self.validateKey(call.getString("key"))
                guard let record = try self.readRaw(account: account) else {
                    call.resolve(["value": NSNull()])
                    return
                }

                let value = try self.unseal(record: record, account: account)

                // One-time migration from the previous plaintext Keychain
                // format. Promotion is verified by decrypting the exact value.
                if !record.starts(with: self.sealedPrefix) {
                    let sealed = try self.seal(value: value, account: account, existingRecord: record)
                    try self.writeRaw(account: account, data: sealed)
                    guard try self.unseal(record: sealed, account: account) == value else {
                        throw ACEError.code("E2EE_ENCLAVE_MIGRATION_READBACK_FAILED")
                    }
                }
                call.resolve(["value": value])
            } catch {
                self.reject(call, error: error)
            }
        }
    }

    @objc func set(_ call: CAPPluginCall) {
        queue.async { [weak self] in
            guard let self else { return }
            do {
                let account = try self.validateKey(call.getString("key"))
                guard let value = call.getString("value") else {
                    throw ACEError.code("E2EE_NATIVE_KEYCHAIN_INVALID_VALUE")
                }
                let existing = try self.readRaw(account: account)
                let sealed = try self.seal(value: value, account: account, existingRecord: existing)
                try self.writeRaw(account: account, data: sealed)
                guard try self.unseal(record: sealed, account: account) == value else {
                    throw ACEError.code("E2EE_ENCLAVE_READBACK_FAILED")
                }
                call.resolve()
            } catch {
                self.reject(call, error: error)
            }
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        queue.async { [weak self] in
            guard let self else { return }
            do {
                let account = try self.validateKey(call.getString("key"))
                try self.deleteRaw(account: account)
                call.resolve()
            } catch {
                self.reject(call, error: error)
            }
        }
    }
}
