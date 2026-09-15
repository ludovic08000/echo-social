# Chantier libsignal-only

- [x] Supprimer Windows Hello / WebAuthn / passkeys (code, UI, fonction edge, workflow)
- [x] Supprimer la crypto message maison (X3DH, Double Ratchet, aegis1.*)
- [x] deviceApi.prepareKeys : provisioning libsignal uniquement
- [x] deviceLifecycleController : enrôlement auto sur toute plateforme
- [x] Fixtures et tests alignés sur le fil libsignal
- [x] Tests (793 passés), typecheck, verify-libsignal-wasm, build
- [x] SQL de cutover rédigé (supabase/pending-migrations/, non appliqué)
- [ ] BLOQUÉ : écriture Git sur la branche codex/libsignal-only-messaging (aucune opération git possible ici)
- [ ] BLOQUÉ : le fichier de migration ne peut pas être ajouté sans être appliqué immédiatement
