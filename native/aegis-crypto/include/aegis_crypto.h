#ifndef AEGIS_CRYPTO_H
#define AEGIS_CRYPTO_H

#include <stddef.h>
#include <stdint.h>

#ifdef _WIN32
#define AEGIS_API __declspec(dllimport)
#else
#define AEGIS_API
#endif

#ifdef __cplusplus
extern "C" {
#endif

typedef struct AegisBuffer {
  uint8_t *data;
  size_t len;
} AegisBuffer;

AEGIS_API uint32_t aegis_crypto_abi_version(void);
AEGIS_API const uint8_t *aegis_crypto_last_error_message(void);
AEGIS_API void aegis_crypto_buffer_free(AegisBuffer buffer);
AEGIS_API int32_t aegis_crypto_identity_generate(AegisBuffer *secret, AegisBuffer *public_key);
AEGIS_API int32_t aegis_crypto_identity_public(
    const uint8_t *secret, size_t secret_len, AegisBuffer *public_key);
AEGIS_API int32_t aegis_crypto_signed_prekey_generate(
    const uint8_t *identity_secret, size_t identity_secret_len,
    uint32_t key_id, uint64_t timestamp_ms,
    AegisBuffer *record, AegisBuffer *public_key, AegisBuffer *signature);

/* Serialized-store API shared by Android, iOS and Windows native bindings. */
AEGIS_API int32_t aegis_crypto_store_create(
    uint32_t registration_id, AegisBuffer *store);
AEGIS_API int32_t aegis_crypto_bundle_create(
    const uint8_t *store, size_t store_len,
    uint32_t device_id, uint32_t pre_key_id, uint32_t signed_pre_key_id,
    uint32_t kyber_pre_key_id,
    AegisBuffer *next_store, AegisBuffer *public_bundle);
AEGIS_API int32_t aegis_crypto_session_establish(
    const uint8_t *store, size_t store_len,
    const uint8_t *local_name, size_t local_name_len, uint32_t local_device,
    const uint8_t *remote_name, size_t remote_name_len, uint32_t remote_device,
    const uint8_t *bundle, size_t bundle_len,
    AegisBuffer *next_store);
AEGIS_API int32_t aegis_crypto_message_encrypt(
    const uint8_t *store, size_t store_len,
    const uint8_t *local_name, size_t local_name_len, uint32_t local_device,
    const uint8_t *remote_name, size_t remote_name_len, uint32_t remote_device,
    const uint8_t *plaintext, size_t plaintext_len,
    AegisBuffer *next_store, uint8_t *message_type, AegisBuffer *ciphertext);
AEGIS_API int32_t aegis_crypto_message_decrypt(
    const uint8_t *store, size_t store_len,
    const uint8_t *local_name, size_t local_name_len, uint32_t local_device,
    const uint8_t *remote_name, size_t remote_name_len, uint32_t remote_device,
    uint8_t message_type,
    const uint8_t *ciphertext, size_t ciphertext_len,
    AegisBuffer *next_store, AegisBuffer *plaintext);

#ifdef __cplusplus
}
#endif
#endif
