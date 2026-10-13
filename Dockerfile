# OpenCode Zen free-tier proxy.
#
# Zero npm runtime deps for the proxy itself, BUT the fingerprint capture in
# src/fingerprint.js spawns the REAL `opencode` CLI to obtain a valid
# x-opencode-session id (the free-tier gateway validates its structure/checksum
# and it cannot be faked). So `opencode` must be installed in the image, and the
# TLS-interception CA it uses is minted with `openssl`.
#
# IMPORTANT — base image / libc:
#   `opencode` ships as a Bun-compiled native ELF that links against GLIBC
#   (libc.so.6, libpthread, libdl, libm). Alpine (musl) cannot run it without a
#   fragile gcompat shim, so we use the Debian (glibc) Node image, not -alpine.
#
# Node >= 24 is REQUIRED: the built-in global `fetch` only honors the
# `https_proxy`/`HTTPS_PROXY` env vars (via `NODE_USE_ENV_PROXY=1`) starting in
# Node v24.0.0. See README "Outbound proxy".
#
# Override the base image at build time if you mirror it, e.g.:
#   docker build --build-arg NODE_IMAGE=registry.cn-hangzhou.aliyuncs.com/jcleng/library-node:24 .
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS base

WORKDIR /app

# ca-certificates : outbound HTTPS to opencode.ai/zen/v1
# openssl         : mint the throwaway MITM CA used by src/fingerprint.js
# curl            : handy for health checks / debugging from inside the container
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl curl \
  && rm -rf /var/lib/apt/lists/*

# Install the real opencode CLI (provides the `opencode` binary on PATH).
# Pinned to a known-good version; bump deliberately if the upstream free-tier
# gate changes. The fingerprint is captured from whatever version is present, so
# a newer compatible release also works — just re-pin and rebuild.
# Override at build time with: docker build --build-arg OPENCODE_VERSION=2.0.27 .
ARG OPENCODE_VERSION=2.0.22
RUN npm install -g --no-audit --no-fund "@opencode/cli@${OPENCODE_VERSION}" \
  && opencode --version

# Copy project (respects .dockerignore). node_modules is excluded.
COPY . .

# The proxy listens on 127.0.0.1 by default; in a container bind 0.0.0.0 so the
# host/compose port mapping reaches it. Override HOST/PORT at runtime as needed.
ENV HOST=0.0.0.0
ENV PORT=8791

# OPENCODE_FP_DISABLE=1 would force the static fallback fingerprint (no opencode
# spawn). Left unset so we capture a real, valid fingerprint from the CLI above.
EXPOSE 8791

# `node server.js` auto-listens because it is executed directly (import.meta.url).
CMD ["node", "server.js"]
