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

FROM --platform=$BUILDPLATFORM golang:1.26.10-trixie@sha256:a050dcceee6eb9bf110151662dfac7662f3bec40927c7dee48731e3d92083d42 AS kubectl
# kubectl: the auth-refresh scheduler drives the chrome-auth browser pods
# through `kubectl port-forward` (WebDriver + noVNC stay loopback-only).
# Built from the v1.37.2 source with golang.org/x/net and golang.org/x/text
# bumped past the upstream pins: the release binary still carries x/net 0.57.0
# and x/text 0.40.0, which Trivy flags as fixable HIGH/CRITICAL. Drop the
# `go get` once upstream ships fixed pins.
ARG TARGETARCH
ARG TARGETVARIANT
ARG KUBECTL_VERSION=v1.37.2
ARG KUBECTL_COMMIT=c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32
RUN git clone --quiet --depth 1 --branch "${KUBECTL_VERSION}" \
      https://github.com/kubernetes/kubernetes /src/kubernetes \
 && test "$(git -C /src/kubernetes rev-parse HEAD)" = "${KUBECTL_COMMIT}"
WORKDIR /src/kubernetes
RUN case "${TARGETARCH}" in \
      amd64|arm64|ppc64le|s390x) goarm= ;; \
      arm) goarm="${TARGETVARIANT#v}"; goarm="${goarm:-7}" ;; \
      *) echo "unsupported kubectl architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && export GOFLAGS=-mod=mod GOWORK=off CGO_ENABLED=0 GOOS=linux GOARCH="${TARGETARCH}" GOARM="${goarm}" \
 && go get golang.org/x/net@v0.62.0 golang.org/x/text@v0.43.0 \
 && v=k8s.io/component-base/version \
 && go build -trimpath \
      -ldflags "-s -w -X ${v}.gitVersion=${KUBECTL_VERSION} -X ${v}.gitMajor=1 -X ${v}.gitMinor=37 -X ${v}.gitTreeState=clean -X ${v}.gitCommit=${KUBECTL_COMMIT}" \
      -o /usr/local/bin/kubectl ./cmd/kubectl

FROM debian:trixie-slim
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
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
