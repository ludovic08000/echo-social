package fans.forsure.app;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.ConcurrentHashMap;
import org.signal.libsignal.protocol.IdentityKey;
import org.signal.libsignal.protocol.IdentityKeyPair;
import org.signal.libsignal.protocol.SessionBuilder;
import org.signal.libsignal.protocol.SessionCipher;
import org.signal.libsignal.protocol.SignalProtocolAddress;
import org.signal.libsignal.protocol.ecc.ECKeyPair;
import org.signal.libsignal.protocol.ecc.ECPublicKey;
import org.signal.libsignal.protocol.kem.KEMKeyPair;
import org.signal.libsignal.protocol.kem.KEMKeyType;
import org.signal.libsignal.protocol.kem.KEMPublicKey;
import org.signal.libsignal.protocol.message.CiphertextMessage;
import org.signal.libsignal.protocol.message.PreKeySignalMessage;
import org.signal.libsignal.protocol.message.SignalMessage;
import org.signal.libsignal.protocol.state.KyberPreKeyRecord;
import org.signal.libsignal.protocol.state.PreKeyBundle;
import org.signal.libsignal.protocol.state.PreKeyRecord;
import org.signal.libsignal.protocol.state.SignalProtocolStore;
import org.signal.libsignal.protocol.state.SignedPreKeyRecord;
import org.signal.libsignal.protocol.state.impl.InMemorySignalProtocolStore;
import org.signal.libsignal.protocol.util.KeyHelper;
import org.signal.libsignal.protocol.util.Medium;

@CapacitorPlugin(name = "LibSignal")
public final class LibSignalPlugin extends Plugin {
  private static final String ENGINE = "signalapp/libsignal";
  private static final Map<String, DeviceState> DEVICES = new ConcurrentHashMap<>();
  private volatile DeviceState current;
  private static volatile android.content.Context appContext;

  @Override public void load() { appContext = getContext().getApplicationContext(); }

  private static final class DeviceState {
    final String userId;
    final String deviceId;
    final int signalDeviceId;
    final SignalProtocolStore store;
    final PreKeyRecord preKey;
    final SignedPreKeyRecord signedPreKey;
    final KyberPreKeyRecord kyberPreKey;
    DeviceState(String userId, String deviceId) throws Exception {
      this.userId = userId;
      this.deviceId = deviceId;
      this.signalDeviceId = stableSignalDeviceId(deviceId);
      this.store = newStore();
      Random random = new Random();
      int preKeyId = random.nextInt(Medium.MAX_VALUE);
      int signedId = random.nextInt(Medium.MAX_VALUE);
      int kyberId = random.nextInt(Medium.MAX_VALUE);
      ECKeyPair pre = ECKeyPair.generate();
      ECKeyPair signed = ECKeyPair.generate();
      byte[] signedSig = store.getIdentityKeyPair().getPrivateKey().calculateSignature(signed.getPublicKey().serialize());
      KEMKeyPair kyber = KEMKeyPair.generate(KEMKeyType.KYBER_1024);
      byte[] kyberSig = store.getIdentityKeyPair().getPrivateKey().calculateSignature(kyber.getPublicKey().serialize());
      this.preKey = new PreKeyRecord(preKeyId, pre);
      this.signedPreKey = new SignedPreKeyRecord(signedId, System.currentTimeMillis(), signed, signedSig);
      this.kyberPreKey = new KyberPreKeyRecord(kyberId, System.currentTimeMillis(), kyber, kyberSig);
      store.storePreKey(preKeyId, preKey);
      store.storeSignedPreKey(signedId, signedPreKey);
      store.storeKyberPreKey(kyberId, kyberPreKey);
    }
  }

  @PluginMethod
  public void getCapabilities(PluginCall call) {
    JSObject result = new JSObject();
    result.put("available", true); result.put("engine", ENGINE); result.put("platform", "android");
    result.put("pqxdh", true); result.put("kyber1024", true); result.put("nativeSelfTest", true);
    call.resolve(result);
  }

  @PluginMethod
  public void ensureDevice(PluginCall call) {
    try {
      String userId = required(call.getString("userId"), "userId");
      String deviceId = required(call.getString("deviceId"), "deviceId");
      current = DEVICES.computeIfAbsent(userId + "|" + deviceId, key -> {
        try { return new DeviceState(userId, deviceId); } catch (Exception e) { throw new IllegalStateException(e); }
      });
      call.resolve(toBundle(current));
    } catch (Exception error) { call.reject("LIBSIGNAL_DEVICE_INIT_FAILED", error); }
  }

