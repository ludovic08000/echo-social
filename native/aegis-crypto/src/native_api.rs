//! Portable native ABI above the same serialized libsignal store used by WASM.
//! Every mutating operation returns the updated store. Callers must seal that
//! store before publishing ciphertext or acknowledging a received message.

use std::str;

use futures::executor::block_on;
use libsignal_protocol::{IdentityKeyPair, ProtocolAddress};

use crate::{
    AEGIS_ERR_CRYPTO, AEGIS_ERR_INVALID_INPUT, AEGIS_ERR_NULL_POINTER, AegisBuffer,
    AegisSignalStore, DevicePreKeyBundle, EncryptedMessage, create_device_bundle,
    decrypt_message, encrypt_message, establish_outbound_session, ffi_guard, input_slice,
    owned_buffer, set_error,
};

type NativeResult<T> = Result<T, String>;

fn signal<T>(result: Result<T, libsignal_protocol::SignalProtocolError>) -> NativeResult<T> {
    result.map_err(|error| format!("AEGIS_LIBSIGNAL:{error}"))
}

fn address(name: &str, device_id: u32) -> NativeResult<ProtocolAddress> {
    let device = device_id
        .try_into()
        .map_err(|_| "AEGIS_DEVICE_ID_INVALID".to_owned())?;
    Ok(ProtocolAddress::new(name.to_owned(), device))
}

fn pack(parts: &[&[u8]]) -> Vec<u8> {
    let mut packed = Vec::new();
    for part in parts {
        packed.extend_from_slice(&(part.len() as u32).to_le_bytes());
        packed.extend_from_slice(part);
    }
    packed
}

fn unpack<'a>(mut bytes: &'a [u8], expected: usize) -> NativeResult<Vec<&'a [u8]>> {
    let mut parts = Vec::with_capacity(expected);
    for _ in 0..expected {
        if bytes.len() < 4 {
            return Err("AEGIS_PACK_INVALID".to_owned());
        }
        let len = u32::from_le_bytes(bytes[..4].try_into().expect("four bytes")) as usize;
        bytes = &bytes[4..];
        if bytes.len() < len {
            return Err("AEGIS_PACK_INVALID".to_owned());
        }
        parts.push(&bytes[..len]);
        bytes = &bytes[len..];
    }
    if !bytes.is_empty() {
        return Err("AEGIS_PACK_INVALID".to_owned());
    }
    Ok(parts)
}

fn encode_bundle(bundle: &DevicePreKeyBundle) -> Vec<u8> {
    let numbers = [
        bundle.registration_id,
        bundle.device_id,
        bundle.pre_key_id,
        bundle.signed_pre_key_id,
        bundle.kyber_pre_key_id,
    ];
    let metadata = numbers
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect::<Vec<_>>();
    pack(&[
        &metadata,
        &bundle.identity_key,
        &bundle.pre_key,
        &bundle.signed_pre_key,
        &bundle.signed_pre_key_signature,
        &bundle.kyber_pre_key,
        &bundle.kyber_pre_key_signature,
    ])
}

fn decode_bundle(bytes: &[u8]) -> NativeResult<DevicePreKeyBundle> {
    let parts = unpack(bytes, 7)?;
    if parts[0].len() != 20 {
        return Err("AEGIS_BUNDLE_INVALID".to_owned());
    }
    let number = |index: usize| {
        u32::from_le_bytes(
            parts[0][index * 4..index * 4 + 4]
                .try_into()
                .expect("four bytes"),
        )
    };
    Ok(DevicePreKeyBundle {
        registration_id: number(0),
        device_id: number(1),
        pre_key_id: number(2),
        signed_pre_key_id: number(3),
        kyber_pre_key_id: number(4),
        identity_key: parts[1].to_vec(),
        pre_key: parts[2].to_vec(),
        signed_pre_key: parts[3].to_vec(),
        signed_pre_key_signature: parts[4].to_vec(),
        kyber_pre_key: parts[5].to_vec(),
        kyber_pre_key_signature: parts[6].to_vec(),
    })
}

