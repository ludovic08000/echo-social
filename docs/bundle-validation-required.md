# Bundle validation required before X3DH send

A peer device must not be used as an encryption target unless its X3DH bundle is complete and coherent.

A valid bundle requires identity key, device public key, signed prekey, signed prekey signature, signed prekey id, and a valid signature. Invalid active devices must be excluded from fanout/bootstrap and trigger repair instead of delaying message send.
