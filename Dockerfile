# Imagem pequena (~60 MB). O app não tem dependências npm, então não há etapa de install.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/app/data/app.db \
    TRUST_PROXY=1

WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node scripts ./scripts

# Pasta do banco, gravável pelo usuário sem privilégios. O volume montado aqui herda o dono.
RUN mkdir -p /app/data && chown node:node /app/data
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz > /dev/null || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
