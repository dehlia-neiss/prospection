# Stage 1 : build React
FROM node:18-alpine AS build-frontend

WORKDIR /app

# Installer les deps du frontend
COPY tableau-entreprises/frontend/package*.json ./frontend/
WORKDIR /app/frontend
RUN npm install

COPY tableau-entreprises/frontend/ ./
RUN npm run build

# Stage 2 : backend Node + build React
FROM node:18-alpine

WORKDIR /app

# Dépendances backend
COPY package*.json ./
RUN npm install

# Code backend (inclut server.js, etc.)
COPY . .

# Copier le build React à l'endroit attendu par server.js (./build)
COPY --from=build-frontend /app/frontend/build ./build

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
