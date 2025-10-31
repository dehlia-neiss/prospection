import React, { useState } from "react";
import CompanyProspectList from "./companyprospect";

/*
  Composant principal :
  - mapCompanyData : normalize la réponse backend pour l'UI.
  - handleSearch : envoie POST /prospect et parse la réponse.
  Points à vérifier :
  - L'URL "http://localhost:5000/prospect" doit correspondre au port du backend.
  - CORS : le backend doit autoriser http://localhost:3000.
  - Si le backend renvoie du HTML d'erreur, JSON.parse échouera -> on affiche une erreur lisible.
  - Le frontend exige companyName + postalCode : si tu veux FullEnrich-only, adapter le body (site au lieu de location).
*/

export default function App() {
  const [companyName, setCompanyName] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const mapCompanyData = (rawData = []) =>
    (rawData || []).map((c, i) => ({
      id: i,
      // Uniformiser les clés (attention aux noms renvoyés par le backend)
      name: c.nom || c.nom_entreprise || "Inconnu",
      address: c.adresse || c.adresse_siege || "",
      sector: c.secteur || c.libelle_naf || "",
      resume: c.resume || "",
      // FRONT <-> BACK contract : le backend renvoie `site_web` ; on mappe en `site`
      site: c.site_web || c.site || "",
      contacts: c.contacts || [],
      sources: c.sources || []
    }));

  async function handleSearch(e) {
    if (e && e.preventDefault) e.preventDefault();
    console.debug("Lancement recherche:", { companyName, postalCode });
    setError(null);
    if (!companyName || !postalCode) {
      setError("Nom et code postal requis"); // UX : adapter si mode FullEnrich only
      return;
    }
    setLoading(true);
    setData([]);
    try {
      // Vérifier que le backend est bien accessible et CORS ok
      const res = await fetch("http://localhost:5000/prospect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyName, location: postalCode }) // contrat request attendu côté backend
      });

      // Lecture en texte pour diagnostiquer si le backend renvoie autre chose que du JSON
      const text = await res.text().catch(() => "");
      console.debug("Réponse HTTP:", res.status, "Content-Type:", res.headers.get("content-type"));
      console.debug("Corps brut (début):", (text || "").slice(0, 1000));

      let js = null;
      try {
        js = text ? JSON.parse(text) : null;
      } catch (parseErr) {
        // Erreur fréquente : backend renvoie HTML (404/500) — informer l'utilisateur et regarder les logs backend
        console.error("Impossible de parser le JSON:", parseErr);
        setError(`Réponse inattendue du serveur (status ${res.status}). Voir console pour le corps brut.`);
        setLoading(false);
        return;
      }

      if (!res.ok) {
        // backend peut renvoyer { error: "..." }
        setError(js?.error || `Erreur serveur (${res.status})`);
        setLoading(false);
        return;
      }

      const mapped = mapCompanyData(js.data || []);
      console.debug("Données mappées:", mapped.length, mapped.slice(0, 2));
      setData(mapped);
    } catch (err) {
      console.error("handleSearch erreur:", err);
      setError(err.message || "Erreur réseau");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ padding: 16, fontFamily: "Arial, sans-serif" }}>
      <h2>Prospection</h2>
      <form onSubmit={handleSearch} style={{ marginBottom: 12 }}>
        <input
          placeholder="Nom entreprise (ex: Castorama)"
          value={companyName}
          onChange={(e) => setCompanyName(e.target.value)}
          style={{ marginRight: 8 }}
        />
        <input
          placeholder="Code postal (ex: 75015)"
          value={postalCode}
          onChange={(e) => setPostalCode(e.target.value)}
          style={{ marginRight: 8, width: 110 }}
        />
        <button type="submit" disabled={loading}>
          {loading ? "Recherche..." : "Rechercher"}
        </button>
      </form>

      {error && <div style={{ color: "crimson", marginBottom: 8 }}>{error}</div>}

      <CompanyProspectList data={data} />
    </div>
  );
}