//! Store libsignal sérialisable. Le blob retourné reste secret et doit être
//! scellé atomiquement par le vault matériel avant publication des clés.

use std::collections::HashMap;

use async_trait::async_trait;
use libsignal_protocol::{
    Direction, GenericSignedPreKey, IdentityChange, IdentityKey, IdentityKeyPair, IdentityKeyStore, KyberPreKeyId,
    KyberPreKeyRecord, KyberPreKeyStore, PreKeyId, PreKeyRecord, PreKeyStore, ProtocolAddress,
    PublicKey, SessionRecord, SessionStore, SignalProtocolError, SignedPreKeyId,
    SignedPreKeyRecord, SignedPreKeyStore,
};

type Result<T> = std::result::Result<T, SignalProtocolError>;

const MAGIC: &[u8; 8] = b"AEGISLS\0";

#[derive(Clone)]
pub struct AegisSignalStore {
    identity: IdentityKeyPair,
    registration_id: u32,
    known: HashMap<ProtocolAddress, IdentityKey>,
    sessions: HashMap<ProtocolAddress, SessionRecord>,
    prekeys: HashMap<PreKeyId, PreKeyRecord>,
    signed_prekeys: HashMap<SignedPreKeyId, SignedPreKeyRecord>,
    kyber_prekeys: HashMap<KyberPreKeyId, KyberPreKeyRecord>,
    kyber_seen: HashMap<(KyberPreKeyId, SignedPreKeyId), Vec<PublicKey>>,
}

fn invalid(message: impl Into<String>) -> SignalProtocolError {
    SignalProtocolError::InvalidArgument(message.into())
}

fn put(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(bytes);
}

fn take<'a>(input: &mut &'a [u8]) -> Result<&'a [u8]> {
    let len = input.get(..4).ok_or_else(|| invalid("store truncated"))?;
    let len = u32::from_le_bytes(len.try_into().expect("four bytes")) as usize;
    *input = &input[4..];
    let value = input.get(..len).ok_or_else(|| invalid("store truncated"))?;
    *input = &input[len..];
    Ok(value)
}

fn put_address(out: &mut Vec<u8>, address: &ProtocolAddress) {
    put(out, address.name().as_bytes());
    out.extend_from_slice(&u32::from(address.device_id()).to_le_bytes());
}

fn take_address(input: &mut &[u8]) -> Result<ProtocolAddress> {
    let name = std::str::from_utf8(take(input)?).map_err(|_| invalid("invalid address"))?;
    let raw = input.get(..4).ok_or_else(|| invalid("store truncated"))?;
    let device = u32::from_le_bytes(raw.try_into().expect("four bytes"));
    *input = &input[4..];
    let device = device.try_into().map_err(|_| invalid("invalid device id"))?;
    Ok(ProtocolAddress::new(name.to_owned(), device))
}

fn put_map<K, V>(out: &mut Vec<u8>, map: &HashMap<K, V>, mut item: impl FnMut(&mut Vec<u8>, &K, &V)) {
    out.extend_from_slice(&(map.len() as u32).to_le_bytes());
    for (key, value) in map { item(out, key, value); }
}

fn count(input: &mut &[u8]) -> Result<usize> {
    let raw = input.get(..4).ok_or_else(|| invalid("store truncated"))?;
    *input = &input[4..];
    Ok(u32::from_le_bytes(raw.try_into().expect("four bytes")) as usize)
}

impl AegisSignalStore {
    pub fn new(identity: IdentityKeyPair, registration_id: u32) -> Self {
        Self { identity, registration_id, known: HashMap::new(), sessions: HashMap::new(), prekeys: HashMap::new(), signed_prekeys: HashMap::new(), kyber_prekeys: HashMap::new(), kyber_seen: HashMap::new() }
    }

    pub fn serialize(&self) -> Result<Vec<u8>> {
        let mut out = MAGIC.to_vec();
        put(&mut out, &self.identity.serialize());
        out.extend_from_slice(&self.registration_id.to_le_bytes());
        put_map(&mut out, &self.known, |o, a, k| { put_address(o, a); put(o, &k.serialize()); });
        put_map(&mut out, &self.sessions, |o, a, r| { put_address(o, a); put(o, &r.serialize().expect("validated session")); });
        put_map(&mut out, &self.prekeys, |o, id, r| { o.extend_from_slice(&u32::from(*id).to_le_bytes()); put(o, &r.serialize().expect("validated prekey")); });
        put_map(&mut out, &self.signed_prekeys, |o, id, r| { o.extend_from_slice(&u32::from(*id).to_le_bytes()); put(o, &r.serialize().expect("validated signed prekey")); });
        put_map(&mut out, &self.kyber_prekeys, |o, id, r| { o.extend_from_slice(&u32::from(*id).to_le_bytes()); put(o, &r.serialize().expect("validated kyber prekey")); });
        // Les marqueurs anti-rejeu Kyber font partie du commit atomique du store.
        put_map(&mut out, &self.kyber_seen, |o, (kid, sid), keys| { o.extend_from_slice(&u32::from(*kid).to_le_bytes()); o.extend_from_slice(&u32::from(*sid).to_le_bytes()); o.extend_from_slice(&(keys.len() as u32).to_le_bytes()); for key in keys { put(o, &key.serialize()); } });
        Ok(out)
    }

