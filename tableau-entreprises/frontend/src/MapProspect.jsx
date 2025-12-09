import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './MapProspect.css';

// Fix des icônes Leaflet
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

export default function MapProspects({ onSearch }) {
  const mapRef = useRef(null);
  const mapInstance = useRef(null);
  const markersRef = useRef([]);
  const [data, setData] = useState([]);
  const [filteredData, setFilteredData] = useState([]);
  const [companyName, setCompanyName] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [center, setCenter] = useState({ lat: 48.8566, lng: 2.3522 });
  const [filters, setFilters] = useState({
    radius: 100,
    hasEmail: false,
    hasPhone: false
  });
  const [favorites, setFavorites] = useState(() => {
    return new Set(JSON.parse(localStorage.getItem('favorites') || '[]'));
  });
  const [selectedCompany, setSelectedCompany] = useState(null);

  // Calcul distance (Haversine)
  const calculateDistance = (lat1, lon1, lat2, lon2) => {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  };

  const geocodePostal = async (cp) => {
    try {
      const res = await fetch(
        `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(cp)}&limit=1`
      );
      const json = await res.json();
      const feat = json.features?.[0];
      if (!feat) return null;
      const [lon, lat] = feat.geometry.coordinates;
      return { lat, lng: lon };
    } catch (error) {
      console.error('Erreur de géocodage:', error);
      return null;
    }
  };

  // util pour extraire prénom/nom à partir de "Prénom Nom"
      const splitName = (fullName = "") => {
        const parts = fullName.trim().split(" ");
        if (parts.length === 1) return { firstname: parts[0], lastname: "" };
        const firstname = parts[0];
        const lastname = parts.slice(1).join(" ");
        return { firstname, lastname };
      };

      // Détecte si l'input ressemble à un code NAF (ex: 47.52, 47.52A, 47.52B)
      const isNafInput = (s = "") => {
        if (!s || typeof s !== 'string') return false;
        const cleaned = s.trim().toUpperCase();
        // Formats possibles: "47.52", "47.52A", "4752" (rare)
        if (/^\d{2}[.,]?\d{2}[A-Z]?$/.test(cleaned)) return true;
        if (/^NAF[:\s]*\d{2}[.,]?\d{2}[A-Z]?$/.test(cleaned)) return true;
        return false;
      };

      // util pour extraire le domaine d'une URL
      const getDomainFromUrl = (url = "") => {
        if (!url) return "";
        try {
          const u = new URL(url.startsWith("http") ? url : `https://${url}`);
          return u.hostname.replace(/^www\./, "");
        } catch {
          return url.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
        }
      };

      // Appel de l'endpoint /enrich-contact pour un contact
      const enrichContactWithFullEnrich = async (company, contact) => {
        try {
          const { firstname, lastname } = splitName(contact.nom || contact.name || "");
          if (!firstname) {
            alert("Impossible d'enrichir: le contact n'a pas de nom.");
            return;
          }

          const domain = getDomainFromUrl(company.site);

          const res = await fetch("http://localhost:5000/enrich-contact", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              firstname,
              lastname,
              company_name: company.name,
              domain,
              linkedin_url: contact.linkedin || ""
            })
          });

          const data = await res.json();

          if (!res.ok) {
            alert(data.error || "Erreur FullEnrich");
            console.error("FullEnrich error:", data);
            return;
          }

          if (!data.data || data.data.length === 0) {
            alert("Aucune donnée supplémentaire trouvée par FullEnrich.");
            return;
          }

          const enriched = data.data[0];
          alert(
            `Enrichi :\n` +
            `Nom: ${enriched.nom}\n` +
            `Poste: ${enriched.poste}\n` +
            `Email: ${enriched.email || "N/A"}\n` +
            `Téléphone: ${enriched.telephone || "N/A"}`
          );
        } catch (err) {
          console.error("Erreur enrich-contact:", err);
          alert("Erreur réseau FullEnrich");
        }
      };

      // Manuel: lance l'enrichissement FullEnrich sur un nombre limité de contacts (évite boucle automatique)
      const startAutoEnrich = async (limit = 8) => {
        let enrichedCount = 0;
        for (const company of data) {
          if (!company || !company.contacts || company.contacts.length === 0) continue;

          for (const contact of company.contacts) {
            // n'enrichit que les contacts sans email ni téléphone pour limiter les appels
            const hasEmail = contact.email && contact.email.trim().length > 0;
            const hasPhone = contact.telephone && contact.telephone.toString().replace(/\D/g,'').length > 0;
            if (hasEmail || hasPhone) continue;

            if (enrichedCount >= limit) return;
            await enrichContactWithFullEnrich(company, contact);
            enrichedCount += 1;
            await new Promise(r => setTimeout(r, 400));
          }
        }
      };

      // Exporte les favoris en CSV
      const exportFavoritesToCSV = () => {
        if (!data || data.length === 0 || favorites.size === 0) {
          alert("Aucun favori à exporter.");
          return;
        }

        // Récupère les entreprises dont le siren est dans favorites
        const favCompanies = data.filter(c => favorites.has(c.siren));

        if (favCompanies.length === 0) {
          alert("Aucun favori à exporter.");
          return;
        }

        // Colonnes de ton CSV
        const headers = [
          "SIREN",
          "Nom",
          "Adresse",
          "Code postal",
          "Ville",
          "NAF",
          "Secteur",
          "Site web",
          "Téléphone",
          "Nb contacts",
          "Emails contacts",
        ];

        const rows = favCompanies.map(c => {
          const contactEmails = (c.contacts || [])
            .map(ct => ct.email)
            .filter(Boolean)
            .join(" | ");

          return [
            c.siren || "",
            c.name || "",
            c.adresse || c.address || "",
            c.code_postal || "",
            c.ville || "",
            c.naf || "",
            c.sector || "",
            c.site || "",
            c.telephone || "",
            (c.contacts || []).length.toString(),
            contactEmails,
          ];
        });

        // Construire le CSV
        const csvContent =
          [headers, ...rows]
            .map(row =>
              row
                .map(value => {
                  const v = (value ?? "").toString().replace(/"/g, '""');
                  return `"${v}"`;
                })
                .join(";")
            )
            .join("\n");

        const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);

        const link = document.createElement("a");
        link.href = url;
        const date = new Date().toISOString().slice(0, 10);
        link.download = `prospects_favoris_${date}.csv`;
        link.click();

        URL.revokeObjectURL(url);
      };



  // FONCTION DE RECHERCHE UNIFIÉE
  const handleSearch = async (e) => {
    if (e) e.preventDefault();

    if (!companyName || !postalCode) {
      setError('Nom et code postal requis');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // 1. GÉOCODAGE D'ABORD pour avoir un centre précis
      const centerFromCp = await geocodePostal(postalCode);
      if (!centerFromCp) {
        setError('Code postal introuvable');
        setLoading(false);
        return;
      }
      
      setCenter(centerFromCp);

      // 2. Appel backend
      // Si l'utilisateur a entré un code NAF dans le champ principal, on l'envoie
      const nafValue = isNafInput(companyName) ? companyName.trim().toUpperCase().replace(',', '.') : null;

      const res = await fetch('http://localhost:5000/prospect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyName: isNafInput(companyName) ? '' : companyName,
          nafCode: nafValue,
          postalCode,
          radiusKm: filters.radius || 100,
        }),
      });

      const text = await res.text();
      let js = null;
      try {
        js = text ? JSON.parse(text) : null;
      } catch (parseErr) {
        setError(`Réponse inattendue du serveur (status ${res.status})`);
        setLoading(false);
        return;
      }

      if (!res.ok) {
        setError(js?.error || `Erreur serveur (${res.status})`);
        setLoading(false);
        return;
      }

      // util pour extraire prénom/nom à partir de "Prénom Nom"


      // 3. Mapping des entreprises
      const companies = (js.data || []).map((c, i) => ({
        id: i,
        name: c.nom || c.nom_entreprise || "Inconnu",
        address: c.adresse || c.adresse_siege || "",
        sector: c.secteur || c.libelle_activite_principale || c.libelle_naf || "",
        site: c.site_web || c.site || "",
        telephone: c.telephone || "",
        // Les contacts sont déjà limités et traités par le backend (pas besoin de processContacts ici)
        contacts: c.contacts || [],
        latitude: c.latitude || c.lat || null,
        longitude: c.longitude || c.lng || null,
        ville: c.ville || "",
        code_postal: c.code_postal || "",
        adresse: c.adresse || "",
        naf: c.naf || c.activite_principale || "",
        siren: c.siren || `temp-${i}`,
      }));

      // Option : lancer FullEnrich automatiquement sur chaque contact
      const autoEnrich = async () => {
        for (const company of companies) {
          if (!company.site || !company.contacts || company.contacts.length === 0) continue;

          for (const contact of company.contacts) {
            // tu peux mettre des conditions si tu veux éviter de tout enrichir
            // ex : si pas d'email ou pas de téléphone
            // if (contact.email && contact.telephone) continue;

            await enrichContactWithFullEnrich(company, contact);
            // éventuellement un petit délai pour ne pas spammer l’API
            await new Promise(r => setTimeout(r, 300));
          }
        }
      };

      // Ne lance pas automatiquement l'enrichissement FullEnrich en frontend
      // (le backend s'en charge déjà lors de la requête /prospect)

      setData(companies);

      // 4. FILTRAGE UNIFIÉ avec toutes les conditions
      const filtered = companies.filter(company => {
        // Vérification des coordonnées
        const lat = parseFloat(company.latitude);
        const lng = parseFloat(company.longitude);
        if (!lat || !lng || isNaN(lat) || isNaN(lng)) return false;

        // Filtre distance
        const distance = calculateDistance(centerFromCp.lat, centerFromCp.lng, lat, lng);
        if (distance > filters.radius) return false;

        // Filtre email
        if (filters.hasEmail && (!company.contacts || !company.contacts.some(c => c.email))) {
          return false;
        }

        // Filtre téléphone
        if (filters.hasPhone && !company.telephone && (!company.contacts || !company.contacts.some(c => c.telephone))) {
          return false;
        }

        return true;
      });

      setFilteredData(filtered);

      // 5. Centrage de la carte sur le CP géocodé
      if (mapInstance.current) {
        mapInstance.current.setView([centerFromCp.lat, centerFromCp.lng], 11);
      }

    } catch (err) {
      setError(err.message || 'Erreur réseau');
    } finally {
      setLoading(false);
    }
  };

  // APPLY FILTERS - seulement pour les filtres appliqués après la recherche
  const applyFilters = () => {
    if (data.length === 0) {
      setFilteredData([]);
      return;
    }

    const filtered = data.filter(company => {
      const lat = parseFloat(company.latitude);
      const lng = parseFloat(company.longitude);
      
      if (!lat || !lng) return false;

      // Filtre distance (utilise le centre actuel)
      const distance = calculateDistance(center.lat, center.lng, lat, lng);
      if (distance > filters.radius) return false;

      // Filtre email
      if (filters.hasEmail && (!company.contacts || !company.contacts.some(c => c.email))) {
        return false;
      }

      // Filtre téléphone
      if (filters.hasPhone && !company.telephone && (!company.contacts || !company.contacts.some(c => c.telephone))) {
        return false;
      }

      return true;
    });

    setFilteredData(filtered);
  };

  // Applique les filtres quand ils changent
  useEffect(() => {
    if (data.length > 0) {
      applyFilters();
    }
  }, [filters, center]);

  // Initialise la carte Leaflet
  useEffect(() => {
    if (!mapRef.current || mapInstance.current) return;

    mapInstance.current = L.map(mapRef.current).setView([center.lat, center.lng], 6);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(mapInstance.current);

    // Nettoyage
    return () => {
      if (mapInstance.current) {
        mapInstance.current.remove();
        mapInstance.current = null;
      }
    };
  }, []);

  // Crée les markers
  useEffect(() => {
    if (!mapInstance.current) return;

    // Nettoie anciens markers
    markersRef.current.forEach(m => mapInstance.current.removeLayer(m));
    markersRef.current = [];

    if (filteredData.length === 0) return;

    const bounds = [];
    const seenAddresses = new Map();

    filteredData.forEach(company => {
      const lat = parseFloat(company.latitude);
      const lng = parseFloat(company.longitude);

      if (!lat || !lng || isNaN(lat) || isNaN(lng)) return;

      // Déduplication
      const addressKey = `${lat.toFixed(4)},${lng.toFixed(4)}`;
      if (seenAddresses.has(addressKey)) return;
      seenAddresses.set(addressKey, true);

      // Icône personnalisée selon la charte graphique
      const hasContacts = company.contacts && company.contacts.length > 0;
      const isFavorite = favorites.has(company.siren);
      
      // Couleurs selon la charte graphique
      let iconColor, textColor, symbol;
      
      if (isFavorite) {
        iconColor = '#00FF89'; // Vert pour les favoris
        textColor = '#000000'; // Texte noir sur fond vert
        symbol = '★';
      } else if (hasContacts) {
        iconColor = '#000000'; // Noir pour les entreprises avec contacts
        textColor = '#00FF89'; // Texte vert sur fond noir
        symbol = 'E';
      } else {
        iconColor = '#000000'; // Noir pour les entreprises sans contacts
        textColor = '#FFFFFF'; // Texte blanc sur fond noir
        symbol = '!';
      }

      const iconSize = isFavorite ? 32 : 24;
      const borderWidth = isFavorite ? 3 : 2;

      const customIcon = L.divIcon({
        className: 'custom-leaflet-marker',
        html: `
            <div style="
            background: ${iconColor};
            width: ${iconSize}px;
            height: ${iconSize}px;
            border-radius: 0;
            border: ${borderWidth}px solid #000000;
            display: flex;
            align-items: center;
            justify-content: center;
            font-family: 'DM Mono', monospace;
            font-weight: 500;
            color: ${textColor};
            font-size: ${iconSize * 0.5}px;
            line-height: 1;
            transform: translate(-50%, -50%);
            ">
            ${symbol}
            </div>
        `,
        iconSize: [iconSize, iconSize],
        iconAnchor: [iconSize/2, iconSize/2],
        popupAnchor: [0, -iconSize/2]
        });

      const marker = L.marker([lat, lng], { icon: customIcon })
        .addTo(mapInstance.current)
        .bindPopup(() => createPopupContent(company))
        .on('click', () => setSelectedCompany(company.siren));

      markersRef.current.push(marker);
      bounds.push([lat, lng]);
    });

    // Ajuste le zoom
    if (bounds.length > 0) {
      mapInstance.current.fitBounds(bounds, { padding: [50, 50] });
    }
  }, [filteredData, favorites]);



   
  // Popup personnalisée COMPACTE
  const createPopupContent = (company) => {
    const popupContainer = document.createElement('div');
    popupContainer.className = 'leaflet-popup-content-custom';
    
    const renderPopupContent = () => {
        return `
        <div class="compact-popup">
            <h3 class="popup-title">${company.name || company.nom || 'Entreprise'}</h3>
            
            <div class="popup-section">
            <strong>📍</strong> ${company.address || company.adresse || ''} ${company.code_postal || ''} ${company.ville || ''}
            </div>
            
            <div class="popup-section">
            <strong>🏢</strong> ${company.sector || company.secteur || 'Non renseigné'}
            </div>
            
            ${company.site || company.site_web ? `
            <div class="popup-section">
                <strong>🌐</strong> 
                <a href="${company.site || company.site_web}" target="_blank" class="popup-link">
                Site web
                </a>
            </div>
            ` : ''}
            
            ${company.telephone ? `
            <div class="popup-section">
                <strong>📞</strong> 
                <a href="tel:${company.telephone}" class="popup-link">
                ${company.telephone} (Standard - ${company.ville || 'Entreprise'})
                </a>
            </div>
            ` : ''}
            
            <!-- SECTION CONTACTS COMPACTE -->
            <div class="contacts-section">
            ${company.contacts && company.contacts.length > 0 ? `
                <div class="contacts-dropdown">
                <label for="contact-select-${company.siren}">
                    <strong>👥 Contacts (${company.contacts.length})</strong>
                </label>
                <select 
                    id="contact-select-${company.siren}" 
                    class="contact-select"
                    onchange="handleContactSelect(this, '${company.siren}')"
                >
                    <option value="">Sélectionner un contact</option>
                    ${company.contacts.map((contact, index) => `
                    <option value="${index}" data-contact='${JSON.stringify(contact).replace(/'/g, "&#39;")}'>
                        ${contact.nom} - ${contact.poste}
                    </option>
                    `).join('')}
                </select>
                
                <div id="contact-details-${company.siren}" class="contact-details"></div>
                </div>
            ` : '<div class="no-contacts">Aucun contact</div>'}
            </div>
        </div>
        `;
    };
    popupContainer.innerHTML = renderPopupContent();

    // Attendre que le DOM soit mis à jour avant d'ajouter les écouteurs
    setTimeout(() => {
      // Fonction pour gérer la sélection des contacts
      window.handleContactSelect = function(selectElement, siren) {
        const selectedIndex = selectElement.value;
        const detailsDiv = document.getElementById(`contact-details-${siren}`);
        
        if (selectedIndex && selectedIndex !== '') {
          const option = selectElement.options[selectElement.selectedIndex];
          const contact = JSON.parse(option.getAttribute('data-contact').replace(/&#39;/g, "'"));
          
          detailsDiv.innerHTML = `
            <div class="selected-contact">
              <div class="contact-header">
                <strong>${contact.nom}</strong>
                <span class="confidence-badge ${contact.confidence}">
                  ${contact.confidence === 'high' ? 'Élevée' : contact.confidence === 'medium' ? 'Moyenne' : 'Faible'}
                </span>
              </div>
              <div class="contact-info">${contact.poste}</div>
              ${contact.email ? `
                <div class="contact-action">
                  <a href="mailto:${contact.email}" class="btn-email" target="_blank">
                    📧 ${contact.email}
                  </a>
                </div>
              ` : ''}
              ${contact.telephone ? `
                <div class="contact-action">
                  <a href="tel:${contact.telephone}" class="btn-call">
                    📞 ${contact.telephone}
                  </a>
                </div>
              ` : ''}
              ${contact.linkedin ? `
                <div class="contact-action">
                  <a href="${contact.linkedin}" class="btn-linkedin" target="_blank">
                    🔗 LinkedIn
                  </a>
                </div>
              ` : ''}
              <div class="contact-source">Source: ${contact.source}</div>
            </div>
          `;
          detailsDiv.style.display = 'block';
        } else {
          detailsDiv.style.display = 'none';
        }
      };
    }, 100);

    return popupContainer;
  };

  // Toggle favoris
  const toggleFavorite = (siren) => {
    const newFavorites = new Set(favorites);
    if (newFavorites.has(siren)) {
      newFavorites.delete(siren);
    } else {
      newFavorites.add(siren);
    }
    setFavorites(newFavorites);
    localStorage.setItem('favorites', JSON.stringify([...newFavorites]));
  };

  const focusOnCompany = (company) => {
    if (!company || !mapInstance.current) return;

    const lat = parseFloat(company.latitude);
    const lng = parseFloat(company.longitude);
    
    if (!lat || !lng || isNaN(lat) || isNaN(lng)) return;

    setTimeout(() => {
      mapInstance.current.options.zoomAnimation = false;
      mapInstance.current.setView([lat, lng], 15);
      
      setTimeout(() => {
        mapInstance.current.options.zoomAnimation = true;
        
        const companyMarker = markersRef.current.find(marker => {
          const markerLatLng = marker.getLatLng();
          const latDiff = Math.abs(markerLatLng.lat - lat);
          const lngDiff = Math.abs(markerLatLng.lng - lng);
          return latDiff < 0.0001 && lngDiff < 0.0001;
        });

        if (companyMarker) {
          markersRef.current.forEach(marker => {
            if (marker !== companyMarker && marker.isPopupOpen()) {
              marker.closePopup();
            }
          });
          
          setTimeout(() => {
            companyMarker.openPopup();
          }, 100);
        }
      }, 50);
    }, 500);
  };

  return (
    <div className="prospect-layout">
      {/* Sidebar principal */}
      <div id="sidebar">
        <div className="sidebar-center">
          {/* Titre de section */}
          <h2 className="section-title">SalesPropstect</h2>

          {/* Formulaire de recherche */}
          <form className="panel-content" onSubmit={handleSearch}>
            <div id="search-container">
              <input
                id="search-input"
                type="text"
                placeholder="Ex: Castorama ou 47.52A (NAF)"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
              />
            </div>
            <div id="search-container">
              <input
                id="search-input"
                type="text"
                placeholder="Ex: 75015"
                value={postalCode}
                onChange={(e) => setPostalCode(e.target.value)}
              />
            </div>

            {/* Filtre rayon avec slider */}
            <div id="association-distance-filter">
              <div className="capacity-filter-title">
                Rayon de recherche : {filters.radius} km
              </div>
              <div className="capacity-filter-controls">
                <input
                  type="range"
                  min="1"
                  max="500"
                  value={filters.radius}
                  onChange={(e) =>
                    setFilters({
                      ...filters,
                      radius: parseInt(e.target.value, 10),
                    })
                  }
                  className="capacity-range"
                  id="distance-slider"
                  style={{
                    "--progress": `${(filters.radius / 500) * 100}%`,
                  }}
                />
              </div>
              <div className="slider-labels">
                <span>1 km</span>
                <span>500 km</span>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="btn btn-primary" type="submit" disabled={loading}>
                {loading ? "🔄 Recherche..." : "Rechercher"}
              </button>
            </div>
          </form>

          {error && <div className="error-message">{error}</div>}

          {/* Filtres simplifiés */}
          <div className="filters-section">
            <div className="filter-toggle-group">
              <label className="filter-toggle-label" htmlFor="toggle-email">
                Avec email
              </label>
              <input
                type="checkbox"
                id="toggle-email"
                className="filter-toggle-radio"
                checked={!!filters.hasEmail}
                onChange={(e) =>
                  setFilters({ ...filters, hasEmail: e.target.checked })
                }
              />
            </div>

            <div className="filter-toggle-group">
              <label className="filter-toggle-label" htmlFor="toggle-phone">
                Avec téléphone
              </label>
              <input
                type="checkbox"
                id="toggle-phone"
                className="filter-toggle-radio"
                checked={!!filters.hasPhone}
                onChange={(e) =>
                  setFilters({ ...filters, hasPhone: e.target.checked })
                }
              />
            </div>

            <button
              type="button"
              className="export-csv-button"
              onClick={exportFavoritesToCSV}
            >
              Exporter les favoris en CSV
            </button>

          </div>

          {/* Liste des entreprises */}
          <div className="transaction-list">
            {filteredData.length === 0 && !loading && (
              <div className="no-results">Aucune entreprise trouvée</div>
            )}

            {filteredData
              .sort((a, b) => {
                const aIsFavorite = favorites.has(a.siren);
                const bIsFavorite = favorites.has(b.siren);

                if (aIsFavorite && !bIsFavorite) return -1;
                if (!aIsFavorite && bIsFavorite) return 1;
                return 0;
              })
              .map((company, i) => (
                <div
                  className={`transaction-card${
                    selectedCompany === company.siren ? " selected" : ""
                  }${favorites.has(company.siren) ? " favori" : ""}`}
                  key={i}
                  onClick={() => {
                    setSelectedCompany(company.siren);
                    focusOnCompany(company);
                  }}
                >
                  <div className="transaction-header">
                    <span className="card-title">
                      {company.name || company.nom}
                    </span>
                    <button
                      className="favorite-btn"
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleFavorite(company.siren);
                      }}
                    >
                      {favorites.has(company.siren) ? "★" : "☆"}
                    </button>
                  </div>

                  <div className="card-details">
                    <div>📍 {company.ville}</div>
                    <div>🏢 {company.sector || company.secteur}</div>

                    {/* Indication simple qu'il existe des contacts */}
                    {company.contacts && company.contacts.length > 0 && (
                      <div className="contact-summary">
                        👥 Contacts disponibles
                      </div>
                    )}

                    {/* Téléphone direct de l'entreprise si disponible */}
                    {company.telephone && (
                      <div className="company-direct-phone">
                        📞{" "}
                        <a
                          href={`tel:${company.telephone}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {company.telephone}
                        </a>
                      </div>
                    )}
                  </div>
                </div>
              ))}
          </div>
        </div>
      </div>

      {/* Carte interactive */}
      <div id="map" ref={mapRef}></div>
    </div>
  );
  }