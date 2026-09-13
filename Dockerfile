FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --chown=node:node admin ./admin
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node src ./src
RUN mkdir -p data sites && chown -R node:node /app

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(Response=>{if(!Response.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/Server.js"]
