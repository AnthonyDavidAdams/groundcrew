# Ground Crew reference server. Ground Crew is part of EarthPilot: mission support for Spaceship Earth.
#
#   docker build -t groundcrew .
#   docker run --rm -p 3000:3000 -v $PWD/my-crew:/crew -v groundcrew-state:/state \
#     -e GROUNDCREW_MAINTAINER_TOKEN=<secret> groundcrew
#   curl localhost:3000/healthz
#
# The crew directory is mounted (or COPYed by a derived image) at /crew; state lives at /state/state.json.
FROM node:22-alpine
ENV NODE_ENV=production PORT=3000 GROUNDCREW_CREW=/crew GROUNDCREW_STATE=/state/state.json
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY bin ./bin
COPY server ./server
COPY schemas ./schemas
COPY templates ./templates
RUN mkdir -p /crew /state
VOLUME ["/crew", "/state"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
CMD ["node", "server/index.mjs", "--http"]
