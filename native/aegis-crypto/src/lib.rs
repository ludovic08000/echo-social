//! ABI native Aegis au-dessus de libsignal.
//!
//! Invariant : les octets secrets retournés par ce bridge doivent être placés
//! immédiatement dans ACE/Keychain, Android Keystore ou Windows Hello. Ils ne
//! doivent jamais être envoyés à l'API Aegis ni journalisés.

use std::cell::RefCell;
use std::ptr;

use libsignal_protocol::{
    GenericSignedPreKey, IdentityKeyPair, KeyPair, SignedPreKeyId, SignedPreKeyRecord, Timestamp,
};

#[cfg(target_os = "android")]
mod android;
#[cfg(target_arch = "wasm32")]
mod wasm;

pub const AEGIS_CRYPTO_ABI_VERSION: u32 = 1;

pub const AEGIS_OK: i32 = 0;
pub const AEGIS_ERR_NULL_POINTER: i32 = 1;
pub const AEGIS_ERR_INVALID_INPUT: i32 = 2;
pub const AEGIS_ERR_CRYPTO: i32 = 3;
pub const AEGIS_ERR_PANIC: i32 = 255;

#[repr(C)]
#[derive(Debug)]
pub struct AegisBuffer {
    pub data: *mut u8,
    pub len: usize,
}

impl Default for AegisBuffer {
    fn default() -> Self {
        Self {
            data: ptr::null_mut(),
            len: 0,
        }
    }
}

