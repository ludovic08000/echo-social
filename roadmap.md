# Roadmap — migration libsignal-only

- [ ] Supprimer le sous-système Windows Hello / WebAuthn (client, API, edge function, workflow, config)
- [ ] Supprimer la crypto message custom (x3dh, kdfChain, aegisDeviceWire, deviceSessionStore, skippedKeyVault, replayGuard, securityEpoch, deviceManifest, deviceTransfer)
- [ ] deviceApi.prepareKeys / provisioning / lifecycle / routage : libsignal exclusif
- [ ] messageCompatibility : ancien ciphertext => unsupported, aucun fallback
- [ ] Migration destructive (non déployée) : purge devices/sessions/copies/webauthn/prekeys custom + gate bundle libsignal
- [ ] Tests, typecheck, verify-libsignal-wasm, build au vert
- [ ] Bloqué : création/checkout/push de la branche codex/libsignal-only-messaging (opérations git interdites dans cet environnement)
