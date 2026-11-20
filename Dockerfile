ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE} AS dependencies
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM dependencies AS source
COPY src ./src
COPY scripts ./scripts
COPY db ./db
COPY panel ./panel
COPY public ./public
COPY portal ./portal
RUN node scripts/prepare-runtime.mjs /runtime

FROM dependencies AS runtime

COPY --from=source /runtime/ ./

ARG SOURCE_REVISION=unrecorded
ARG RELEASE_VERSION=unrecorded
LABEL org.opencontainers.image.revision=$SOURCE_REVISION \
      org.opencontainers.image.version=$RELEASE_VERSION

USER node
EXPOSE 3001

CMD ["npm", "run", "start:api"]

# Target opt-in para validar o mesmo runtime sem incluir testes na release.
FROM runtime AS validation
COPY scripts ./scripts
COPY src/server.js ./src/server.js
COPY db/seeds ./db/seeds
COPY panel/group-notifier-pilot ./panel/group-notifier-pilot
COPY test ./test
COPY infra ./infra
COPY .github ./.github
COPY Dockerfile docker-compose.yml .env.example ./
ENV NODE_ENV=test
CMD ["npm", "test"]

FROM runtime AS release
