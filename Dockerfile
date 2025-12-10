FROM alpine:latest
WORKDIR /app

# Copier tout
COPY . .

# Voir ce qu'on a
RUN echo "=== STRUCTURE COMPLÈTE ==="
RUN ls -la
RUN echo "=== RECHERCHE tableau-entreprises ==="
RUN find . -name "*tableau*" -type d
RUN echo "=== CONTENU ==="
RUN find . -type f -name "*.js" -o -name "*.json" | head -30

CMD ["sleep", "3600"]
