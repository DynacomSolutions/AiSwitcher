# AIS console daemon image: one self-contained `ais` binary plus the built
# WebUI, serving both on AIS_WEB_PORT via `ais web --serve-internal`.
# Bun version comes from .bun-version via the BUN_VERSION build arg (no default,
# so a missing arg fails the build). COPY --from cannot take a variable, hence the stage.
ARG BUN_VERSION
FROM oven/bun:${BUN_VERSION} AS bun-bin

FROM oven/bun:${BUN_VERSION} AS server
WORKDIR /build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY mods ./mods
COPY scripts ./scripts
RUN bun build --compile src/ais.ts --outfile /out/ais

FROM node:22-bookworm-slim AS web
WORKDIR /build
RUN npm install -g pnpm@10
COPY apps/web/package.json apps/web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY apps/web ./
RUN pnpm build

FROM debian:trixie-slim AS kubectl
# kubectl: the auth-refresh scheduler drives the chrome-auth browser pods
# through `kubectl port-forward` (WebDriver + noVNC stay loopback-only).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && case "$(dpkg --print-architecture)" in \
      amd64) kubectl_arch=amd64; kubectl_sha256=65691ff77eb6fa44c908b77a1082c9f092c3b9733b5cefabec0d1104890e21a8 ;; \
      arm64) kubectl_arch=arm64; kubectl_sha256=ff749f4b78d9c4f1ec87307df9b50119ed819e2094aa9810cb9acffc3286c8c7 ;; \
      armhf) kubectl_arch=arm; kubectl_sha256=8af0113a5b03b13b923f530bc4177479799dee2a0c188d15bef0ebef5d0c6d75 ;; \
      ppc64el) kubectl_arch=ppc64le; kubectl_sha256=50a33e7a7f0d1125099abbdba3c010a3cb497142f58ed8ea198949f738e79b82 ;; \
      s390x) kubectl_arch=s390x; kubectl_sha256=222798cd808e287cccd427718f9d76f7b3bff4e8601dca96b8bf5c371d3b59f6 ;; \
      *) echo "unsupported kubectl architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac \
 && curl -fsSL "https://dl.k8s.io/release/v1.37.1/bin/linux/${kubectl_arch}/kubectl" \
      -o /usr/local/bin/kubectl \
 && printf '%s  %s\n' "$kubectl_sha256" /usr/local/bin/kubectl | sha256sum -c - \
 && chmod +x /usr/local/bin/kubectl

FROM debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends util-linux ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=kubectl /usr/local/bin/kubectl /usr/local/bin/kubectl
COPY --from=server /out/ais /usr/local/bin/ais
# bun/bunx: the usage pipeline shells out to `bunx tokscale` to refresh its
# cache; the compiled ais binary cannot serve as a bunx entrypoint.
COPY --from=bun-bin /usr/local/bin/bun /usr/local/bin/bun
COPY --from=bun-bin /usr/local/bin/bunx /usr/local/bin/bunx
COPY --from=web /build/dist /web/dist
# resolveInstalledAisBinary() probes $HOME/.local/bin/ais first (background
# sync workers and remote-AIS callers), so give it a real file to find.
RUN useradd --uid 1000 --create-home ais \
 && mkdir -p /home/ais/.local/bin /web/state \
 && cp /usr/local/bin/ais /home/ais/.local/bin/ais \
 && chown -R 1000:1000 /home/ais /web/state
USER 1000
WORKDIR /home/ais
ENV HOME=/home/ais \
    AIS_WEB_HOST=0.0.0.0 \
    AIS_WEB_PORT=47129 \
    AIS_WEB_DIST=/web/dist
EXPOSE 47129
CMD ["ais", "web", "--serve-internal"]
