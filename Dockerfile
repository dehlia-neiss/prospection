FROM node:18-alpine
WORKDIR /app
COPY tableau-entreprise/front/ ./front/
RUN cd front && npm install && npm run build
COPY tableau-entreprise/back/ ./back/
RUN cd back && npm install
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node", "back/server.js"]