    pub fn deserialize(mut input: &[u8]) -> Result<Self> {
        if input.get(..MAGIC.len()) != Some(MAGIC) { return Err(invalid("invalid libsignal store")); }
        input = &input[MAGIC.len()..];
        let identity = IdentityKeyPair::try_from(take(&mut input)?)?;
        let raw = input.get(..4).ok_or_else(|| invalid("store truncated"))?;
        let registration_id = u32::from_le_bytes(raw.try_into().expect("four bytes")); input = &input[4..];
        let mut store = Self::new(identity, registration_id);
        for _ in 0..count(&mut input)? { let a = take_address(&mut input)?; store.known.insert(a, IdentityKey::decode(take(&mut input)?)?); }
        for _ in 0..count(&mut input)? { let a = take_address(&mut input)?; store.sessions.insert(a, SessionRecord::deserialize(take(&mut input)?)?); }
        for _ in 0..count(&mut input)? { let id = take_u32(&mut input)?; store.prekeys.insert(id.into(), PreKeyRecord::deserialize(take(&mut input)?)?); }
        for _ in 0..count(&mut input)? { let id = take_u32(&mut input)?; store.signed_prekeys.insert(id.into(), SignedPreKeyRecord::deserialize(take(&mut input)?)?); }
        for _ in 0..count(&mut input)? { let id = take_u32(&mut input)?; store.kyber_prekeys.insert(id.into(), KyberPreKeyRecord::deserialize(take(&mut input)?)?); }
        for _ in 0..count(&mut input)? { let kid: KyberPreKeyId = take_u32(&mut input)?.into(); let sid: SignedPreKeyId = take_u32(&mut input)?.into(); let mut keys = Vec::new(); for _ in 0..count(&mut input)? { keys.push(PublicKey::deserialize(take(&mut input)?)?); } store.kyber_seen.insert((kid, sid), keys); }
        if !input.is_empty() { return Err(invalid("trailing store data")); }
        Ok(store)
    }

    pub fn identity_key_pair(&self) -> IdentityKeyPair { self.identity }
    pub fn registration_id(&self) -> u32 { self.registration_id }
}

fn take_u32(input: &mut &[u8]) -> Result<u32> { let raw = input.get(..4).ok_or_else(|| invalid("store truncated"))?; *input = &input[4..]; Ok(u32::from_le_bytes(raw.try_into().expect("four bytes"))) }

#[async_trait(?Send)]
impl IdentityKeyStore for AegisSignalStore {
    async fn get_identity_key_pair(&self) -> Result<IdentityKeyPair> { Ok(self.identity) }
    async fn get_local_registration_id(&self) -> Result<u32> { Ok(self.registration_id) }
    async fn save_identity(&mut self, a: &ProtocolAddress, k: &IdentityKey) -> Result<IdentityChange> { let changed = self.known.insert(a.clone(), *k).is_some_and(|old| old != *k); Ok(if changed { IdentityChange::ReplacedExisting } else { IdentityChange::NewOrUnchanged }) }
    async fn is_trusted_identity(&self, a: &ProtocolAddress, k: &IdentityKey, _: Direction) -> Result<bool> { Ok(self.known.get(a).is_none_or(|old| old == k)) }
    async fn get_identity(&self, a: &ProtocolAddress) -> Result<Option<IdentityKey>> { Ok(self.known.get(a).copied()) }
}
#[async_trait(?Send)] impl SessionStore for AegisSignalStore { async fn load_session(&self, a: &ProtocolAddress) -> Result<Option<SessionRecord>> { Ok(self.sessions.get(a).cloned()) } async fn store_session(&mut self, a: &ProtocolAddress, r: &SessionRecord) -> Result<()> { self.sessions.insert(a.clone(), r.clone()); Ok(()) } }
#[async_trait(?Send)] impl PreKeyStore for AegisSignalStore { async fn get_pre_key(&self, id: PreKeyId) -> Result<PreKeyRecord> { self.prekeys.get(&id).cloned().ok_or(SignalProtocolError::InvalidPreKeyId) } async fn save_pre_key(&mut self, id: PreKeyId, r: &PreKeyRecord) -> Result<()> { self.prekeys.insert(id, r.clone()); Ok(()) } async fn remove_pre_key(&mut self, id: PreKeyId) -> Result<()> { self.prekeys.remove(&id); Ok(()) } }
#[async_trait(?Send)] impl SignedPreKeyStore for AegisSignalStore { async fn get_signed_pre_key(&self, id: SignedPreKeyId) -> Result<SignedPreKeyRecord> { self.signed_prekeys.get(&id).cloned().ok_or(SignalProtocolError::InvalidSignedPreKeyId) } async fn save_signed_pre_key(&mut self, id: SignedPreKeyId, r: &SignedPreKeyRecord) -> Result<()> { self.signed_prekeys.insert(id, r.clone()); Ok(()) } }
#[async_trait(?Send)] impl KyberPreKeyStore for AegisSignalStore { async fn get_kyber_pre_key(&self, id: KyberPreKeyId) -> Result<KyberPreKeyRecord> { self.kyber_prekeys.get(&id).cloned().ok_or(SignalProtocolError::InvalidKyberPreKeyId) } async fn save_kyber_pre_key(&mut self, id: KyberPreKeyId, r: &KyberPreKeyRecord) -> Result<()> { self.kyber_prekeys.insert(id, r.clone()); Ok(()) } async fn mark_kyber_pre_key_used(&mut self, id: KyberPreKeyId, sid: SignedPreKeyId, base: &PublicKey) -> Result<()> { let seen = self.kyber_seen.entry((id, sid)).or_default(); if seen.contains(base) { return Err(invalid("reused kyber base key")); } seen.push(*base); Ok(()) } }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn empty_store_round_trip_preserves_identity() {
        let mut rng = rand::rng();
        let store = AegisSignalStore::new(IdentityKeyPair::generate(&mut rng), 42);
        let restored = AegisSignalStore::deserialize(&store.serialize().unwrap()).unwrap();
        assert_eq!(restored.registration_id, 42);
        assert_eq!(restored.identity.serialize(), store.identity.serialize());
    }
}
