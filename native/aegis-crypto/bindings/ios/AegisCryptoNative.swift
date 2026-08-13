import Foundation

/// Façade Swift. Les Data secrets doivent être écrits dans ACE/Keychain avant
/// de quitter le flux d'enrôlement et ne doivent jamais être journalisés.
enum AegisCryptoNative {
    struct Identity {
        let secretRecord: Data
        let publicKey: Data
    }

    static func generateIdentity() throws -> Identity {
        var secret = AegisBuffer(data: nil, len: 0)
        var publicKey = AegisBuffer(data: nil, len: 0)
        let status = aegis_crypto_identity_generate(&secret, &publicKey)
        guard status == 0 else { throw nativeError(status) }
        defer {
            aegis_crypto_buffer_free(secret)
            aegis_crypto_buffer_free(publicKey)
        }
        return Identity(
            secretRecord: Data(bytes: secret.data, count: secret.len),
            publicKey: Data(bytes: publicKey.data, count: publicKey.len)
        )
    }

    private static func nativeError(_ status: Int32) -> NSError {
        let pointer = aegis_crypto_last_error_message()
        let message = pointer.map {
            String(cString: UnsafeRawPointer($0).assumingMemoryBound(to: CChar.self))
        } ?? "Erreur native Aegis"
        return NSError(domain: "fans.forsure.aegis.crypto", code: Int(status),
                       userInfo: [NSLocalizedDescriptionKey: message])
    }
}
