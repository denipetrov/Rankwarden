# syntax=docker/dockerfile:1.7

# One Node version for the image and for CI, so what is tested is what runs.
ARG NODE_VERSION=24

# ---------------------------------------------------------------------- deps
# Every dependency, development ones included: the build needs the Nest CLI
# and the compiler. Also the stage CI runs the test suites in.
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json .npmrc ./

# `@denipetrov/blizz-auth` is a private GitHub package. The token arrives as a
# build secret, is handed to npm through the environment of this one command,
# and is never written to a file — so it is in no layer of any stage, the cache
# included. Build with:
#   docker build --secret id=npm_token,env=NPM_TOKEN .
#
# `extra_ca` is optional, and only for building behind something that re-signs
# HTTPS: a corporate proxy, or an antivirus that scans TLS. Without its root
# certificate npm rejects every download. CI does not need it.
#   docker build --secret id=npm_token,env=NPM_TOKEN --secret id=extra_ca,src=ca.pem .
RUN --mount=type=secret,id=npm_token,required=true \
    --mount=type=secret,id=extra_ca \
    --mount=type=cache,target=/root/.npm \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    env "NPM_CONFIG_//npm.pkg.github.com/:_authToken=$(cat /run/secrets/npm_token)" \
    npm ci

# --------------------------------------------------------------------- build
FROM deps AS build

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src

# Compile, then drop the development dependencies in place: one install, and
# the production tree is exactly the one the build was resolved against.
RUN npm run build && npm prune --omit=dev

# ------------------------------------------------------------------- runtime
FROM node:${NODE_VERSION}-alpine AS runtime

# NO_COLOR keeps Nest's logger from writing terminal colour codes into logs
# that are read through `kubectl logs` or a collector.
ENV NODE_ENV=production \
    NO_COLOR=1

WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# `"type": "module"` lives here; without it Node would load dist/ as CommonJS.
COPY --chown=node:node package.json ./

USER node
EXPOSE 3000

# The same image runs the schema step and the config check:
#   node dist/schema.main.js
#   node dist/config-check.main.js
CMD ["node", "dist/main.js"]
