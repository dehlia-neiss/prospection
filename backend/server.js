/**
 * server.js
 *
 * Serveur Express minimal, clair et commenté pour que ton manager
 * voie le fonctionnement, les erreurs possibles et les points à corriger.
 *
 * - Charge .env (dossier backend puis repo root)
 * - Expose:
 *    GET  /health   => statut simple
 *    POST /prospect => body { companyName, site? } -> FullEnrich (prioritaire) -> Hunter fallback
 *
 * Problèmes potentiels listés dans les commentaires :
 * - variables d'environnement manquantes (FULLENRICH_API_KEY, HUNTER_API_KEY)
 * - endpoint FullEnrich changeant de version (base URL, payload attendu)
 * - CORS / ports mal configurés (frontend sur 3000, backend sur 5000)
 * - réponse non-JSON renvoyée en cas d'erreur -> frontend plantant sur JSON.parse
 *
 * Actions recommandées (rapide) :
 * - Créer backend/package.json et installer deps: npm init -y && npm install express cors dotenv
 * - Vérifier .env au repo root (ne pas committer)
 * - Tester manuellement FullEnrich via curl pour confirmer les endpoints/doc
 */

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";

// === Charger .env ===
// On essaye le .env dans backend, puis ../.env (repo root).
dotenv.config();
if (!process.env.FULLENRICH_API_KEY || !process.env.HUNTER_API_KEY) {
  dotenv.config({ path: path.resolve(process.cwd(), "..", ".env") });
}

// === Config / constantes ===
const FULLENRICH_API_KEY = process.env.FULLENRICH_API_KEY || "";
const HUNTER_API_KEY = process.env.HUNTER_API_KEY || "";
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:3000";
const PORT = Number(process.env.PORT || 5000);

const app = express();

// CORS : autoriser le frontend pendant le dev.
// Problème potentiel : si origine différente, changer FRONTEND_ORIGIN
app.use(
  cors({
    origin: FRONTEND_ORIGIN,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 200
  })
);

app.use(express.json({ limit: "200kb" }));

// Petit helper de log centralisé (modifiable)
function log(...args) {
  console.log(...args);
}
function warn(...args) {
  console.warn(...args);
}
function errlog(...args) {
  console.error(...args);
}

// === Vérifications au démarrage (pour ton manager) ===
if (!FULLENRICH_API_KEY) {
  warn("⚠️ FULLENRICH_API_KEY non défini. FullEnrich sera désactivé.");
}
if (!HUNTER_API_KEY) {
  warn("⚠️ HUNTER_API_KEY non défini. Hunter sera désactivé.");
}

// === Endpoints d'utilité ===
app.get("/health", (req, res) => {
  return res.json({
    ok: true,
    env: {
      fullenrich: !!FULLENRICH_API_KEY,
      hunter: !!HUNTER_API_KEY
    }
  });
});

// === FullEnrich helper ===
// IMPORTANT: selon la version de l'API FullEnrich la route et les champs changent.
// Ici on implémente un appel "single" au endpoint /api/v1/contact/enrich (si disponible).
// Si ta API fournit un autre chemin / format, il faut l'adapter.
async function callFullEnrichSingle(companyName, jobTitle = "Directeur Général", website) {
  if (!FULLENRICH_API_KEY) return null;

  const url = "https://app.fullenrich.com/api/v1/contact/enrich"; // vérifier la doc si différente
  const payload = {
    company_name: companyName,
    job_title: jobTitle,
    // certains comptes attendent "fields" ou "enrich_fields" — l'API peut varier.
    fields: ["contact.email", "contact.phone", "contact.linkedin", "company.website"]
  };
  if (website) payload.company_website = website;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${FULLENRICH_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const text = await res.text().catch(() => "");
    // debug utile pour le manager : on loggue le code et début du body
    log("FullEnrich single:", res.status, (text || "").slice(0, 400));

    if (!res.ok) {
      // erreurs 4xx/5xx -> retourner null pour fallback
      return null;
    }

    // essayer de parser
    let json;
    try {
      json = JSON.parse(text || "{}");
    } catch (e) {
      warn("FullEnrich: réponse non-JSON:", text?.slice(0, 500));
      return null;
    }

    // Normaliser la structure en tableau de contacts {nom,email,telephone,poste}
    const datas = json?.datas || (json?.data ? [json.data] : []);
    const contacts = [];
    for (const d of datas) {
      const email = d?.contact?.email?.[0]?.value || d?.emails?.[0]?.value || null;
      if (email) {
        contacts.push({
          poste: d?.input?.job_title || jobTitle,
          nom: d?.contact?.full_name || d?.contact?.name || "Inconnu",
          email,
          telephone: d?.contact?.phone?.[0]?.value || ""
        });
      }
    }
    return contacts.length ? contacts : null;
  } catch (err) {
    warn("FullEnrich error:", err?.message || err);
    return null;
  }
}

