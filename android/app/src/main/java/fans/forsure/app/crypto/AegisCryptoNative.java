package fans.forsure.app.crypto;

/** JNI vers le moteur Rust/libsignal embarque dans l'APK. */
public final class AegisCryptoNative {
    static { System.loadLibrary("aegis_crypto"); }
    private AegisCryptoNative() {}

    public static native int abiVersion();
    public static native byte[][] generateIdentity();
    public static native byte[] storeCreate(int registrationId);
    public static native byte[][] bundleCreate(
        byte[] store,
        int deviceId,
        int preKeyId,
        int signedPreKeyId,
        int kyberPreKeyId
    );
    public static native byte[] sessionEstablish(
        byte[] store,
        String localName,
        int localDevice,
        String remoteName,
        int remoteDevice,
        byte[] bundle
    );
    public static native byte[][] messageEncrypt(
        byte[] store,
        String localName,
        int localDevice,
        String remoteName,
        int remoteDevice,
        byte[] plaintext
    );
    public static native byte[][] messageDecrypt(
        byte[] store,
        String localName,
        int localDevice,
        String remoteName,
        int remoteDevice,
        int messageType,
        byte[] ciphertext
    );
}
