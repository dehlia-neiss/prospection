import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Capture erreurs non gérées
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT_EXCEPTION]', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED_REJECTION]', reason);
});

let fullEnrichQuota = 3; // global (à mettre en haut du fichier par ex.) 
let lastFullEnrichReset = Date.now();


dotenv.config();
if (!process.env.GOOGLE_MAPS_API_KEY) {
  dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

}

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || "";
const HUNTER_API_KEY = process.env.HUNTER_API_KEY || "";
const FULLENRICH_API_KEY = process.env.FULLENRICH_API_KEY || "";
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:3000";
const PORT = Number(process.env.PORT || 5000);

const app = express();

// Bloque les requêtes favicon
app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});
// Bloque les requêtes de ressources common
app.get('/robots.txt', (req, res) => {
  res.status(204).end();
});

app.use(cors({
  origin: FRONTEND_ORIGIN,
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 200
}));

app.use(express.json({ limit: "200kb" }));

function log(...args) { console.log("[SERVER]", ...args); }
function warn(...args) { console.warn("[WARN]", ...args); }
function errlog(...args) { console.error("[ERROR]", ...args); }

app.get("/health", (req, res) => {
  return res.json({
    ok: true,
    env: {
      google_maps: !!GOOGLE_MAPS_API_KEY,
      hunter: !!HUNTER_API_KEY,
      fullenrich: !!FULLENRICH_API_KEY
    }
  });
});

// ===================================
// HELPER: Mapping NAF → Mots-clés
// ===================================
function getNafKeyword(naf) {
  const nafMapping = {
    "47.52": "bricolage",
    "47.52B": "bricolage quincaillerie",
    "47.52A": "bricolage peinture",
    "47.11": "supermarché",
    "47.19": "commerce général",
    "47.71": "habillement",
    "47.72": "chaussures",
    "56.10": "restaurant",
    "56.30": "café bar",
    "68.20": "immobilier location",
    "62.01": "informatique développement",
    "62.02": "conseil informatique",
    "70.22": "conseil gestion",
    "41.20": "construction",
    "43.99": "travaux",
    "45.20": "entretien véhicules",
    "46.90": "commerce gros",
  };
  
  if (!naf || typeof naf !== "string") return "commerce";
  if (nafMapping[naf]) return nafMapping[naf];
  const nafPrefix = naf.slice(0, 5);
  if (nafMapping[nafPrefix]) return nafMapping[nafPrefix];
  return "commerce";
}

// ===================================
// 1. TROUVER L'ENTREPRISE CIBLE
// ===================================
async function findTargetCompany(companyName, codePostal) {
  const url = `https://recherche-entreprises.api.gouv.fr/search?q=${encodeURIComponent(companyName)}&code_postal=${codePostal}&limite=1`;
  
  try {
    log(`🔍 Recherche entreprise: "${companyName}" dans ${codePostal}`);
    const res = await fetch(url);
    const json = await res.json();
    
    if (!json.results || json.results.length === 0) {
      warn("❌ Entreprise introuvable");
      return null;
    }
    
    const target = json.results[0];
    log(`✅ Trouvé: ${target.nom_complet} - NAF: ${target.activite_principale}`);
    
    return {
      nom: target.nom_complet,
      siren: target.siren,
      naf: target.activite_principale,
      adresse: target.siege?.adresse,
      code_postal: target.siege?.code_postal,
      ville: target.siege?.commune,
      latitude: target.siege?.latitude,
      longitude: target.siege?.longitude
    };
  } catch (err) {
    errlog("❌ Erreur recherche:", err.message);
    return null;
  }
}

// ===================================
// 2. TROUVER ENTREPRISES SIMILAIRES
// ===================================
async function findSimilarCompanies(targetCompany, codePostal, maxResults = 20) {
  const naf = targetCompany.naf;
  const url = `https://recherche-entreprises.api.gouv.fr/search?activite_principale=${naf}&code_postal=${codePostal}&limite=${maxResults}`;
  
  try {
    log(`🔍 Recherche similaires: NAF ${naf}, CP ${codePostal}`);
    const res = await fetch(url);
    const json = await res.json();
    
    if (!json.results || json.results.length === 0) {
      warn("❌ Aucune entreprise similaire");
      return [];
    }
    
    log(`✅ ${json.results.length} entreprises trouvées`);
    
    return json.results.map(c => ({
      nom: c.nom_complet || c.nom_raison_sociale,
      siren: c.siren,
      naf: c.activite_principale,
      secteur: c.libelle_activite_principale,
      adresse: c.siege?.adresse,
      code_postal: c.siege?.code_postal,
      ville: c.siege?.commune,
      latitude: c.siege?.latitude,
      longitude: c.siege?.longitude,
      site_web: null,
      telephone: null,
      contacts: []
    }));
  } catch (err) {
    errlog("❌ Erreur similaires:", err.message);
    return [];
  }
}

// ===================================
// 3. ENRICHIR AVEC GOOGLE MAPS
// ===================================
async function enrichWithGoogleMaps(companyName, naf, ville) {
  if (!GOOGLE_MAPS_API_KEY) {
    warn("❌ Google Maps API key manquante");
    return null;
  }

  const nafKeyword = getNafKeyword(naf ||"");
  const query = `${companyName} ${nafKeyword} ${ville}`;
  
  try {
    log(`  🗺️  Google Maps: "${query}"`);
    
    const searchUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${GOOGLE_MAPS_API_KEY}&language=fr`;
    
    const searchRes = await fetch(searchUrl);
    const searchData = await searchRes.json();
    
    if (searchData.status !== "OK" || !searchData.results || searchData.results.length === 0) {
      warn(`  ❌ Google Maps: Aucun résultat`);
      return null;
    }
    
    const place = searchData.results[0];
    const placeId = place.place_id;
    
    const detailsUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=name,formatted_address,formatted_phone_number,website,url&key=${GOOGLE_MAPS_API_KEY}&language=fr`;
    
    const detailsRes = await fetch(detailsUrl);
    const detailsData = await detailsRes.json();
    
    if (detailsData.status !== "OK" || !detailsData.result) {
      return null;
    }
    
    const result = detailsData.result;
    
    log(`  ✅ Site: ${result.website || 'N/A'}, Tél: ${result.formatted_phone_number || 'N/A'}`);
    
    return {
      site_web: result.website || null,
      telephone: result.formatted_phone_number || null,
      adresse_complete: result.formatted_address || null,
      google_maps_url: result.url || null
    };
    
  } catch (err) {
    warn("  ❌ Google Maps error:", err.message);
    return null;
  }
}

