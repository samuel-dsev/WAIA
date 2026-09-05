FROM node:22-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts
COPY db ./db
COPY panel ./panel
COPY public ./public

USER node
EXPOSE 3001

CMD ["npm", "run", "start:api"]