pub(crate) fn store_create(registration_id: u32) -> NativeResult<Vec<u8>> {
    if registration_id == 0 {
        return Err("AEGIS_REGISTRATION_ID_INVALID".to_owned());
    }
    let mut rng = rand::rng();
    signal(
        AegisSignalStore::new(IdentityKeyPair::generate(&mut rng), registration_id).serialize(),
    )
}

pub(crate) fn bundle_create(
    store: &[u8],
    device_id: u32,
    pre_key_id: u32,
    signed_pre_key_id: u32,
    kyber_pre_key_id: u32,
) -> NativeResult<(Vec<u8>, Vec<u8>)> {
    let mut store = signal(AegisSignalStore::deserialize(store))?;
    let bundle = signal(block_on(create_device_bundle(
        &mut store,
        device_id,
        pre_key_id,
        signed_pre_key_id,
        kyber_pre_key_id,
    )))?;
    let next_store = signal(store.serialize())?;
    Ok((next_store, encode_bundle(&bundle)))
}

pub(crate) fn session_establish(
    store: &[u8],
    local_name: &str,
    local_device: u32,
    remote_name: &str,
    remote_device: u32,
    bundle: &[u8],
) -> NativeResult<Vec<u8>> {
    let mut store = signal(AegisSignalStore::deserialize(store))?;
    let bundle = decode_bundle(bundle)?;
    signal(block_on(establish_outbound_session(
        &mut store,
        &address(local_name, local_device)?,
        &address(remote_name, remote_device)?,
        &bundle,
    )))?;
    signal(store.serialize())
}

pub(crate) fn message_encrypt(
    store: &[u8],
    local_name: &str,
    local_device: u32,
    remote_name: &str,
    remote_device: u32,
    plaintext: &[u8],
) -> NativeResult<(Vec<u8>, u8, Vec<u8>)> {
    let mut store = signal(AegisSignalStore::deserialize(store))?;
    let encrypted = signal(block_on(encrypt_message(
        &mut store,
        &address(local_name, local_device)?,
        &address(remote_name, remote_device)?,
        plaintext,
    )))?;
    let next_store = signal(store.serialize())?;
    Ok((next_store, encrypted.message_type, encrypted.ciphertext))
}

pub(crate) fn message_decrypt(
    store: &[u8],
    local_name: &str,
    local_device: u32,
    remote_name: &str,
    remote_device: u32,
    message_type: u8,
    ciphertext: &[u8],
) -> NativeResult<(Vec<u8>, Vec<u8>)> {
    let mut store = signal(AegisSignalStore::deserialize(store))?;
    let plaintext = signal(block_on(decrypt_message(
        &mut store,
        &address(local_name, local_device)?,
        &address(remote_name, remote_device)?,
        &EncryptedMessage {
            message_type,
            ciphertext: ciphertext.to_vec(),
        },
    )))?;
    let next_store = signal(store.serialize())?;
    Ok((next_store, plaintext))
}

fn ffi_error(message: String) -> i32 {
    set_error(message);
    AEGIS_ERR_CRYPTO
}

