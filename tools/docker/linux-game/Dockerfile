FROM node:24.20.0-bookworm-slim AS node_runtime
FROM mcr.microsoft.com/dotnet/runtime:8.0-bookworm-slim AS dotnet_runtime
FROM tiangz-v07-native-validation:20260926
LABEL tiangz.codex.task="v07-linux-game-validation"
COPY --from=node_runtime /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
COPY --from=dotnet_runtime /usr/share/dotnet /usr/share/dotnet
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && ln -s /usr/share/dotnet/dotnet /usr/local/bin/dotnet \
    && apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 update -qq \
    && apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 install -y -qq --no-install-recommends git libicu-dev \
    && rm -rf /var/lib/apt/lists/* \
    && node --version && npm --version && dotnet --list-runtimes
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1
WORKDIR /work
