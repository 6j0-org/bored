# Bored? server. No npm packages: just Node (>= 24, for the built-in node:sqlite) and the app's own files.
# seed.js is left out on purpose: demo data must never land in a real database.
FROM node:24-alpine

WORKDIR /app
COPY package.json server.js db.js webauthn.js ./
COPY public ./public

# The SQLite database (accounts, posts, encrypted vaults and chats) lives here; mount a volume to keep it.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

# Set ORIGIN (e.g. https://bored.example) when serving over HTTPS: passkeys are bound to it, and it turns on
# Secure cookies. RP_ID defaults to the ORIGIN hostname.
ENV PORT=3000 DB_PATH=/data/data.sqlite
EXPOSE 3000
USER node
CMD ["node", "server.js"]