  @PluginMethod
  public void encryptForDevice(PluginCall call) {
    try {
      DeviceState state = requireCurrent();
      String recipientUserId = required(call.getString("recipientUserId"), "recipientUserId");
      String recipientDeviceId = required(call.getString("recipientDeviceId"), "recipientDeviceId");
      String plaintext = required(call.getString("plaintext"), "plaintext");
      JSObject b = call.getObject("bundle");
      if (b == null) throw new IllegalArgumentException("bundle required");
      int remoteSignalDeviceId = requiredInt(b, "signalDeviceId");
      SignalProtocolAddress local = new SignalProtocolAddress(state.userId, state.signalDeviceId);
      SignalProtocolAddress remote = new SignalProtocolAddress(recipientUserId, remoteSignalDeviceId);
      if (!state.store.containsSession(remote)) new SessionBuilder(state.store, remote, local).process(bundleFromJs(b));
      CiphertextMessage encrypted = new SessionCipher(state.store, local, remote).encrypt(plaintext.getBytes(StandardCharsets.UTF_8));
      JSObject result = new JSObject();
      result.put("messageType", encrypted.getType() == CiphertextMessage.PREKEY_TYPE ? "prekey" : "signal");
      result.put("ciphertextB64", b64(encrypted.serialize()));
      call.resolve(result);
    } catch (Exception error) { call.reject("LIBSIGNAL_ENCRYPT_FAILED", error); }
  }

  @PluginMethod
  public void decryptFromDevice(PluginCall call) {
    try {
      DeviceState state = requireCurrent();
      String senderUserId = required(call.getString("senderUserId"), "senderUserId");
      String senderDeviceId = required(call.getString("senderDeviceId"), "senderDeviceId");
      String messageType = required(call.getString("messageType"), "messageType");
      byte[] ciphertext = fromB64(required(call.getString("ciphertextB64"), "ciphertextB64"));
      SignalProtocolAddress local = new SignalProtocolAddress(state.userId, state.signalDeviceId);
      SignalProtocolAddress remote = new SignalProtocolAddress(senderUserId, stableSignalDeviceId(senderDeviceId));
      SessionCipher cipher = new SessionCipher(state.store, local, remote);
      byte[] plaintext = "prekey".equals(messageType)
          ? cipher.decrypt(new PreKeySignalMessage(ciphertext))
          : cipher.decrypt(new SignalMessage(ciphertext));
      JSObject result = new JSObject(); result.put("plaintext", new String(plaintext, StandardCharsets.UTF_8)); call.resolve(result);
    } catch (Exception error) { call.reject("LIBSIGNAL_DECRYPT_FAILED", error); }
  }

  @PluginMethod
  public void runSelfTest(PluginCall call) {
    try {
      SignalProtocolStore alice = newStore(); SignalProtocolStore bob = newStore();
      SignalProtocolAddress a = new SignalProtocolAddress("selftest-alice", 1);
      SignalProtocolAddress b = new SignalProtocolAddress("selftest-bob", 1);
      new SessionBuilder(alice, b, a).process(createBundle(bob));
      SessionCipher ac = new SessionCipher(alice, a, b); SessionCipher bc = new SessionCipher(bob, b, a);
      CiphertextMessage first = ac.encrypt("forsure-libsignal-pqxdh".getBytes(StandardCharsets.UTF_8));
      String plain = new String(bc.decrypt(new PreKeySignalMessage(first.serialize())), StandardCharsets.UTF_8);
      JSObject result = new JSObject(); result.put("ok", "forsure-libsignal-pqxdh".equals(plain)); result.put("engine", ENGINE);
      result.put("protocol", "PQXDH"); result.put("sessionVersion", alice.loadSession(b).getSessionVersion()); result.put("elapsedMs", 0); result.put("roundTrips", 1); call.resolve(result);
    } catch (Exception error) { call.reject("LIBSIGNAL_SELF_TEST_FAILED", error); }
  }