// HUNTER.IO - Domain Search
// HUNTER.IO - Domain Search (version simplifiée et robuste)
async function enrichWithHunter(company) {
  if (!HUNTER_API_KEY) {
    log(` 📧 Hunter: API key manquante`);
    return [];
  }

  if (!company.site_web) {
    log(` 📧 Hunter: Skip (pas de site web)`);
    return [];
  }

  try {
    // Extraction du domaine depuis l'URL
    const domain = company.site_web
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0];

    if (!domain || domain.length < 3) {
      log(` 📧 Hunter: Domaine invalide: ${domain}`);
      return [];
    }

    log(` 📧 Hunter: Domain Search pour ${domain}`);

    // Utilise l'API v2 (comme dans le script google_hunter.js)
    const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(
      domain
    )}&api_key=${encodeURIComponent(HUNTER_API_KEY)}&limit=10`;

    const res = await fetch(url);

    if (!res.ok) {
      const errorText = await res.text();
      warn(` ❌ Hunter HTTP ${res.status}: ${errorText}`);
      return [];
    }

    const json = await res.json();
    const data = json.data || null;
    const emails = data?.emails || [];

    if (!emails.length) {
      log(` 📧 Hunter: Aucun email trouvé pour ${domain}`);
      return [];
    }

    const contacts = emails.map((e) => ({
      nom: `${e.first_name || ""} ${e.last_name || ""}`.trim() || "Contact Hunter",
      poste: e.position || e.department || "Poste non renseigné",
      email: e.value || e.email,
      telephone: "", // Hunter Domain Search ne renvoie pas de téléphone
      linkedin: e.linkedin || "",
      source: "Hunter",
      confidence: e.confidence && e.confidence >= 80 ? "high" : "medium",
    }));

    log(` ✅ Hunter: ${contacts.length} email(s) trouvé(s) pour ${domain}`);
    return contacts;
  } catch (error) {
    warn(" ❌ Hunter error:", error.message);
    return [];
  }
}

// 2. SCRAPING ULTRA SIMPLE des pages de contact
async function simpleScraping(website) {
  if (!website) return [];
  
  try {
    log(`  🌐 Scraping: ${website}`);
    
    // Seulement la page contact principale
    const contactUrls = [
      `${website}/contact`,
      `${website}/nous-contacter`, 
      `${website}/contactez-nous`,
      `${website}/contact.html`,
      `${website}/contacts`
    ];
    
    let foundEmails = [];
    
    for (const url of contactUrls.slice(0, 3)) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);
        
        const res = await fetch(url, { 
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; ProspectBot/1.0)'
          }
        });
        
        clearTimeout(timeoutId);
        
        if (res.ok) {
          const html = await res.text();
          
          // Regex email simple
          const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
          const emails = html.match(emailRegex) || [];
          
          // Filtre les emails du domaine
          const domain = website.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
          const domainEmails = emails.filter(email => 
            email.includes(domain) || 
            email.includes(domain.replace('www.', ''))
          );
          
          domainEmails.forEach(email => {
            if (!foundEmails.includes(email)) {
              foundEmails.push(email);
            }
          });
          
          if (domainEmails.length > 0) {
            log(`    ✅ ${url}: ${domainEmails.length} email(s) trouvé(s)`);
          }
        }
      } catch (e) {
        // Continue silencieusement
      }
    }
    
    const contacts = foundEmails.map(email => ({
      nom: "Contact site web",
      poste: "Commercial/Support",
      email: email,
      telephone: "",
      source: "Web Scraping",
      confidence: "high"
    }));
    
    log(`  ✅ Scraping: ${contacts.length} email(s) réel(s) trouvé(s)`);
    return contacts;
    
  } catch (err) {
    warn("  ❌ Scraping error:", err.message);
    return [];
  }
}

// 3. FULLENRICH (option payante)
// 3. FULLENRICH (option payante)
async function enrichWithFullEnrich(company) {
  if (!FULLENRICH_API_KEY) {
    log(`  💰 FullEnrich: API key manquante`);
    return [];
  }

  if (!company.site_web) {
    log(`  💰 FullEnrich: Skip (pas de site web)`);
    return [];
  }

  try {
    log(`  💰 FullEnrich: Recherche pour "${company.nom}"`);

    // Extraction du domaine
    let domain = company.site_web
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0];

    if (!domain || domain.length < 3) {
      log(`  💰 FullEnrich: Domaine invalide: ${domain}`);
      return [];
    }

    // Payload EXACT selon la doc FullEnrich
    const payload = {
      name: `Prospect ${company.nom.substring(0, 80)}`,
      // webhook facultatif, tu peux le laisser vide ou mettre un endpoint si tu veux bosser 100% async
      webhook_url: "", 
      datas: [
        {
          firstname: "", // tu pourras remplir plus tard si tu as un nom
          lastname: "",
          domain: domain,
          company_name: company.nom.substring(0, 100),
          linkedin_url: "", // pas de LinkedIn pour l'instant
          enrich_fields: [
            "contact.emails",
            "contact.personal_emails",
            "contact.phones"
          ],
          custom: {
            source_company_siren: company.siren || "",
            source_company_city: company.ville || "",
          }
        }
      ]
    };

    log(`  💰 FullEnrich: Domaine: ${domain}, Ville: ${company.ville}`);

    log(`  💰 FullEnrich POST payload: ${JSON.stringify(payload).substring(0,1000)}`);
    let res = await fetch("https://app.fullenrich.com/api/v1/contact/enrich/bulk", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${FULLENRICH_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    let result;
    if (!res.ok) {
      const errorText = await res.text();
      warn(`  ❌ FullEnrich HTTP ${res.status}: ${errorText}`);

      // Try a fallback: some accounts expect `enrich_fields` at root
      try {
        const parsed = JSON.parse(errorText || "{}");
        if (parsed.code && parsed.code.toString().toLowerCase().includes('enrich_fields')) {
          warn('  ℹ️ FullEnrich responded enrich_fields issue, retrying with fallback payload (root enrich_fields)');
          const fallback = { ...payload, enrich_fields: payload.datas?.[0]?.enrich_fields || [] };
          log(`  💬 FullEnrich retry payload: ${JSON.stringify(fallback).substring(0,1000)}`);
          res = await fetch("https://app.fullenrich.com/api/v1/contact/enrich/bulk", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${FULLENRICH_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify(fallback)
          });
        } else {
          return [];
        }
      } catch (e) {
        return [];
      }
    }

    if (!res.ok) {
      const errorText2 = await res.text();
      warn(`  ❌ FullEnrich HTTP (after retry) ${res.status}: ${errorText2}`);
      return [];
    }

    result = await res.json();
    log(`  💰 FullEnrich raw response: ${JSON.stringify(result).substring(0, 400)}`);

    // Selon la doc, la réponse peut contenir un "job" ou des "results"
    // Au début, on considère que les résultats sont synchrones dans result.datas ou result.results
    const contacts = [];

    const records = Array.isArray(result.datas || result.results)
      ? (result.datas || result.results)
      : [];

    for (const rec of records) {
      // rec.contact ou rec.enriched_contact selon la doc de ton compte
      const contactData = rec.contact || rec.enriched_contact || rec;

      if (!contactData) continue;

      // Emails pro & persos
      const emails = [
        ...(contactData.emails || []),
        ...(contactData.personal_emails || [])
      ];

      for (const emailObj of emails) {
        const email =
          typeof emailObj === "string"
            ? emailObj
            : emailObj.email || emailObj.value || "";

        if (!email) continue;

        const contact = {
          nom: `${contactData.first_name || ""} ${contactData.last_name || ""}`.trim() || "Contact à identifier",
          poste: contactData.title || contactData.position || "Poste non renseigné",
          email,
          telephone:
            (contactData.phones && contactData.phones[0]) ||
            contactData.phone ||
            "",
          linkedin: contactData.linkedin_url || "",
          source: "FullEnrich",
          confidence: "high"
        };

        contacts.push(contact);
        log(`  ✅ FullEnrich: ${contact.nom} - ${contact.email}`);
      }

      // Si aucun email trouvé mais le contact a un nom, ajoute-le quand même (sans coordonnées)
      if (emails.length === 0 && (contactData.first_name || contactData.last_name)) {
        const contact = {
          nom: `${contactData.first_name || ""} ${contactData.last_name || ""}`.trim() || "Contact à identifier",
          poste: contactData.title || contactData.position || "Poste non renseigné",
          email: "",
          telephone: "",
          linkedin: contactData.linkedin_url || "",
          source: "FullEnrich",
          confidence: "low"
        };
        contacts.push(contact);
        log(`  ℹ️ FullEnrich (nom seul): ${contact.nom}`);
      }
    }

    log(`  💰 FullEnrich: ${contacts.length} contact(s) trouvé(s)`);
    return contacts;

  } catch (err) {
    warn("  ❌ FullEnrich error:", err);
    return [];
  }
}

// ===================================
// FONCTION DÉDIÉE PURIFICATION TÉLÉPHONES
// ===================================
function normalizePhoneNumber(phone) {
  if (!phone) return null;
  
  // Supprime tous les caractères non numériques
  const cleaned = phone.replace(/\D/g, '');
  
  // Format français
  if (cleaned.startsWith('33') && cleaned.length === 11) {
    return `0${cleaned.substring(2)}`;
  }
  
  // Déjà format français
  if (cleaned.startsWith('0') && cleaned.length === 10) {
    return cleaned;
  }
  
  // Format international +33
  if (cleaned.startsWith('33') && cleaned.length === 11) {
    return `0${cleaned.substring(2)}`;
  }
  
  return cleaned.length >= 10 ? cleaned : null;
}

// ===================================
// SCRAPING AMÉLIORÉ AVEC TÉLÉPHONES
// ===================================
async function enhancedScraping(website) {
  if (!website) return [];
  
  try {
    log(`  🌐 Scraping amélioré: ${website}`);
    
    const contactUrls = [
      `${website}/contact`,
      `${website}/nous-contacter`, 
      `${website}/contactez-nous`,
      `${website}/contact.html`,
      `${website}/contacts`,
      `${website}/about`,
      `${website}/equipe`,
      `${website}/team`
    ];
    
    let foundEmails = [];
    let foundPhones = [];
    
    for (const url of contactUrls.slice(0, 5)) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        
        const res = await fetch(url, { 
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; ProspectBot/1.0)'
          }
        });
        
        clearTimeout(timeoutId);
        
        if (res.ok) {
          const html = await res.text();
          
          // Regex email améliorée
          const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
          const emails = html.match(emailRegex) || [];
          
          // Regex téléphone française améliorée
          const phoneRegex = /(?:(?:\+|00)33[\s.-]{0,3}|0)[1-9][\s.-]?(\d{2}[\s.-]?){4}/g;
          const phones = html.match(phoneRegex) || [];
          
          // Filtre les emails du domaine
          const domain = website.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
          const domainEmails = emails.filter(email => 
            email.toLowerCase().includes(domain.toLowerCase()) || 
            email.toLowerCase().includes(domain.replace('www.', '').toLowerCase())
          );
          
          domainEmails.forEach(email => {
            if (!foundEmails.includes(email.toLowerCase())) {
              foundEmails.push(email.toLowerCase());
            }
          });
          
          // Nettoie et filtre les téléphones (limite à 5 par page pour éviter bruit)
          const cleanedPhones = phones.map(phone => normalizePhoneNumber(phone)).filter(Boolean).slice(0, 5);
          cleanedPhones.forEach(phone => {
            if (!foundPhones.includes(phone)) {
              foundPhones.push(phone);
            }
          });
          
          if (domainEmails.length > 0 || cleanedPhones.length > 0) {
            log(`    ✅ ${url}: ${domainEmails.length} email(s), ${cleanedPhones.length} téléphone(s)`);
          }
        }
      } catch (e) {
        // Continue silencieusement
      }
    }
    
    // Création des contacts combinant emails et téléphones
    const contacts = [];
    
    // Priorité aux emails avec téléphones
    foundEmails.forEach((email, index) => {
      contacts.push({
        nom: "Contact commercial",
        poste: "Commercial/Support",
        email: email,
        telephone: foundPhones[index] || "", // Associe le téléphone correspondant
        source: "Web Scraping",
        confidence: "high"
      });
    });
    
    // Ajoute les téléphones restants sans email
    if (foundPhones.length > foundEmails.length) {
      for (let i = foundEmails.length; i < foundPhones.length; i++) {
        contacts.push({
          nom: "Standard téléphonique",
          poste: "Accueil",
          email: "",
          telephone: foundPhones[i],
          source: "Web Scraping",
          confidence: "medium"
        });
      }
    }
    
    log(`  ✅ Scraping: ${contacts.length} contact(s) trouvé(s)`);
    return contacts;
    
  } catch (err) {
    warn("  ❌ Scraping error:", err.message);
    return [];
  }
}
// ===================================
// ENRICHIR VIA SIRET - API INPI (dirigeants/représentants)
// ===================================
async function enrichWithINPI(company) {
  if (!company.siren) {
    log(`  📋 INPI: Skip (pas de SIREN)`);
    return [];
  }

  try {
    log(`  📋 INPI: Recherche dirigeants pour SIREN ${company.siren}`);

    // API INPI gratuit: récupère les informations de l'entreprise et ses dirigeants
    const url = `https://data.inpi.fr/api/companies/${company.siren}`;
    
    const res = await fetch(url, { 
      headers: { 'Accept': 'application/json' },
      timeout: 5000
    });

    if (!res.ok) {
      log(`  📋 INPI: HTTP ${res.status} pour ${company.siren}`);
      return [];
    }

    const data = await res.json();
    const contacts = [];

    // Récupère les dirigeants/représentants
    if (data.businessRepresentatives && Array.isArray(data.businessRepresentatives)) {
      log(`  📋 INPI: ${data.businessRepresentatives.length} dirigeant(s) trouvé(s)`);

      data.businessRepresentatives.slice(0, 10).forEach(rep => {
        const nom = rep.lastname ? `${rep.firstname || ''} ${rep.lastname}`.trim() : "Dirigeant";
        const contact = {
          nom: nom || "Dirigeant",
          poste: rep.function || "Dirigeant",
          email: rep.email || "",
          telephone: rep.phone || "",
          linkedin: "",
          source: "INPI",
          confidence: "high"
        };

        if (nom && nom !== "Dirigeant") {
          contacts.push(contact);
          log(`    ✅ INPI: ${contact.nom} - ${contact.poste}`);
        }
      });
    }

    // Alternative: si pas de dirigeants, essaie de récupérer les contacts du registre
    if (contacts.length === 0 && data.contacts && Array.isArray(data.contacts)) {
      log(`  📋 INPI: ${data.contacts.length} contact(s) du registre`);
      
      data.contacts.slice(0, 5).forEach(contact => {
        const nom = contact.lastname ? `${contact.firstname || ''} ${contact.lastname}`.trim() : "Contact";
        const c = {
          nom: nom || "Contact",
          poste: contact.role || "Contact",
          email: contact.email || "",
          telephone: contact.phone || "",
          linkedin: "",
          source: "INPI",
          confidence: "medium"
        };

        if (nom && nom !== "Contact") {
          contacts.push(c);
          log(`    ℹ️ INPI (registre): ${c.nom}`);
        }
      });
    }

    log(`  📋 INPI: ${contacts.length} contact(s) trouvé(s)`);
    return contacts;

  } catch (error) {
    log(`  ⚠️ INPI error: ${error.message}`);
    return [];
  }
}

