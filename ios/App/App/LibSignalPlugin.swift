import Foundation
import Capacitor

/** Capacitor bridge over the shared Aegis/libsignal Rust engine. */
@objc(LibSignalPlugin)
public class LibSignalPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LibSignalPlugin"
    public let jsName = "LibSignal"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getCapabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "createStore", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "createBundle", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "establishSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "encrypt", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "decrypt", returnType: CAPPluginReturnPromise)
    ]

    private let queue = DispatchQueue(label: "fans.forsure.libsignal.native", qos: .userInitiated)

    private enum BridgeError: Error {
        case code(String)
    }

    private func requiredString(_ call: CAPPluginCall, _ key: String) throws -> String {
        guard let value = call.getString(key), !value.isEmpty else {
            throw BridgeError.code("LIBSIGNAL_\(key.uppercased())_REQUIRED")
        }
        return value
    }

    private func requiredUInt32(_ call: CAPPluginCall, _ key: String) throws -> UInt32 {
        guard let raw = call.getInt(key), raw > 0, raw <= Int(UInt32.max) else {
            throw BridgeError.code("LIBSIGNAL_\(key.uppercased())_INVALID")
        }
        return UInt32(raw)
    }

    private func requiredMessageType(_ call: CAPPluginCall) throws -> UInt8 {
        guard let raw = call.getInt("messageType"), raw >= 0, raw <= 255 else {
            throw BridgeError.code("LIBSIGNAL_MESSAGE_TYPE_INVALID")
        }
        return UInt8(raw)
    }

    private func decode(_ value: String) throws -> Data {
        guard let data = Data(base64Encoded: value) else {
            throw BridgeError.code("LIBSIGNAL_BASE64_INVALID")
        }
        return data
    }

    private func reject(_ call: CAPPluginCall, _ error: Error, fallback: String) {
        if case let BridgeError.code(code) = error {
            call.reject(code)
            return
        }
        let ns = error as NSError
        call.reject(ns.localizedDescription.isEmpty ? fallback : ns.localizedDescription)
    }

    @objc func getCapabilities(_ call: CAPPluginCall) {
        queue.async {
            do {
                try AegisCryptoNative.requireAbi()
                call.resolve([
                    "available": true,
                    "engine": "signalapp/libsignal-rust",
                    "platform": "ios",
                    "abiVersion": Int(AegisCryptoNative.expectedAbi),
                    "pqxdh": true,
                    "kyber1024": true
                ])
            } catch {
                self.reject(call, error, fallback: "LIBSIGNAL_NATIVE_UNAVAILABLE")
            }
        }
    }

    @objc func createStore(_ call: CAPPluginCall) {
        queue.async {
            do {
                let registrationId = try self.requiredUInt32(call, "registrationId")
                let store = try AegisCryptoNative.createStore(registrationId: registrationId)
                call.resolve(["storeB64": store.base64EncodedString()])
            } catch {
                self.reject(call, error, fallback: "LIBSIGNAL_STORE_CREATE_FAILED")
            }
        }
    }

    @objc func createBundle(_ call: CAPPluginCall) {
        queue.async {
            do {
                let store = try self.decode(self.requiredString(call, "storeB64"))
                let result = try AegisCryptoNative.createBundle(
                    store: store,
                    deviceId: self.requiredUInt32(call, "deviceNumber"),
                    preKeyId: self.requiredUInt32(call, "preKeyId"),
                    signedPreKeyId: self.requiredUInt32(call, "signedPreKeyId"),
                    kyberPreKeyId: self.requiredUInt32(call, "kyberPreKeyId")
                )
                call.resolve([
                    "storeB64": result.store.base64EncodedString(),
                    "bundleB64": result.publicBundle.base64EncodedString()
                ])
            } catch {
                self.reject(call, error, fallback: "LIBSIGNAL_BUNDLE_CREATE_FAILED")
            }
        }
    }

    @objc func establishSession(_ call: CAPPluginCall) {
        queue.async {
            do {
                let store = try self.decode(self.requiredString(call, "storeB64"))
                let bundle = try self.decode(self.requiredString(call, "bundleB64"))
                let nextStore = try AegisCryptoNative.establishSession(
                    store: store,
                    localName: self.requiredString(call, "localUserId"),
                    localDevice: self.requiredUInt32(call, "localDeviceNumber"),
                    remoteName: self.requiredString(call, "remoteUserId"),
                    remoteDevice: self.requiredUInt32(call, "remoteDeviceNumber"),
                    bundle: bundle
                )
                call.resolve(["storeB64": nextStore.base64EncodedString()])
            } catch {
                self.reject(call, error, fallback: "LIBSIGNAL_SESSION_ESTABLISH_FAILED")
            }
        }
    }

    @objc func encrypt(_ call: CAPPluginCall) {
        queue.async {
            do {
                let result = try AegisCryptoNative.encryptMessage(
                    store: self.decode(self.requiredString(call, "storeB64")),
                    localName: self.requiredString(call, "localUserId"),
                    localDevice: self.requiredUInt32(call, "localDeviceNumber"),
                    remoteName: self.requiredString(call, "remoteUserId"),
                    remoteDevice: self.requiredUInt32(call, "remoteDeviceNumber"),
                    plaintext: self.decode(self.requiredString(call, "plaintextB64"))
                )
                call.resolve([
                    "storeB64": result.store.base64EncodedString(),
                    "messageType": Int(result.messageType),
                    "ciphertextB64": result.ciphertext.base64EncodedString()
                ])
            } catch {
                self.reject(call, error, fallback: "LIBSIGNAL_ENCRYPT_FAILED")
            }
        }
    }

    @objc func decrypt(_ call: CAPPluginCall) {
        queue.async {
            do {
                let result = try AegisCryptoNative.decryptMessage(
                    store: self.decode(self.requiredString(call, "storeB64")),
                    localName: self.requiredString(call, "localUserId"),
                    localDevice: self.requiredUInt32(call, "localDeviceNumber"),
                    remoteName: self.requiredString(call, "remoteUserId"),
                    remoteDevice: self.requiredUInt32(call, "remoteDeviceNumber"),
                    messageType: self.requiredMessageType(call),
                    ciphertext: self.decode(self.requiredString(call, "ciphertextB64"))
                )
                call.resolve([
                    "storeB64": result.store.base64EncodedString(),
                    "plaintextB64": result.plaintext.base64EncodedString()
                ])
            } catch {
                self.reject(call, error, fallback: "LIBSIGNAL_DECRYPT_FAILED")
            }
        }
    }
}
