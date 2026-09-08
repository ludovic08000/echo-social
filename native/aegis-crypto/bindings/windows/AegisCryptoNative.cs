using System;
using System.Runtime.InteropServices;
using System.Text;

namespace Forsure.Aegis.Crypto;

/// <summary>
/// P/Invoke facade over the same serialized Rust/libsignal store used by iOS,
/// Android and WASM. Mutating calls return a new store that must be protected
/// by the Windows credential/vault layer before network output is committed.
/// </summary>
internal static class AegisCryptoNative
{
    internal const uint ExpectedAbi = 1;

    [StructLayout(LayoutKind.Sequential)]
    private struct Buffer
    {
        public IntPtr Data;
        public nuint Length;
    }

    [DllImport("aegis_crypto", CallingConvention = CallingConvention.Cdecl)]
    internal static extern uint aegis_crypto_abi_version();

    [DllImport("aegis_crypto", CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr aegis_crypto_last_error_message();

    [DllImport("aegis_crypto", CallingConvention = CallingConvention.Cdecl)]
    private static extern void aegis_crypto_buffer_free(Buffer buffer);

    [DllImport("aegis_crypto", CallingConvention = CallingConvention.Cdecl)]
    private static extern int aegis_crypto_identity_generate(out Buffer secret, out Buffer publicKey);

    [DllImport("aegis_crypto", CallingConvention = CallingConvention.Cdecl)]
    private static extern int aegis_crypto_store_create(uint registrationId, out Buffer store);

    [DllImport("aegis_crypto", CallingConvention = CallingConvention.Cdecl)]
    private static extern int aegis_crypto_bundle_create(
        byte[] store, nuint storeLength,
        uint deviceId, uint preKeyId, uint signedPreKeyId, uint kyberPreKeyId,
        out Buffer nextStore, out Buffer publicBundle);

    [DllImport("aegis_crypto", CallingConvention = CallingConvention.Cdecl)]
    private static extern int aegis_crypto_session_establish(
        byte[] store, nuint storeLength,
        byte[] localName, nuint localNameLength, uint localDevice,
        byte[] remoteName, nuint remoteNameLength, uint remoteDevice,
        byte[] bundle, nuint bundleLength,
        out Buffer nextStore);

    [DllImport("aegis_crypto", CallingConvention = CallingConvention.Cdecl)]
    private static extern int aegis_crypto_message_encrypt(
        byte[] store, nuint storeLength,
        byte[] localName, nuint localNameLength, uint localDevice,
        byte[] remoteName, nuint remoteNameLength, uint remoteDevice,
        byte[] plaintext, nuint plaintextLength,
        out Buffer nextStore, out byte messageType, out Buffer ciphertext);

    [DllImport("aegis_crypto", CallingConvention = CallingConvention.Cdecl)]
    private static extern int aegis_crypto_message_decrypt(
        byte[] store, nuint storeLength,
        byte[] localName, nuint localNameLength, uint localDevice,
        byte[] remoteName, nuint remoteNameLength, uint remoteDevice,
        byte messageType,
        byte[] ciphertext, nuint ciphertextLength,
        out Buffer nextStore, out Buffer plaintext);

    internal static void RequireAbi()
    {
        var actual = aegis_crypto_abi_version();
        if (actual != ExpectedAbi)
            throw new InvalidOperationException($"AEGIS_NATIVE_ABI_MISMATCH:{actual}");
    }

    internal static (byte[] SecretRecord, byte[] PublicKey) GenerateIdentity()
    {
        RequireAbi();
        var status = aegis_crypto_identity_generate(out var secret, out var publicKey);
        Check(status);
        try
        {
            return (Copy(secret), Copy(publicKey));
        }
        finally
        {
            aegis_crypto_buffer_free(secret);
            aegis_crypto_buffer_free(publicKey);
        }
    }

    internal static byte[] CreateStore(uint registrationId)
    {
        RequireAbi();
        var status = aegis_crypto_store_create(registrationId, out var store);
        Check(status);
        return Take(store);
    }

    internal static (byte[] Store, byte[] PublicBundle) CreateBundle(
        byte[] store,
        uint deviceId,
        uint preKeyId,
        uint signedPreKeyId,
        uint kyberPreKeyId)
    {
        RequireAbi();
        var status = aegis_crypto_bundle_create(
            store, (nuint)store.Length,
            deviceId, preKeyId, signedPreKeyId, kyberPreKeyId,
            out var nextStore, out var publicBundle);
        Check(status);
        try
        {
            return (Copy(nextStore), Copy(publicBundle));
        }
        finally
        {
            aegis_crypto_buffer_free(nextStore);
            aegis_crypto_buffer_free(publicBundle);
        }
    }

    internal static byte[] EstablishSession(
        byte[] store,
        string localUserId,
        uint localDevice,
        string remoteUserId,
        uint remoteDevice,
        byte[] bundle)
    {
        RequireAbi();
        var local = Utf8(localUserId);
        var remote = Utf8(remoteUserId);
        var status = aegis_crypto_session_establish(
            store, (nuint)store.Length,
            local, (nuint)local.Length, localDevice,
            remote, (nuint)remote.Length, remoteDevice,
            bundle, (nuint)bundle.Length,
            out var nextStore);
        Check(status);
        return Take(nextStore);
    }

    internal static (byte[] Store, byte MessageType, byte[] Ciphertext) Encrypt(
        byte[] store,
        string localUserId,
        uint localDevice,
        string remoteUserId,
        uint remoteDevice,
        byte[] plaintext)
    {
        RequireAbi();
        var local = Utf8(localUserId);
        var remote = Utf8(remoteUserId);
        var status = aegis_crypto_message_encrypt(
            store, (nuint)store.Length,
            local, (nuint)local.Length, localDevice,
            remote, (nuint)remote.Length, remoteDevice,
            plaintext, (nuint)plaintext.Length,
            out var nextStore, out var messageType, out var ciphertext);
        Check(status);
        try
        {
            return (Copy(nextStore), messageType, Copy(ciphertext));
        }
        finally
        {
            aegis_crypto_buffer_free(nextStore);
            aegis_crypto_buffer_free(ciphertext);
        }
    }

    internal static (byte[] Store, byte[] Plaintext) Decrypt(
        byte[] store,
        string localUserId,
        uint localDevice,
        string remoteUserId,
        uint remoteDevice,
        byte messageType,
        byte[] ciphertext)
    {
        RequireAbi();
        var local = Utf8(localUserId);
        var remote = Utf8(remoteUserId);
        var status = aegis_crypto_message_decrypt(
            store, (nuint)store.Length,
            local, (nuint)local.Length, localDevice,
            remote, (nuint)remote.Length, remoteDevice,
            messageType,
            ciphertext, (nuint)ciphertext.Length,
            out var nextStore, out var plaintext);
        Check(status);
        try
        {
            return (Copy(nextStore), Copy(plaintext));
        }
        finally
        {
            aegis_crypto_buffer_free(nextStore);
            aegis_crypto_buffer_free(plaintext);
        }
    }

    private static byte[] Utf8(string value)
    {
        if (string.IsNullOrEmpty(value)) throw new ArgumentException("AEGIS_USER_ID_REQUIRED");
        return Encoding.UTF8.GetBytes(value);
    }

    private static byte[] Take(Buffer buffer)
    {
        try { return Copy(buffer); }
        finally { aegis_crypto_buffer_free(buffer); }
    }

    private static byte[] Copy(Buffer buffer)
    {
        if (buffer.Length == 0) return Array.Empty<byte>();
        if (buffer.Data == IntPtr.Zero) throw new InvalidOperationException("AEGIS_NATIVE_BUFFER_INVALID");
        var result = new byte[checked((int)buffer.Length)];
        Marshal.Copy(buffer.Data, result, 0, result.Length);
        return result;
    }

    private static void Check(int status)
    {
        if (status == 0) return;
        var pointer = aegis_crypto_last_error_message();
        var message = pointer == IntPtr.Zero ? null : Marshal.PtrToStringUTF8(pointer);
        throw new InvalidOperationException(message ?? $"AEGIS_NATIVE_ERROR:{status}");
    }
}
