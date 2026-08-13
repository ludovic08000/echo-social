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
