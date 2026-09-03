# AIS console daemon image: one self-contained `ais` binary plus the built
# WebUI, serving both on AIS_WEB_PORT via `ais web --serve-internal`.
FROM oven/bun:1.3 AS server
WORKDIR /build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN bun build --compile src/ais.ts --outfile /out/ais

FROM node:22-bookworm-slim AS web
WORKDIR /build
RUN npm install -g pnpm@10
COPY apps/web/package.json apps/web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY apps/web ./
RUN pnpm build

FROM debian:bookworm-slim
# kubectl: the auth-refresh scheduler drives the chrome-auth browser pods
# through `kubectl port-forward` (WebDriver + noVNC stay loopback-only).
RUN apt-get update \
 && apt-get install -y --no-install-recommends util-linux ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/$(dpkg --print-architecture)/kubectl" \
      -o /usr/local/bin/kubectl \
 && chmod +x /usr/local/bin/kubectl
COPY --from=server /out/ais /usr/local/bin/ais
COPY --from=web /build/dist /web/dist
# resolveInstalledAisBinary() probes $HOME/.local/bin/ais first (background
# sync workers and remote-AIS callers), so give it a real file to find.
RUN useradd --uid 1000 --create-home thomas \
 && mkdir -p /home/thomas/.local/bin /web/state \
 && cp /usr/local/bin/ais /home/thomas/.local/bin/ais \
 && chown -R 1000:1000 /home/thomas /web/state
USER 1000
WORKDIR /home/thomas
ENV HOME=/home/thomas \
    AIS_WEB_HOST=0.0.0.0 \
    AIS_WEB_PORT=47129 \
    AIS_WEB_DIST=/web/dist
EXPOSE 47129
CMD ["ais", "web", "--serve-internal"]
