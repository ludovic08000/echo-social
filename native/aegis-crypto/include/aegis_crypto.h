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

#ifdef __cplusplus
}
#endif
#endif

