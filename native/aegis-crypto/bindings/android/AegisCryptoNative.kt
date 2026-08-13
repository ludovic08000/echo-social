package fans.forsure.app.crypto

/** Accès JNI au moteur Rust. `identity[0]` est secret, `identity[1]` public. */
internal object AegisCryptoNative {
    init { System.loadLibrary("aegis_crypto") }

    external fun abiVersion(): Int
    external fun generateIdentity(): Array<ByteArray>
}

