# Plain Alpine + the nodejs package, rather than node:22-alpine — same Node 22,
# roughly half the image size, since we need no npm or toolchain at runtime.
FROM alpine:3.22

RUN apk add --no-cache nodejs

ENV NODE_ENV=production

# Bind all interfaces *inside* the container — 127.0.0.1 would be unreachable
# from the host. Control real exposure with the published port instead, e.g.
# -p 127.0.0.1:8123:8123 to keep it loopback-only on the host.
ENV HOST=0.0.0.0
ENV PORT=8123

WORKDIR /app

# No dependency install step: the proxy is Node stdlib only, so there is no
# package-lock.json and nothing for npm to fetch.
COPY package.json server.js ./

USER nobody
EXPOSE 8123

CMD ["node", "server.js"]
