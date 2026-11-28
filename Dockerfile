# Bored server: Node (>= 24, for the built-in node:sqlite), the app's own files, and the npm packages in
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
COPY server.js db.js demo.js push.js idtoken.js feedback.js ./
COPY public ./public

# The SQLite database (accounts, posts, encrypted vaults, and chats) and feedback.jsonl live here; mount a volume to
# keep them.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

# Set ID_ORIGIN (the 6j0.org identity server, e.g. https://id.6j0.org), or DEMO=1. Set ORIGIN (e.g.
# https://bored.example) when serving over HTTPS: links in notifications use it, and it turns on Secure cookies.
ENV PORT=3000 DB_PATH=/data/data.sqlite
EXPOSE 3000
USER node
CMD ["node", "server.js"]
