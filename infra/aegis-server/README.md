# Aegis Server gateway

This stateless gateway gives the ForSure client a stable Aegis HTTP protocol
while the authoritative queue remains in PostgreSQL/Supabase.

It never receives plaintext or private keys. It forwards the caller's Supabase
JWT to the restricted Aegis RPC functions, so `auth.uid()` and all server-side
device checks remain authoritative.

## Start on a VPS

1. Copy `.env.example` to `.env` and set the three values. Keep every allowed
   web/Capacitor origin explicit in `AEGIS_ALLOWED_ORIGINS`.
2. Run `docker compose up -d --build`.
3. Put Caddy or nginx in front of `127.0.0.1:8787`.
4. Expose it only through HTTPS, for example `https://aegis.forsure.social`.
5. Set `VITE_AEGIS_SERVER_URL=https://aegis.forsure.social` in the Vercel build.

Without `VITE_AEGIS_SERVER_URL`, the same client calls Supabase RPC directly.
This makes the VPS migration reversible and requires no ciphertext conversion.

The first VPS version is deliberately stateless. A later migration can move
PostgreSQL and notification workers behind the same three endpoints without
changing the web/mobile client.
