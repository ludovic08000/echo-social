package fans.forsure.app.crypto;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "AegisKeychain")
public final class AegisKeychainPlugin extends Plugin {
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "forsure.aegis.snapshot.prod";
    private static final String PREFS = "forsure_aegis_sealed_records";

    private SharedPreferences records() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance(KEYSTORE);
        store.load(null);
        java.security.Key existing = store.getKey(KEY_ALIAS, null);
        if (existing instanceof SecretKey) return (SecretKey) existing;
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(
            KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(false);
        if (android.os.Build.VERSION.SDK_INT >= 28) spec.setUnlockedDeviceRequired(true);
        generator.init(spec.build());
        return generator.generateKey();
    }

    private String seal(String name, String value) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        cipher.updateAAD(name.getBytes(StandardCharsets.UTF_8));
        byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        ByteBuffer blob = ByteBuffer.allocate(1 + cipher.getIV().length + encrypted.length);
        blob.put((byte) cipher.getIV().length).put(cipher.getIV()).put(encrypted);
        return Base64.encodeToString(blob.array(), Base64.NO_WRAP);
    }

    private String open(String name, String encoded) throws Exception {
        ByteBuffer blob = ByteBuffer.wrap(Base64.decode(encoded, Base64.NO_WRAP));
        int ivLength = blob.get() & 0xff;
        if (ivLength != 12 || blob.remaining() <= ivLength) throw new IllegalStateException("AEGIS_INVALID_BLOB");
        byte[] iv = new byte[ivLength];
        blob.get(iv);
        byte[] encrypted = new byte[blob.remaining()];
        blob.get(encrypted);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
        cipher.updateAAD(name.getBytes(StandardCharsets.UTF_8));
        return new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
    }

    @PluginMethod
    public void set(PluginCall call) {
        String name = call.getString("key");
        String value = call.getString("value");
        if (name == null || value == null) { call.reject("AEGIS_KEY_VALUE_REQUIRED"); return; }
        try {
            // Invariant Aegis Android : seul le blob AES-GCM quitte le Keystore.
            String sealed = seal(name, value);
            if (!records().edit().putString(name, sealed).commit()) throw new IllegalStateException("AEGIS_COMMIT_FAILED");
            if (!value.equals(open(name, records().getString(name, "")))) throw new IllegalStateException("AEGIS_READBACK_MISMATCH");
            call.resolve();
        } catch (Exception error) { call.reject("AEGIS_SET_FAILED", error); }
    }

    @PluginMethod
    public void get(PluginCall call) {
        String name = call.getString("key");
        if (name == null) { call.reject("AEGIS_KEY_REQUIRED"); return; }
        try {
            String sealed = records().getString(name, null);
            JSObject result = new JSObject();
            if (sealed != null) result.put("value", open(name, sealed));
            call.resolve(result);
        } catch (Exception error) { call.reject("AEGIS_GET_FAILED", error); }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String name = call.getString("key");
        if (name == null) { call.reject("AEGIS_KEY_REQUIRED"); return; }
        if (!records().edit().remove(name).commit()) { call.reject("AEGIS_REMOVE_FAILED"); return; }
        call.resolve();
    }

    @PluginMethod
    public void abiVersion(PluginCall call) {
        try {
            JSObject result = new JSObject();
            result.put("version", AegisCryptoNative.abiVersion());
            call.resolve(result);
        } catch (Throwable error) {
            call.reject("AEGIS_NATIVE_ENGINE_UNAVAILABLE", error.getClass().getSimpleName());
        }
    }
}
