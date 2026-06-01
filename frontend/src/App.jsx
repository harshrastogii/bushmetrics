import { useEffect, useState } from "react";
import { MapContainer, TileLayer, GeoJSON } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { getBioregions } from "./api";
import "./App.css";

// Colour a region by its protection percentage (red = low, green = high)
function colorFor(pct) {
  if (pct >= 25) return "#1a9850";
  if (pct >= 15) return "#91cf60";
  if (pct >= 7)  return "#d9ef8b";
  if (pct >= 2)  return "#fee08b";
  if (pct >= 0.5) return "#fc8d59";
  return "#d73027";
}

export default function App() {
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    getBioregions().then(setData).catch((e) => setError(e.message));
  }, []);

  const styleFn = (feature) => ({
    fillColor: colorFor(feature.properties.pct_protected),
    weight: 1,
    color: "#444",
    fillOpacity: 0.75,
  });

  const onEach = (feature, layer) => {
    layer.on({
      click: () => setSelected(feature.properties),
      mouseover: (e) => e.target.setStyle({ weight: 3, color: "#000" }),
      mouseout: (e) => e.target.setStyle({ weight: 1, color: "#444" }),
    });
  };

  return (
    <div className="app">
      <header>
        <h1>Northern Territory — Protected Area Coverage</h1>
        <p>Click a bioregion to see how much of it is protected.</p>
      </header>

      <div className="layout">
        <div className="map-wrap">
          {error && <div className="error">Error: {error} — is the API running on port 8000?</div>}
          <MapContainer center={[-19.5, 133.5]} zoom={5} style={{ height: "100%", width: "100%" }}>
            <TileLayer
              url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
              attribution="&copy; OpenStreetMap &copy; CARTO"
            />
            {data && <GeoJSON data={data} style={styleFn} onEachFeature={onEach} />}
          </MapContainer>
        </div>

        <aside className="panel">
          {selected ? (
            <>
              <h2>{selected.GEO_ZONE}</h2>
              <div className="stat"><span>Protected</span><strong>{selected.pct_protected.toFixed(1)}%</strong></div>
              <div className="stat"><span>Total area</span><strong>{Math.round(selected.total_km2).toLocaleString()} km²</strong></div>
              <div className="stat"><span>Protected area</span><strong>{Math.round(selected.protected_km2).toLocaleString()} km²</strong></div>
              <div className="stat"><span>Hot/cold spot</span><strong>{selected.gi_class}</strong></div>
            </>
          ) : (
            <p className="hint">Select a bioregion on the map.</p>
          )}

          <div className="legend">
            <h3>% Protected</h3>
            {[[">= 25", "#1a9850"], ["15–25", "#91cf60"], ["7–15", "#d9ef8b"],
              ["2–7", "#fee08b"], ["0.5–2", "#fc8d59"], ["< 0.5", "#d73027"]].map(([label, c]) => (
              <div className="legend-row" key={label}>
                <span className="swatch" style={{ background: c }} /> {label}
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
