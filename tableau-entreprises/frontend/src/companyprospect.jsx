import React, { useState, useMemo } from "react";

/*
  - Ce composant affiche la liste des sociétés et leurs contacts.
  - Points à vérifier :
    * Cohérence des noms de champs entre frontend (name,address,site,sector,contacts) et backend.
    * Si mapCompanyData change, adapter les clés ici.
    * Export CSV : attention aux caractères spéciaux / encodage (UTF-8 ok si header correct).
*/

export default function CompanyProspectList({ data = [] }) {
  const [query, setQuery] = useState("");
  const [openIdx, setOpenIdx] = useState(null);

  // Filtre local côté client
  const filtered = useMemo(() => {
    const q = String(query || "").toLowerCase().trim();
    if (!q) return data;
    return data.filter(
      (c) =>
        String(c.name || "").toLowerCase().includes(q) ||
        String(c.sector || "").toLowerCase().includes(q) ||
        String(c.site || "").toLowerCase().includes(q)
    );
  }, [data, query]);

  const toggle = (i) => setOpenIdx(openIdx === i ? null : i);

  const exportCSV = (list) => {
    const rows = [["Nom", "Adresse", "Secteur", "Site", "Contact", "Email", "Téléphone", "Source"]];
    list.forEach((c) => {
      if (!c.contacts || c.contacts.length === 0) {
        rows.push([c.name, c.address, c.sector, c.site, "", "", "", (c.sources || []).join(";")]);
      } else {
        c.contacts.forEach((ct, idx) => {
          rows.push([
            idx === 0 ? c.name : "",
            idx === 0 ? c.address : "",
            idx === 0 ? c.sector : "",
            idx === 0 ? c.site : "",
            ct.nom || "",
            ct.email || "",
            ct.telephone || "",
            (c.sources || []).join(";")
          ]);
        });
      }
    });
    // Attention : encoding CSV → UTF-8, retourne un blob ; bon pour téléchargement local
    const csv = rows.map((r) => r.map((v) => `"${String(v || "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "prospects.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!data || data.length === 0) {
    return (
      <div>
        <div style={{ marginBottom: 8 }}>
          <input
            placeholder="Filtrer (nom, secteur, site)..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ width: 320 }}
          />
        </div>
        <div>Aucun résultat</div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <input
          placeholder="Filtrer (nom, secteur, site)..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ width: 320 }}
        />
        <button style={{ marginLeft: 8 }} onClick={() => exportCSV(filtered)}>
          Export CSV
        </button>
      </div>

      <ul style={{ listStyle: "none", padding: 0 }}>
        {filtered.map((c, i) => (
          <li
            key={c.id || i}
            style={{
              border: "1px solid #ddd",
              padding: 10,
              marginBottom: 8,
              borderRadius: 4
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <strong>{c.name}</strong>{" "}
                <span style={{ color: "#666", marginLeft: 8 }}>{c.resume}</span>
                <div style={{ fontSize: 13, color: "#333" }}>{c.sector}</div>
                <div style={{ fontSize: 13, color: "#333" }}>{c.address}</div>
                {(c.site || c.telephone) && (
                <div style={{ fontSize: 13 }}>
                  {c.site && (
                    <a href={c.site.startsWith("http") ? c.site : `https://${c.site}`} target="_blank" rel="noreferrer">
                      {c.site}
                    </a>
                )}
                {c.telephone && (
                  <span style={{ marginLeft: 8 }}>
                    📞 {c.telephone}
                  </span>
              )}
            </div>
          )}

              </div>

              <div>
                <button onClick={() => toggle(i)}>{openIdx === i ? "Masquer" : "Voir contacts"}</button>
              </div>
            </div>

            {openIdx === i && (
              <div style={{ marginTop: 8, background: "#fafafa", padding: 8, borderRadius: 4 }}>
                {c.contacts && c.contacts.length > 0 ? (
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: "left", borderBottom: "1px solid #eee", padding: 6 }}>Nom</th>
                        <th style={{ textAlign: "left", borderBottom: "1px solid #eee", padding: 6 }}>Poste</th>
                        <th style={{ textAlign: "left", borderBottom: "1px solid #eee", padding: 6 }}>Email</th>
                        <th style={{ textAlign: "left", borderBottom: "1px solid #eee", padding: 6 }}>Téléphone</th>
                      </tr>
                    </thead>
                    <tbody>
                      {c.contacts.map((ct, ci) => (
                        <tr key={ci}>
                          <td style={{ padding: 6 }}>{ct.nom}</td>
                          <td style={{ padding: 6 }}>{ct.poste}</td>
                          <td style={{ padding: 6 }}>{ct.email}</td>
                          <td style={{ padding: 6 }}>{ct.telephone}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div>Aucun contact disponible</div>
                )}
                <div style={{ marginTop: 6, fontSize: 12, color: "#666" }}>Sources: {(c.sources || []).join(", ")}</div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}