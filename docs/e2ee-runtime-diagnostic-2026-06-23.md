# E2EE runtime diagnostic - 2026-06-23

Repository: ludovic08000/echo-social

Sender account: 98c32ea4-faae-4c87-b8d4-8a0ea9e7be7e
Peer account: ffeb378a-e1b3-4bfb-8c31-72c94e4da14d
Conversation: b20b5f51-2dba-482d-957c-a43f11d8c012

## Observed runtime facts

The old peer-key symptom changed. The runtime now logs:

[PEER_KEY] loaded ffeb378a-e1b3-4bfb-8c31-72c94e4da14d

So peer public key loading is no longer the first visible blocker in this run.

The remaining issue is send latency before encryption. First attempt:

session_check_start elapsedMs=1
session_ok elapsedMs=4657
identity_bootstrap_start elapsedMs=4660
identity_bootstrap_ok elapsedMs=51258
encrypt_start elapsedMs=51258
encrypt_failed elapsedMs=86806

Second attempt:

session_ok elapsedMs=18398
identity_bootstrap_start elapsedMs=18398
identity_bootstrap_ok elapsedMs=18399
encrypt_start elapsedMs=18399
encrypt_failed elapsedMs=40549

## Diagnosis

The frontend must not block a message send on full account maintenance.

Signal and WhatsApp style behavior separates these phases:

1. local identity availability, required before encryption;
2. peer public identity availability, required before encryption;
3. device-scoped X3DH bundle availability, required for new device/session bootstrap;
4. backup sync, key maintenance, legacy SPK refresh, server state marking and post-restore resync, which are background maintenance tasks.

The log shows that ensureUserE2EEIdentity() is awaited during message send and can take tens of seconds before encrypt_start.

## Required correction

The send path may quickly check local identity availability, but it must not wait for encrypted backup creation, backup sync, legacy account-wide SPK refresh, server crypto-state provisioning, post-restore maintenance, or non-critical background resync.

If the peer has active devices but no usable device bundle, the message must remain local pending and the app must not fall back to the legacy get_signed_prekey() path.

## Expected post-fix behavior

Healthy flow:

[PEER_KEY] loaded ffeb378a-e1b3-4bfb-8c31-72c94e4da14d
identity_bootstrap_ok elapsedMs small
encrypt_start elapsedMs small
[X3DH][ROUTE] device bundle selected
[X3DH][SPK_VERIFY] valid: true

Intentional hard-fail flow:

[X3DH][ROUTE] active devices exist but no device bundle is usable; legacy fallback refused

That hard-fail is intentional because it avoids hiding a device-bundle problem behind the legacy account-wide prekey path.
