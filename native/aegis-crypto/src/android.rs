//! Façade JNI Android. Les tableaux secrets doivent être scellés dans le
//! Keystore avant le retour au code applicatif ou conservés seulement en RAM.

use jni::EnvUnowned;
use jni::errors::ThrowRuntimeExAndDefault;
use jni::jni_str;
use jni::objects::{JByteArray, JClass, JObjectArray};
use jni::sys::jobjectArray;
use libsignal_protocol::IdentityKeyPair;

#[unsafe(no_mangle)]
pub extern "system" fn Java_fans_forsure_app_crypto_AegisCryptoNative_abiVersion(
    _env: EnvUnowned,
    _class: JClass,
) -> i32 {
    super::AEGIS_CRYPTO_ABI_VERSION as i32
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_fans_forsure_app_crypto_AegisCryptoNative_generateIdentity(
    mut unowned_env: EnvUnowned,
    _class: JClass,
) -> jobjectArray {
    let mut rng = rand::rng();
    let identity = IdentityKeyPair::generate(&mut rng);
    let secret = identity.serialize();
    let public = identity.identity_key().serialize();

    unowned_env
        .with_env(|env| -> jni::errors::Result<jobjectArray> {
            let byte_array_class = env.find_class(jni_str!("[B"))?;
            let result: JObjectArray =
                env.new_object_array(2, byte_array_class, JByteArray::default())?;
            let secret_array = env.byte_array_from_slice(&secret)?;
            let public_array = env.byte_array_from_slice(&public)?;
            result.set_element(env, 0, secret_array)?;
            result.set_element(env, 1, public_array)?;
            Ok(result.into_raw())
        })
        .resolve::<ThrowRuntimeExAndDefault>()
}
