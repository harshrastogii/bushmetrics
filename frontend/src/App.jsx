import { useEffect, useState, useRef } from "react";
import { MapContainer, TileLayer, GeoJSON, useMap, CircleMarker, Tooltip } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { getBioregions, askQuestion } from "./api";
import "./App.css";

const NT_AVERAGE = 5.1;
const NT_CENTER = [-19.5, 133.5];
const NT_ZOOM = 5;

/* Ray-casting point-in-polygon. lng/lat point; ring = array of [lng,lat]. */
function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = (yi > lat) !== (yj > lat) &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/* Handles Polygon and MultiPolygon; respects holes (even-odd across rings). */
function pointInFeature(lng, lat, geometry) {
  if (!geometry) return false;
  const polys = geometry.type === "Polygon" ? [geometry.coordinates]
    : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
  for (const poly of polys) {
    let within = false;
    for (let r = 0; r < poly.length; r++) {
      if (pointInRing(lng, lat, poly[r])) within = !within; // outer adds, holes subtract
    }
    if (within) return true;
  }
  return false;
}

function findRegionAt(lng, lat, geojson) {
  if (!geojson || !geojson.features) return null;
  for (const f of geojson.features) {
    if (pointInFeature(lng, lat, f.geometry)) return f.properties;
  }
  return null;
}

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

/* Imperatively fit the map back to the NT extent without disturbing map state */
function MapController({ resetSignal }) {
  const map = useMap();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    map.flyTo(NT_CENTER, NT_ZOOM, { duration: 0.6 });
  }, [resetSignal, map]);
  return null;
}

/* Fly to the user's location once it's found */
function LocateController({ userPos }) {
  const map = useMap();
  useEffect(() => {
    if (userPos) map.flyTo([userPos.lat, userPos.lng], 7, { duration: 0.8 });
  }, [userPos, map]);
  return null;
}

