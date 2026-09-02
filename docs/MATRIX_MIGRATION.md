# Migration de la messagerie ForSure vers Matrix

## Frontière de responsabilité

- Supabase reste responsable de l'authentification ForSure, des profils et des
  fonctions sociales.
- Matrix devient responsable des salons, messages, appareils, synchronisation,
  chiffrement E2EE et médias de la messagerie.
- Le navigateur échange sa session Supabase contre une session Matrix via la
  fonction serveur `matrix-session`. Le mot de passe Supabase n'est jamais
  transmis au homeserver Matrix.

## Invariants de sécurité

1. Un seul `MatrixClient` peut être actif par profil navigateur. Un verrou Web
   Locks exclusif empêche deux onglets d'ouvrir le même stockage crypto.
2. `initRustCrypto()` termine avant le démarrage de `/sync`.
3. Une conversation utilise exclusivement Matrix ou exclusivement Aegis. Aucun
   message n'est écrit dans les deux protocoles.
4. Le serveur ne reçoit jamais de clé de récupération en clair.
5. Les médias Matrix sont téléchargés avec authentification, transformés en URL
   `blob:` locale, puis révoqués au démontage de la bulle.
6. Le drapeau Matrix reste désactivé tant que le homeserver et l'échange de
   session ne sont pas opérationnels.

## Configuration du prototype

```env
VITE_MATRIX_ENABLED=true
VITE_MATRIX_HOMESERVER_URL=https://matrix.example.com
VITE_MATRIX_SESSION_FUNCTION=matrix-session
```

La fonction `matrix-session` doit vérifier le JWT Supabase, associer de manière
stable l'UUID Supabase à un Matrix user ID et retourner :

```json
{
  "access_token": "opaque-token",
  "device_id": "stable-device-id",
  "user_id": "@stable-user:example.com"
}
```

Elle ne doit jamais contenir un secret administrateur Matrix dans le bundle
Vite. Ce secret appartient uniquement à une fonction serveur ou à un service
d'identité dédié.

Les fonctions `matrix-session` et `matrix-route`, la migration SQL et une
configuration Docker Synapse épinglée sont présentes dans le dépôt. Les secrets
nécessaires sont documentés dans `infra/matrix/README.md`.

## Déploiement progressif

1. Déployer un homeserver de test et `matrix-session`.
2. Créer des comptes et salons Matrix pour deux comptes de test.
3. Brancher une conversation pilote sur l'adaptateur Matrix.
4. Valider texte, image, vidéo, document, hors-ligne et reprise.
5. Valider Windows vers iOS/Android et plusieurs appareils simultanés.
6. Configurer secret storage, cross-signing et key backup.
7. Migrer les nouvelles conversations. Les messages Aegis de développement
   peuvent être supprimés après validation, conformément à la décision produit.
8. Retirer Aegis seulement lorsqu'aucune route de production ne l'importe.