// ROCKETREACH - Remplacement Hunter
async function enrichWithRocketReach(company) {
  const ROCKETREACH_API_KEY = process.env.ROCKETREACH_API_KEY;
  
  if (!ROCKETREACH_API_KEY) {
    log(`  🚀 RocketReach: API key manquante`);
    return [];
  }

  if (!company.site_web) {
    log(`  🚀 RocketReach: Skip (pas de site web)`);
    return [];
  }

  try {
    log(`  🚀 RocketReach: Recherche pour "${company.nom}"`);
    
    // Extraction du domaine
    let domain = company.site_web.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
    
    if (!domain || domain.length < 3) {
      log(`  🚀 RocketReach: Domaine invalide: ${domain}`);
      return [];
    }

    // Recherche par domaine
    const searchUrl = `https://api.rocketreach.co/v2/api/search?domain=${domain}&api_key=${ROCKETREACH_API_KEY}`;
    
    log(`  🚀 RocketReach: Appel API pour ${domain}`);
    
    const response = await fetch(searchUrl);
    const data = await response.json();
    
    const contacts = [];
    
    if (data.profiles && data.profiles.length > 0) {
      log(`  🚀 RocketReach: ${data.profiles.length} profils trouvés`);
      
      data.profiles.slice(0, 15).forEach(profile => {
        const name = `${profile.first_name || ''} ${profile.last_name || ''}`.trim();
        const contact = {
          nom: name || "Contact à identifier",
          poste: profile.current_title || profile.title || "Poste non renseigné",
          email: profile.work_email || "",
          telephone: profile.phone_numbers?.[0] || "",
          linkedin: profile.linkedin_url || "",
          source: "RocketReach",
          confidence: profile.work_email ? "high" : "low"
        };

        // N'ajoute que si on a au moins un nom utile
        if (name) {
          contacts.push(contact);
          if (contact.email) log(`    ✅ RocketReach: ${contact.nom} - ${contact.email}`);
          else log(`    ℹ️ RocketReach (nom seul): ${contact.nom}`);
        }
      });
    } else {
      log(`  🚀 RocketReach: Aucun profil trouvé pour ${domain}`);
    }
    
    log(`  🚀 RocketReach: ${contacts.length} contact(s) valide(s)`);
    return contacts;
    
  } catch (error) {
    warn("  ❌ RocketReach error:", error.message);
    return [];
  }
}