  private DeviceState requireCurrent() { if (current == null) throw new IllegalStateException("LIBSIGNAL_DEVICE_NOT_INITIALIZED"); return current; }
  private static String required(String value, String name) { if (value == null || value.isEmpty()) throw new IllegalArgumentException(name + " required"); return value; }
  private static int requiredInt(JSObject value, String name) { Integer result = value.getInteger(name); if (result == null) throw new IllegalArgumentException(name + " required"); return result; }
  private static int stableSignalDeviceId(String id) { return (id.hashCode() & 0x7fffffff) % 2147483646 + 1; }
  private static String b64(byte[] value) { return Base64.encodeToString(value, Base64.NO_WRAP); }
  private static byte[] fromB64(String value) { return Base64.decode(value, Base64.NO_WRAP); }

  private static JSObject toBundle(DeviceState s) throws Exception {
    JSObject b = new JSObject(); b.put("signalDeviceId", s.signalDeviceId); b.put("registrationId", s.store.getLocalRegistrationId());
    b.put("identityKeyB64", b64(s.store.getIdentityKeyPair().getPublicKey().serialize())); b.put("signedPreKeyId", s.signedPreKey.getId());
    b.put("signedPreKeyB64", b64(s.signedPreKey.getKeyPair().getPublicKey().serialize())); b.put("signedPreKeySignatureB64", b64(s.signedPreKey.getSignature()));
    b.put("kyberPreKeyId", s.kyberPreKey.getId()); b.put("kyberPreKeyB64", b64(s.kyberPreKey.getKeyPair().getPublicKey().serialize()));
    b.put("kyberPreKeySignatureB64", b64(s.kyberPreKey.getSignature())); b.put("oneTimePreKeyId", s.preKey.getId()); b.put("oneTimePreKeyB64", b64(s.preKey.getKeyPair().getPublicKey().serialize())); return b;
  }

  private static PreKeyBundle bundleFromJs(JSObject b) throws Exception {
    return new PreKeyBundle(requiredInt(b,"registrationId"), requiredInt(b,"signalDeviceId"), requiredInt(b,"oneTimePreKeyId"), new ECPublicKey(fromB64(required(b.getString("oneTimePreKeyB64"),"oneTimePreKeyB64"))), requiredInt(b,"signedPreKeyId"), new ECPublicKey(fromB64(required(b.getString("signedPreKeyB64"),"signedPreKeyB64"))), fromB64(required(b.getString("signedPreKeySignatureB64"),"signedPreKeySignatureB64")), new IdentityKey(fromB64(required(b.getString("identityKeyB64"),"identityKeyB64"))), requiredInt(b,"kyberPreKeyId"), new KEMPublicKey(fromB64(required(b.getString("kyberPreKeyB64"),"kyberPreKeyB64"))), fromB64(required(b.getString("kyberPreKeySignatureB64"),"kyberPreKeySignatureB64")));
  }

  private static SignalProtocolStore newStore() { return new InMemorySignalProtocolStore(IdentityKeyPair.generate(), KeyHelper.generateRegistrationId(false)); }
  private static PreKeyBundle createBundle(SignalProtocolStore store) throws Exception {
    ECKeyPair pre = ECKeyPair.generate(); ECKeyPair signed = ECKeyPair.generate(); byte[] ss = store.getIdentityKeyPair().getPrivateKey().calculateSignature(signed.getPublicKey().serialize());
    KEMKeyPair kyber = KEMKeyPair.generate(KEMKeyType.KYBER_1024); byte[] ks = store.getIdentityKeyPair().getPrivateKey().calculateSignature(kyber.getPublicKey().serialize()); Random r = new Random();
    int p=r.nextInt(Medium.MAX_VALUE), s=r.nextInt(Medium.MAX_VALUE), k=r.nextInt(Medium.MAX_VALUE); store.storePreKey(p,new PreKeyRecord(p,pre)); store.storeSignedPreKey(s,new SignedPreKeyRecord(s,System.currentTimeMillis(),signed,ss)); store.storeKyberPreKey(k,new KyberPreKeyRecord(k,System.currentTimeMillis(),kyber,ks));
    return new PreKeyBundle(store.getLocalRegistrationId(),1,p,pre.getPublicKey(),s,signed.getPublicKey(),ss,store.getIdentityKeyPair().getPublicKey(),k,kyber.getPublicKey(),ks);
  }
}