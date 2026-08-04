# Aegis Server Gateway

Gateway HTTP durci entre les clients Echo Social et les RPC Aegis de Supabase/PostgreSQL.

Le gateway ne reçoit jamais de clé privée. Les messages transmis sont déjà chiffrés côté client. PostgreSQL reste l'autorité pour l'idempotence durable, la validation des routes, la couverture exacte des appareils et la transaction message + copies.

## Garanties du gateway

- validation réelle du JWT Supabase avant chaque RPC ;
- CORS par origine exacte ;
- protocole versionné avec `X-Aegis-Protocol-Version` ;
- `X-Request-Id` propagé de bout en bout ;
- idempotence liée aux identifiants stables déjà présents (`p_message_id`, `p_device_id`) ou à l'en-tête `Idempotency-Key` ;
- aucune modification du body RPC : compatibilité avec les fonctions PostgreSQL actuelles ;
- limites de taille différentes selon les routes ;
- rate limiting par IP et utilisateur ;
- limite de concurrence ;
- délais séparés pour l'authentification, les RPC et le readiness ;
- erreurs structurées et messages utilisateurs sans UUID brut ;
- logs JSON sans body, plaintext, ciphertext, token ou clé ;
- arrêt propre et endpoints liveness/readiness.

## Endpoints

Compatibilité actuelle :

- `POST /v1/rpc/aegis_send_message`
- `POST /v1/rpc/aegis_sync_device`
- `POST /v1/rpc/aegis_ack_device_messages`

Protocole v2 :

- `POST /v2/rpc/aegis_send_message`
- `POST /v2/rpc/aegis_sync_device`
- `POST /v2/rpc/aegis_ack_device_messages`
- `POST /v2/rpc/aegis_resolve_conversation_route`
- `POST /v2/rpc/aegis_get_device_health`
- `POST /v2/rpc/aegis_enroll_device`
- `POST /v2/rpc/aegis_publish_prekey_bundle`
- `POST /v2/rpc/aegis_repair_current_device`
- `GET /health/live`
- `GET /health/ready`

Les nouvelles routes v2 ne fonctionneront qu'après création des RPC PostgreSQL correspondantes. Le gateway renverra proprement l'erreur Supabase tant qu'elles n'existent pas.

## Contrat client

Le client doit envoyer :

```http
Authorization: Bearer <supabase-jwt>
Content-Type: application/json
X-Aegis-Protocol-Version: 2
X-Request-Id: <uuid ou identifiant stable>
Idempotency-Key: <identifiant stable facultatif>
```

Pour l'envoi, `p_message_id` reste l'identifiant durable principal. Une nouvelle tentative doit réutiliser exactement le même `p_message_id`, le même ciphertext préparé, les mêmes copies tant que la route n'est pas déclarée obsolète, et la même transaction locale de ratchet.

Réponse réussie :

```json
{
  "data": {},
  "error": null,
  "meta": {
    "request_id": "...",
    "protocol_version": 2
  }
}
```

Erreur structurée :

```json
{
  "error": {
    "code": "PARTICIPANT_DEVICE_SETUP_REQUIRED",
    "message": "Le destinataire doit terminer la sécurisation de son appareil.",
    "retryable": true,
    "details": null,
    "hint": null,
    "request_id": "..."
  }
}
```

## Déploiement VPS

1. Copier `.env.example` vers `.env` et renseigner les valeurs.
2. Exécuter `docker compose up -d --build`.
3. Placer Caddy ou nginx devant `127.0.0.1:8787`.
4. Exposer uniquement en HTTPS, par exemple `https://aegis.forsure.fans`.
5. Configurer `VITE_AEGIS_SERVER_URL=https://aegis.forsure.fans` côté client.
6. Vérifier `/health/live` puis `/health/ready` avant de router le trafic.

Sans `VITE_AEGIS_SERVER_URL`, le client continue d'appeler Supabase directement. Cette bascule permet un déploiement progressif et un rollback sans conversion des messages existants.

## Travaux PostgreSQL encore nécessaires

Le gateway ne peut pas inventer l'état cryptographique. Les RPC suivantes doivent être atomiques et couvertes par des tests SQL :

- enrôlement/réparation de l'appareil actuel ;
- publication et rotation des Signed PreKeys ;
- réapprovisionnement des One-Time PreKeys ;
- diagnostic `ACCOUNT_READY + DEVICE_READY + ROUTE_READY` ;
- résolution transactionnelle d'une route de conversation ;
- idempotence durable de `aegis_send_message` ;
- file d'attente/retry pour participant temporairement non routable ;
- unicité d'une identité active et d'un appareil actif par DeviceID.

Aucune RPC ne doit recevoir de clé privée ni de plaintext.
