// src/MapProspects.jsx
import React, { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Fix icônes Leaflet
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

export default function MapProspects({ data }) {
  const mapRef = useRef(null);
  const mapInstance = useRef(null);

  useEffect(() => {
    if (!mapRef.current || !data.length) return;

    // Init carte
    if (!mapInstance.current) {
      mapInstance.current = L.map(mapRef.current).setView([46.2276, 2.2137], 6); // France
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; OpenStreetMap',
      }).addTo(mapInstance.current);
    }

    const map = mapInstance.current;

    // Nettoie anciens points
    map.eachLayer((layer) => {
      if (layer instanceof L.Marker) map.removeLayer(layer);
    });

    // Ajoute points
    data.forEach((ent) => {
      if (!ent.adresse) return;

      // Extraire coordonnées (simulé ici, voir §3)
      const lat = ent.lat || 48.8566; // Paris par défaut
      const lng = ent.lng || 2.3522;

      const marker = L.marker([lat, lng]).addTo(map);

      const contactsHtml = ent.contacts
        .map(
          (c) => `
          <div class="p-2 border-b">
            <strong>${c.nom}</strong> - ${c.poste}<br>
            ${c.email ? `Email: ${c.email}<br>` : ""}
            ${c.telephone ? `Tel: ${c.telephone}<br>` : ""}
            ${c.linkedin ? `<a href="${c.linkedin}" target="_blank" class="text-blue-600">LinkedIn</a>` : ""}
          </div>
        `
        )
        .join("");

      marker.bindPopup(`
        <div class="p-3 max-w-xs">
          <h3 class="font-bold text-lg">${ent.nom}</h3>
          <p class="text-sm"><strong>Secteur:</strong> ${ent.secteur}</p>
          <p class="text-sm"><strong>Adresse:</strong> ${ent.adresse}</p>
          <p class="text-xs mt-2"><em>${ent.resume}</em></p>
          <div class="mt-3">
            <strong>Contacts :</strong>
            ${contactsHtml || "<p class='text-gray-500'>Aucun contact</p>"}
          </div>
          <a href="${ent.site_web}" target="_blank" class="block mt-2 text-blue-600 text-sm">Site web</a>
        </div>
      `);
    });

    return () => {
      if (mapInstance.current) {
        mapInstance.current.remove();
        mapInstance.current = null;
      }
    };
  }, [data]);

  return <div ref={mapRef} className="h-96 w-full rounded-xl shadow-lg border" />;
}