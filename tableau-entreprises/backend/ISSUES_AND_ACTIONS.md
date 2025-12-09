Résumé des erreurs observées
- 401 Unauthorized chez Pappers quand PAPPERS_API_KEY était undefined -> .env non chargé correctement.
- CORS errors côté navigateur : "CORS request did not succeed" -> backend mal configuré ou serveur pas démarré sur le port attendu.
- 404 Cannot POST /prospect -> endpoint /prospect manquant ou mal déclaré.
- FullEnrich renvoie 400 {"code":"error.enrichment.enrich_fields.empty","message":"EnrichFields cannot be empty"} -> l'API FullEnrich utilisée par ton script rejette le champ enrich_fields ou le format attendu diffère. Puis réponses 404 « Unknown api path » pour certains endpoints testés.
- Frontend JSON.parse errors -> backend renvoie HTML d'erreur (404/500) ou réponse non-JSON.

Points critiques à corriger
1) Dépendances & structure
   - Créer deux package.json séparés :
     - /frontend/package.json : react, react-dom, react-scripts (ou Vite), etc.
     - /backend/package.json : express, cors, dotenv (si utilisé), node-fetch (si Node <18).
   - Commandes rapides :
     - cd backend && npm init -y && npm install express cors dotenv
     - cd frontend && npx create-react-app .  OR npm init vite@latest

2) .env et sécurité
   - Ne pas committer .env avec API keys.
   - Vérifier que backend charge .env du bon dossier (on charge ../.env actuellement).
   - Ajouter un check au démarrage pour refuser de lancer si les clés obligatoires manquent (log clair).

3) FullEnrich
   - Contacter la doc API FullEnrich / vérifier la version : endpoint exact et nom du champ attendu pour les fields.
   - Tests manuels via curl avec la clé pour vérifier le comportement (body minimal) et récupérer l'exemple de payload accepté.
   - Si la version de l'API ne supporte pas le bulk, utiliser l'endpoint single correct ou adapter le payload.

4) CORS / ports
   - Backend doit exposer CORS origin: http://localhost:3000 (ou '*') pendant dev.
   - S'assurer que frontend fetch cible le bon port (5000 ou 3000 selon config).

5) Robustesse
   - Toujours renvoyer Content-Type: application/json et structure { data: [...] } même en cas d'erreur partielle.
   - Logs côté backend plus explicites (console.error avec body des réponses non-ok).
   - Timeout/polling FullEnrich configurable.

Commandes utiles pour debug
- Vérifier serveur écoute : ss -ltnp | grep :5000
- Tester endpoint backend : curl -v -X POST http://localhost:5000/prospect -H "Content-Type: application/json" -d '{"companyName":"Castorama","site":"castorama.fr"}'
- Tester FullEnrich minimal (adapter à ta clé) : curl -v -X POST https://app.fullenrich.com/api/v1/contact/enrich -H "Authorization: Bearer $FULLENRICH_API_KEY" -H "Content-Type: application/json" -d '{"company_name":"Castorama","job_title":"CEO","fields":["contact.email"]}'

Sécurité & organisation
- Ne pas stocker les clés dans le repo.
- Documenter le contrat frontend/backend (exemple JSON request/response) dans README.