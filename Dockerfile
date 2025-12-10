# Stage 1 : build React
FROM node:18-alpine AS build
WORKDIR /app

# Copier le package.json du frontend
COPY tableau-entreprises/frontend/package*.json ./frontend/
WORKDIR /app/frontend
RUN npm install

# Copier le reste du frontend et builder
COPY tableau-entreprises/frontend/ ./
RUN npm run build

# Stage 2 : image finale légère qui sert le build
FROM node:18-alpine
WORKDIR /app
RUN npm install -g serve

# Copier le build généré
COPY --from=build /app/frontend/build ./build

# Cloud Run écoute sur 8080
CMD ["serve", "-s", "build", "-l", "8080"]
