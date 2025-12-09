FROM node:18-alpine
WORKDIR /app
COPY tableau-entreprise/frontend/ ./frontend/
RUN cd front && npm install && npm run build
COPY tableau-entreprise/backend/ ./backend/
RUN cd back && npm install
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node", "back/server.js"]