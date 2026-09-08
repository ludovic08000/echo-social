import Foundation
import AegisCrypto

/// Swift facade over the portable Aegis/libsignal C ABI.
/// Mutating operations always return the next serialized store; callers must
/// seal it in ACE/Keychain before using network-visible output.
enum AegisCryptoNative {
    static let expectedAbi: UInt32 = 1

    struct BundleResult {
        let store: Data
        let publicBundle: Data
    }

    struct EncryptResult {
        let store: Data
        let messageType: UInt8
        let ciphertext: Data
    }

    struct DecryptResult {
        let store: Data
        let plaintext: Data
    }

    static func requireAbi() throws {
        let actual = aegis_crypto_abi_version()
        guard actual == expectedAbi else {
            throw NSError(
                domain: "fans.forsure.aegis.crypto",
                code: Int(actual),
                userInfo: [NSLocalizedDescriptionKey: "AEGIS_NATIVE_ABI_MISMATCH:\(actual)"]
            )
        }
    }

    static func createStore(registrationId: UInt32) throws -> Data {
        try requireAbi()
        var output = AegisBuffer(data: nil, len: 0)
        let status = aegis_crypto_store_create(registrationId, &output)
        guard status == 0 else { throw nativeError(status) }
        return take(output)
    }

    static func createBundle(
        store: Data,
        deviceId: UInt32,
        preKeyId: UInt32,
        signedPreKeyId: UInt32,
        kyberPreKeyId: UInt32
    ) throws -> BundleResult {
        try requireAbi()
        return try store.withUnsafeBytes { (storeBytes: UnsafeRawBufferPointer) in
            var nextStore = AegisBuffer(data: nil, len: 0)
            var publicBundle = AegisBuffer(data: nil, len: 0)
            let status = aegis_crypto_bundle_create(
                storeBytes.bindMemory(to: UInt8.self).baseAddress,
                store.count,
                deviceId,
                preKeyId,
                signedPreKeyId,
                kyberPreKeyId,
                &nextStore,
                &publicBundle
            )
            guard status == 0 else { throw nativeError(status) }
            return BundleResult(store: take(nextStore), publicBundle: take(publicBundle))
        }
    }

    static func establishSession(
        store: Data,
        localName: String,
        localDevice: UInt32,
        remoteName: String,
        remoteDevice: UInt32,
        bundle: Data
    ) throws -> Data {
        try requireAbi()
        let local = Data(localName.utf8)
        let remote = Data(remoteName.utf8)
        return try store.withUnsafeBytes { (storeBytes: UnsafeRawBufferPointer) in
            try local.withUnsafeBytes { (localBytes: UnsafeRawBufferPointer) in
                try remote.withUnsafeBytes { (remoteBytes: UnsafeRawBufferPointer) in
                    try bundle.withUnsafeBytes { (bundleBytes: UnsafeRawBufferPointer) in
                        var nextStore = AegisBuffer(data: nil, len: 0)
                        let status = aegis_crypto_session_establish(
                            storeBytes.bindMemory(to: UInt8.self).baseAddress,
                            store.count,
                            localBytes.bindMemory(to: UInt8.self).baseAddress,
                            local.count,
                            localDevice,
                            remoteBytes.bindMemory(to: UInt8.self).baseAddress,
                            remote.count,
                            remoteDevice,
                            bundleBytes.bindMemory(to: UInt8.self).baseAddress,
                            bundle.count,
                            &nextStore
                        )
                        guard status == 0 else { throw nativeError(status) }
                        return take(nextStore)
                    }
                }
            }
        }
    }

    static func encryptMessage(
        store: Data,
        localName: String,
        localDevice: UInt32,
        remoteName: String,
        remoteDevice: UInt32,
        plaintext: Data
    ) throws -> EncryptResult {
        try requireAbi()
        let local = Data(localName.utf8)
        let remote = Data(remoteName.utf8)
        return try store.withUnsafeBytes { (storeBytes: UnsafeRawBufferPointer) in
            try local.withUnsafeBytes { (localBytes: UnsafeRawBufferPointer) in
                try remote.withUnsafeBytes { (remoteBytes: UnsafeRawBufferPointer) in
                    try plaintext.withUnsafeBytes { (plainBytes: UnsafeRawBufferPointer) in
                        var nextStore = AegisBuffer(data: nil, len: 0)
                        var messageType: UInt8 = 0
                        var ciphertext = AegisBuffer(data: nil, len: 0)
                        let status = aegis_crypto_message_encrypt(
                            storeBytes.bindMemory(to: UInt8.self).baseAddress,
                            store.count,
                            localBytes.bindMemory(to: UInt8.self).baseAddress,
                            local.count,
                            localDevice,
                            remoteBytes.bindMemory(to: UInt8.self).baseAddress,
                            remote.count,
                            remoteDevice,
                            plainBytes.bindMemory(to: UInt8.self).baseAddress,
                            plaintext.count,
                            &nextStore,
                            &messageType,
                            &ciphertext
                        )
                        guard status == 0 else { throw nativeError(status) }
                        return EncryptResult(
                            store: take(nextStore),
                            messageType: messageType,
                            ciphertext: take(ciphertext)
                        )
                    }
                }
            }
        }
    }

    static func decryptMessage(
        store: Data,
        localName: String,
        localDevice: UInt32,
        remoteName: String,
        remoteDevice: UInt32,
        messageType: UInt8,
        ciphertext: Data
    ) throws -> DecryptResult {
        try requireAbi()
        let local = Data(localName.utf8)
        let remote = Data(remoteName.utf8)
        return try store.withUnsafeBytes { (storeBytes: UnsafeRawBufferPointer) in
            try local.withUnsafeBytes { (localBytes: UnsafeRawBufferPointer) in
                try remote.withUnsafeBytes { (remoteBytes: UnsafeRawBufferPointer) in
                    try ciphertext.withUnsafeBytes { (cipherBytes: UnsafeRawBufferPointer) in
                        var nextStore = AegisBuffer(data: nil, len: 0)
                        var plaintext = AegisBuffer(data: nil, len: 0)
                        let status = aegis_crypto_message_decrypt(
                            storeBytes.bindMemory(to: UInt8.self).baseAddress,
                            store.count,
                            localBytes.bindMemory(to: UInt8.self).baseAddress,
                            local.count,
                            localDevice,
                            remoteBytes.bindMemory(to: UInt8.self).baseAddress,
                            remote.count,
                            remoteDevice,
                            messageType,
                            cipherBytes.bindMemory(to: UInt8.self).baseAddress,
                            ciphertext.count,
                            &nextStore,
                            &plaintext
                        )
                        guard status == 0 else { throw nativeError(status) }
                        return DecryptResult(store: take(nextStore), plaintext: take(plaintext))
                    }
                }
            }
        }
    }

    private static func take(_ buffer: AegisBuffer) -> Data {
        defer { aegis_crypto_buffer_free(buffer) }
        guard let pointer = buffer.data, buffer.len > 0 else { return Data() }
        return Data(bytes: pointer, count: buffer.len)
    }

    private static func nativeError(_ status: Int32) -> NSError {
        let pointer = aegis_crypto_last_error_message()
        let message = pointer.map {
            String(cString: UnsafeRawPointer($0).assumingMemoryBound(to: CChar.self))
        } ?? "AEGIS_NATIVE_OPERATION_FAILED"
        return NSError(
            domain: "fans.forsure.aegis.crypto",
            code: Int(status),
            userInfo: [NSLocalizedDescriptionKey: message]
        )
    }
}
