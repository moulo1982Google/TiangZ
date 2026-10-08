FROM node:24.20.0-bookworm-slim AS node_runtime
FROM rust:1.97.1-slim
LABEL tiangz.codex.task="v07-linux-native-validation"
RUN apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 update -qq \
    && apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 install -y -qq --no-install-recommends g++ pkg-config python3 curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node_runtime /usr/local/bin/node /usr/local/bin/node
RUN rustup component add --toolchain 1.97.1-x86_64-unknown-linux-gnu clippy rustfmt
WORKDIR /work
