FROM node:22-alpine
WORKDIR /app
COPY index.js .
ENV NODE_OPTIONS="--max-old-space-size=128"
CMD ["node", "index.js"]
