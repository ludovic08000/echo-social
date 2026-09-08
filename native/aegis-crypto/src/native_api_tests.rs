#[test]
fn native_serialized_store_round_trip() {
    use crate::native_api::{
        bundle_create, message_decrypt, message_encrypt, session_establish, store_create,
    };

    let alice = store_create(1001).expect("alice store");
    let bob = store_create(2001).expect("bob store");
    let (bob, bob_bundle) = bundle_create(&bob, 1, 11, 12, 13).expect("bob bundle");
    let alice = session_establish(&alice, "alice", 1, "bob", 1, &bob_bundle)
        .expect("alice session");

    let (alice, message_type, ciphertext) =
        message_encrypt(&alice, "alice", 1, "bob", 1, b"android vers ios")
            .expect("encrypt");
    let (bob, plaintext) =
        message_decrypt(&bob, "bob", 1, "alice", 1, message_type, &ciphertext)
            .expect("decrypt");
    assert_eq!(plaintext, b"android vers ios");

    // A second message proves that both serialized ratchets survive restore.
    let (_bob, reply_type, reply_ciphertext) =
        message_encrypt(&bob, "bob", 1, "alice", 1, b"ios vers android")
            .expect("reply encrypt");
    let (_alice, reply_plaintext) = message_decrypt(
        &alice,
        "alice",
        1,
        "bob",
        1,
        reply_type,
        &reply_ciphertext,
    )
    .expect("reply decrypt");
    assert_eq!(reply_plaintext, b"ios vers android");
}