// Wrapper FullEnrich : on tente plusieurs postes communs (court)
async function enrichWithFullEnrich(companyName, website) {
  if (!FULLENRICH_API_KEY) return null;

  const titles = [
    "Directeur Général",
    "CEO",
    "Directeur Commercial",
    "Responsable Achats",
    "Responsable RSE"
  ];

  for (const t of titles) {
    const c = await callFullEnrichSingle(companyName, t, website);
    if (c && c.length) {
      log(`FullEnrich: trouvé ${c.length} contacts pour "${companyName}" (poste=${t})`);
      return c;
    }
    // pause courte pour éviter throttling
    await new Promise((r) => setTimeout(r, 300));
  }
  log(`FullEnrich: pas de résultat pour "${companyName}"`);
  return null;
}

// === Hunter helper (fallback) ===
// Domain search via Hunter.io: retourne quelques emails trouvés sur le domaine.
async function enrichWithHunter(domainOrUrl) {
  if (!HUNTER_API_KEY) return null;
  if (!domainOrUrl) return null;

  const domain = String(domainOrUrl).replace(/^https?:\/\//, "").split("/")[0];
  if (!domain) return null;

  const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${encodeURIComponent(HUNTER_API_KEY)}`;

  try {
    const res = await fetch(url);
    const json = await res.json().catch(() => null);
    log("Hunter status:", res.status);
    if (!res.ok || !json?.data?.emails) return null;

    return (json.data.emails || []).slice(0, 5).map((e) => ({
      poste: e.position || "Contact",
      nom: `${e.first_name || ""} ${e.last_name || ""}`.trim() || "Inconnu",
      email: e.value || "",
      telephone: ""
    }));
  } catch (err) {
    warn("Hunter error:", err?.message || err);
    return null;
  }
}

// === POST /prospect (FullEnrich-prioritaire) ===
/*
 Request body expected:
  { companyName: string, site?: string }
 Response:
  { data: [ { nom, adresse, secteur, resume, site_web, contacts: [...], sources: [...] } ] }
*/
app.post("/prospect", async (req, res) => {
  const { companyName, site } = req.body || {};
  log("RECHERCHE (FullEnrich priority):", companyName, "site:", site || "n/a");

  if (!companyName) {
    return res.status(400).json({ error: "companyName requis" });
  }

  try {
    // 1) tenter FullEnrich en priorité
    const feContacts = await enrichWithFullEnrich(companyName, site);
    if (feContacts && feContacts.length) {
      return res.json({
        data: [
          {
            nom: companyName,
            adresse: "",
            secteur: "",
            resume: "",
            site_web: site || "",
            contacts: feContacts,
            sources: ["FullEnrich"]
          }
        ]
      });
    }

    // 2) fallback Hunter si site fourni
    const hunterContacts = site ? await enrichWithHunter(site) : null;
    if (hunterContacts && hunterContacts.length) {
      return res.json({
        data: [
          {
            nom: companyName,
            adresse: "",
            secteur: "",
            resume: "",
            site_web: site || "",
            contacts: hunterContacts,
            sources: ["Hunter"]
          }
        ]
      });
    }

    // 3) aucun contact trouvé -> renvoyer structure vide mais valide
    return res.json({
      data: [
        {
          nom: companyName,
          adresse: "",
          secteur: "",
          resume: "",
          site_web: site || "",
          contacts: [{ poste: "n/d", nom: "n/d", email: "", telephone: "" }],
          sources: ["None"]
        }
      ]
    });
  } catch (err) {
    errlog("Endpoint /prospect erreur:", err?.message || err);
    // Retourner JSON lisible (éviter HTML d'erreur)
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

// === Démarrage ===
app.listen(PORT, () => {
  log(`Server listening on http://localhost:${PORT}`);
  log(`FULLENRICH_API_KEY set: ${!!FULLENRICH_API_KEY}, HUNTER_API_KEY set: ${!!HUNTER_API_KEY}`);
});

/*
 Points de surveillance / éléments à expliquer à ton manager :
 - Si FullEnrich renvoie 400 avec "enrich_fields.empty" : l'API attend un autre paramètre/format.
   -> Action : vérifier la doc FullEnrich et tester manuellement via curl le endpoint exact.
 - Si les réponses sont HTML (404/500) : le backend doit toujours renvoyer JSON. Ici on normalise.
 - CORS : si frontend sur autre origine, mettre FRONTEND_ORIGIN en .env.
 - Dépendances : backend/package.json doit inclure express, cors, dotenv.
 - tests manuels utiles :
    curl -v -X POST http://localhost:5000/prospect -H "Content-Type: application/json" -d '{"companyName":"Castorama","site":"castorama.fr"}'
 - Pour un fonctionnement "scale" : envisager queue / batch / retry / backoff pour FullEnrich (limites d'API).
*/