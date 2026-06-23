# X3DH timeout repair behavior

The sender must not block for tens of seconds while trying to bootstrap X3DH against a stale or invalid peer device bundle.

Expected behavior:

- Device prekey bundle lookup is time-bounded.
- OPK claim is time-bounded and non-fatal.
- Invalid or unavailable peer device bundles request server-side prekey repair.
- The outbound message remains local pending when no secure route exists.
