using System;
using System.Runtime.InteropServices;

namespace Forsure.Aegis.Crypto;

internal static class AegisCryptoNative
{
    [StructLayout(LayoutKind.Sequential)]
    private struct Buffer { public IntPtr Data; public nuint Length; }

    [DllImport("aegis_crypto", CallingConvention = CallingConvention.Cdecl)]
    internal static extern uint aegis_crypto_abi_version();

    [DllImport("aegis_crypto", CallingConvention = CallingConvention.Cdecl)]
    private static extern int aegis_crypto_identity_generate(out Buffer secret, out Buffer publicKey);

    [DllImport("aegis_crypto", CallingConvention = CallingConvention.Cdecl)]
    private static extern void aegis_crypto_buffer_free(Buffer buffer);

    internal static (byte[] SecretRecord, byte[] PublicKey) GenerateIdentity()
    {
        var status = aegis_crypto_identity_generate(out var secret, out var publicKey);
        if (status != 0) throw new InvalidOperationException($"Aegis crypto error {status}");
        try {
            return (Copy(secret), Copy(publicKey));
        }
        finally {
            aegis_crypto_buffer_free(secret);
            aegis_crypto_buffer_free(publicKey);
        }
    }

    private static byte[] Copy(Buffer buffer)
    {
        var result = new byte[checked((int)buffer.Length)];
        Marshal.Copy(buffer.Data, result, 0, result.Length);
        return result;
    }
}

