// google_hunter.js
import dotenv from "dotenv";
dotenv.config();

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const HUNTER_API_KEY = process.env.HUNTER_API_KEY;
const FULLENRICH_API_KEY = process.env.FULLENRICH_API_KEY;

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} - ${text}`);
  }
  return res.json();
}

// 1) Google Maps
async function searchCompanyOnGoogleMaps(name, postalCode) {
  if (!GOOGLE_MAPS_API_KEY) {
    console.warn("⚠️ GOOGLE_MAPS_API_KEY manquante");
    return null;
  }

  const query = `${name} ${postalCode} France`;
  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(
    query
  )}&key=${encodeURIComponent(GOOGLE_MAPS_API_KEY)}`;

  console.log("🔍 Google Maps query:", query);

  const json = await fetchJson(url);
  const first = (json.results || [])[0];

  if (!first) {
    console.warn("⚠️ Google Maps: aucun résultat");
    return null;
  }

  const place = {
    name: first.name,
    address: first.formatted_address,
    location: first.geometry?.location || null,
    place_id: first.place_id,
  };

  const detailsUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(
    place.place_id
  )}&fields=name,formatted_phone_number,website,geometry&key=${encodeURIComponent(
    GOOGLE_MAPS_API_KEY
  )}`;

  const detailsJson = await fetchJson(detailsUrl);

  const details = detailsJson.result || {};
  place.phone = details.formatted_phone_number || null;
  place.website = details.website || null;
  place.location = details.geometry?.location || place.location;

  console.log("📍 Google Maps résultat:");
  console.dir(place, { depth: null });

  return place;
}

// 2) Hunter
async function fetchEmailsFromHunter(website) {
  if (!HUNTER_API_KEY) {
    console.warn("⚠️ HUNTER_API_KEY manquante");
    return null;
  }
  if (!website) {
    console.warn("⚠️ Pas de site web → skip Hunter");
    return null;
  }

  const domain = website
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];

  console.log("📧 Hunter domaine:", domain);

  const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(
    domain
  )}&api_key=${encodeURIComponent(HUNTER_API_KEY)}&limit=10`;

  const json = await fetchJson(url);
  const data = json.data || null;
  if (!data) return null;

  const emails = (data.emails || []).map((e) => ({
    value: e.value,
    type: e.type,
    position: e.position,
    confidence: e.confidence,
    first_name: e.first_name,
    last_name: e.last_name,
    department: e.department,
  }));

  const result = {
    organization: data.organization,
    domain: data.domain,
    emails,
  };

  console.log("📧 Hunter résultats:");
  console.dir(result, { depth: null });

  return result;
}

// 3) FullEnrich - lancer enrichissement
async function enrichContactsWithFullEnrich(hunterContacts, company) {
  if (!FULLENRICH_API_KEY) {
    console.warn("⚠️ FULLENRICH_API_KEY manquante");
    return null;
  }

  if (!hunterContacts || hunterContacts.length === 0) {
    console.log("⚠️ Aucun contact Hunter à envoyer à FullEnrich");
    return null;
  }

  const candidates = hunterContacts.filter(
    (c) => c.first_name && c.last_name
  );

  if (candidates.length === 0) {
    console.log("⚠️ Aucun contact avec prénom + nom pour FullEnrich");
    return null;
  }

  const toEnrich = candidates.slice(0, 3);

  const url = "https://app.fullenrich.com/api/v1/contact/enrich/bulk";

  const body = {
    name: `Batch ${company.companyName || company.name || "unknown"} ${Date.now()}`,
    datas: toEnrich.map((c) => ({
      firstname: c.first_name,
      lastname: c.last_name,
      company_name: company.companyName || company.name || null,
      domain: company.domain || null,
      linkedin_url: null,
      enrich_fields: ["contact.emails", "contact.personal_emails", "contact.phones"],
    })),
  };

  console.log("\n📞 FullEnrich - envoi de contacts:");
  console.dir(body, { depth: null });

  try {
    const json = await fetchJson(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${FULLENRICH_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    console.log("\n📞 FullEnrich - réponse (création enrichissement):");
    console.dir(json, { depth: null });

    return json.enrichment_id || json.id || null;
  } catch (err) {
    console.error("❌ FullEnrich erreur:", err.message);
    return null;
  }
}

// 4) FullEnrich - récupérer le résultat
async function getFullEnrichResult(enrichmentId) {
  if (!FULLENRICH_API_KEY) return null;
  if (!enrichmentId) return null;

  const url = `https://app.fullenrich.com/api/v1/enrichment/${encodeURIComponent(
    enrichmentId
  )}`;

  console.log(`\n⏳ FullEnrich - récupération du résultat pour ${enrichmentId}...`);

  try {
    const json = await fetchJson(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${FULLENRICH_API_KEY}`,
        Accept: "application/json",
      },
    });

    console.log("\n📦 FullEnrich - résultat brut:");
    console.dir(json, { depth: null });

    const items = json.results || json.data || [];

    const contacts = items.map((item) => {
      const contact = item.contact || item;
      return {
        status: item.status || item.enriched_status || null,
        first_name: contact.first_name || null,
        last_name: contact.last_name || null,
        emails: contact.emails || contact.personal_emails || [],
        phones: contact.phones || [],
      };
    });

    console.log("\n🎯 Contacts enrichis FullEnrich (normalisés):");
    console.dir(contacts, { depth: null });

    return contacts;
  } catch (err) {
    console.error("❌ FullEnrich erreur (get result):", err.message);
    return null;
  }
}

// 5) Pipeline complet
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runPipeline(companyName, postalCode) {
  console.log("════════════════════════════════════");
  console.log("PROSPECTION (Google Maps → Hunter → FullEnrich)");
  console.log(`Entreprise: ${companyName}`);
  console.log(`Code postal: ${postalCode}`);
  console.log("════════════════════════════════════");

  try {
    const place = await searchCompanyOnGoogleMaps(companyName, postalCode);

    if (!place) {
      console.log("❌ Aucune entreprise trouvée sur Google Maps");
      return;
    }

    const hunter = await fetchEmailsFromHunter(place.website);

    const prospect = {
      companyName: place.name,
      address: place.address,
      lat: place.location?.lat,
      lng: place.location?.lng,
      phone: place.phone,
      website: place.website,
      domain: place.website
        ? place.website.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]
        : null,
      hunterEmails: hunter?.emails || [],
      fullenrichContacts: [],
    };

    console.log("\n🎯 Prospect (avant FullEnrich):");
    console.dir(prospect, { depth: null });

    const enrichmentId = await enrichContactsWithFullEnrich(
      prospect.hunterEmails,
      prospect
    );

    if (!enrichmentId) {
      console.log("⚠️ Pas d'enrichment_id retourné par FullEnrich");
      return;
    }

    // Attendre quelques secondes que FullEnrich traite
    await sleep(5000);

    const fullenrichContacts = await getFullEnrichResult(enrichmentId);
    prospect.fullenrichContacts = fullenrichContacts || [];

    console.log("\n✅ Prospect FINAL (avec FullEnrich):");
    console.dir(prospect, { depth: null });
  } catch (err) {
    console.error("❌ Erreur pipeline:", err.message);
  }
}

// Lancer avec: node google_hunter.js "Castorama" "75015"
const [,, nameArg, postalArg] = process.argv;

if (!nameArg || !postalArg) {
  console.log('Usage: node google_hunter.js "Nom Entreprise" "CodePostal"');
  process.exit(1);
}

runPipeline(nameArg, postalArg);
