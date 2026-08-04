# Aegis anonymous live delivery test

Executed successfully on 2026-08-04 against the Lovable Cloud Supabase database using only the public publishable key and two disposable anonymous sessions.

## Defects found and fixed

The test exposed two signup regressions before reaching Aegis:

1. `handle_new_user()` assumed that every account had an email, leaving `profiles.name` null for anonymous users.
2. `zeus_welcome_new_user()` attempted to insert a plaintext `legacy` message after Aegis had restricted messages to `system` or `multi_device` bodies.

The fixes are additive and versioned:

- anonymous profiles receive a non-sensitive fallback name when no name or email exists;
- Zeus welcome messages are written as `system` messages;
- Zeus welcome side effects are skipped for anonymous accounts.

## Successful live lifecycle

Run ID: `2d2f754e-cf1c-423a-9353-be851cf9ddab`

1. anonymous sender created — HTTP 200;
2. anonymous recipient created — HTTP 200;
3. both account-authorized devices registered — `DEVICE_AUTHORIZED`;
4. atomic DM conversation created;
5. route version resolved;
6. encrypted parent envelope generated and integrity self-check passed;
7. `aegis_send_message` committed — HTTP 200, verified commit receipt;
8. recipient `aegis_sync_device` returned exactly one matching encrypted parent and device copy;
9. `aegis_ack_device_messages` returned `1`;
10. a second sync confirmed the message was no longer pending.

Total scenario duration: `4121 ms`.

## Database verification

A direct PostgreSQL verification after the run returned:

- anonymous users: `2`;
- profiles: `2`;
- active devices: `2`;
- committed messages: `1`;
- device copies: `1`;
- ACKed inbox rows with read timestamp: `1`;
- pending inbox rows: `0`.

## Safe request correlation

The four gateway calls completed with HTTP 200 and no logged JWT, DeviceID, plaintext, ciphertext or request/response body values:

- send: `live-message_committed-45678dce-9f84-45ff-80fd-a0fe70d78c76`;
- sync: `live-recipient_sync-a120d69d-922a-4b34-a1f2-5601b55e1b90`;
- ACK: `live-recipient_ack-651eeabd-ed81-4b8f-bb85-2a4347408dc7`;
- sync after ACK: `live-recipient_resync_after_ack-8c810c49-4a1e-4c43-afcf-5e807a685cae`.

No service-role key was used.
