# Stage 1 : build frontend
FROM node:18-alpine AS build-frontend

WORKDIR /app

COPY tableau-entreprises/frontend/package*.json ./frontend/
WORKDIR /app/frontend
RUN npm install

COPY tableau-entreprises/frontend/ ./
RUN npm run build

# Stage 2 : backend + build
FROM node:18-alpine

WORKDIR /app

# Backend deps
COPY package*.json ./
RUN npm install

# Code backend
COPY . .

# Copier le build React là où server.js l’attend
COPY --from=build-frontend /app/frontend/build ./build

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
