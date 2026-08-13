# Source libsignal utilisée par Aegis

Ce dossier contient une copie du workspace Rust officiel de
[`signalapp/libsignal`](https://github.com/signalapp/libsignal).

- Commit amont : `857c4dca03537dc5e395a5e1eda6bf18f59c3601`
- Date du commit : 2026-08-06
- Licence : `AGPL-3.0-only`
- Import Aegis : 2026-08-12

Le code de ce dossier reste une source tierce identifiable. Les adaptations
Aegis doivent vivre hors de ce dossier afin de pouvoir comparer et mettre à
jour libsignal sans mélanger les modifications locales avec l'amont.

## Frontière de sécurité

Les primitives libsignal s'exécutent sur l'appareil. Le serveur Aegis ne reçoit
que les identités publiques, SPK/OPK publiques, enveloppes chiffrées, capsules
par appareil et accusés de réception. Il ne reçoit jamais les clés privées,
les clés de chaîne, les clés de message ni l'état Double Ratchet en clair.

## Composants retenus

- `rust/protocol` : X3DH/PQXDH, sessions, Double Ratchet et formats de message.
- `rust/bridge/ffi` : base du binding Swift/iOS et du binding Windows natif.
- `rust/bridge/jni` : base du binding Android/Kotlin.
- `rust/bridge/node` : tests d'interopérabilité et outils locaux, pas le serveur
  de production.

Les autres crates sont conservés parce que le workspace et les crates retenus
les référencent. Leur présence ne signifie pas qu'ils sont activés dans Aegis.
