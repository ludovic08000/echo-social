# Aegis live remote-directory X3DH validation

Executed successfully on 2026-08-05 against the Lovable Cloud database and the shared Aegis gateway core.

## Scope

- two disposable anonymous users;
- one independently authorized device per user (`A1` and `B1`);
- account identity binding verification;
- device authorization signature verification;
- live publication of one signed prekey and 100 one-time prekeys;
- live remote Sesame directory lookup;
- Ed25519 signed-prekey verification;
- destructive, atomic one-time-prekey claims;
- production X3DH implementation with DH1, DH2, DH3 and DH4;
- authoritative server-side initial-message replay ledger;
- responder X3DH signed-prekey state bridged into the persistent device Double Ratchet;
- live durable Aegis send, sync and ACK against Lovable Cloud;
- no service-role key.

Successful run ID: `8059c99a-0b02-4ffc-adb9-89cec8b96fea`

GitHub Actions run: `30959507135`

## Remote identity and prekey directory

The receiver device published:

- one active X25519 signed prekey;
- an Ed25519 signature over that signed prekey;
- 100 X25519 one-time prekeys.

The initiator retrieved the receiver through the remote Sesame directory. The production verification path accepted:

- the account identity binding signature;
- the device authorization signature;
- the device signing key;
- the signed-prekey signature.

Two destructive OTK claims were made to prove that the server never returned the same one-time prekey twice. Their IDs were distinct and the available count changed from 100 to 98. The first claimed OTK was used in the X3DH derivation; the second claim was used only as an atomic non-reuse assertion in this disposable test.

## X3DH derivation

The initiator and responder independently derived the X3DH secret using:

- DH1: initiator identity × receiver signed prekey;
- DH2: initiator ephemeral × receiver identity;
- DH3: initiator ephemeral × receiver signed prekey;
- DH4: initiator ephemeral × receiver one-time prekey.

The two 32-byte shared secrets matched byte-for-byte.

The initial tuple was reserved and finalized in the new authoritative server replay ledger. Re-submitting the same initial message was rejected.

## X3DH to Double Ratchet bridge

The live test exposed a missing production bridge: the responder X3DH path loaded the private signed-prekey JWK from local IndexedDB but returned only a non-exportable `CryptoKey`. The persistent Double Ratchet requires the original private JWK to install the responder's first receiving chain.

`src/lib/crypto/x3dhRatchetBootstrap.ts` now loads the exact local signed-prekey record and installs it directly into the responder ratchet session. The private JWK never leaves local IndexedDB and is never sent to the server or logs.

## Durable encrypted delivery

After X3DH:

1. both device-pair ratchet states were installed with the same session ID;
2. A1 encrypted the first plaintext with the production Double Ratchet;
3. the resulting `aegis1.ratchet.*` envelope was committed through the shared Aegis gateway core;
4. B1 synchronized its device inbox from Lovable Cloud;
5. B1 decrypted the exact plaintext;
6. B1 ACKed and marked the delivery read;
7. the next sync returned no pending copy.

Final runtime evidence:

- anonymous users: `2`;
- devices: `2`;
- active signed prekeys: `1`;
- one-time prekeys initially published: `100`;
- distinct OTK claims: `2`;
- remaining one-time prekeys: `98`;
- X3DH DH terms: `4`;
- shared-secret match: `true`;
- replay rejection: `true`;
- ratchet messages: `1`;
- exact plaintext decryptions: `1`;
- successful ACKs: `1`;
- pending after ACK: `0`;
- scenario duration: `9,342 ms`.

## Database inspection

Before cleanup, PostgreSQL contained:

- two authenticated anonymous users;
- two authorized devices;
- two active account identities;
- one active signed prekey;
- 98 remaining one-time prekeys;
- one finalized replay-ledger row;
- one conversation;
- one message;
- one device copy;
- one ACKed/read inbox row;
- zero pending inbox rows.

Server-side plaintext inspection found:

- plaintext parent rows: `0`;
- plaintext device-copy rows: `0`;
- valid `aegis1.ratchet.*` rows: `1`.

JWTs, private keys, shared secrets, plaintexts and ciphertexts were not emitted by the gateway logs.

## Corrections added

- `supabase/migrations/20260805011500_aegis_x3dh_replay_ledger.sql`
  - authenticated reserve/finalize/cancel RPCs;
  - transaction-level serialization per responder and fingerprint;
  - short reservation expiry;
  - seven-day finalized replay retention;
  - RLS enabled and no direct client table access.
- `src/lib/crypto/x3dhRatchetBootstrap.ts`
  - safe local responder bootstrap from the exact signed prekey used by X3DH.

## Vercel boundary

The branch Preview deployment is protected by Vercel Deployment Protection. A direct GitHub Actions POST therefore returned `401 Protected deployment` before reaching Aegis. The successful final run started the exact shared Aegis gateway core inside the runner while keeping Lovable Cloud, JWT authentication, prekey RPCs, send, sync and ACK fully live.

The Vercel function build and `/health` are validated separately. An authenticated end-to-end POST through the protected Preview requires a Vercel protection-bypass credential or an unprotected production route.

## Cleanup

All disposable users, devices, prekeys, replay rows, conversations, messages, copies and inbox rows were removed after inspection. Final residual counts were zero.
