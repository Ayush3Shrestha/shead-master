FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production PORT=3001 DATA_FILE=/app/data/db.json
EXPOSE 3001
VOLUME ["/app/data"]
CMD ["npm", "start"]