export default function App() {
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState("protection");
  const [resetSignal, setResetSignal] = useState(0);

  // Geolocation state — opt-in, never stored or sent anywhere
  const [userPos, setUserPos] = useState(null);     // {lat, lng, accuracy}
  const [locating, setLocating] = useState(false);
  const [locateMsg, setLocateMsg] = useState(null); // {tone, text}

  // Search state
  const [query, setQuery] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState(null);          // {ok, results, message}
  const [highlight, setHighlight] = useState(null);    // array of region names to highlight

  useEffect(() => {
    getBioregions()
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, []);

  async function runQuery(e) {
    e.preventDefault();
    if (!query.trim()) return;
    setAsking(true);
    setAnswer(null);
    setHighlight(null);
    try {
      const res = await askQuestion(query);
      setAnswer(res);
      if (res.ok && res.names) setHighlight(res.names);
    } catch {
      setAnswer({ ok: false, message: "Something went wrong. Try again." });
    }
    setAsking(false);
  }

  function clearQuery() {
    setQuery(""); setAnswer(null); setHighlight(null);
  }

  function locateMe() {
    if (!("geolocation" in navigator)) {
      setLocateMsg({ tone: "bad", text: "Your browser doesn't support location." });
      return;
    }
    setLocating(true);
    setLocateMsg(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lng, accuracy } = pos.coords;
        setUserPos({ lat, lng, accuracy });
        setLocating(false);
        // Which bioregion am I in? Reuse the already-loaded GeoJSON.
        const region = data ? findRegionAt(lng, lat, data) : null;
        if (region) {
          setSelected(region);
          setLocateMsg({ tone: "good", text: `You're in ${region.GEO_ZONE}.` });
        } else {
          setLocateMsg({ tone: "warn", text: "You're outside the NT bioregions shown on this map." });
        }
      },
      (err) => {
        setLocating(false);
        const text = err.code === err.PERMISSION_DENIED
          ? "Location permission was denied. You can enable it in your browser's site settings."
          : err.code === err.TIMEOUT
          ? "Finding your location took too long. Try again."
          : "Couldn't determine your location.";
        setLocateMsg({ tone: "bad", text });
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  }

  function clearLocation() {
    setUserPos(null); setLocateMsg(null);
  }

  const styleFn = (feature) => {
    const p = feature.properties;
    const base = view === "protection" ? colorForPct(p.pct_protected) : colorForGi(p.gi_class);
    // If a search is active, dim everything not in the highlight set
    if (highlight) {
      const isMatch = highlight.includes(p.GEO_ZONE);
      return {
        fillColor: base,
        weight: isMatch ? 2.5 : 0.5,
        color: isMatch ? "#111" : "#999",
        fillOpacity: isMatch ? 0.92 : 0.12,
      };
    }
    return { fillColor: base, weight: 1, color: "#444", fillOpacity: 0.75 };
  };

  const onEach = (feature, layer) => {
    layer.on({
      click: () => setSelected(feature.properties),
      mouseover: (e) => e.target.setStyle({ weight: 3, color: "#000" }),
      mouseout: (e) => e.target.setStyle({ weight: highlight && !highlight.includes(feature.properties.GEO_ZONE) ? 0.5 : 1, color: "#444" }),
    });
  };

  const v = selected ? verdict(selected.pct_protected) : null;
  // Meter scale capped at 35% (matches best-protected class) for readable bars
  const meterMax = 35;
  const meterPct = selected ? Math.min(100, (selected.pct_protected / meterMax) * 100) : 0;
  const avgPct = (NT_AVERAGE / meterMax) * 100;

  return (
    <div className="app">
      <header>
        <div className="header-text">
          <p className="eyebrow"><span className="dot" aria-hidden="true" /> Environmental Intelligence · Northern Territory</p>
          <h1 className="brand">
            <span className="brand-name">Groundtruth</span>
            <span className="brand-sub">Protected-Area Coverage Explorer</span>
          </h1>
          <p className="lede">
            The NT protects its scenic northern country far more than its vast arid interior.
            This map shows how much of each region sits inside a <strong>park or reserve</strong>.
          </p>
        </div>

        <div className="header-stats" role="group" aria-label="Territory-wide summary statistics">
          <div className="hstat animate-rise stagger-1"><span className="hnum">{NT_AVERAGE}%</span><span className="hlabel">Territory-wide average protection</span></div>
          <div className="hstat best animate-rise stagger-2"><span className="hnum">33%</span><span className="hlabel">Best protected — limestone hills</span></div>
          <div className="hstat worst animate-rise stagger-3"><span className="hnum">0.6%</span><span className="hlabel">Tanami — the NT's largest region</span></div>
        </div>
      </header>

      {/* Toolbar: search + view toggle */}
      <div className="toolbar">
        <form className="search" onSubmit={runQuery} role="search">
          <div className="search-field">
            <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="11" cy="11" r="7" /><path d="m20 20-3-3" strokeLinecap="round" />
            </svg>
            <label htmlFor="ask" className="sr-only">Ask a question about NT bioregions</label>
            <input
              id="ask"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Ask a question, e.g. which regions are least protected?"
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={asking}>{asking ? "Asking…" : "Ask"}</button>
          {answer && <button type="button" className="btn btn-ghost" onClick={clearQuery}>Clear</button>}
        </form>

        <div className="toggle" role="tablist" aria-label="Map view">
          <button role="tab" aria-selected={view === "protection"} className={view === "protection" ? "on" : ""} onClick={() => setView("protection")}>% Protected</button>
          <button role="tab" aria-selected={view === "hotspot"} className={view === "hotspot" ? "on" : ""} onClick={() => setView("hotspot")}>Hot / cold spots</button>
        </div>
      </div>

      <div className="layout">
        <div className="map-wrap">
          {loading && (
            <div className="loading" role="status">
              <div className="spinner" aria-hidden="true" />
              <div>Loading map data…</div>
              <div className="sub-note">First load may take ~30s while the server wakes.</div>
            </div>
          )}
          {error && (
            <div className="error" role="alert">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" strokeLinecap="round" /></svg>
              <span>Error: {error}</span>
            </div>
          )}

          {data && !loading && (
            <div className="map-control">
              <button onClick={() => setResetSignal((s) => s + 1)} aria-label="Reset map to Northern Territory extent">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.4 2.6L3 8" strokeLinecap="round" strokeLinejoin="round" /><path d="M3 4v4h4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Fit to NT
              </button>
              <button onClick={locateMe} disabled={locating} aria-label="Find my location on the map">
                {locating ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="spin-svg">
                    <path d="M12 3a9 9 0 1 0 9 9" strokeLinecap="round" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" strokeLinecap="round" />
                  </svg>
                )}
                {locating ? "Locating…" : "Locate me"}
              </button>
              {userPos && (
                <button onClick={clearLocation} aria-label="Remove my location marker">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
                  </svg>
                  Clear pin
                </button>
              )}
            </div>
          )}

          <MapContainer center={NT_CENTER} zoom={NT_ZOOM} style={{ height: "100%", width: "100%" }}>
            <MapController resetSignal={resetSignal} />
            <LocateController userPos={userPos} />
            <TileLayer url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png" attribution="&copy; OpenStreetMap &copy; CARTO" />
            {data && <GeoJSON key={view + (highlight ? "-hl" : "")} data={data} style={styleFn} onEachFeature={onEach} />}
            {userPos && (
              <>
                <CircleMarker
                  center={[userPos.lat, userPos.lng]}
                  radius={8}
                  pathOptions={{ color: "#1d4ed8", weight: 3, fillColor: "#3b82f6", fillOpacity: 0.9 }}
                >
                  <Tooltip direction="top" offset={[0, -8]}>You are here</Tooltip>
                </CircleMarker>
              </>
            )}
          </MapContainer>
        </div>

        <aside className="panel" aria-label="Region details and legend">
          {/* Location status — opt-in geolocation feedback */}
          {locateMsg && (
            <div className={`locate-msg ${locateMsg.tone} animate-fade`} role="status">
              <span>{locateMsg.text}</span>
              <button onClick={() => setLocateMsg(null)} aria-label="Dismiss location message">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" /></svg>
              </button>
            </div>
          )}

          {/* Skeleton while the dataset loads */}
          {loading && (
            <div className="skeleton" aria-hidden="true">
              <div className="sk-line sm" />
              <div className="sk-line lg" />
              <div className="sk-line" />
              <div className="sk-line sm" />
            </div>
          )}

          {/* Search answer takes priority in the panel */}
          {answer && (
            <div className="card answer animate-rise">
              <span className="card-label">Answer</span>
              {answer.ok ? (
                <ol>
                  {answer.results.map((r) => (
                    <li key={r.name}>
                      <span className="rank" aria-hidden="true" />
                      <span className="aname">{r.name}</span>
                      <span className="apct">{r.pct_protected}%</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="amsg">{answer.message}</p>
              )}
              <span className="ahint">Matching regions are highlighted on the map.</span>
            </div>
          )}

          {selected ? (
            <div className="card detail animate-rise" key={selected.GEO_ZONE}>
              <h2>{selected.GEO_ZONE}</h2>
              <div className={`verdict ${v.tone}`}>{v.text}</div>
              <div className="hero-stat">
                <span className="num">{selected.pct_protected.toFixed(1)}</span>
                <span className="unit">%</span>
                <span className="caption">protected</span>
              </div>

              {/* Coverage meter with NT-average reference tick */}
              <div className="meter" role="img" aria-label={`${selected.pct_protected.toFixed(1)} percent protected, on a scale to ${meterMax} percent`}>
                <div className="meter-fill" style={{ width: `${meterPct}%`, background: colorForPct(selected.pct_protected) }} />
              </div>
              <div className="meter-avg">
                <div className="tick" style={{ left: `${avgPct}%` }} />
                <div className="tick-label" style={{ left: `${avgPct}%` }}>NT avg {NT_AVERAGE}%</div>
              </div>

              <p className="meaning">
                {selected.pct_protected.toFixed(1)}% of {selected.GEO_ZONE}'s land area sits inside a
                national park or reserve. The remaining {(100 - selected.pct_protected).toFixed(1)}% has
                no conservation protection status.
              </p>
              <div className="stat"><span>Total area</span><strong>{Math.round(selected.total_km2).toLocaleString()} km²</strong></div>
              <div className="stat"><span>Protected area</span><strong>{Math.round(selected.protected_km2).toLocaleString()} km²</strong></div>
              <div className="stat"><span>Statistical cluster</span><strong>{selected.gi_class}</strong></div>
            </div>
          ) : (
            !answer && !loading && (
              <div className="hint animate-fade">
                <svg className="hint-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                  <path d="M9 11a3 3 0 1 0 6 0 3 3 0 0 0-6 0Z" /><path d="M17.6 6.4 12 12" strokeLinecap="round" />
                  <path d="M12 2v2M12 20v2M2 12h2M20 12h2" strokeLinecap="round" />
                </svg>
                Click any region on the map, or ask a question above to explore protection coverage.
              </div>
            )
          )}

          {!loading && (
            <>
              <div className="card explainer animate-fade">
                <span className="card-label">What you're seeing</span>
                {view === "protection" ? (
                  <p>Each region is shaded by the share of its area inside a park or reserve. Green is well protected, red is barely protected. Most of the red sits in the arid south.</p>
                ) : (
                  <p>Statistically significant clusters (Getis-Ord Gi*). Red regions sit in a neighbourhood of high protection, blue in a neighbourhood of low protection, grey shows no significant pattern.</p>
                )}
              </div>

              <div className="card legend animate-fade">
                <span className="card-label">{view === "protection" ? "% Protected" : "Gi* cluster"}</span>
                {view === "protection"
                  ? [[">= 25", "#1a9850"], ["15–25", "#91cf60"], ["7–15", "#d9ef8b"], ["2–7", "#fee08b"], ["0.5–2", "#fc8d59"], ["< 0.5", "#d73027"]].map(([label, c]) => (
                      <div className="legend-row" key={label}><span className="swatch" style={{ background: c }} /> {label}</div>))
                  : [["Hot spot (high)", "#c0392b"], ["Cold spot (low)", "#2980b9"], ["Not significant", "#d5d5d5"]].map(([label, c]) => (
                      <div className="legend-row" key={label}><span className="swatch" style={{ background: c }} /> {label}</div>))}
              </div>

              <div className="footer-note">
                <p className="fn-line">
                  Full analysis (clustering, spatial statistics) and methodology on{" "}
                  <a href="https://github.com/harshrastogii/nt-protected-areas" target="_blank" rel="noreferrer">GitHub</a>.
                </p>

                <div className="credit">
                  <span className="credit-by">
                    Built by{" "}
                    <a href="https://www.harshrastogii.com/" target="_blank" rel="noreferrer">Harsh Rastogi</a>
                  </span>
                  <a className="kofi" href="https://ko-fi.com/harshrastogi" target="_blank" rel="noreferrer">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                      <path d="M5 8h11a3 3 0 0 1 0 6h-1" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M3 8h13v5a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V8Z" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M7 2.5v1.5M10 2v2M13 2.5v1.5" strokeLinecap="round" />
                    </svg>
                    Support this project
                  </a>
                </div>
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
