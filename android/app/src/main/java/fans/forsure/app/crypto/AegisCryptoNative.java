package fans.forsure.app.crypto;

/** JNI minimal vers le moteur Rust libsignal embarque dans l'APK. */
final class AegisCryptoNative {
    static { System.loadLibrary("aegis_crypto"); }
    private AegisCryptoNative() {}
    static native int abiVersion();
    static native byte[][] generateIdentity();
}
