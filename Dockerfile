# Étape 1: Build du frontend
FROM node:18 AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci --only=production
COPY frontend/ .
RUN npm run build

# Étape 2: Backend avec les fichiers buildés
FROM node:18
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci --only=production
COPY backend/ .
# Copier les fichiers buildés du frontend
COPY --from=frontend-builder /app/frontend/build ./public
EXPOSE 3000
CMD ["node", "server.js"]