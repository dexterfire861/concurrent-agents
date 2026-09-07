# A long-lived container: a run spawns a child process and streams for its duration.
FROM node:22-slim

# Run unprivileged. node:22-slim already ships a `node` user at uid 1000, which is
# also the uid managed hosts expect, so reuse it instead of adding a second account.
ENV HOME=/home/node
RUN mkdir -p $HOME/app && chown node:node $HOME/app
USER node
WORKDIR $HOME/app

# Dependencies first so a source edit does not reinstall them.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

# tsx runs the TypeScript directly, so the sources are the build output.
COPY --chown=node:node src ./src
COPY --chown=node:node configs ./configs
COPY --chown=node:node public ./public
COPY --chown=node:node tsconfig.json ./

# 0.0.0.0 so the host's proxy can reach us. PORT is a default: hosts that inject
# their own PORT at runtime override it, which is what the server reads.
ENV HOST=0.0.0.0 \
    PORT=7860 \
    NODE_ENV=production
EXPOSE 7860

CMD ["npm", "start"]
