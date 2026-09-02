# Homeserver Matrix ForSure

La version Synapse est volontairement épinglée. Ne pas utiliser `latest` en
production.

## Génération initiale

Depuis ce dossier :

```powershell
$env:SYNAPSE_SERVER_NAME="matrix.example.com"
$env:SYNAPSE_REPORT_STATS="no"
docker run --rm `
  -v "${PWD}/data:/data" `
  -e SYNAPSE_SERVER_NAME `
  -e SYNAPSE_REPORT_STATS `
  matrixdotorg/synapse:v1.157.1 generate
```

Dans `data/homeserver.yaml`, configurer PostgreSQL :

```yaml
database:
  name: psycopg2
  args:
    user: synapse
    password: "MATRIX_POSTGRES_PASSWORD"
    database: synapse
    host: postgres
    cp_min: 5
    cp_max: 10
```

Conserver l'inscription publique désactivée :

```yaml
enable_registration: false
```

L'API Admin Synapse doit être accessible uniquement depuis la fonction serveur
`matrix-session`/`matrix-route` ou un réseau privé. Le reverse proxy public doit
bloquer `/_synapse/admin/`.

## Secrets Supabase

```text
MATRIX_HOMESERVER_URL=https://matrix.example.com
MATRIX_SERVER_NAME=matrix.example.com
MATRIX_ADMIN_ACCESS_TOKEN=<jeton administrateur>
MATRIX_ACCOUNT_DERIVATION_SECRET=<32 octets aléatoires minimum>
```

Puis déployer :

```powershell
supabase functions deploy matrix-session
supabase functions deploy matrix-route
```

Appliquer aussi la migration
`20260728090000_matrix_messaging_bridge.sql`, puis configurer le client :

```text
VITE_MATRIX_ENABLED=true
VITE_MATRIX_HOMESERVER_URL=https://matrix.example.com
VITE_MATRIX_SESSION_FUNCTION=matrix-session
```