// DROPCONTACT - Solution française
async function enrichWithDropcontact(company) {
  const DROPCONTACT_API_KEY = process.env.DROPCONTACT_API_KEY;
  
  if (!DROPCONTACT_API_KEY) {
    log(`  🇫🇷 Dropcontact: API key manquante`);
    return [];
  }

  if (!company.site_web) {
    log(`  🇫🇷 Dropcontact: Skip (pas de site web)`);
    return [];
  }

  try {
    log(`  🇫🇷 Dropcontact: Recherche pour "${company.nom}"`);
    
    // Extraction du domaine
    const domain = company.site_web.replace(/^https?:\/\//, "")
                                  .replace(/^www\./, "")
                                  .split("/")[0];

    // Préparation des données pour Dropcontact
    const requestData = {
      data: [{
        entreprise: company.nom,
        website: company.site_web,
        siren: company.siren || "",
        ville: company.ville || "",
        code_postal: company.code_postal || ""
      }]
    };

    log(`  🇫🇷 Dropcontact: Envoi requête pour ${domain}`);

    // Appel API Dropcontact
    const response = await fetch('https://api.dropcontact.io/batch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Access-Token': DROPCONTACT_API_KEY
      },
      body: JSON.stringify(requestData)
    });

    if (!response.ok) {
      const errorText = await response.text();
      warn(`  ❌ Dropcontact HTTP error: ${response.status} - ${errorText}`);
      return [];
    }

    const data = await response.json();
    const contacts = [];

    // Traitement des résultats
    if (data.data && data.data.length > 0 && data.data[0].emails) {
      const emails = data.data[0].emails;
      log(`  🇫🇷 Dropcontact: ${emails.length} email(s) trouvé(s)`);
      
      emails.forEach(emailInfo => {
        if (emailInfo.email) {
          const contact = {
            nom: `${emailInfo.prenom || ''} ${emailInfo.nom || ''}`.trim() || "Contact commercial",
            poste: emailInfo.fonction || "Poste non renseigné",
            email: emailInfo.email,
            telephone: emailInfo.telephone || "",
            linkedin: emailInfo.linkedin || "",
            source: "Dropcontact",
            confidence: emailInfo.qualite === "bon" ? "high" : "medium"
          };
          
          contacts.push(contact);
          log(`    ✅ Dropcontact: ${contact.nom} - ${contact.email} (${emailInfo.qualite || 'qualité inconnue'})`);
        }
      });
    } else {
      log(`  🇫🇷 Dropcontact: Aucun email trouvé`);
    }

    log(`  🇫🇷 Dropcontact: ${contacts.length} contact(s) valide(s)`);
    return contacts;

  } catch (error) {
    warn("  ❌ Dropcontact error:", error.message);
    return [];
  }
}