thread_local! {
    static LAST_ERROR: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn set_error(message: impl AsRef<str>) {
    LAST_ERROR.with(|slot| {
        let mut bytes = message.as_ref().as_bytes().to_vec();
        bytes.push(0);
        *slot.borrow_mut() = bytes;
    });
}

fn owned_buffer(bytes: impl Into<Vec<u8>>) -> AegisBuffer {
    let boxed = bytes.into().into_boxed_slice();
    let len = boxed.len();
    let data = Box::into_raw(boxed) as *mut u8;
    AegisBuffer { data, len }
}

unsafe fn input_slice<'a>(data: *const u8, len: usize) -> Result<&'a [u8], i32> {
    if data.is_null() {
        set_error("pointeur d'entrée nul");
        return Err(AEGIS_ERR_NULL_POINTER);
    }
    Ok(unsafe { std::slice::from_raw_parts(data, len) })
}

fn ffi_guard(operation: impl FnOnce() -> Result<(), i32>) -> i32 {
    LAST_ERROR.with(|slot| slot.borrow_mut().clear());
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(operation)) {
        Ok(Ok(())) => AEGIS_OK,
        Ok(Err(code)) => code,
        Err(_) => {
            set_error("panique interne interceptée par le bridge Aegis");
            AEGIS_ERR_PANIC
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn aegis_crypto_abi_version() -> u32 {
    AEGIS_CRYPTO_ABI_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn aegis_crypto_last_error_message() -> *const u8 {
    LAST_ERROR.with(|slot| {
        let bytes = slot.borrow();
        if bytes.is_empty() {
            ptr::null()
        } else {
            bytes.as_ptr()
        }
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn aegis_crypto_buffer_free(buffer: AegisBuffer) {
    if buffer.data.is_null() || buffer.len == 0 {
        return;
    }
    drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(buffer.data, buffer.len)) });
}

/// Génère une identité libsignal sérialisée et sa seule partie publique.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn aegis_crypto_identity_generate(
    out_secret: *mut AegisBuffer,
    out_public: *mut AegisBuffer,
) -> i32 {
    ffi_guard(|| {
        if out_secret.is_null() || out_public.is_null() {
            set_error("pointeur de sortie nul");
            return Err(AEGIS_ERR_NULL_POINTER);
        }
        let mut rng = rand::rng();
        let identity = IdentityKeyPair::generate(&mut rng);
        unsafe {
            out_secret.write(owned_buffer(identity.serialize().into_vec()));
            out_public.write(owned_buffer(identity.identity_key().serialize().into_vec()));
        }
        Ok(())
    })
}

/// Redérive la clé publique afin de contrôler une identité restaurée du vault.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn aegis_crypto_identity_public(
    secret: *const u8,
    secret_len: usize,
    out_public: *mut AegisBuffer,
) -> i32 {
    ffi_guard(|| {
        if out_public.is_null() {
            set_error("pointeur de sortie nul");
            return Err(AEGIS_ERR_NULL_POINTER);
        }
        let secret = unsafe { input_slice(secret, secret_len)? };
        let identity = IdentityKeyPair::try_from(secret).map_err(|error| {
            set_error(format!("identité libsignal invalide: {error}"));
            AEGIS_ERR_INVALID_INPUT
        })?;
        unsafe { out_public.write(owned_buffer(identity.identity_key().serialize().into_vec())) };
        Ok(())
    })
}

/// Génère une SPK signée. `out_record` contient le record privé à sceller ;
/// seules `out_public` et `out_signature` peuvent être publiées par l'API.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn aegis_crypto_signed_prekey_generate(
    identity_secret: *const u8,
    identity_secret_len: usize,
    key_id: u32,
    timestamp_ms: u64,
    out_record: *mut AegisBuffer,
    out_public: *mut AegisBuffer,
    out_signature: *mut AegisBuffer,
) -> i32 {
    ffi_guard(|| {
        if out_record.is_null() || out_public.is_null() || out_signature.is_null() {
            set_error("pointeur de sortie nul");
            return Err(AEGIS_ERR_NULL_POINTER);
        }
        let identity_bytes = unsafe { input_slice(identity_secret, identity_secret_len)? };
        let identity = IdentityKeyPair::try_from(identity_bytes).map_err(|error| {
            set_error(format!("identité libsignal invalide: {error}"));
            AEGIS_ERR_INVALID_INPUT
        })?;
        let mut rng = rand::rng();
        let key_pair = KeyPair::generate(&mut rng);
        let public = key_pair.public_key.serialize();
        let signature = identity
            .private_key()
            .calculate_signature(&public, &mut rng)
            .map_err(|error| {
                set_error(format!("signature SPK impossible: {error}"));
                AEGIS_ERR_CRYPTO
            })?;
        let record = SignedPreKeyRecord::new(
            SignedPreKeyId::from(key_id),
            Timestamp::from_epoch_millis(timestamp_ms),
            &key_pair,
            &signature,
        );
        let serialized = record.serialize().map_err(|error| {
            set_error(format!("sérialisation SPK impossible: {error}"));
            AEGIS_ERR_CRYPTO
        })?;
        unsafe {
            out_record.write(owned_buffer(serialized));
            out_public.write(owned_buffer(public.into_vec()));
            out_signature.write(owned_buffer(signature.into_vec()));
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use libsignal_protocol::PublicKey;

    fn take(buffer: AegisBuffer) -> Vec<u8> {
        if buffer.data.is_null() {
            return vec![];
        }
        let bytes = unsafe { std::slice::from_raw_parts(buffer.data, buffer.len).to_vec() };
        unsafe { aegis_crypto_buffer_free(buffer) };
        bytes
    }

    #[test]
    fn identity_round_trip_and_spk_signature() {
        let mut secret = AegisBuffer::default();
        let mut public = AegisBuffer::default();
        assert_eq!(
            unsafe { aegis_crypto_identity_generate(&mut secret, &mut public) },
            AEGIS_OK
        );
        let secret = take(secret);
        let public = take(public);

        let mut restored_public = AegisBuffer::default();
        assert_eq!(
            unsafe {
                aegis_crypto_identity_public(secret.as_ptr(), secret.len(), &mut restored_public)
            },
            AEGIS_OK
        );
        assert_eq!(take(restored_public), public);

        let mut record = AegisBuffer::default();
        let mut spk_public = AegisBuffer::default();
        let mut signature = AegisBuffer::default();
        assert_eq!(
            unsafe {
                aegis_crypto_signed_prekey_generate(
                    secret.as_ptr(),
                    secret.len(),
                    7,
                    42,
                    &mut record,
                    &mut spk_public,
                    &mut signature,
                )
            },
            AEGIS_OK
        );
        let record = take(record);
        let spk_public = take(spk_public);
        let signature = take(signature);
        assert!(!record.is_empty());
        let identity_public = PublicKey::deserialize(&public).expect("public identity");
        assert!(identity_public.verify_signature(&spk_public, &signature));
    }
}
