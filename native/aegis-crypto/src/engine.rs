//! Façade transactionnelle du protocole officiel libsignal.
//! Chaque opération mutante retourne un store à resceller avant tout ACK réseau.

use std::time::SystemTime;

use libsignal_protocol::{
    CiphertextMessage, CiphertextMessageType, DeviceId, GenericSignedPreKey, IdentityKey,
    IdentityKeyStore, KeyPair, KyberPreKeyId, KyberPreKeyRecord, KyberPreKeyStore,
    PreKeyBundle, PreKeyId, PreKeyRecord, PreKeySignalMessage, PreKeyStore, ProtocolAddress,
    PublicKey, SignalMessage, SignalProtocolError, SignedPreKeyId,
    SignedPreKeyRecord, SignedPreKeyStore, Timestamp, kem, message_decrypt, message_encrypt,
    process_prekey_bundle,
};

use crate::AegisSignalStore;

type Result<T> = std::result::Result<T, SignalProtocolError>;

#[derive(Clone, Debug)]
pub struct DevicePreKeyBundle {
    pub registration_id: u32,
    pub device_id: u32,
    pub identity_key: Vec<u8>,
    pub pre_key_id: u32,
    pub pre_key: Vec<u8>,
    pub signed_pre_key_id: u32,
    pub signed_pre_key: Vec<u8>,
    pub signed_pre_key_signature: Vec<u8>,
    pub kyber_pre_key_id: u32,
    pub kyber_pre_key: Vec<u8>,
    pub kyber_pre_key_signature: Vec<u8>,
}

impl DevicePreKeyBundle {
    fn to_libsignal(&self) -> Result<PreKeyBundle> {
        let device: DeviceId = self.device_id.try_into().map_err(|_| {
            SignalProtocolError::InvalidArgument("invalid device id".into())
        })?;
        PreKeyBundle::new(
            self.registration_id,
            device,
            Some((self.pre_key_id.into(), PublicKey::deserialize(&self.pre_key)?)),
            self.signed_pre_key_id.into(),
            PublicKey::deserialize(&self.signed_pre_key)?,
            self.signed_pre_key_signature.clone(),
            self.kyber_pre_key_id.into(),
            kem::PublicKey::deserialize(&self.kyber_pre_key)?,
            self.kyber_pre_key_signature.clone(),
            IdentityKey::decode(&self.identity_key)?,
        )
    }
}

#[derive(Clone, Debug)]
pub struct EncryptedMessage {
    pub message_type: u8,
    pub ciphertext: Vec<u8>,
}

/// Génère ensemble les clés publiques publiables et leurs records privés.
pub async fn create_device_bundle(
    store: &mut AegisSignalStore,
    device_id: u32,
    pre_key_id: u32,
    signed_pre_key_id: u32,
    kyber_pre_key_id: u32,
) -> Result<DevicePreKeyBundle> {
    let mut rng = rand::rng();
    let identity = store.get_identity_key_pair().await?;
    let pre_pair = KeyPair::generate(&mut rng);
    let signed_pair = KeyPair::generate(&mut rng);
    let signed_public = signed_pair.public_key.serialize();
    let signed_signature = identity.private_key().calculate_signature(&signed_public, &mut rng)?.into_vec();
    let kyber_record = KyberPreKeyRecord::generate(
        kem::KeyType::Kyber1024,
        KyberPreKeyId::from(kyber_pre_key_id),
        identity.private_key(),
    )?;
    let signed_record = SignedPreKeyRecord::new(
        SignedPreKeyId::from(signed_pre_key_id),
        Timestamp::from_epoch_millis(
            SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_millis() as u64,
        ),
        &signed_pair,
        &signed_signature,
    );
    let pre_record = PreKeyRecord::new(PreKeyId::from(pre_key_id), &pre_pair);
    store.save_pre_key(pre_key_id.into(), &pre_record).await?;
    store.save_signed_pre_key(signed_pre_key_id.into(), &signed_record).await?;
    store.save_kyber_pre_key(kyber_pre_key_id.into(), &kyber_record).await?;
    Ok(DevicePreKeyBundle {
        registration_id: store.get_local_registration_id().await?,
        device_id,
        identity_key: identity.identity_key().serialize().into_vec(),
        pre_key_id,
        pre_key: pre_pair.public_key.serialize().into_vec(),
        signed_pre_key_id,
        signed_pre_key: signed_public.into_vec(),
        signed_pre_key_signature: signed_signature,
        kyber_pre_key_id,
        kyber_pre_key: kyber_record.public_key()?.serialize().into_vec(),
        kyber_pre_key_signature: kyber_record.signature()?,
    })
}

