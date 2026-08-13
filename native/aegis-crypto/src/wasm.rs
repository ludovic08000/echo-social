//! Façade WebAssembly pour Windows Web. Les records secrets retournés ici
//! doivent être scellés immédiatement par Windows Hello avant persistance.

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use hmac::{Hmac, Mac};
use libsignal_protocol::{
    GenericSignedPreKey, IdentityKeyPair, KeyPair, SignedPreKeyId, SignedPreKeyRecord, Timestamp,
};
use rand::RngCore;
use sha2::Sha256;
use wasm_bindgen::prelude::*;
use libsignal_protocol::{IdentityKeyPair as SignalIdentityKeyPair, ProtocolAddress};
use crate::{AegisSignalStore, EncryptedMessage, create_device_bundle, decrypt_message, encrypt_message, establish_outbound_session};

type HmacSha256 = Hmac<Sha256>;

fn chain_step(chain_key: &[u8]) -> Result<([u8; 32], [u8; 32]), JsError> {
    if chain_key.len() != 32 {
        return Err(JsError::new("AEGIS_CHAIN_KEY_INVALID"));
    }
    let mut message_mac = <HmacSha256 as Mac>::new_from_slice(chain_key)
        .map_err(|_| JsError::new("AEGIS_CHAIN_KEY_INVALID"))?;
    message_mac.update(&[0x01]);
    let message_key: [u8; 32] = message_mac.finalize().into_bytes().into();
    let mut chain_mac = <HmacSha256 as Mac>::new_from_slice(chain_key)
        .map_err(|_| JsError::new("AEGIS_CHAIN_KEY_INVALID"))?;
    chain_mac.update(&[0x02]);
    let next_chain: [u8; 32] = chain_mac.finalize().into_bytes().into();
    Ok((next_chain, message_key))
}

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

/// Retourne record || public || signature, chacun précédé de sa taille u32 LE.
/// Le record est privé ; public et signature sont les seules parties publiables.
#[wasm_bindgen]
pub fn aegis_wasm_signed_prekey_generate(
    identity_secret: &[u8],
    key_id: u32,
    timestamp_ms: u64,
) -> Result<Vec<u8>, JsError> {
    let identity = IdentityKeyPair::try_from(identity_secret)
        .map_err(|error| JsError::new(&format!("AEGIS_IDENTITY_INVALID:{error}")))?;
    let mut rng = rand::rng();
    let key_pair = KeyPair::generate(&mut rng);
    let public = key_pair.public_key.serialize().into_vec();
    let signature = identity
        .private_key()
        .calculate_signature(&public, &mut rng)
        .map_err(|error| JsError::new(&format!("AEGIS_SPK_SIGNATURE_FAILED:{error}")))?
        .into_vec();
    let record = SignedPreKeyRecord::new(
        SignedPreKeyId::from(key_id),
        Timestamp::from_epoch_millis(timestamp_ms),
        &key_pair,
        &signature,
    )
    .serialize()
    .map_err(|error| JsError::new(&format!("AEGIS_SPK_SERIALIZE_FAILED:{error}")))?;

    let mut packed = Vec::with_capacity(12 + record.len() + public.len() + signature.len());
    for part in [&record[..], &public[..], &signature[..]] {
        packed.extend_from_slice(&(part.len() as u32).to_le_bytes());
        packed.extend_from_slice(part);
    }
    Ok(packed)
}

#[wasm_bindgen]
pub fn aegis_wasm_store_create(registration_id: u32) -> Result<Vec<u8>, JsError> {
    let mut rng = rand::rng();
    AegisSignalStore::new(SignalIdentityKeyPair::generate(&mut rng), registration_id)
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

/// Étape d'envoi compatible avec `deviceRatchet.ts` : retourne
/// nextChainKey || iv || ciphertext+tag, encodés par longueurs u32 LE.
#[wasm_bindgen]
pub fn aegis_wasm_ratchet_encrypt(
    chain_key: &[u8],
    aad: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, JsError> {
    let (next_chain, message_key) = chain_step(chain_key)?;
    let cipher = Aes256Gcm::new_from_slice(&message_key)
        .map_err(|_| JsError::new("AEGIS_MESSAGE_KEY_INVALID"))?;
    let mut iv = [0u8; 12];
    rand::rng().fill_bytes(&mut iv);
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&iv),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| JsError::new("AEGIS_RATCHET_ENCRYPT_FAILED"))?;
    Ok(pack(&[&next_chain, &iv, &ciphertext]))
}

/// Étape de réception compatible : retourne nextChainKey || plaintext.
/// L'appelant ne persiste la nouvelle chaîne qu'après authentification réussie.
#[wasm_bindgen]
pub fn aegis_wasm_ratchet_decrypt(
    chain_key: &[u8],
    aad: &[u8],
    iv: &[u8],
    ciphertext: &[u8],
) -> Result<Vec<u8>, JsError> {
    if iv.len() != 12 {
        return Err(JsError::new("AEGIS_RATCHET_IV_INVALID"));
    }
    let (next_chain, message_key) = chain_step(chain_key)?;
    let cipher = Aes256Gcm::new_from_slice(&message_key)
        .map_err(|_| JsError::new("AEGIS_MESSAGE_KEY_INVALID"))?;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(iv),
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|_| JsError::new("AEGIS_RATCHET_DECRYPT_FAILED"))?;
    Ok(pack(&[&next_chain, &plaintext]))
}