// ===================================
// HELPER: VÉRIFIER LE QUOTA FULLENRICH
// ===================================
function canUseFullEnrich() {
  const now = Date.now();
  // reset toutes les 60 secondes
  if (now - lastFullEnrichReset > 60_000) {
    fullEnrichQuota = 3;
    lastFullEnrichReset = now;
  }
  return FULLENRICH_API_KEY && fullEnrichQuota > 0;
}

// ===================================
// HELPER: DÉTERMINER SI UN CONTACT EST DE FRANCE (+33 ou email .fr)
// ===================================
function isContactFromFrance(contact) {
  // Stratégie: accepter si:
  // 1. Email en .fr (France)
  // 2. Téléphone +33 ou 0X (France)
  // 3. Pas de coordonnée pays claire = on garde (peut être valide)

  // Vérifier le téléphone pour ACCEPTER les indicatifs France
  if (contact.telephone) {
    const phoneCleaned = contact.telephone.replace(/\D/g, '');
    // Indicatif France: 33 (pour +33) ou 0 (pour numéros français)
    if (phoneCleaned.startsWith('33') || phoneCleaned.match(/^0[1-9]/)) {
      return true;
    }
    // Si le téléphone commence par un autre indicatif, rejette
    if (phoneCleaned.length > 6 && !phoneCleaned.startsWith('33') && !phoneCleaned.match(/^0/)) {
      return false; // Clairement étranger
    }
  }

  // Vérifier l'email pour ACCEPTER les TLDs français ET internationaux courants
  if (contact.email) {
    const emailLower = contact.email.toLowerCase();
    // TLDs français = accepter
    if (emailLower.endsWith('.fr') || emailLower.endsWith('.gouv.fr') || 
        emailLower.endsWith('.com.fr') || emailLower.endsWith('.co.fr')) {
      return true;
    }
    // TLDs génériques/internationaux = accepter aussi
    if (emailLower.endsWith('.com') || emailLower.endsWith('.net') || 
        emailLower.endsWith('.org') || emailLower.endsWith('.biz')) {
      return true;
    }
  }

  // Si pas de téléphone ET pas d'email: rejeté (aucune coordonnée)
  if (!contact.telephone && !contact.email) {
    return false;
  }

  // Si email générique (.com, etc.) sans téléphone France: accepter quand même
  // (car l'entreprise recherchée est en France, les contacts le sont probablement)
  if (contact.email && !contact.telephone) {
    return true;
  }

  // Par défaut: accepter (pour ne pas perdre de contacts potentiels)
  return true;
}

// ===================================
// ENRICHIR LES CONTACTS TROUVÉS AVEC FULLENRICH
// ===================================

