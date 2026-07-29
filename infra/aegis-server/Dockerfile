FROM node:22.17.0-alpine

WORKDIR /app
COPY server.mjs /app/server.mjs

ENV NODE_ENV=production
EXPOSE 8787
USER node

CMD ["node", "/app/server.mjs"]
