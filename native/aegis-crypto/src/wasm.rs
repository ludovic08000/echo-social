//! Façade WebAssembly pour Windows Web. Les records secrets retournés ici
//! doivent être scellés immédiatement par le coffre Aegis avant persistance.

use wasm_bindgen::prelude::*;
use libsignal_protocol::{IdentityKeyPair, ProtocolAddress};
use crate::{AegisSignalStore, EncryptedMessage, create_device_bundle, decrypt_message, encrypt_message, establish_outbound_session};

fn pack(parts: &[&[u8]]) -> Vec<u8> {
    let mut packed = Vec::new();
    for part in parts {
        packed.extend_from_slice(&(part.len() as u32).to_le_bytes());
        packed.extend_from_slice(part);
    }
    packed
}

#[wasm_bindgen]
pub fn aegis_wasm_abi_version() -> u32 {
    super::AEGIS_CRYPTO_ABI_VERSION
}

#[wasm_bindgen]
pub fn aegis_wasm_identity_generate() -> Vec<u8> {
    let mut rng = rand::rng();
    IdentityKeyPair::generate(&mut rng).serialize().into_vec()
}

#[wasm_bindgen]
pub fn aegis_wasm_identity_public(secret: &[u8]) -> Result<Vec<u8>, JsError> {
    let identity = IdentityKeyPair::try_from(secret)
        .map_err(|error| JsError::new(&format!("AEGIS_IDENTITY_INVALID:{error}")))?;
    Ok(identity.identity_key().serialize().into_vec())
}

#[wasm_bindgen]
pub fn aegis_wasm_store_create(registration_id: u32) -> Result<Vec<u8>, JsError> {
    let mut rng = rand::rng();
    AegisSignalStore::new(IdentityKeyPair::generate(&mut rng), registration_id)
        .serialize().map_err(js_signal)
}

fn js_signal(error: libsignal_protocol::SignalProtocolError) -> JsError {
    JsError::new(&format!("AEGIS_LIBSIGNAL:{error}"))
}

fn address(name: &str, device_id: u32) -> Result<ProtocolAddress, JsError> {
    let id = device_id.try_into().map_err(|_| JsError::new("AEGIS_DEVICE_ID_INVALID"))?;
    Ok(ProtocolAddress::new(name.to_owned(), id))
}

/// Retourne store || bundle public, tous deux encodés par longueur.
#[wasm_bindgen]
pub async fn aegis_wasm_bundle_create(store: &[u8], device_id: u32, pre_key_id: u32, signed_pre_key_id: u32, kyber_pre_key_id: u32) -> Result<Vec<u8>, JsError> {
    let mut store = AegisSignalStore::deserialize(store).map_err(js_signal)?;
    let bundle = create_device_bundle(&mut store, device_id, pre_key_id, signed_pre_key_id, kyber_pre_key_id).await.map_err(js_signal)?;
    let public = encode_bundle(&bundle);
    let secret = store.serialize().map_err(js_signal)?;
    Ok(pack(&[&secret, &public]))
}

#[wasm_bindgen]
pub async fn aegis_wasm_session_establish(store: &[u8], local_name: &str, local_device: u32, remote_name: &str, remote_device: u32, bundle: &[u8]) -> Result<Vec<u8>, JsError> {
    let mut store = AegisSignalStore::deserialize(store).map_err(js_signal)?;
    let bundle = decode_bundle(bundle)?;
    establish_outbound_session(&mut store, &address(local_name, local_device)?, &address(remote_name, remote_device)?, &bundle).await.map_err(js_signal)?;
    store.serialize().map_err(js_signal)
}

/// Retourne store muté || type u8 || ciphertext. Le store doit être scellé
/// avant que le ciphertext puisse être publié au serveur.
#[wasm_bindgen]
pub async fn aegis_wasm_message_encrypt(store: &[u8], local_name: &str, local_device: u32, remote_name: &str, remote_device: u32, plaintext: &[u8]) -> Result<Vec<u8>, JsError> {
    let mut store = AegisSignalStore::deserialize(store).map_err(js_signal)?;
    let encrypted = encrypt_message(&mut store, &address(local_name, local_device)?, &address(remote_name, remote_device)?, plaintext).await.map_err(js_signal)?;
    let secret = store.serialize().map_err(js_signal)?;
    Ok(pack(&[&secret, &[encrypted.message_type], &encrypted.ciphertext]))
}

/// Retourne store muté || plaintext. Le store doit être scellé avant ACK.
#[wasm_bindgen]
pub async fn aegis_wasm_message_decrypt(store: &[u8], local_name: &str, local_device: u32, remote_name: &str, remote_device: u32, message_type: u8, ciphertext: &[u8]) -> Result<Vec<u8>, JsError> {
    let mut store = AegisSignalStore::deserialize(store).map_err(js_signal)?;
    let plaintext = decrypt_message(&mut store, &address(local_name, local_device)?, &address(remote_name, remote_device)?, &EncryptedMessage { message_type, ciphertext: ciphertext.to_vec() }).await.map_err(js_signal)?;
    let secret = store.serialize().map_err(js_signal)?;
    Ok(pack(&[&secret, &plaintext]))
}

fn encode_bundle(b: &crate::DevicePreKeyBundle) -> Vec<u8> {
    let numbers = [b.registration_id, b.device_id, b.pre_key_id, b.signed_pre_key_id, b.kyber_pre_key_id];
    let n = numbers.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<_>>();
    pack(&[&n, &b.identity_key, &b.pre_key, &b.signed_pre_key, &b.signed_pre_key_signature, &b.kyber_pre_key, &b.kyber_pre_key_signature])
}

fn decode_bundle(bytes: &[u8]) -> Result<crate::DevicePreKeyBundle, JsError> {
    let parts = unpack(bytes, 7)?;
    if parts[0].len() != 20 { return Err(JsError::new("AEGIS_BUNDLE_INVALID")); }
    let num = |i: usize| u32::from_le_bytes(parts[0][i*4..i*4+4].try_into().expect("four bytes"));
    Ok(crate::DevicePreKeyBundle { registration_id: num(0), device_id: num(1), pre_key_id: num(2), signed_pre_key_id: num(3), kyber_pre_key_id: num(4), identity_key: parts[1].to_vec(), pre_key: parts[2].to_vec(), signed_pre_key: parts[3].to_vec(), signed_pre_key_signature: parts[4].to_vec(), kyber_pre_key: parts[5].to_vec(), kyber_pre_key_signature: parts[6].to_vec() })
}

fn unpack<'a>(mut bytes: &'a [u8], expected: usize) -> Result<Vec<&'a [u8]>, JsError> {
    let mut parts = Vec::new();
    for _ in 0..expected { if bytes.len() < 4 { return Err(JsError::new("AEGIS_PACK_INVALID")); } let len = u32::from_le_bytes(bytes[..4].try_into().expect("four bytes")) as usize; bytes = &bytes[4..]; if bytes.len() < len { return Err(JsError::new("AEGIS_PACK_INVALID")); } parts.push(&bytes[..len]); bytes = &bytes[len..]; }
    if !bytes.is_empty() { return Err(JsError::new("AEGIS_PACK_INVALID")); }
    Ok(parts)
}
