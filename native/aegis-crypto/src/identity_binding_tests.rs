//! Tests avec le vrai moteur officiel, sans simulateur de ratchet.
use crate::{AegisSignalStore, native_api::*};

fn public(store: &[u8]) -> Vec<u8> {
    AegisSignalStore::deserialize(store).unwrap().identity_key_pair().identity_key().serialize().to_vec()
}

fn setup() -> (Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>) {
    let alice = store_create(101).unwrap();
    let (bob, bundle) = bundle_create(&store_create(202).unwrap(), 2, 11, 12, 13).unwrap();
    let alice_key = public(&alice);
    let bob_key = public(&bob);
    let alice = session_establish(&alice, "alice", 1, "bob", 2, &bundle).unwrap();
    (alice, bob, alice_key, bob_key)
}

#[test]
fn bound_first_receive_and_warm_replies_keep_both_identities() {
    let (mut alice, mut bob, alice_key, bob_key) = setup();
    for index in 0..3 {
        alice = identity_bind(&alice, "bob", 2, &bob_key).unwrap();
        let (next, kind, cipher) = message_encrypt(&alice,"alice",1,"bob",2,b"Bonjour").unwrap();
        alice = next;
        bob = identity_bind(&bob,"alice",1,&alice_key).unwrap();
        let (next, clear) = message_decrypt(&bob,"bob",2,"alice",1,kind,&cipher).unwrap();
        bob = next;
        assert_eq!(clear,b"Bonjour");
        let (next, kind, cipher) = message_encrypt(&bob,"bob",2,"alice",1,b"Reponse").unwrap();
        bob = next;
        let (next, clear) = message_decrypt(&alice,"alice",1,"bob",2,kind,&cipher).unwrap();
        alice = next;
        assert_eq!(clear,b"Reponse");
        assert_eq!(public(&alice),alice_key,"alice identity round {index}");
        assert_eq!(public(&bob),bob_key,"bob identity round {index}");
    }
}

#[test]
fn impostor_first_prekey_is_rejected_before_consuming_the_real_prekey() {
    let alice = store_create(101).unwrap();
    let (bob,bundle) = bundle_create(&store_create(202).unwrap(),2,11,12,13).unwrap();
    let attacker = session_establish(&store_create(999).unwrap(),"alice",1,"bob",2,&bundle).unwrap();
    let (_, kind, cipher) = message_encrypt(&attacker,"alice",1,"bob",2,b"impostor").unwrap();
    let pinned = identity_bind(&bob,"alice",1,&public(&alice)).unwrap();
    assert!(message_decrypt(&pinned,"bob",2,"alice",1,kind,&cipher).is_err());
    // L'essai refusé n'a retourné aucun store : la même préclé privée sert encore au vrai expéditeur.
    let alice = session_establish(&alice,"alice",1,"bob",2,&bundle).unwrap();
    let (_,kind,cipher) = message_encrypt(&alice,"alice",1,"bob",2,b"legitimate").unwrap();
    let (_,clear) = message_decrypt(&pinned,"bob",2,"alice",1,kind,&cipher).unwrap();
    assert_eq!(clear,b"legitimate");
}

#[test]
fn existing_tofu_session_cannot_be_laundered_with_a_different_verified_key() {
    let (alice,_,_,bob_key) = setup();
    let different = public(&store_create(303).unwrap());
    assert!(identity_bind(&alice,"bob",2,&different).is_err());
    let matching = identity_bind(&alice,"bob",2,&bob_key).unwrap();
    assert!(message_encrypt(&matching,"alice",1,"bob",2,b"still usable").is_ok());
}

#[test]
fn pinned_identity_rejects_a_later_inconsistent_bundle() {
    let (_,bob,alice_key,_) = setup();
    let bob = identity_bind(&bob,"alice",1,&alice_key).unwrap();
    let (_,fake) = bundle_create(&store_create(303).unwrap(),1,21,22,23).unwrap();
    assert!(session_establish(&bob,"bob",2,"alice",1,&fake).is_err());
}

#[test]
fn binding_is_scoped_to_user_and_numeric_device() {
    let local = store_create(101).unwrap();
    let key1 = public(&store_create(202).unwrap());
    let key2 = public(&store_create(303).unwrap());
    let local = identity_bind(&local,"bob",1,&key1).unwrap();
    let local = identity_bind(&local,"bob",2,&key2).unwrap();
    let local = identity_bind(&local,"carol",1,&key2).unwrap();
    assert!(identity_bind(&local,"bob",1,&key2).is_err());
    assert!(identity_bind(&local,"bob",2,&key2).is_ok());
}

#[test]
fn refuses_empty_truncated_extended_and_private_key_encodings() {
    let local = store_create(101).unwrap();
    let key = public(&store_create(202).unwrap());
    let mut extended = key.clone(); extended.push(0);
    let mut wrong_type = key.clone(); wrong_type[0] = 4;
    let secret = AegisSignalStore::deserialize(&local).unwrap().identity_key_pair().serialize().to_vec();
    for invalid in [vec![],key[..32].to_vec(),extended,wrong_type,secret] {
        assert!(identity_bind(&local,"bob",1,&invalid).is_err());
    }
}

#[test]
fn late_messages_survive_binding_an_existing_session_and_store_restore() {
    let (alice,bob,alice_key,bob_key) = setup();
    let (alice,kind1,first) = message_encrypt(&alice,"alice",1,"bob",2,b"first").unwrap();
    let (bob,_) = message_decrypt(&bob,"bob",2,"alice",1,kind1,&first).unwrap();
    let (bob,reply_kind,reply) = message_encrypt(&bob,"bob",2,"alice",1,b"reply").unwrap();
    let (alice,_) = message_decrypt(&alice,"alice",1,"bob",2,reply_kind,&reply).unwrap();
    let (alice,kind2,late) = message_encrypt(&alice,"alice",1,"bob",2,b"late").unwrap();
    let alice = identity_bind(&alice,"bob",2,&bob_key).unwrap();
    let (_,kind3,current) = message_encrypt(&alice,"alice",1,"bob",2,b"current").unwrap();
    let bob = identity_bind(&bob,"alice",1,&alice_key).unwrap();
    let (bob,clear) = message_decrypt(&bob,"bob",2,"alice",1,kind3,&current).unwrap();
    assert_eq!(clear,b"current");
    let bob = identity_bind(&bob,"alice",1,&alice_key).unwrap();
    let (bob,clear) = message_decrypt(&bob,"bob",2,"alice",1,kind2,&late).unwrap();
    assert_eq!(clear,b"late");
    assert!(message_decrypt(&bob,"bob",2,"alice",1,kind2,&late).is_err());
}

#[test]
fn native_c_abi_rejection_returns_no_store_and_no_private_output() {
    use crate::*;
    use crate::native_api::aegis_crypto_identity_bind;
    let store = store_create(101).unwrap();
    let mut output = AegisBuffer::default();
    let result = unsafe { aegis_crypto_identity_bind(store.as_ptr(),store.len(),b"bob".as_ptr(),3,1,
        std::ptr::null(),0,&mut output) };
    assert_eq!(result,AEGIS_ERR_CRYPTO);
    assert!(output.data.is_null()); assert_eq!(output.len,0);
    let result = unsafe { aegis_crypto_identity_bind(store.as_ptr(),store.len(),b"bob".as_ptr(),3,1,
        std::ptr::null(),33,&mut output) };
    assert_eq!(result,AEGIS_ERR_NULL_POINTER);
    assert!(output.data.is_null());
}
