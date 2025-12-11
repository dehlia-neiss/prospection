# Stage 1 : build React
FROM node:18-alpine AS build-frontend

WORKDIR /app

# Frontend
COPY tableau-entreprises/frontend/package*.json ./frontend/
WORKDIR /app/frontend
RUN npm install

COPY tableau-entreprises/frontend/ ./
RUN npm run build

# Stage 2 : backend + React build
FROM node:18-alpine

WORKDIR /app

# Dépendances backend
COPY tableau-entreprises/backend/package*.json ./
RUN npm install

# Copier le backend (dont server.js)
COPY tableau-entreprises/backend/ ./

# Copier le build React dans /app/build
COPY --from=build-frontend /app/frontend/build ./build

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
