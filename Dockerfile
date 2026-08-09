# Dependencies are installed in a throwaway stage so npm and its cache never
# reach the runtime image.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Plain Alpine + the nodejs package, rather than node:22-alpine — same Node 22,
# roughly half the size, since nothing at runtime needs npm or a toolchain.
FROM alpine:3.22

RUN apk add --no-cache nodejs

ENV NODE_ENV=production

# Bind all interfaces *inside* the container — 127.0.0.1 would be unreachable
# from the host. Control real exposure with the published port instead, e.g.
# -p 127.0.0.1:8123:8123 to keep it loopback-only on the host.
ENV HOST=0.0.0.0
ENV PORT=8123

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js mqtt-publisher.js ./

USER nobody
EXPOSE 8123

CMD ["node", "server.js"]
