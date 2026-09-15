FROM node:22.17.0-alpine

WORKDIR /app
COPY infra/aegis-server/server.mjs /app/infra/aegis-server/server.mjs
COPY supabase/functions/_shared/aegisDiagnostics.mjs /app/supabase/functions/_shared/aegisDiagnostics.mjs

ENV NODE_ENV=production
EXPOSE 8787
USER node

CMD ["node", "/app/infra/aegis-server/server.mjs"]
