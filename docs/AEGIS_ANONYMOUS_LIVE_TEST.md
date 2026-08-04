# Aegis anonymous live delivery test

Attempted on 2026-08-04 against the Supabase cloud project using only the public publishable key.

## Result

The authentication request was rejected before any test account or test data was created:

- HTTP status: `422`
- Auth response: `Anonymous sign-ins are disabled`
- Aegis gateway contract tests still passed: `26/26`

The temporary schema/auth/live-delivery probes were removed after diagnosis and the stable CI workflow was restored.

## Gate before rerun

Enable anonymous sign-ins in the Supabase Authentication settings. Then rerun the disposable two-user scenario:

1. create anonymous sender and recipient;
2. register one account-authorized device per user;
3. create an atomic DM conversation;
4. send through `aegis_send_message`;
5. sync the recipient device;
6. ACK the delivered message;
7. sync again and verify that the message is no longer pending;
8. correlate the gateway lifecycle by safe `request_id` logs without JWT, device identifier, ciphertext or plaintext values.

No service-role key is required or permitted for this test.
