# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24-bookworm
ARG DOTNET_IMAGE=mcr.microsoft.com/dotnet/runtime:8.0
ARG BASE_IMAGE=ubuntu:24.04

FROM ${NODE_IMAGE} AS node_runtime
FROM ${DOTNET_IMAGE} AS dotnet_runtime
FROM ${BASE_IMAGE}

ARG DEBIAN_FRONTEND=noninteractive
LABEL org.opencontainers.image.title="TiangZ Linux release builder" \
      org.opencontainers.image.description="Pinned Linux toolchain for repeatable TiangZ Release builds" \
      io.tiangz.role="linux-release-builder"

# Docker Desktop在国内直连Ubuntu官方源容易中途超时，Builder固定使用国内镜像。
# The builder uses a mainland mirror to avoid intermittent archive.ubuntu.com timeouts.
RUN sed -i \
        -e 's|http://archive.ubuntu.com/ubuntu|http://mirrors.aliyun.com/ubuntu|g' \
        -e 's|http://security.ubuntu.com/ubuntu|http://mirrors.aliyun.com/ubuntu|g' \
        /etc/apt/sources.list.d/ubuntu.sources \
    && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 update \
    && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 install -y --no-install-recommends \
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

# Node/npm、.NET Runtime和Rust工具链只在创建或更新builder镜像时安装。
# Node/npm, .NET Runtime, and Rust are installed only when the builder image changes.
COPY --from=node_runtime /usr/local/ /usr/local/
COPY --from=dotnet_runtime /usr/share/dotnet/ /usr/share/dotnet/
RUN ln -s /usr/share/dotnet/dotnet /usr/bin/dotnet

ENV CARGO_HOME=/root/.cargo \
    RUSTUP_HOME=/root/.rustup \
    PATH=/root/.cargo/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin

RUN npm install --global npm@11.18.0 \
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
       | sh -s -- -y --profile minimal --default-toolchain none \
    && rustup toolchain install 1.97.1 --profile minimal --component clippy --component rustfmt \
    && rustup default 1.97.1

WORKDIR /opt/tiangz-deps

# npm依赖和Cargo下载缓存只受依赖清单影响，普通业务代码变化不会重建这些层。
# npm dependencies and Cargo downloads are keyed only by dependency manifests.
COPY package-lock.json ./
RUN node -e "const fs=require('fs');const lock=require('./package-lock.json');const root=lock.packages[''];fs.writeFileSync('package.json',JSON.stringify({name:root.name,private:true,devDependencies:root.devDependencies,engines:root.engines},null,2));" \
    && npm ci

COPY Cargo.toml Cargo.lock rust-toolchain.toml build.rs ./
RUN mkdir -p src \
    && touch src/main.rs src/transport_lib.rs \
    && cargo fetch --locked \
    && rm -rf Cargo.toml Cargo.lock rust-toolchain.toml build.rs src

# Luban CLI固定在工具镜像中；每次发布仍会重新执行Excel生成。
# Luban is pinned in the tool image, while every release still reruns Excel generation.
COPY tools/third_party/luban/4.10.2 /opt/tiangz/luban/4.10.2

RUN node --version \
    && npm --version \
    && rustc --version \
    && cargo --version \
    && dotnet --list-runtimes | grep '^Microsoft.NETCore.App 8\.' \
    && test -f /opt/tiangz/luban/4.10.2/Luban.dll

WORKDIR /workspace
CMD ["bash"]
