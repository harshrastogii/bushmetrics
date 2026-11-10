import { useEffect, useRef, useState } from "react";
import { MapContainer, TileLayer, GeoJSON, useMap, CircleMarker, Tooltip } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { getBioregions, getProtectedAreas, getSummary, askQuestion } from "./api";
import "./App.css";

// CBD Kunming-Montreal Target 3 ("30 by 30"), the target McGinley et al. (2026) assess the NT against
const TARGET_PCT = 30;
const NT_CENTER = [-19.5, 133.5];
const NT_ZOOM = 5;  // starting view only; MapController then fits NT_BOUNDS
const NT_BOUNDS = [[-26.0, 129.0], [-10.9, 138.0]];  // extent of the bioregion data
const FIT_PADDING = [16, 16];

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

// Bins anchored on the 30% target and the superseded 17% Aichi target
const PCT_BINS = [
  [30, "#1a9850", "≥ 30% (meets target)"],
  [17, "#91cf60", "17–30%"],
  [10, "#d9ef8b", "10–17%"],
  [5,  "#fee08b", "5–10%"],
  [1,  "#fc8d59", "1–5%"],
  [0,  "#d73027", "< 1%"],
];
function colorForPct(pct) {
  return PCT_BINS.find(([min]) => pct >= min)[1];
}

// Who manages each protected area, from CAPAD's GOVERNANCE field.
// Palette validated all-pairs for colour-vision deficiency (dataviz validator).
const GOVERNANCE = [
  { key: "ipa",        color: "#eb6834", label: "Indigenous Protected Area" },
  { key: "joint",      color: "#1baf7a", label: "Jointly managed with Traditional Owners" },
  { key: "government", color: "#2a78d6", label: "Government managed" },
  { key: "private",    color: "#4a3aa7", label: "Privately managed" },
];
const GOV_COLOR = Object.fromEntries(GOVERNANCE.map((g) => [g.key, g.color]));
function colorForGi(gi) {
  if (gi === "Hot spot (high protection)") return "#c0392b";
  if (gi === "Cold spot (low protection)") return "#2980b9";
  return "#d5d5d5";
}
function verdict(pct, ntAverage) {
  if (pct >= TARGET_PCT) return { text: `Meets the ${TARGET_PCT}% target`, tone: "good" };
  if (pct >= ntAverage) return { text: `Above the NT average, short of ${TARGET_PCT}%`, tone: "warn" };
  if (pct >= 1) return { text: "Below the NT average", tone: "warn" };
  return { text: "Almost no protection", tone: "bad" };
}

const fmtKm2 = (v) => `${Math.round(v).toLocaleString()} km²`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/* Frame the NT to the map's actual size: on load, and on "Fit to NT" */
function MapController({ resetSignal }) {
  const map = useMap();
  // Keep re-framing the NT as the layout settles, until the visitor moves the map
  const auto = useRef(true);
  const programmatic = useRef(false);

  // A fixed zoom suits one screen size: on a large monitor it left the NT a
  // small shape in a map of half the Asia-Pacific. Leaflet also measures its
  // container only on window resize, so when the header reflows after web
  // fonts load, the map kept a stale size: the wrong framing, and grey untiled
  // strips at the edge. Watching the container itself fixes both.
  useEffect(() => {
    let fittedTo = "";
    const fit = () => {
      const size = map.getSize();
      // Fitting a 0x0 map divides by zero and yields NaN coordinates
      if (!size.x || !size.y) return;
      // The observer also fires once on attach; re-fitting an unchanged size
      // would only make the map redraw its tiles
      const key = `${size.x}x${size.y}`;
      if (key === fittedTo) return;
      fittedTo = key;
      programmatic.current = true;
      map.fitBounds(NT_BOUNDS, { padding: FIT_PADDING, animate: false });
      programmatic.current = false;
    };
    const onMoveStart = () => { if (!programmatic.current) auto.current = false; };
    map.on("movestart", onMoveStart);
    fit();

    // Re-frames on every container size change. Observers only run when the
    // browser renders a frame, so the immediate fit above covers a page that
    // loads in a background tab.
    const ro = new ResizeObserver(() => {
      map.invalidateSize({ pan: false });
      if (auto.current) fit();
    });
    ro.observe(map.getContainer());
    return () => { ro.disconnect(); map.off("movestart", onMoveStart); };
  }, [map]);

  useEffect(() => {
    // resetSignal starts at 0 and only increments on an explicit "Fit to NT".
    // Guarding on the value (not a mutable ref) keeps this correct under
    // StrictMode, which runs effects twice on mount.
    if (resetSignal === 0) return;
    const size = map.getSize();
    if (!size.x || !size.y) return;
    programmatic.current = true;
    map.flyToBounds(NT_BOUNDS, { padding: FIT_PADDING, duration: 0.6 });
    programmatic.current = false;
    auto.current = true;
  }, [resetSignal, map]);
  return null;
}

