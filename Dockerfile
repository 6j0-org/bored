# Bored? server: Node (>= 24, for the built-in node:sqlite), the app's own files, and the npm packages in
# package.json (installed at build time from the lock file; nothing is fetched while the app runs).
# demo.js is in, for DEMO=1, which keeps everything in memory and ignores DB_PATH, so demo data never lands in a
# real database.
FROM node:24-alpine

WORKDIR /app
COPY package.json package-lock.json .npmrc ./
# git only while installing: @devopscoop/eat-the-pii comes from its git URL until it's published to npm.
RUN apk add --no-cache --virtual .install-deps git \
 && npm ci --omit=dev --ignore-scripts \
 && apk del .install-deps
COPY server.js db.js demo.js push.js webauthn.js idtoken.js ./
COPY public ./public

# The SQLite database (accounts, posts, encrypted vaults, and chats) lives here; mount a volume to keep it.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

# Set ORIGIN (e.g. https://bored.example) when serving over HTTPS: passkeys are bound to it, and it turns on
# Secure cookies. RP_ID defaults to the ORIGIN hostname.
ENV PORT=3000 DB_PATH=/data/data.sqlite
EXPOSE 3000
USER node
CMD ["node", "server.js"]
