# Messagerie Aegis + Libsignal

## Architecture retenue

- Aegis est l’unique autorité du cycle de vie appareil.
- Libsignal est l’unique moteur de sessions, de préclés et de chiffrement des messages.
- Le store Libsignal et les clés appareil sont scellés dans le coffre Aegis.
- La récupération reste limitée au PIN Aegis ou à la clé de récupération.
- Un appareil absent est enrôlé par le pipeline serveur canonique ; un appareil révoqué reste bloqué.
- Les lectures RPC sont bornées, annulables et tracées afin qu’aucun écran ne reste en attente infinie.

## Déploiement

1. Valider le typecheck, les tests unitaires, les scénarios Libsignal multi-appareils et le build.
2. Publier le client Aegis + Libsignal.
3. Vérifier le parcours complet : enrôlement, approbation serveur, binding, provisioning, synchronisation et échange chiffré.

## Invariants

- Aucun chiffrement de secours ni double pile cryptographique.
- Aucune clé privée dans les logs ou en clair côté serveur.
- Aucun succès simulé : une panne expose un code, une trace et une action Réessayer.
- La messagerie ne s’ouvre qu’après synchronisation réelle du compte et état serveur `ready`.
