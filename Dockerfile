# Image of the remote (OAuth) server, published to ghcr.io by .github/workflows/image.yml.
# The build stage compiles a single Linux executable for CPUs without AVX2 (Celeron J3455 of the DS718+…),
# where the regular Bun build crashes; the runtime stage holds only that binary.

FROM oven/bun:1.4.4 AS build
WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src ./src
RUN bun build --compile --minify --target=bun-linux-x64-baseline src/index.ts --outfile /out/synology-mcp

# glibc and CA certificates, no shell. Runs as root inside the container so it can write the bind-mounted
# data folder whatever its owner on the NAS; compose.yml forbids privilege escalation.
FROM gcr.io/distroless/base-debian12
COPY --from=build /out/synology-mcp /app/synology-mcp
WORKDIR /data
ENV SYNO_TRANSPORT=http \
    SYNO_HTTP_HOST=0.0.0.0 \
    SYNO_HTTP_PORT=8080 \
    SYNO_DATA_DIR=/data
EXPOSE 8080
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["/app/synology-mcp", "--healthcheck"]
ENTRYPOINT ["/app/synology-mcp"]
LABEL org.opencontainers.image.source="https://github.com/LeoMartinDev/synology-mcp-server" \
      org.opencontainers.image.description="MCP server to manage a Synology NAS, with OAuth sign-in"