pub async fn establish_outbound_session(
    store: &mut AegisSignalStore,
    local: &ProtocolAddress,
    remote: &ProtocolAddress,
    bundle: &DevicePreKeyBundle,
) -> Result<()> {
    let mut rng = rand::rng();
    let ptr: *mut AegisSignalStore = store;
    unsafe { process_prekey_bundle(remote, local, &mut *ptr, &mut *ptr, &bundle.to_libsignal()?, SystemTime::now(), &mut rng).await }
}

pub async fn encrypt_message(
    store: &mut AegisSignalStore,
    local: &ProtocolAddress,
    remote: &ProtocolAddress,
    plaintext: &[u8],
) -> Result<EncryptedMessage> {
    let mut rng = rand::rng();
    // Les deux traits partagent le store ; les pointeurs sont séparés uniquement
    // pendant l'appel et libsignal ne les conserve jamais.
    let store_ptr: *mut AegisSignalStore = store;
    let message = unsafe {
        message_encrypt(plaintext, remote, local, &mut *store_ptr, &mut *store_ptr, SystemTime::now(), &mut rng).await?
    };
    Ok(EncryptedMessage { message_type: message.message_type() as u8, ciphertext: message.serialize().to_vec() })
}

pub async fn decrypt_message(
    store: &mut AegisSignalStore,
    local: &ProtocolAddress,
    remote: &ProtocolAddress,
    encrypted: &EncryptedMessage,
) -> Result<Vec<u8>> {
    let message_type = CiphertextMessageType::try_from(encrypted.message_type)
        .map_err(|_| SignalProtocolError::InvalidArgument("unsupported message type".into()))?;
    let message = match message_type {
        CiphertextMessageType::Whisper => CiphertextMessage::SignalMessage(SignalMessage::try_from(encrypted.ciphertext.as_slice())?),
        CiphertextMessageType::PreKey => CiphertextMessage::PreKeySignalMessage(PreKeySignalMessage::try_from(encrypted.ciphertext.as_slice())?),
        other => return Err(SignalProtocolError::InvalidArgument(format!("unsupported message type {other:?}"))),
    };
    let mut rng = rand::rng();
    let ptr: *mut AegisSignalStore = store;
    unsafe { message_decrypt(&message, remote, local, &mut *ptr, &mut *ptr, &mut *ptr, &*ptr, &mut *ptr, &mut rng).await }
}

#[cfg(test)]
mod tests {
    use super::*;
    use libsignal_protocol::IdentityKeyPair;

    #[test]
    fn official_libsignal_round_trip_and_store_restore() {
        futures::executor::block_on(async {
            let mut rng = rand::rng();
            let mut alice = AegisSignalStore::new(IdentityKeyPair::generate(&mut rng), 1001);
            let mut bob = AegisSignalStore::new(IdentityKeyPair::generate(&mut rng), 2001);
            let alice_address = ProtocolAddress::new("alice".into(), 1u32.try_into().unwrap());
            let bob_address = ProtocolAddress::new("bob".into(), 1u32.try_into().unwrap());
            let bundle = create_device_bundle(&mut bob, 1, 11, 12, 13).await.unwrap();
            establish_outbound_session(&mut alice, &alice_address, &bob_address, &bundle).await.unwrap();
            let first = encrypt_message(&mut alice, &alice_address, &bob_address, b"windows vers ios").await.unwrap();
            assert_eq!(first.message_type, CiphertextMessageType::PreKey as u8);
            bob = AegisSignalStore::deserialize(&bob.serialize().unwrap()).unwrap();
            assert_eq!(decrypt_message(&mut bob, &bob_address, &alice_address, &first).await.unwrap(), b"windows vers ios");
            let reply = encrypt_message(&mut bob, &bob_address, &alice_address, b"ios vers windows").await.unwrap();
            alice = AegisSignalStore::deserialize(&alice.serialize().unwrap()).unwrap();
            assert_eq!(decrypt_message(&mut alice, &alice_address, &bob_address, &reply).await.unwrap(), b"ios vers windows");
        });
    }
}
