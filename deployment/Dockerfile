# Reconstructed verified Dockerfile from the PLD field deployment.
FROM rust:1-bookworm AS prolog-builder
RUN cargo install --locked scryer-prolog --version 0.10.0

FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       libssl3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=prolog-builder /usr/local/cargo/bin/scryer-prolog /usr/local/bin/scryer-prolog
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm install --global supergateway@4.2.1
COPY index.mjs engine.mjs ./
ENV NODE_ENV=production
ENV SCRYER_PROLOG=/usr/local/bin/scryer-prolog
ENV SCRYER_SESSIONS=/sessions
RUN mkdir -p /sessions && chown node:node /sessions
USER node
EXPOSE 8000
CMD ["supergateway", "--stdio", "node /app/index.mjs", "--outputTransport", "streamableHttp", "--stateful", "--port", "8000", "--healthEndpoint", "/healthz"]
