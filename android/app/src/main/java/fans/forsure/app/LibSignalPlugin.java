package fans.forsure.app;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import fans.forsure.app.crypto.AegisCryptoNative;

/**
 * Capacitor bridge for the shared Rust/libsignal engine.
 *
 * The plugin is intentionally stateless. The serialized store is supplied by
 * JavaScript for each operation and the updated store is returned immediately;
 * libsignalPlatformBridge seals it with AegisKeychain before any network-visible
 * result is used. This keeps Android, iOS and Windows on the same store format.
 */
@CapacitorPlugin(name = "LibSignal")
public final class LibSignalPlugin extends Plugin {
    private static final int EXPECTED_ABI = 1;
    private static final String ENGINE = "signalapp/libsignal-rust";

    private static String b64(byte[] value) {
        return Base64.encodeToString(value, Base64.NO_WRAP);
    }

    private static byte[] fromB64(String value) {
        return Base64.decode(value, Base64.NO_WRAP);
    }

    private static String requiredString(PluginCall call, String key) {
        String value = call.getString(key);
        if (value == null || value.isEmpty()) throw new IllegalArgumentException(key + " required");
        return value;
    }

    private static int requiredInt(PluginCall call, String key) {
        Integer value = call.getInt(key);
        if (value == null || value <= 0) throw new IllegalArgumentException(key + " invalid");
        return value;
    }

    private static int requiredMessageType(PluginCall call) {
        Integer value = call.getInt("messageType");
        if (value == null || value < 0 || value > 255) {
            throw new IllegalArgumentException("messageType invalid");
        }
        return value;
    }

    /**
     * Capacitor 8 PluginCall.reject accepts Exception, not Throwable. Native
     * linkage failures are Errors, so preserve them by wrapping them rather
     * than letting them escape across the plugin boundary.
     */
    private static void reject(PluginCall call, String code, String message, Throwable error) {
        Exception cause = error instanceof Exception
            ? (Exception) error
            : new RuntimeException(error);
        call.reject(message, code, cause);
    }

    private static void requireAbi() {
        int abi = AegisCryptoNative.abiVersion();
        if (abi != EXPECTED_ABI) throw new IllegalStateException("AEGIS_NATIVE_ABI_MISMATCH:" + abi);
    }

    @PluginMethod
    public void getCapabilities(PluginCall call) {
        try {
            requireAbi();
            JSObject result = new JSObject();
            result.put("available", true);
            result.put("engine", ENGINE);
            result.put("platform", "android");
            result.put("abiVersion", EXPECTED_ABI);
            result.put("pqxdh", true);
            result.put("kyber1024", true);
            call.resolve(result);
        } catch (Throwable error) {
            reject(call, "LIBSIGNAL_NATIVE_UNAVAILABLE", "Native libsignal unavailable", error);
        }
    }

    @PluginMethod
    public void createStore(PluginCall call) {
        try {
            requireAbi();
            byte[] store = AegisCryptoNative.storeCreate(requiredInt(call, "registrationId"));
            JSObject result = new JSObject();
            result.put("storeB64", b64(store));
            call.resolve(result);
        } catch (Throwable error) {
            reject(call, "LIBSIGNAL_STORE_CREATE_FAILED", "Failed to create libsignal store", error);
        }
    }

    @PluginMethod
    public void createBundle(PluginCall call) {
        try {
            requireAbi();
            byte[][] output = AegisCryptoNative.bundleCreate(
                fromB64(requiredString(call, "storeB64")),
                requiredInt(call, "deviceNumber"),
                requiredInt(call, "preKeyId"),
                requiredInt(call, "signedPreKeyId"),
                requiredInt(call, "kyberPreKeyId")
            );
            if (output == null || output.length != 2) throw new IllegalStateException("AEGIS_BUNDLE_OUTPUT_INVALID");
            JSObject result = new JSObject();
            result.put("storeB64", b64(output[0]));
            result.put("bundleB64", b64(output[1]));
            call.resolve(result);
        } catch (Throwable error) {
            reject(call, "LIBSIGNAL_BUNDLE_CREATE_FAILED", "Failed to create libsignal bundle", error);
        }
    }

    @PluginMethod
    public void establishSession(PluginCall call) {
        try {
            requireAbi();
            byte[] nextStore = AegisCryptoNative.sessionEstablish(
                fromB64(requiredString(call, "storeB64")),
                requiredString(call, "localUserId"),
                requiredInt(call, "localDeviceNumber"),
                requiredString(call, "remoteUserId"),
                requiredInt(call, "remoteDeviceNumber"),
                fromB64(requiredString(call, "bundleB64"))
            );
            JSObject result = new JSObject();
            result.put("storeB64", b64(nextStore));
            call.resolve(result);
        } catch (Throwable error) {
            reject(call, "LIBSIGNAL_SESSION_ESTABLISH_FAILED", "Failed to establish libsignal session", error);
        }
    }

    @PluginMethod
    public void encrypt(PluginCall call) {
        try {
            requireAbi();
            byte[][] output = AegisCryptoNative.messageEncrypt(
                fromB64(requiredString(call, "storeB64")),
                requiredString(call, "localUserId"),
                requiredInt(call, "localDeviceNumber"),
                requiredString(call, "remoteUserId"),
                requiredInt(call, "remoteDeviceNumber"),
                fromB64(requiredString(call, "plaintextB64"))
            );
            if (output == null || output.length != 3 || output[1].length != 1) {
                throw new IllegalStateException("AEGIS_ENCRYPT_OUTPUT_INVALID");
            }
            JSObject result = new JSObject();
            result.put("storeB64", b64(output[0]));
            result.put("messageType", output[1][0] & 0xff);
            result.put("ciphertextB64", b64(output[2]));
            call.resolve(result);
        } catch (Throwable error) {
            reject(call, "LIBSIGNAL_ENCRYPT_FAILED", "Failed to encrypt libsignal message", error);
        }
    }

    @PluginMethod
    public void decrypt(PluginCall call) {
        try {
            requireAbi();
            byte[][] output = AegisCryptoNative.messageDecrypt(
                fromB64(requiredString(call, "storeB64")),
                requiredString(call, "localUserId"),
                requiredInt(call, "localDeviceNumber"),
                requiredString(call, "remoteUserId"),
                requiredInt(call, "remoteDeviceNumber"),
                requiredMessageType(call),
                fromB64(requiredString(call, "ciphertextB64"))
            );
            if (output == null || output.length != 2) throw new IllegalStateException("AEGIS_DECRYPT_OUTPUT_INVALID");
            JSObject result = new JSObject();
            result.put("storeB64", b64(output[0]));
            result.put("plaintextB64", b64(output[1]));
            call.resolve(result);
        } catch (Throwable error) {
            reject(call, "LIBSIGNAL_DECRYPT_FAILED", "Failed to decrypt libsignal message", error);
        }
    }
}
