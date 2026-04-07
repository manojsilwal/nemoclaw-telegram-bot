# syntax=docker/dockerfile:1.7
# Minimal OpenClaw image — browser disabled, no Chromium/xvfb installed.
# Saves ~400MB image size and eliminates Playwright startup overhead.
FROM ghcr.io/openclaw/openclaw:latest

USER root

COPY config/openclaw.json /opt/openclaw/openclaw.json
COPY skills /opt/openclaw/skills
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh \
  && chown root:root /usr/local/bin/docker-entrypoint.sh

USER node
WORKDIR /app

HEALTHCHECK --interval=3m --timeout=10s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
