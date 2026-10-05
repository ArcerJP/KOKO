FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 AS build
ENV HUSKY=0
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/image/package.json apps/image/package.json
COPY packages/contract/package.json packages/contract/package.json
RUN npm ci --include=dev --strict-peer-deps --ignore-scripts --no-audit --workspace @koko/image
COPY packages/contract/tsconfig.json packages/contract/tsconfig.json
COPY packages/contract/src packages/contract/src
COPY apps/image/tsconfig.json apps/image/tsconfig.json
COPY apps/image/src apps/image/src
RUN npm run build --workspace @koko/image

FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 AS runtime
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/image/package.json apps/image/package.json
COPY packages/contract/package.json packages/contract/package.json
RUN npm ci --omit=dev --ignore-scripts --strict-peer-deps --no-audit --workspace @koko/image
COPY --from=build /app/packages/contract/dist packages/contract/dist
COPY --from=build /app/apps/image/dist apps/image/dist
USER node
ENTRYPOINT ["node", "apps/image/dist/cli.js"]

FROM runtime AS verification
USER root
# SQL-to-Node acceptance is verification-only; runtime remains production-only.
RUN npm ci --include=dev --include-workspace-root --ignore-scripts --strict-peer-deps --no-audit --workspace @koko/image
COPY apps/image/test apps/image/test
COPY apps/api/supabase/migrations apps/api/supabase/migrations
USER node
WORKDIR /app/apps/image
ENTRYPOINT ["node"]
CMD ["--test", "test/transform.test.mjs", "test/cli.test.mjs", "test/r2.test.mjs", "test/pipeline.test.mjs", "test/db.test.mjs", "test/runner.test.mjs", "test/service-auth.test.mjs", "test/service.test.mjs", "test/moderation.test.mjs", "test/moderation-db.test.mjs", "test/moderation-runner.test.mjs", "test/moderation-frames.test.mjs", "test/evaluation.test.mjs"]

# Explicit private HTTP service target; no deployment or IAM is configured here.
FROM runtime AS service
ENTRYPOINT ["node", "apps/image/dist/service-main.js"]

# Only used to generate our synthetic fixture; never shipped in runtime.
FROM verification AS fixture-generator
USER root
RUN apt-get update && apt-get install -y --no-install-recommends libheif-examples && rm -rf /var/lib/apt/lists/*
USER node
CMD ["test/generate-fixture.mjs", "/fixtures/blocks.heic"]

# The default build is the production CLI, never the fixture toolchain.
FROM runtime AS image