unsafe fn input_utf8<'a>(data: *const u8, len: usize) -> Result<&'a str, i32> {
    let bytes = unsafe { input_slice(data, len)? };
    str::from_utf8(bytes).map_err(|_| {
        set_error("AEGIS_UTF8_INVALID");
        AEGIS_ERR_INVALID_INPUT
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn aegis_crypto_store_create(
    registration_id: u32,
    out_store: *mut AegisBuffer,
) -> i32 {
    ffi_guard(|| {
        if out_store.is_null() {
            set_error("pointeur de sortie nul");
            return Err(AEGIS_ERR_NULL_POINTER);
        }
        let store = store_create(registration_id).map_err(ffi_error)?;
        unsafe { out_store.write(owned_buffer(store)) };
        Ok(())
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn aegis_crypto_bundle_create(
    store: *const u8,
    store_len: usize,
    device_id: u32,
    pre_key_id: u32,
    signed_pre_key_id: u32,
    kyber_pre_key_id: u32,
    out_store: *mut AegisBuffer,
    out_bundle: *mut AegisBuffer,
) -> i32 {
    ffi_guard(|| {
        if out_store.is_null() || out_bundle.is_null() {
            set_error("pointeur de sortie nul");
            return Err(AEGIS_ERR_NULL_POINTER);
        }
        let store = unsafe { input_slice(store, store_len)? };
        let (next_store, bundle) = bundle_create(
            store,
            device_id,
            pre_key_id,
            signed_pre_key_id,
            kyber_pre_key_id,
        )
        .map_err(ffi_error)?;
        unsafe {
            out_store.write(owned_buffer(next_store));
            out_bundle.write(owned_buffer(bundle));
        }
        Ok(())
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn aegis_crypto_session_establish(
    store: *const u8,
    store_len: usize,
    local_name: *const u8,
    local_name_len: usize,
    local_device: u32,
    remote_name: *const u8,
    remote_name_len: usize,
    remote_device: u32,
    bundle: *const u8,
    bundle_len: usize,
    out_store: *mut AegisBuffer,
) -> i32 {
    ffi_guard(|| {
        if out_store.is_null() {
            set_error("pointeur de sortie nul");
            return Err(AEGIS_ERR_NULL_POINTER);
        }
        let store = unsafe { input_slice(store, store_len)? };
        let local_name = unsafe { input_utf8(local_name, local_name_len)? };
        let remote_name = unsafe { input_utf8(remote_name, remote_name_len)? };
        let bundle = unsafe { input_slice(bundle, bundle_len)? };
        let next_store = session_establish(
            store,
            local_name,
            local_device,
            remote_name,
            remote_device,
            bundle,
        )
        .map_err(ffi_error)?;
        unsafe { out_store.write(owned_buffer(next_store)) };
        Ok(())
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn aegis_crypto_message_encrypt(
    store: *const u8,
    store_len: usize,
    local_name: *const u8,
    local_name_len: usize,
    local_device: u32,
    remote_name: *const u8,
    remote_name_len: usize,
    remote_device: u32,
    plaintext: *const u8,
    plaintext_len: usize,
    out_store: *mut AegisBuffer,
    out_message_type: *mut u8,
    out_ciphertext: *mut AegisBuffer,
) -> i32 {
    ffi_guard(|| {
        if out_store.is_null() || out_message_type.is_null() || out_ciphertext.is_null() {
            set_error("pointeur de sortie nul");
            return Err(AEGIS_ERR_NULL_POINTER);
        }
        let store = unsafe { input_slice(store, store_len)? };
        let local_name = unsafe { input_utf8(local_name, local_name_len)? };
        let remote_name = unsafe { input_utf8(remote_name, remote_name_len)? };
        let plaintext = unsafe { input_slice(plaintext, plaintext_len)? };
        let (next_store, message_type, ciphertext) = message_encrypt(
            store,
            local_name,
            local_device,
            remote_name,
            remote_device,
            plaintext,
        )
        .map_err(ffi_error)?;
        unsafe {
            out_store.write(owned_buffer(next_store));
            out_message_type.write(message_type);
            out_ciphertext.write(owned_buffer(ciphertext));
        }
        Ok(())
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn aegis_crypto_message_decrypt(
    store: *const u8,
    store_len: usize,
    local_name: *const u8,
    local_name_len: usize,
    local_device: u32,
    remote_name: *const u8,
    remote_name_len: usize,
    remote_device: u32,
    message_type: u8,
    ciphertext: *const u8,
    ciphertext_len: usize,
    out_store: *mut AegisBuffer,
    out_plaintext: *mut AegisBuffer,
) -> i32 {
    ffi_guard(|| {
        if out_store.is_null() || out_plaintext.is_null() {
            set_error("pointeur de sortie nul");
            return Err(AEGIS_ERR_NULL_POINTER);
        }
        let store = unsafe { input_slice(store, store_len)? };
        let local_name = unsafe { input_utf8(local_name, local_name_len)? };
        let remote_name = unsafe { input_utf8(remote_name, remote_name_len)? };
        let ciphertext = unsafe { input_slice(ciphertext, ciphertext_len)? };
        let (next_store, plaintext) = message_decrypt(
            store,
            local_name,
            local_device,
            remote_name,
            remote_device,
            message_type,
            ciphertext,
        )
        .map_err(ffi_error)?;
        unsafe {
            out_store.write(owned_buffer(next_store));
            out_plaintext.write(owned_buffer(plaintext));
        }
        Ok(())
    })
}
