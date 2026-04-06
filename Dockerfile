# syntax=docker/dockerfile:1.7
# Extends the official OpenClaw image: https://github.com/openclaw/openclaw/pkgs/container/openclaw
# Pre-installs Chromium + deps for the bundled browser tool (browser-heavy workflows on Render).
FROM ghcr.io/openclaw/openclaw:latest

USER root

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /home/node/.cache/ms-playwright \
  && PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright \
  node /app/node_modules/playwright-core/cli.js install --with-deps chromium \
  && chown -R node:node /home/node/.cache/ms-playwright

COPY config/openclaw.json /opt/openclaw/openclaw.json
COPY strategies/skills /opt/openclaw/skills
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh \
  && chown root:root /usr/local/bin/docker-entrypoint.sh

USER node
WORKDIR /app

# Blueprint uses OPENCLAW_GATEWAY_PORT=8080; base image HEALTHCHECK still probes 18789.
HEALTHCHECK --interval=3m --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