async function enrichFoundContactsWithFullEnrich(company, foundContacts = []) {
  if (!FULLENRICH_API_KEY || !canUseFullEnrich()) {
    log(`  💰 FullEnrich enrichissement: API key manquante ou quota épuisé`);
    return [];
  }

  if (!company.site_web || foundContacts.length === 0) {
    return [];
  }

  try {
    log(`  💰 FullEnrich enrichissement: ${foundContacts.length} contact(s) trouvé(s) à enrichir`);

    // Extraction du domaine
    let domain = company.site_web
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0];

    if (!domain || domain.length < 3) {
      log(`  💰 FullEnrich: Domaine invalide: ${domain}`);
      return [];
    }

    // Batch: envoie les contacts trouvés à FullEnrich pour enrichissement
    // Prend les noms des contacts et les envoie par batch
    const datas = foundContacts
      .filter(c => c.nom && c.nom.trim().length > 0)
      .slice(0, 10) // max 10 par batch
      .map(contact => {
        // Essaie de splitter le nom en prénom/nom
        const parts = (contact.nom || "").trim().split(/\s+/);
        const firstname = parts[0] || "";
        const lastname = parts.slice(1).join(" ") || "";

        return {
          firstname,
          lastname,
          domain,
          company_name: company.nom.substring(0, 100),
          linkedin_url: contact.linkedin || "",
          enrich_fields: [
            "contact.emails",
            "contact.personal_emails",
            "contact.phones"
          ],
          custom: {
            source_company_siren: company.siren || "",
            source_company_city: company.ville || "",
            source_contact_original_name: contact.nom
          }
        };
      });

    if (datas.length === 0) {
      log(`  💰 FullEnrich enrichissement: Aucun contact valide à enrichir`);
      return [];
    }

    const payload = {
      name: `Enrich batch ${company.nom.substring(0, 50)}`,
      webhook_url: "",
      datas
    };

    log(`  💰 FullEnrich enrichissement batch: ${datas.length} contact(s)`);
    let res = await fetch("https://app.fullenrich.com/api/v1/contact/enrich/bulk", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${FULLENRICH_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errorText = await res.text();
      warn(`  ❌ FullEnrich batch HTTP ${res.status}: ${errorText}`);
      return [];
    }

    const result = await res.json();
    log(`  💰 FullEnrich batch raw response: ${JSON.stringify(result).substring(0, 200)}`);

    // Retourne la réponse enrichie (elle contient enrichment_id en async mode)
    // Pour l'instant, on retourne [] car les résultats arrivent via webhook/polling
    // mais on a consommé le quota pour cette tentative
    fullEnrichQuota -= 1;
    log(`  💰 FullEnrich batch: quota restant=${fullEnrichQuota}`);

    return [];

  } catch (err) {
    warn("  ❌ FullEnrich enrichissement error:", err.message);
    return [];
  }
}

// ===================================
// STRATÉGIE PRINCIPALE AMÉLIORÉE
// ===================================

async function completelyFreeEnrichment(company) {
  // Si pas de site web, pas d'enrichissement
  if (!company.site_web) {
    log(` ❌ Pas de site web, skip enrichment`);
    return [];
  }

  let allContacts = [];
  log(` 🎯 ENRICHISSEMENT COMPLET: ${company.nom}`);

  // 1. Dropcontact
  const dropcontactContacts = await enrichWithDropcontact(company);
  if (dropcontactContacts.length > 0) {
    allContacts.push(...dropcontactContacts);
  }

  // 2. Scraping
  const scrapedContacts = await enhancedScraping(company.site_web);
  if (scrapedContacts.length > 0) {
    allContacts.push(...scrapedContacts);
  }

  // 3. Hunter
  const hunterContacts = await enrichWithHunter(company);
  if (hunterContacts.length > 0) {
    allContacts.push(...hunterContacts);
  }

  // 4. RocketReach si très peu de contacts
  if (allContacts.length < 3) {
    const rocketContacts = await enrichWithRocketReach(company);
    if (rocketContacts.length > 0) {
      allContacts.push(...rocketContacts);
    }
  }

  // 5. FullEnrich en dernier recours (si configuré)
  if (allContacts.length === 0 && canUseFullEnrich()) {
    const fullEnrichContacts = await enrichWithFullEnrich(company);
    if (fullEnrichContacts && fullEnrichContacts.length > 0) {
      allContacts.push(...fullEnrichContacts);
    }
    fullEnrichQuota -= 1;
  }

  // DÉDUP SOFT: 1 standard / numéro, max contacts perso
  const uniqueContacts = [];
  const seenEmails = new Set();
  const seenStandardPhones = new Set();

  allContacts.forEach((contact) => {
    const emailKey = contact.email ? contact.email.toLowerCase() : "";
    const rawPhone = contact.telephone ? normalizePhoneNumber(contact.telephone) : "";

    const isStandard =
      (contact.nom && contact.nom.toLowerCase().includes("standard")) ||
      (contact.poste && contact.poste.toLowerCase().includes("standard")) ||
      (contact.poste && contact.poste.toLowerCase().includes("accueil"));

    // Dédup par email
    if (emailKey && seenEmails.has(emailKey)) {
      return;
    }

    // Standard: 1 par numéro max
    if (isStandard && rawPhone) {
      if (seenStandardPhones.has(rawPhone)) {
        return;
      }
      seenStandardPhones.add(rawPhone);
    }

    if (emailKey) seenEmails.add(emailKey);
    if (rawPhone) {
      contact.telephone = rawPhone;
    }

    uniqueContacts.push(contact);
  });

  log(` 📊 RÉSULTAT: ${uniqueContacts.length} contact(s) unique(s) pour ${company.nom}`);
  return uniqueContacts;
}

// ====== ici tu dois déjà avoir ensuite ton app.post("/prospect", ...) puis les endpoints /enrich-contact, etc. ======

