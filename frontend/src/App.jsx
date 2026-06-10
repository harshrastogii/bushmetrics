import { useEffect, useState } from "react";
import { MapContainer, TileLayer, GeoJSON } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { getBioregions } from "./api";
import "./App.css";

const NT_AVERAGE = 5.1;

function colorForPct(pct) {
  if (pct >= 25) return "#1a9850";
  if (pct >= 15) return "#91cf60";
  if (pct >= 7)  return "#d9ef8b";
  if (pct >= 2)  return "#fee08b";
  if (pct >= 0.5) return "#fc8d59";
  return "#d73027";
}
function colorForGi(gi) {
  if (gi === "Hot spot (high protection)") return "#c0392b";
  if (gi === "Cold spot (low protection)") return "#2980b9";
  return "#d5d5d5";
}
function verdict(pct) {
  if (pct >= 20) return { text: "Very well protected", tone: "good" };
  if (pct >= NT_AVERAGE) return { text: "Above the NT average", tone: "good" };
  if (pct >= 1) return { text: "Below the NT average — under-protected", tone: "warn" };
  return { text: "Almost no protection", tone: "bad" };
}

export default function App() {
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState("protection");

  useEffect(() => {
    getBioregions()
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, []);

  const styleFn = (feature) => {
    const p = feature.properties;
    const fill = view === "protection" ? colorForPct(p.pct_protected) : colorForGi(p.gi_class);
    return { fillColor: fill, weight: 1, color: "#444", fillOpacity: 0.75 };
  };
  const onEach = (feature, layer) => {
    layer.on({
      click: () => setSelected(feature.properties),
      mouseover: (e) => e.target.setStyle({ weight: 3, color: "#000" }),
      mouseout: (e) => e.target.setStyle({ weight: 1, color: "#444" }),
    });
  };
  const v = selected ? verdict(selected.pct_protected) : null;

  return (
    <div className="app">
      <header>
        <div className="header-text">
          <h1>Northern Territory — Protected Area Coverage</h1>
          <p className="lede">
            The NT protects its scenic northern country far more than its vast arid interior.
            This map shows how much of each region is inside a park or reserve.
          </p>
          <p className="sub">
            Based on 16,831 land-system polygons and 217 protected areas from the NT Open Data Portal.
          </p>
          <div className="toggle">
            <button className={view === "protection" ? "on" : ""} onClick={() => setView("protection")}>
              % Protected
            </button>
            <button className={view === "hotspot" ? "on" : ""} onClick={() => setView("hotspot")}>
              Statistical hot / cold spots
            </button>
          </div>
        </div>

        <div className="header-stats">
          <div className="hstat">
            <span className="hnum">{NT_AVERAGE}%</span>
            <span className="hlabel">Territory-wide average protection</span>
          </div>
          <div className="hstat best">
            <span className="hnum">33%</span>
            <span className="hlabel">Best protected — limestone hills</span>
          </div>
          <div className="hstat worst">
            <span className="hnum">0.6%</span>
            <span className="hlabel">Tanami — the NT's largest region</span>
          </div>
        </div>
      </header>

      <div className="layout">
        <div className="map-wrap">
          {loading && <div className="loading">Loading map data… (first load may take ~30s while the server wakes)</div>}
          {error && <div className="error">Error: {error}</div>}
          <MapContainer center={[-19.5, 133.5]} zoom={5} style={{ height: "100%", width: "100%" }}>
            <TileLayer
              url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
              attribution="&copy; OpenStreetMap &copy; CARTO"
            />
            {data && <GeoJSON key={view} data={data} style={styleFn} onEachFeature={onEach} />}
          </MapContainer>
        </div>

        <aside className="panel">
          {selected ? (
            <div className="detail">
              <h2>{selected.GEO_ZONE}</h2>
              <div className={`verdict ${v.tone}`}>{v.text}</div>
              <div className="hero-stat">
                <span className="num">{selected.pct_protected.toFixed(1)}</span>
                <span className="unit">%</span>
                <span className="caption">protected</span>
              </div>
              <div className="ref">NT-wide average is {NT_AVERAGE}%</div>
              <div className="stat"><span>Total area</span><strong>{Math.round(selected.total_km2).toLocaleString()} km²</strong></div>
              <div className="stat"><span>Protected area</span><strong>{Math.round(selected.protected_km2).toLocaleString()} km²</strong></div>
              <div className="stat"><span>Statistical cluster</span><strong>{selected.gi_class}</strong></div>
            </div>
          ) : (
            <p className="hint">👆 Click any region on the map to see its protection story.</p>
          )}

          <div className="explainer">
            <strong>What you're seeing</strong>
            {view === "protection" ? (
              <p>Each region is shaded by the share of its area inside a park or reserve.
              Green is well protected, red is barely protected. Most of the red sits in the arid south.</p>
            ) : (
              <p>Statistically significant clusters (Getis-Ord Gi*). Red regions sit in a
              neighbourhood of high protection, blue in a neighbourhood of low protection,
              grey shows no significant pattern.</p>
            )}
          </div>

          <div className="legend">
            <h3>{view === "protection" ? "% Protected" : "Gi* cluster"}</h3>
            {view === "protection"
              ? [[">= 25", "#1a9850"], ["15–25", "#91cf60"], ["7–15", "#d9ef8b"],
                 ["2–7", "#fee08b"], ["0.5–2", "#fc8d59"], ["< 0.5", "#d73027"]].map(([label, c]) => (
                  <div className="legend-row" key={label}><span className="swatch" style={{ background: c }} /> {label}</div>
                ))
              : [["Hot spot (high)", "#c0392b"], ["Cold spot (low)", "#2980b9"], ["Not significant", "#d5d5d5"]].map(([label, c]) => (
                  <div className="legend-row" key={label}><span className="swatch" style={{ background: c }} /> {label}</div>
                ))}
          </div>

          <div className="footer-note">
            Full analysis (clustering, spatial statistics) and methodology on{" "}
            <a href="https://github.com/harshrastogii/nt-protected-areas" target="_blank" rel="noreferrer">GitHub</a>.
          </div>
        </aside>
      </div>
    </div>
  );
}