/* Fly to the user's location once it's found */
function LocateController({ userPos }) {
  const map = useMap();
  useEffect(() => {
    if (!userPos) return;
    const size = map.getSize();
    if (!size.x || !size.y) { map.setView([userPos.lat, userPos.lng], 7); return; }
    map.flyTo([userPos.lat, userPos.lng], 7, { duration: 0.8 });
  }, [userPos, map]);
  return null;
}

export default function App() {
  const [data, setData] = useState(null);
  const [areas, setAreas] = useState(null);      // CAPAD protected-area polygons
  const [summary, setSummary] = useState(null);  // Territory-wide headline figures
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
    Promise.all([getBioregions(), getProtectedAreas(), getSummary()])
      .then(([d, a, s]) => { setData(d); setAreas(a); setSummary(s); setLoading(false); })
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
          setLocateMsg({ tone: "good", text: `You're in ${region.name}.` });
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
    // In the governance view the bioregions become a quiet backdrop for the protected areas
    if (view === "governance") {
      return { fillColor: "#f4f1ea", weight: 1, color: "#8a8578", fillOpacity: 0.35 };
    }
    const base = view === "protection" ? colorForPct(p.pct_protected) : colorForGi(p.gi_class);
    // If a search is active, dim everything not in the highlight set
    if (highlight) {
      const isMatch = highlight.includes(p.name);
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
      mouseout: (e) => e.target.setStyle(styleFn(feature)),
    });
  };

  const areaStyle = (feature) => ({
    fillColor: GOV_COLOR[feature.properties.governance],
    fillOpacity: 0.7, color: "#fff", weight: 0.8,
  });

  const onEachArea = (feature, layer) => {
    const p = feature.properties;
    const gov = GOVERNANCE.find((g) => g.key === p.governance);
    const kind = p.TYPE === gov.label ? p.TYPE : `${p.TYPE} · ${gov.label}`;
    layer.bindTooltip(
      `<strong>${p.NAME}</strong><br>${kind}<br>${fmtKm2(p.area_km2)}`,
      { sticky: true, direction: "top" }
    );
    // A protected area sits on top of its bioregion, so route clicks through to it
    layer.on("click", (e) => {
      const region = findRegionAt(e.latlng.lng, e.latlng.lat, data);
      if (region) setSelected(region);
    });
  };

  const ntAverage = summary ? summary.pct_protected : 0;
  const v = selected ? verdict(selected.pct_protected, ntAverage) : null;
  const giCounts = data ? data.features.reduce((acc, f) => {
    acc[f.properties.gi_class] = (acc[f.properties.gi_class] || 0) + 1; return acc;
  }, {}) : {};

  return (
    <div className="app">
      <header>
        <div className="header-text">
          <p className="eyebrow"><span className="dot" aria-hidden="true" /> Environmental Intelligence · Northern Territory</p>
          <h1 className="brand">
            <span className="brand-name">BushMetrics</span>
            <span className="brand-sub">Protected-Area Coverage Explorer</span>
          </h1>
          <p className="lede">
            Almost a quarter of the NT sits inside a <strong>protected area</strong>, most of it
            Indigenous Protected Areas and parks managed with Traditional Owners. The gaps run
            through the pastoral middle of the Territory.
          </p>
        </div>

        <div className="header-stats" role="group" aria-label="Territory-wide summary statistics">
          <div className="hstat animate-rise stagger-1">
            <span className="hnum">{summary ? `${summary.pct_protected.toFixed(1)}%` : "—"}</span>
            <span className="hlabel">of the NT is protected</span>
          </div>
          <div className="hstat ipa animate-rise stagger-2">
            <span className="hnum">{summary ? `${Math.round(summary.by_governance_pct_of_protected.ipa)}%` : "—"}</span>
            <span className="hlabel">of that is Indigenous Protected Areas</span>
          </div>
          <div className="hstat animate-rise stagger-3">
            <span className="hnum">{summary ? `${summary.n_meeting_target} of ${summary.n_bioregions}` : "—"}</span>
            <span className="hlabel">bioregions meet the {TARGET_PCT}% target</span>
          </div>
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
          <button role="tab" aria-selected={view === "governance"} className={view === "governance" ? "on" : ""} onClick={() => setView("governance")}>Who manages it</button>
          <button role="tab" aria-selected={view === "hotspot"} className={view === "hotspot" ? "on" : ""} onClick={() => setView("hotspot")}>Hot / cold spots</button>
        </div>
      </div>

      <div className="layout">
        <div className="map-wrap">
          {loading && (
            <div className="loading" role="status">
              <div className="spinner" aria-hidden="true" />
              <div>Loading map data…</div>
              <div className="sub-note">Loading region data — just a moment.</div>
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

          <MapContainer center={NT_CENTER} zoom={NT_ZOOM} maxZoom={16} style={{ height: "100%", width: "100%" }}>
            <MapController resetSignal={resetSignal} />
            <LocateController userPos={userPos} />
            {/* Esri light-grey canvas: keyless, and matches the muted palette.
                CARTO's free tiles now come stamped "API KEY REQUIRED".
                Note Esri's tile path is {z}/{y}/{x}, not {z}/{x}/{y}. */}
            <TileLayer
              url="https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}"
              attribution="Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ"
              maxZoom={16}
            />
            <TileLayer
              url="https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}"
              maxZoom={16}
              zIndex={2}
            />
            {data && <GeoJSON key={view + (highlight ? "-hl" : "")} data={data} style={styleFn} onEachFeature={onEach} />}
            {areas && view === "governance" && (
              <GeoJSON key="areas" data={areas} style={areaStyle} onEachFeature={onEachArea} />
            )}
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
              {answer.note && <p className="anote">{answer.note}</p>}
              <span className="ahint">Matching regions are highlighted on the map.</span>
            </div>
          )}

          {selected ? (
            <div className="card detail animate-rise" key={selected.name}>
              <h2>{selected.name}</h2>
              <div className={`verdict ${v.tone}`}>{v.text}</div>
              <div className="hero-stat">
                <span className="num">{selected.pct_protected.toFixed(1)}</span>
                <span className="unit">%</span>
                <span className="caption">protected</span>
              </div>

              {/* Whole bar = the bioregion's NT area; segments = who manages the protected share */}
              <div className="meter stacked" role="img"
                aria-label={`${selected.pct_protected.toFixed(1)} percent protected, against a ${TARGET_PCT} percent target`}>
                {GOVERNANCE.map((g) => {
                  const w = (selected[`${g.key}_km2`] / selected.total_km2) * 100;
                  return w >= 0.2 && <div key={g.key} className="meter-seg" style={{ width: `${w}%`, background: g.color }} />;
                })}
              </div>
              <div className="meter-avg">
                <div className="tick" style={{ left: `${TARGET_PCT}%` }} />
                <div className="tick-label" style={{ left: `${TARGET_PCT}%` }}>{TARGET_PCT}% target</div>
              </div>

              {selected.protected_km2 > 0 ? (
                <div className="gov-rows">
                  {GOVERNANCE.filter((g) => selected[`${g.key}_km2`] > 0).map((g) => (
                    <div className="stat gov" key={g.key}>
                      <span><i className="swatch" style={{ background: g.color }} aria-hidden="true" />{g.label}</span>
                      <strong>{fmtKm2(selected[`${g.key}_km2`])}</strong>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="meaning">No part of this bioregion's NT area is in a protected area.</p>
              )}

              {selected.nt_share < 0.995 && (
                <p className="xborder">
                  {selected.nt_share < 0.5 ? "Only " : ""}
                  {selected.nt_share < 0.01 ? "under 1" : Math.round(selected.nt_share * 100)}% of the {selected.name} bioregion
                  lies in the NT ({fmtKm2(selected.national_km2)} in total). These figures describe the NT part.
                  {!selected.rankable && " It's too small a slice to include in rankings."}
                </p>
              )}

              <div className="stat"><span>Area in the NT</span><strong>{fmtKm2(selected.total_km2)}</strong></div>
              <div className="stat"><span>Protected</span><strong>{fmtKm2(selected.protected_km2)}</strong></div>
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
                {view === "protection" && (
                  <p>Each IBRA bioregion is shaded by the share of its NT area inside a protected area:
                    Indigenous Protected Areas, national parks and private reserves. Dark green meets
                    the {TARGET_PCT}% target.</p>
                )}
                {view === "governance" && (
                  <p>Protected areas coloured by who manages them. Traditional Owners dedicate
                    Indigenous Protected Areas voluntarily, and most NT national parks are jointly
                    managed with them. Hover an area for its name.</p>
                )}
                {view === "hotspot" && (
                  <p>Statistically significant clusters (Getis-Ord Gi*). Only{" "}
                    {plural(giCounts["Hot spot (high protection)"] || 0, "hot spot")} and{" "}
                    {plural(giCounts["Cold spot (low protection)"] || 0, "cold spot")} reach
                    significance. At bioregion scale, protection follows individual large IPAs more
                    than regional clusters.</p>
                )}
              </div>

              <div className="card legend animate-fade">
                <span className="card-label">
                  {{ protection: "% of NT area protected", governance: "Managed by", hotspot: "Gi* cluster" }[view]}
                </span>
                {view === "protection" && PCT_BINS.map(([, c, label]) => (
                  <div className="legend-row" key={label}><span className="swatch" style={{ background: c }} /> {label}</div>))}
                {view === "governance" && GOVERNANCE.map((g) => (
                  <div className="legend-row" key={g.key}>
                    <span className="swatch" style={{ background: g.color }} /> {g.label}
                    {summary && <span className="legend-val">{summary.by_governance_pct_of_protected[g.key].toFixed(1)}%</span>}
                  </div>))}
                {view === "hotspot" && [["Hot spot (high)", "#c0392b"], ["Cold spot (low)", "#2980b9"], ["Not significant", "#d5d5d5"]].map(([label, c]) => (
                  <div className="legend-row" key={label}><span className="swatch" style={{ background: c }} /> {label}</div>))}
              </div>

              <div className="footer-note">
                <p className="fn-line">
                  Protected areas: CAPAD 2024 (at 30 June 2024), DCCEEW, CC BY 4.0. Bioregions: IBRA v7.
                  Target: CBD Kunming-Montreal Target 3. Methodology on{" "}
                  <a href="https://github.com/harshrastogii/bushmetrics" target="_blank" rel="noreferrer">GitHub</a>.
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
