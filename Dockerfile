FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY bot.js ./

RUN mkdir -p /data

VOLUME ["/data"]

ENV DB_PATH=/data/debts.db

CMD ["node", "bot.js"]
