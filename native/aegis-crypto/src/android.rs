//! Android JNI facade over the portable serialized libsignal store.
//! Secret store bytes are returned only to the Capacitor bridge, which seals
//! them immediately with AegisKeychain before any network-visible result is used.

use jni::EnvUnowned;
use jni::errors::ThrowRuntimeExAndDefault;
use jni::jni_str;
use jni::objects::{JByteArray, JClass, JObjectArray, JString};
use jni::sys::{jbyteArray, jint, jobjectArray};

use crate::native_api;

fn byte_array_result<'local>(
    env: &mut jni::Env<'local>,
    bytes: &[u8],
) -> jni::errors::Result<jbyteArray> {
    Ok(env.byte_array_from_slice(bytes)?.into_raw())
}

fn object_array_result<'local>(
    env: &mut jni::Env<'local>,
    parts: &[&[u8]],
) -> jni::errors::Result<jobjectArray> {
    let byte_array_class = env.find_class(jni_str!("[B"))?;
    let result: JObjectArray =
        env.new_object_array(parts.len(), byte_array_class, JByteArray::default())?;
    for (index, part) in parts.iter().enumerate() {
        let array = env.byte_array_from_slice(part)?;
        result.set_element(env, index, array)?;
    }
    Ok(result.into_raw())
}

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
    unowned_env
        .with_env(|env| -> jni::errors::Result<jobjectArray> {
            let mut secret = crate::AegisBuffer::default();
            let mut public = crate::AegisBuffer::default();
            let status = unsafe { crate::aegis_crypto_identity_generate(&mut secret, &mut public) };
            if status != crate::AEGIS_OK {
                env.throw_new(
                    jni_str!("java/lang/RuntimeException"),
                    jni_str!("AEGIS_IDENTITY_GENERATE_FAILED"),
                )?;
                return Ok(std::ptr::null_mut());
            }
            let secret_bytes = unsafe { std::slice::from_raw_parts(secret.data, secret.len).to_vec() };
            let public_bytes = unsafe { std::slice::from_raw_parts(public.data, public.len).to_vec() };
            unsafe {
                crate::aegis_crypto_buffer_free(secret);
                crate::aegis_crypto_buffer_free(public);
            }
            object_array_result(env, &[&secret_bytes, &public_bytes])
        })
        .resolve::<ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_fans_forsure_app_crypto_AegisCryptoNative_storeCreate(
    mut unowned_env: EnvUnowned,
    _class: JClass,
    registration_id: jint,
) -> jbyteArray {
    unowned_env
        .with_env(|env| -> jni::errors::Result<jbyteArray> {
            let store = match native_api::store_create(registration_id as u32) {
                Ok(value) => value,
                Err(_) => {
                    env.throw_new(
                        jni_str!("java/lang/RuntimeException"),
                        jni_str!("AEGIS_STORE_CREATE_FAILED"),
                    )?;
                    return Ok(std::ptr::null_mut());
                }
            };
            byte_array_result(env, &store)
        })
        .resolve::<ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_fans_forsure_app_crypto_AegisCryptoNative_bundleCreate(
    mut unowned_env: EnvUnowned,
    _class: JClass,
    store: JByteArray,
    device_id: jint,
    pre_key_id: jint,
    signed_pre_key_id: jint,
    kyber_pre_key_id: jint,
) -> jobjectArray {
    unowned_env
        .with_env(|env| -> jni::errors::Result<jobjectArray> {
            let store = env.convert_byte_array(&store)?;
            let (next_store, bundle) = match native_api::bundle_create(
                &store,
                device_id as u32,
                pre_key_id as u32,
                signed_pre_key_id as u32,
                kyber_pre_key_id as u32,
            ) {
                Ok(value) => value,
                Err(_) => {
                    env.throw_new(
                        jni_str!("java/lang/RuntimeException"),
                        jni_str!("AEGIS_BUNDLE_CREATE_FAILED"),
                    )?;
                    return Ok(std::ptr::null_mut());
                }
            };
            object_array_result(env, &[&next_store, &bundle])
        })
        .resolve::<ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_fans_forsure_app_crypto_AegisCryptoNative_sessionEstablish(
    mut unowned_env: EnvUnowned,
    _class: JClass,
    store: JByteArray,
    local_name: JString,
    local_device: jint,
    remote_name: JString,
    remote_device: jint,
    bundle: JByteArray,
) -> jbyteArray {
    unowned_env
        .with_env(|env| -> jni::errors::Result<jbyteArray> {
            let store = env.convert_byte_array(&store)?;
            let bundle = env.convert_byte_array(&bundle)?;
            let local_name = local_name.try_to_string(env)?;
            let remote_name = remote_name.try_to_string(env)?;
            let next_store = match native_api::session_establish(
                &store,
                &local_name,
                local_device as u32,
                &remote_name,
                remote_device as u32,
                &bundle,
            ) {
                Ok(value) => value,
                Err(_) => {
                    env.throw_new(
                        jni_str!("java/lang/RuntimeException"),
                        jni_str!("AEGIS_SESSION_ESTABLISH_FAILED"),
                    )?;
                    return Ok(std::ptr::null_mut());
                }
            };
            byte_array_result(env, &next_store)
        })
        .resolve::<ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_fans_forsure_app_crypto_AegisCryptoNative_messageEncrypt(
    mut unowned_env: EnvUnowned,
    _class: JClass,
    store: JByteArray,
    local_name: JString,
    local_device: jint,
    remote_name: JString,
    remote_device: jint,
    plaintext: JByteArray,
) -> jobjectArray {
    unowned_env
        .with_env(|env| -> jni::errors::Result<jobjectArray> {
            let store = env.convert_byte_array(&store)?;
            let plaintext = env.convert_byte_array(&plaintext)?;
            let local_name = local_name.try_to_string(env)?;
            let remote_name = remote_name.try_to_string(env)?;
            let (next_store, message_type, ciphertext) = match native_api::message_encrypt(
                &store,
                &local_name,
                local_device as u32,
                &remote_name,
                remote_device as u32,
                &plaintext,
            ) {
                Ok(value) => value,
                Err(_) => {
                    env.throw_new(
                        jni_str!("java/lang/RuntimeException"),
                        jni_str!("AEGIS_MESSAGE_ENCRYPT_FAILED"),
                    )?;
                    return Ok(std::ptr::null_mut());
                }
            };
            let message_type = [message_type];
            object_array_result(env, &[&next_store, &message_type, &ciphertext])
        })
        .resolve::<ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_fans_forsure_app_crypto_AegisCryptoNative_messageDecrypt(
    mut unowned_env: EnvUnowned,
    _class: JClass,
    store: JByteArray,
    local_name: JString,
    local_device: jint,
    remote_name: JString,
    remote_device: jint,
    message_type: jint,
    ciphertext: JByteArray,
) -> jobjectArray {
    unowned_env
        .with_env(|env| -> jni::errors::Result<jobjectArray> {
            let store = env.convert_byte_array(&store)?;
            let ciphertext = env.convert_byte_array(&ciphertext)?;
            let local_name = local_name.try_to_string(env)?;
            let remote_name = remote_name.try_to_string(env)?;
            let (next_store, plaintext) = match native_api::message_decrypt(
                &store,
                &local_name,
                local_device as u32,
                &remote_name,
                remote_device as u32,
                message_type as u8,
                &ciphertext,
            ) {
                Ok(value) => value,
                Err(_) => {
                    env.throw_new(
                        jni_str!("java/lang/RuntimeException"),
                        jni_str!("AEGIS_MESSAGE_DECRYPT_FAILED"),
                    )?;
                    return Ok(std::ptr::null_mut());
                }
            };
            object_array_result(env, &[&next_store, &plaintext])
        })
        .resolve::<ThrowRuntimeExAndDefault>()
}
