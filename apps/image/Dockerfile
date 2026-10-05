FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 AS build
ENV HUSKY=0
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/image/package.json apps/image/package.json
RUN npm ci --include=dev --strict-peer-deps --ignore-scripts --no-audit --workspace @koko/image
COPY apps/image/tsconfig.json apps/image/tsconfig.json
COPY apps/image/src apps/image/src
RUN npm run build --workspace @koko/image

FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 AS runtime
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/image/package.json apps/image/package.json
RUN npm ci --omit=dev --ignore-scripts --strict-peer-deps --no-audit --workspace @koko/image
COPY --from=build /app/apps/image/dist apps/image/dist
USER node
ENTRYPOINT ["node", "apps/image/dist/cli.js"]

FROM runtime AS verification
COPY apps/image/test apps/image/test
WORKDIR /app/apps/image
ENTRYPOINT ["node"]
CMD ["--test", "test/transform.test.mjs", "test/cli.test.mjs"]

# Only used to generate our synthetic fixture; never shipped in runtime.
FROM verification AS fixture-generator
USER root
RUN apt-get update && apt-get install -y --no-install-recommends libheif-examples && rm -rf /var/lib/apt/lists/*
USER node
CMD ["test/generate-fixture.mjs", "/fixtures/blocks.heic"]

# The default build is the production CLI, never the fixture toolchain.
FROM runtime AS image
