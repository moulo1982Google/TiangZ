# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24-bookworm
ARG BASE_IMAGE=ubuntu:24.04
FROM ${NODE_IMAGE} AS node_runtime
FROM mcr.microsoft.com/dotnet/runtime:8.0 AS dotnet_runtime

FROM ${BASE_IMAGE}

ARG DEBIAN_FRONTEND=noninteractive
ARG TIANGZ_DISTRO=linux

LABEL org.opencontainers.image.title="TiangZ Linux smoke environment" \
      org.opencontainers.image.description="Reproducible TypeScript and Rust build environment for TiangZ" \
      io.tiangz.validation="linux-smoke" \
      io.tiangz.distro="${TIANGZ_DISTRO}"

RUN apt-get -o Acquire::Retries=3 update \
    && apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        clang \
        cmake \
        curl \
        git \
        libclang-dev \
        ninja-build \
        pkg-config \
        python3 \
        unzip \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Node 官方镜像提供固定主版本；复制运行时可让 Ubuntu 与 Debian 使用同一套 Node/npm。
COPY --from=node_runtime /usr/local/ /usr/local/
# Luban 4.10.2 以 net8.0 发布；复制官方 Runtime，避免在构建机安装完整 SDK。
COPY --from=dotnet_runtime /usr/share/dotnet/ /usr/share/dotnet/
# 保留 dotnet 的真实安装路径；直接 COPY /usr/bin/dotnet 会把符号链接展开，导致 host/fxr 查找路径错误。
RUN ln -s /usr/share/dotnet/dotnet /usr/bin/dotnet

ENV CARGO_HOME=/root/.cargo \
    RUSTUP_HOME=/root/.rustup \
    PATH=/root/.cargo/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin

RUN npm install --global npm@11.18.0 \
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
       | sh -s -- -y --profile minimal --default-toolchain none

WORKDIR /workspace

# 依赖清单单独成层，业务源码变化时不会重复安装 npm 与 Cargo 依赖。
COPY package.json package-lock.json Cargo.toml Cargo.lock rust-toolchain.toml build.rs ./
COPY src ./src
RUN npm ci \
    && rustup toolchain install 1.97.1 --profile minimal --component clippy --component rustfmt \
    && rustup default 1.97.1 \
    && cargo fetch --locked

COPY . .

CMD ["node", "tools/docker/linux-smoke/run_inside.mjs"]