// ===================================
// ENDPOINT PRINCIPAL
// ===================================
app.post("/prospect", async (req, res) => {
  const { companyName, postalCode, location, nafCode } = req.body || {};
  const codePostal = postalCode || location;

  log("══════════════════════════════════════");
  log("🚀 PROSPECTION 100% GRATUITE");
  log("Entreprise:", companyName);
  log("Code postal:", codePostal);
  log("NAF demnadé:", nafCode || "(non spécifié)");
  log("══════════════════════════════════════");

  if ((!companyName && !nafCode)|| !codePostal) {
    return res.status(400).json({ 
      error: "companyName ou nafCode et code postal requis",
      data: []
    });
  }

  try {
    // 1. Entreprise de référence
    let target = null;
    let nafToUse = null;

    // 1. Si companyName fourni, on cherche une entreprise de référence
    if (companyName) {
      target = await findTargetCompany(companyName, codePostal);
      if (!target) {
        return res.json({
          data: [],
          message: `Entreprise "${companyName}" introuvable`
        });
      }
    }

    // 2. Déterminer le NAF à utiliser
    if (nafCode && nafCode.trim()) {
      nafToUse = nafCode.trim();
    } else if (target && target.naf) {
      nafToUse = target.naf;
    } else {
      return res.status(400).json({
        error: "Impossible de déterminer un code NAF (ni nafCode fourni, ni NAF trouvé pour l'entreprise)",
        data: []
      });
    }

    // 3. Recherche automatique de codes postaux
    const rayonKm = 100;
    log(`🔍 Recherche d'entreprises (NAF ${nafToUse}) dans un rayon de ${rayonKm}km autour de ${codePostal}...`);
    const codesPostauxRayon = await getCodesPostauxRayon(codePostal, rayonKm);
    log(`📍 Codes postaux trouvés: ${codesPostauxRayon.length}`);

    // 4. Récupère tous les établissements du secteur
    let similarRaw = await searchEntreprisesByCodesPostaux(codesPostauxRayon, nafToUse, 200);

    const similar = similarRaw.map(c => ({
      nom: c.nom_complet || c.nom_raison_sociale || "Nom inconnu",
      siren: c.siren,
      naf: c.activite_principale,
      secteur: c.libelle_activite_principale || "",
      adresse: c.siege?.adresse || "",
      code_postal: c.siege?.code_postal || "",
      ville: c.siege?.commune || "",
      latitude: c.siege?.latitude || null,
      longitude: c.siege?.longitude || null,
      site_web: null,
      telephone: null,
      contacts: []
    }));

    const entreprisesARetenir = similar
      .filter(c => !target ||c.siren !== target.siren)
      .slice(0, 15);

    if (!similar.length) {
      return res.json({
        data: [{ ...target, contacts: [] }],
        message: "Aucune entreprise trouvée dans le rayon"
      });
    }

    log(`🎯 Enrichissement de ${entreprisesARetenir.length} entreprises...`);

    const enriched = [];
    for (const company of entreprisesARetenir) {
      // 3a. Google Maps: site web + téléphone
      const googleData = await enrichWithGoogleMaps(
        company.nom,
        company.naf,
        company.ville
      );
      if (googleData) {
        company.site_web = googleData.site_web;
        company.telephone = googleData.telephone;
        company.adresse_complete = googleData.adresse_complete;
      }

      // 3b. ENRICHISSEMENT 100% GRATUIT SANS COMPTE
      let contacts = await completelyFreeEnrichment(company);

      company.contacts = contacts;

      enriched.push({
        ...company,
        sources: [
          "API Recherche",
          googleData ? "Google Maps" : null,
          contacts.some(c => c.source === "Dropcontact") ? "Dropcontact" : null,
          contacts.some(c => c.source?.includes("Scraping")) ? "Web Scraping" : null,
          contacts.some(c => c.source?.includes("FullEnrich")) ? "FullEnrich" : null
        ].filter(Boolean)
      });
      await new Promise(r => setTimeout(r, 500));
    }

    log("══════════════════════════════════════");
    log(`✅ ${enriched.length} entreprises enrichies`);
    log(`📧 ${enriched.filter(e => e.contacts.length > 0).length} avec contacts`);
    log(`🎯 ${enriched.reduce((acc, e) => acc + e.contacts.length, 0)} contacts au total`);
    log("══════════════════════════════════════");

    return res.json({
      data: enriched,
      target: target,
      total: similar.length,
      message: `${enriched.length} entreprises enrichies avec ${enriched.reduce((acc, e) => acc + e.contacts.length, 0)} contacts`
    });

  } catch (err) {
    errlog("❌ Erreur /prospect:", err.message);
    return res.status(500).json({ 
      error: "Erreur serveur",
      data: []
    });
  }
});

