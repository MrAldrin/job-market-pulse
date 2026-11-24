# Build from the repository root. No credentials or snapshot are baked into the image.
FROM oven/bun:1.4.4 AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
# prepare needs the application files, so run it later as part of the build.
RUN bun install --frozen-lockfile --ignore-scripts

FROM dependencies AS build
COPY vite.config.ts tsconfig.json ./
COPY src/ ./src/
COPY static/.gitkeep ./static/.gitkeep
# Vite bundles these checked-in public parser tables into server code.
COPY resources/html/entities.json ./resources/html/
COPY resources/profile/neutral-screen-source.json \
     resources/profile/python-re-extra-cases-3.13.11.json \
     resources/profile/unicode-assigned-15.1.json \
     resources/profile/unicode-casefold-15.1.json \
     resources/profile/unicode-properties-15.1.json \
     resources/profile/unicode-rejected-text-15.1.json \
     resources/profile/unicode-simple-lower-15.1.json ./resources/profile/
RUN bun run build

FROM oven/bun:1.4.4 AS production-dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM oven/bun:1.4.4 AS runtime
WORKDIR /app
RUN mkdir -p /data && chown 10001:10001 /data
# Only the adapter output and production dependencies enter the runtime image.
COPY --from=build /app/build/ ./build/
COPY --from=production-dependencies /app/node_modules/ ./node_modules/
COPY --from=build /app/package.json ./package.json
ENV NODE_ENV=production \
    PULSE_DASHBOARD_MODE=railway \
    PULSE_DATA_DIR=/data \
    HOST=0.0.0.0
USER 10001:10001
CMD ["bun", "build/index.js"]
