FROM node:18-alpine
WORKDIR /app

# FRONTEND
COPY tableau-entreprises/frontend/ ./frontend/
RUN cd frontend && npm install && npm run build

# BACKEND
COPY tableau-entreprises/backend/ ./backend/
RUN cd backend && npm install

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# MODIFIEZ CETTE LIGNE SI NÉCESSAIRE
CMD ["node", "backend/server.js"]
