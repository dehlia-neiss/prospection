# Stage 1
FROM node:18-alpine AS build-frontend
WORKDIR /app
COPY tableau-entreprises/frontend/package*.json ./frontend/
WORKDIR /app/frontend
RUN npm install
COPY tableau-entreprises/frontend/ ./
RUN npm run build

# Stage 2
FROM node:18-alpine
WORKDIR /app
COPY tableau-entreprises/backend/package*.json ./
RUN npm install
COPY tableau-entreprises/backend/ ./
COPY --from=build-frontend /app/frontend/build ./build
CMD ["node", "server.js"]
