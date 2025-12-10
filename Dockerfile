# Stage 1 : build React
FROM node:18-alpine AS build-frontend

WORKDIR /app

# Copier les fichiers de dépendances du frontend
COPY tableau-entreprises/frontend/package*.json ./frontend/
WORKDIR /app/frontend
RUN npm install

# Copier le reste du frontend et builder
COPY tableau-entreprises/frontend/ ./
RUN npm run build

# Stage 2 : backend Node + build frontend
FROM node:18-alpine

WORKDIR /app

# Dépendances backend
COPY package*.json ./
RUN npm install

# Copier le backend
COPY . .

# Copier le build React dans le backend (adapter le chemin si besoin)
# Exemple : si ton serveur Express sert ./build en statique :
COPY --from=build-frontend /app/frontend/build ./build

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