// ===================================
// ENDPOINT DÉDIÉ : ENRICHIR UN CONTACT AVEC FULLENRICH
// ===================================
app.post("/enrich-contact", async (req, res) => {
  const { firstname, lastname, company_name, domain, linkedin_url } = req.body || {};

  if (!FULLENRICH_API_KEY) {
    return res.status(400).json({ error: "FULLENRICH_API_KEY manquante", data: [] });
  }

  if (!firstname || !lastname) {
    return res.status(400).json({ error: "firstname et lastname sont requis pour FullEnrich", data: [] });
  }

  if (!domain && !company_name && !linkedin_url) {
    return res.status(400).json({ error: "Au moins domain, company_name ou linkedin_url doit être fourni", data: [] });
  }

  try {
    log("══════════════════════════════════════");
    log("💰 ENRICHISSEMENT PERSONNE FULLENRICH");
    log("Prénom:", firstname, "Nom:", lastname);
    log("Société:", company_name, "Domaine:", domain);
    log("LinkedIn:", linkedin_url || "N/A");
    log("══════════════════════════════════════");

    // Payload EXACT doc FullEnrich (bulk)
    const payload = {
      name: `Enrich ${firstname} ${lastname} - ${company_name || domain || ""}`.substring(0, 100),
      webhook_url: "",
      datas: [
        {
          firstname,
          lastname,
          domain: domain || "",
          company_name: company_name || "",
          linkedin_url: linkedin_url || "",
          enrich_fields: [
            "contact.emails",
            "contact.personal_emails",
            "contact.phones"
          ],
          custom: {}
        }
      ]
    };

    log(` 💰 FullEnrich POST payload: ${JSON.stringify(payload).substring(0,1000)}`);
    let feRes = await fetch("https://app.fullenrich.com/api/v1/contact/enrich/bulk", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${FULLENRICH_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!feRes.ok) {
      const errorText = await feRes.text();
      warn(` ❌ FullEnrich HTTP ${feRes.status}: ${errorText}`);

      try {
        const parsed = JSON.parse(errorText || "{}");
        if (parsed.code && parsed.code.toString().toLowerCase().includes('enrich_fields')) {
          warn('  ℹ️ FullEnrich responded enrich_fields issue, retrying with fallback payload (root enrich_fields)');
          const fallback = { ...payload, enrich_fields: payload.datas?.[0]?.enrich_fields || [] };
          log(`  💬 FullEnrich retry payload: ${JSON.stringify(fallback).substring(0,1000)}`);
          feRes = await fetch("https://app.fullenrich.com/api/v1/contact/enrich/bulk", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${FULLENRICH_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify(fallback)
          });
        } else {
          return res.status(feRes.status).json({ error: "FullEnrich error", details: errorText, data: [] });
        }
      } catch (e) {
        return res.status(500).json({ error: "FullEnrich retry error", details: e.message, data: [] });
      }
    }

    if (!feRes.ok) {
      const errorText2 = await feRes.text();
      warn(` ❌ FullEnrich HTTP (after retry) ${feRes.status}: ${errorText2}`);
      return res.status(feRes.status).json({ error: "FullEnrich error", details: errorText2, data: [] });
    }

    const result = await feRes.json();
    log(` 💰 FullEnrich raw response: ${JSON.stringify(result).substring(0, 400)}`);

    const contacts = [];

    const records = Array.isArray(result.datas || result.results)
      ? (result.datas || result.results)
      : [];

    for (const rec of records) {
      const contactData = rec.contact || rec.enriched_contact || rec;

      if (!contactData) continue;

      const emails = [
        ...(contactData.emails || []),
        ...(contactData.personal_emails || [])
      ];

      for (const emailObj of emails) {
        const email =
          typeof emailObj === "string"
            ? emailObj
            : emailObj.email || emailObj.value || "";

        if (!email) continue;

        const contact = {
          nom: `${contactData.first_name || firstname} ${contactData.last_name || lastname}`.trim(),
          poste: contactData.title || contactData.position || "Poste non renseigné",
          email,
          telephone:
            (contactData.phones && contactData.phones[0]) ||
            contactData.phone ||
            "",
          linkedin: contactData.linkedin_url || linkedin_url || "",
          source: "FullEnrich",
          confidence: "high"
        };

        contacts.push(contact);
      }
    }

    log(` 💰 FullEnrich: ${contacts.length} contact(s) enrichi(s)`);
    return res.json({ ok: true, data: contacts });

  } catch (err) {
    warn(" ❌ FullEnrich /enrich-contact error:", err);
    return res.status(500).json({ error: "Erreur serveur FullEnrich", data: [] });
  }
});



// ===================================
// FONCTIONS GÉOGRAPHIQUES (TOP-LEVEL)
// ===================================
async function getCodesPostauxRayon(codePostal, rayonKm) {
  const geo = await fetch(`https://api-adresse.data.gouv.fr/search/?q=${codePostal}&limit=1`).then(r => r.json());
  if (!geo.features?.length) throw new Error('Code postal inconnu');
  const [lon, lat] = geo.features[0].geometry.coordinates;
  const rayonMetres = rayonKm * 1000;
  const communes = await fetch(`https://geo.api.gouv.fr/communes?lat=${lat}&lon=${lon}&radius=${rayonMetres}&fields=code,nom,codesPostaux&format=json&geometry=centre`).then(r => r.json());
  return [...new Set(communes.flatMap(c => c.codesPostaux))];
}

async function searchEntreprisesByCodesPostaux(codesPostaux, naf, limitTotal = 150) {
  const results = [];
  const seenSirens = new Set();

  const shuffled = [...codesPostaux.sort(() => Math.random() - 0.5)];

  for (const cp of shuffled) {
    if (results.length >= limitTotal) break;

    const limite = 50;
    const url = `https://recherche-entreprises.api.gouv.fr/search?activite_principale=${naf}&code_postal=${cp}&limite=${limite}`;

    try {
      const res = await fetch(url);
      if (!res.ok) continue;

      const json = await res.json();

      if (json.results?.length > 0) {
        for (const c of json.results) {
          if (!seenSirens.has(c.siren)) {
            seenSirens.add(c.siren);
            results.push(c);
            if (results.length >= limitTotal) break;
          }
        }
      }
    } catch (err) {
      // silencieux
    }

    await new Promise(r => setTimeout(r, 160));
  }

  log(`✅ ${results.length} entreprises uniques trouvées dans le rayon de 100 km`);
  return results;
}

// ===================================
// DÉMARRAGE DU SERVEUR
// ===================================
app.listen(PORT, () => {
  log("══════════════════════════════════════");
  log(`🚀 Serveur démarré sur http://localhost:${PORT}`);
  log("══════════════════════════════════════");
  log(`🗺️  GOOGLE_MAPS_API_KEY: ${GOOGLE_MAPS_API_KEY ? "✅ PRÊT" : "❌ MANQUANT"}`);
  log(`📧 HUNTER_API_KEY: ${HUNTER_API_KEY ? "✅ PRÊT" : "❌ MANQUANT (utilisation méthode gratuite)"}`);
  log(`💼 FULLENRICH_API_KEY: ${FULLENRICH_API_KEY ? "✅ PRÊT" : "❌ MANQUANT"}`);
  log("");
  log("🎯 STACK DE PROSPECTION 100% GRATUITE:");
  log("🎯 STACK DE PROSPECTION - DROPCONTACT:");
  log("   1. 📊 API Recherche Entreprises");
  log("   2. 🗺️  Google Maps Places (sites + téléphones)");
  log("   3. 🇫🇷 Dropcontact (solution française)");
  log("   4. 🌐 Web Scraping (emails site web)");
  log("   5. 💼 FullEnrich (option premium)");
  log("");
  log("⏱️  Temps estimé: ~5-15s par recherche");
  log("💰 Coûts:");
  log("   - Google Maps: ~$0.05/entreprise");
  log("   - Web Scraping: 100% GRATUIT");
  log("   - Pattern Detection: 100% GRATUIT");
  log("   - FullEnrich: Optionnel (votre abonnement)");
  log("");
  log("🎉 Prêt à prospecter !");
  log("══════════════════════════════════════");
});