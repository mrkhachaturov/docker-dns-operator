# Get node image needed for development & building
# Pinned by digest so Scorecard's PinnedDependencies check passes and
# Dependabot's `docker` ecosystem (see .github/dependabot.yml) keeps it
# fresh on the lts-alpine tag.
FROM node:lts-alpine@sha256:2bdb65ed1dab192432bc31c95f94155ca5ad7fc1392fb7eb7526ab682fa5bf14 AS base

# Install
FROM base AS install
WORKDIR /app
COPY ["package.json", "yarn.lock", "/app/"]
RUN yarn install && \
  yarn cache clean
COPY . .

# Executed to run tests in the container
FROM install AS tests
RUN apk update && apk add docker-cli && apk add acl
RUN yarn run test:ci
RUN setfacl -R -m u:node:rwx reports
USER node
CMD ["yarn", "run", "test:e2e:ci"]

# Build
FROM install AS build
RUN yarn run build
WORKDIR /app/dist
COPY ["package.json", "yarn.lock", "./"]
RUN yarn install --production

FROM scratch AS build-results
WORKDIR /
COPY --from=build /app/dist .

# Production
FROM base AS production
COPY --from=build-results . /home/node/app
WORKDIR /home/node/app
ENV NODE_ENV=production
# Liveness endpoint served on HEALTH_PORT (default 9090, same as sidecars).
# 200 = HTTP server up and event loop responding. Provider/sidecar failures
# are surfaced through logs, not through this probe.
EXPOSE 9090
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD wget -q --spider "http://127.0.0.1:${HEALTH_PORT:-9090}/healthz" || exit 1
ENTRYPOINT ["node", "main.js"]