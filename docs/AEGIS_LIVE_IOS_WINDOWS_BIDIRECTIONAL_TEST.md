# Aegis live iOS ↔ Windows bidirectional validation

Executed successfully on 2026-08-05 against the live Lovable Cloud / Supabase database and the production Aegis gateway.

GitHub Actions run: `30980449945`

GitHub Actions job: `92223543350`

Scenario run ID: `d3496dee-5161-420f-8fdd-e064f4a09068`

## Scenario

Two disposable anonymous users were created:

- one logical iPhone device with platform `ios` and an iPhone/Safari user agent;
- one logical Windows device with platform `web` and a Windows/Chrome user agent.

Both devices used the new server-assigned enrollment flow. PostgreSQL allocated two distinct opaque DeviceIDs matching `dev_<32 hex>`. Each logical device then generated its own X25519 device identity, Ed25519 signing key, account authorization signature, signed prekey and 100 one-time prekeys.

Both routes reached `ready` before messaging began.

## Cryptographic bootstrap

The iPhone logical device initiated X3DH toward Windows. The live remote directory verified:

- the account identity binding;
- the device authorization signature;
- the Windows device signing key;
- the signed-prekey signature.

X3DH used DH1, DH2, DH3 and DH4. Initiator and responder derived the same shared secret. The responder signed-prekey state was bridged into the persistent Double Ratchet session.

## iPhone → Windows

The iPhone logical device encrypted a unique plaintext with the production Double Ratchet and submitted the device copy through `https://aegis.forsure.fans`.

Evidence:

- message commit: HTTP `200`;
- Windows device sync: HTTP `200`;
- exact plaintext recovered: `true`;
- ACK/read: HTTP `200`;
- pending after ACK: `0`;
- message reference: `88b12f0089ab`;
- plaintext SHA-256: `5de2c02e251317dd2948a5e155b7286c5187d07b729d4dc642fd7acac0748dc1`.

## Windows → iPhone

Using the same persistent Double Ratchet session, the Windows logical device encrypted a distinct reply and submitted it through the production Aegis gateway.

Evidence:

- message commit: HTTP `200`;
- iPhone device sync: HTTP `200`;
- exact plaintext recovered: `true`;
- ACK/read: HTTP `200`;
- pending after ACK: `0`;
- message reference: `ea6c3c61dc7a`;
- plaintext SHA-256: `ed24ce0e2439ffb17cf88d6af529bf633d8b93bde5ec3bfb0bfd0a5d55170be2`.

## Final result

- disposable users: `2`;
- server-assigned DeviceIDs: `2`;
- ready routes: `2`;
- verified account bindings: `2`;
- verified device authorizations: `2`;
- active signed prekeys: `2`;
- one-time prekeys initially published: `200`;
- matching X3DH shared secret: `true`;
- Double Ratchet messages: `2`;
- iPhone → Windows plaintext match: `true`;
- Windows → iPhone plaintext match: `true`;
- successful ACKs: `2`;
- pending after ACK: `0`;
- scenario duration: `15,690 ms`;
- Vitest: `1 passed`.

No PIN, JWT, private key, nonce, shared secret, plaintext or ciphertext was emitted in the structured scenario logs. User, device, session, prekey and message identifiers were represented by truncated SHA-256 aliases.

## Gateway/CORS boundary

A first browser-origin probe sent `Origin: https://forsure.fans` directly to the production gateway and received `ORIGIN_DENIED`. That failure occurred after both devices were enrolled, both routes were ready and X3DH had succeeded. It was not a key-attribution or cryptographic failure.

The successful bidirectional cryptographic run used native-client gateway semantics without an `Origin` header. The actual branch Preview uses a same-origin `/v1/rpc/*` gateway, so browser CORS is handled separately from the key and ratchet protocol.

## Cleanup

Before cleanup, the successful run contained exactly:

- two Auth users;
- two devices;
- two account identities;
- two active signed prekeys;
- 199 remaining one-time prekeys after one destructive X3DH claim;
- one conversation;
- two encrypted messages;
- two device copies;
- two ACKed/read inbox rows.

All test users, devices, identities, prekeys, challenges, replay rows, route versions, conversation rows, messages, device copies, inbox rows, notifications, audit rows and profile/settings rows were deleted.

Final residual inspection:

- Auth users: `0`;
- public rows referencing either test user: `0`;
- test conversations: `0`;
- test messages: `0`.

## Remaining physical-device boundary

This is a live protocol and gateway test using WebCrypto-compatible logical devices with iOS and Windows metadata. It validates the server-assigned DeviceID flow, key authorization, X3DH, Double Ratchet, durable delivery, sync, decryption and ACK in both directions. It does not replace the final physical Safari/Chrome iPhone UI test, which also exercises IndexedDB persistence, PIN unlock and browser service-worker/cache behavior.
