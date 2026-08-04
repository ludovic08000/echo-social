# Aegis gateway test client

`smoke-client.mjs` exercises the public Aegis HTTP boundary with correlated,
redacted JSON-line logs. It is intentionally independent from the Echo Social
browser bundle so the gateway can be diagnosed even when the application UI is
not available.

## Safety rules

The client and gateway logs never print:

- Supabase access tokens or Authorization headers;
- ciphertext, plaintext or attachment contents;
- message, user or DeviceID values;
- request or response bodies.

Logs contain only endpoint names, HTTP status, duration, payload byte count,
response shape, field names, item counts and error codes. A raw response can be
written locally with `--capture-file`; the client requests mode `0600` and never
stores the JWT.

Do not commit `.env.test`, captured responses, access tokens or real send
payloads.

## Automated contract tests

From `infra/aegis-server`:

```sh
npm test
```

The dependency-free Node test suite starts the gateway on an ephemeral port and
covers:

- health and request-ID correlation;
- Bearer authentication enforcement;
- CORS rejection;
- invalid JSON as HTTP 400;
- body-size rejection as HTTP 413;
- exact RPC forwarding to Supabase;
- PostgreSQL error propagation;
- upstream timeout as HTTP 504;
- log redaction for JWT, DeviceID and ciphertext values;
- the smoke client's unauthenticated baseline scenario.

The same suite runs in `.github/workflows/aegis-gateway.yml`.

## Start the gateway locally

Create a local server environment file from `.env.example`, then export it
before starting Node:

```sh
cd infra/aegis-server
cp .env.example .env
set -a
. ./.env
set +a
npm start
```

The server emits one structured `server_started` record, then one
`request_complete` record per request. Every record contains a `request_id`
that can be matched with the smoke-client log.

## Configure the smoke client

Copy the client template and fill only local values:

```sh
cp .env.test.example .env.test
set -a
. ./.env.test
set +a
```

`AEGIS_ACCESS_TOKEN` must be a short-lived access token for a real authenticated
Echo Social user. `AEGIS_DEVICE_ID` must be an active, non-revoked and routable
device owned by that same user. Never use or expose a service-role key.

## Baseline scenario

Without credentials, this validates health and confirms that an anonymous sync
is rejected with HTTP 401:

```sh
npm run smoke -- scenario
```

With `AEGIS_ACCESS_TOKEN` and `AEGIS_DEVICE_ID`, the same command also performs
a bounded authenticated sync:

```sh
npm run smoke -- scenario --limit 25
```

## Individual probes

Health:

```sh
npm run smoke -- health --base-url http://127.0.0.1:8787
```

Sync:

```sh
npm run smoke -- sync --limit 25
```

ACK one or more messages after the test consumer has durably stored and
validated their ciphertext:

```sh
npm run smoke -- ack \
  --message-id 00000000-0000-0000-0000-000000000000 \
  --mark-read
```

Send requires a complete JSON payload matching `aegis_send_message`. The client
does not invent keys, route versions or capsules:

```sh
npm run smoke -- send --payload-file ./send-payload.local.json
```

Run several operations in one scenario by setting `AEGIS_ACK_MESSAGE_IDS` and/or
`AEGIS_TEST_PAYLOAD_FILE`. Sending and ACKing are never enabled implicitly.

## Capturing a response for diagnosis

Normal logs expose shape only. To inspect the encrypted response locally:

```sh
npm run smoke -- sync --capture-file ./aegis-sync-capture.local.json
```

Delete the capture after diagnosis. It can contain ciphertext and identifiers,
even though it does not contain the access token.

## Reading the logs

Gateway example:

```json
{"event":"request_complete","request_id":"...","rpc":"aegis_sync_device","status":200,"upstream_status":200,"duration_ms":18.4,"body_bytes":52,"origin_allowed":true,"error_code":null}
```

Client example:

```json
{"event":"probe_succeeded","request_id":"...","status":200,"duration_ms":24.1,"type":"array","count":5,"fields":["copy_id","encrypted_body","message_id"]}
```

Use the shared `request_id` to correlate the client, gateway and reverse-proxy
records. A failing probe exits non-zero, making the client suitable for CI,
deployment checks and VPS monitoring.
