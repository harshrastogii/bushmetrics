"""
Build BushMetrics region data from IBRA7 and CAPAD 2024, for both IBRA
bioregions and the finer IBRA subregions.

Replaces the original notebook pipeline, which used NT Land Systems zones
(not IBRA bioregions) and NT parks only (no Indigenous Protected Areas).

Inputs, downloaded into data/raw (gitignored):
  ibra7/ibra7_regions/IBRARegion_Aust70/IBRARegion_Aust70.shp
      IBRA v7 regions, split by state. data.gov.au, CC BY 4.0.
  ibra7/ibra7_subregions/IBRASubegion_Aust70/IBRASubegion_Aust70.shp
      IBRA v7 subregions, split by state. data.gov.au, CC BY 4.0.
      ("Subegion" is the publisher's spelling.)
  capad/capad2024_nt.geojson
      CAPAD 2024 polygons where STATE='NT', from the DCCEEW CAPAD
      FeatureServer (gis.environment.gov.au/.../ogc_services/CAPAD). CC BY 4.0.
  capad/capad-2024-terrestrial-nt.xlsx
      DCCEEW's published NT summary. Used only to validate our numbers.

Outputs:
  backend/app_data/bioregions.geojson       NT portion of each IBRA7 bioregion
  backend/app_data/subregions.geojson       NT portion of each IBRA7 subregion
  backend/app_data/protected_areas.geojson  CAPAD 2024 NT polygons, for the map
  backend/app_data/summary.json             Territory-wide headline figures

Run from the repo root:  python analysis/build_regions.py
"""

import json
from pathlib import Path

import geopandas as gpd
import pandas as pd
import shapely
from esda.getisord import G_Local
from libpysal.weights import Queen, KNN, w_union

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
OUT = ROOT / "backend" / "app_data"

ALBERS = 3577          # GDA94 / Australian Albers, equal-area, metres
TARGET_PCT = 30        # CBD Kunming-Montreal Target 3 ("30 by 30")
SIMPLIFY_M = 100       # web geometry tolerance for region boundaries
PA_SIMPLIFY_M = 50     # finer: people zoom into individual parks

# Regions where the NT holds only a sliver are excluded from
# "most/least protected" rankings. Their NT figures are real but describe a
# fragment of a region that is mostly managed by another state.
RANK_MIN_NT_SHARE = 0.10

# CAPAD's GOVERNANCE codes, as observed in the NT data:
#   C = community (every NT IPA), J = joint management with Traditional
#   Owners, G = government, P = private.
GOVERNANCE = {
    "C": ("ipa", "Indigenous Protected Area"),
    "J": ("joint", "Jointly managed with Traditional Owners"),
    "G": ("government", "Government managed"),
    "P": ("private", "Privately managed"),
}
GOV_KEYS = [k for k, _ in GOVERNANCE.values()]

LEVELS = {
    "bioregion": {
        "shp": "ibra7/ibra7_regions/IBRARegion_Aust70/IBRARegion_Aust70.shp",
        "code": "IBRA_REG_C", "name": "IBRA_REG_N", "parent": None,
        "sheet": "IBRA Bioregions", "out": "bioregions.geojson",
    },
    "subregion": {
        "shp": "ibra7/ibra7_subregions/IBRASubegion_Aust70/IBRASubegion_Aust70.shp",
        "code": "IBRA_SUB_C", "name": "IBRA_SUB_N", "parent": ("IBRA_REG_C", "IBRA_REG_N"),
        "sheet": "IBRA Subregions", "out": "subregions.geojson",
    },
}


def load_units(level):
    """NT portion of each region, plus its national extent across all states."""
    cfg = LEVELS[level]
    ibra = gpd.read_file(RAW / cfg["shp"]).to_crs(ALBERS)
    ibra["area_km2"] = ibra.area / 1e6
    national = ibra.groupby(cfg["code"]).area_km2.sum().rename("national_km2")

    keep = {cfg["name"]: "first"}
    rename = {cfg["code"]: "code", cfg["name"]: "name"}
    if cfg["parent"]:
        pcode, pname = cfg["parent"]
        keep.update({pcode: "first", pname: "first"})
        rename.update({pcode: "bioregion_code", pname: "bioregion"})

    nt = ibra[ibra.STATE == "NT"].dissolve(by=cfg["code"], aggfunc=keep).reset_index()
    nt = nt.rename(columns=rename)
    nt["total_km2"] = nt.area / 1e6
    nt = nt.join(national, on="code")
    nt["nt_share"] = nt.total_km2 / nt.national_km2
    cols = ["code", "name"] + (["bioregion_code", "bioregion"] if cfg["parent"] else [])
    return nt[cols + ["total_km2", "national_km2", "nt_share", "geometry"]]


def load_capad():
    pa = gpd.read_file(RAW / "capad/capad2024_nt.geojson").to_crs(ALBERS)
    # OVERLAP=2 features sit entirely inside OVERLAP=1 features. CAPAD's own
    # totals exclude them, and so do we, so no area is counted twice.
    pa = pa[pa.OVERLAP.astype(str) == "1"].copy()
    pa["governance"] = pa.GOVERNANCE.map(lambda g: GOVERNANCE[g][0])
    return pa


def protection(units, pa):
    pieces = gpd.overlay(units[["code", "geometry"]], pa[["governance", "geometry"]], how="intersection")
    pieces["km2"] = pieces.area / 1e6
    by_gov = pieces.pivot_table(index="code", columns="governance", values="km2", aggfunc="sum")
    by_gov = by_gov.reindex(columns=GOV_KEYS).fillna(0)

    out = units.set_index("code").join(by_gov.add_suffix("_km2")).fillna(
        {f"{k}_km2": 0 for k in GOV_KEYS})
    out["protected_km2"] = out[[f"{k}_km2" for k in GOV_KEYS]].sum(axis=1)
    out["pct_protected"] = out.protected_km2 / out.total_km2 * 100
    out["meets_target"] = out.pct_protected >= TARGET_PCT
    out["rankable"] = out.nt_share >= RANK_MIN_NT_SHARE
    return out.reset_index()


def published(level):
    """DCCEEW's published NT table for this level: area in NT (km2) and % protected."""
    sheet = LEVELS[level]["sheet"]
    pub = pd.read_excel(RAW / "capad/capad-2024-terrestrial-nt.xlsx", sheet_name=sheet, header=1)
    if level == "bioregion":
        pub = pub[pub["IBRA Region Code"].notna()].set_index("IBRA Region Code")
        area_ha, pct = pub["1 IBRA Region Area in NT"], pub["% IBRA Region Area in NT Protected"]
    else:
        # Columns: region code, subregion name, subregion code, area (ha), protected (ha), %
        pub = pub.set_axis(["reg", "name", "code", "area_ha", "prot_ha", "pct"] + list(pub.columns[6:]), axis=1)
        pub = pub[pub.code.astype(str).str.fullmatch(r"[A-Z]{3}\d\d")].set_index("code")
        area_ha, pct = pub.area_ha, pub.pct
    return pd.DataFrame({"area_km2": area_ha.astype(float) / 100, "pct": pct.astype(float)})


def validate(units, level):
    """Our spatial result must reproduce DCCEEW's published NT table."""
    pub = published(level)
    ours = units.set_index("code")
    missing = set(pub.index) ^ set(ours.index)
    assert not missing, f"{level} codes differ from published table: {missing}"

    d_pct = (ours.pct_protected - pub.pct).abs()
    d_area = (ours.total_km2 / pub.area_km2 - 1).abs()
    print(f"validation vs published CAPAD 2024 NT table ({len(ours)} {level}s):")
    print(f"  % protected: max abs diff {d_pct.max():.3f} pp ({d_pct.idxmax()})")
    print(f"  NT area:     max rel diff {d_area.max() * 100:.3f}% ({d_area.idxmax()})")
    assert d_pct.max() < 0.1, f"{level} protection % disagrees with published CAPAD table"
    assert d_area.max() < 0.005, f"{level} NT area disagrees with published CAPAD table"


def hotspots(units):
    """Getis-Ord Gi* on % protected.

    Queen contiguity, with each region also linked to its nearest neighbour
    so island regions (Tiwi Cobourg, Groote) are not left without neighbours.
    """
    w = w_union(Queen.from_dataframe(units, use_index=False, silence_warnings=True),
                KNN.from_dataframe(units, k=1, use_index=False, silence_warnings=True),
                silence_warnings=True)
    g = G_Local(units.pct_protected.values, w, transform="B", star=True,
                permutations=9999, seed=42)

    def label(z, p):
        if p >= 0.05:
            return "Not significant"
        return "Hot spot (high protection)" if z > 0 else "Cold spot (low protection)"

    units["gi_z"] = g.Zs
    units["gi_p"] = g.p_sim
    units["gi_class"] = [label(z, p) for z, p in zip(g.Zs, g.p_sim)]
    return units


def polygonal(geom, min_m2=10_000):
    """Keep only polygon parts of at least one hectare. Smaller specks collapse
    into lines when coordinates are rounded for the web, and Leaflet would
    draw the result as a map pin. Statistics are computed before this step."""
    polys = [p for p in shapely.get_parts(geom) if p.geom_type == "Polygon" and p.area >= min_m2]
    return shapely.MultiPolygon(polys) if len(polys) > 1 else (polys[0] if polys else shapely.Polygon())


def write_geojson(gdf, path):
    gdf.to_crs(4326).to_file(path, driver="GeoJSON",
                             layer_options={"COORDINATE_PRECISION": 5, "RFC7946": "YES"})
    print(f"  wrote {path.relative_to(ROOT)} ({path.stat().st_size / 1e6:.2f} MB)")


def build_level(level, pa):
    units = protection(load_units(level), pa)
    validate(units, level)
    units = hotspots(units)

    # Simplify shared borders together so adjacent regions stay gap-free.
    units["geometry"] = shapely.coverage_simplify(units.geometry.values, SIMPLIFY_M)
    web = units.copy()
    for c in ["total_km2", "national_km2", "protected_km2"] + [f"{k}_km2" for k in GOV_KEYS]:
        web[c] = web[c].round(1)
    for c in ["pct_protected", "gi_z"]:
        web[c] = web[c].round(2)
    web["nt_share"] = web.nt_share.round(4)
    write_geojson(web, OUT / LEVELS[level]["out"])
    return units


def brief(row):
    return {"name": row["name"], "pct_protected": round(float(row.pct_protected), 2),
            "total_km2": round(float(row.total_km2), 1)}


def level_summary(units):
    # Many subregions tie at 0%; among ties the largest is the most telling
    ranked = units[units.rankable].sort_values(["pct_protected", "total_km2"], ascending=[True, False])
    return {
        "n": int(len(units)),
        "n_meeting_target": int(units.meets_target.sum()),
        "n_unprotected": int((units.protected_km2 < 0.5).sum()),
        "least_protected": brief(ranked.iloc[0]),
        "most_protected": brief(ranked.iloc[-1]),
    }


def main():
    pa = load_capad()
    bio = build_level("bioregion", pa)
    sub = build_level("subregion", pa)

    pa_web = pa[["NAME", "TYPE", "TYPE_ABBR", "governance", "IUCN", "GIS_AREA", "geometry"]].copy()
    pa_web["area_km2"] = (pa_web.pop("GIS_AREA") / 100).round(1)
    pa_web["geometry"] = pa_web.geometry.simplify(PA_SIMPLIFY_M, preserve_topology=True).apply(polygonal)
    pa_web = pa_web[~pa_web.geometry.is_empty]
    write_geojson(pa_web, OUT / "protected_areas.geojson")

    nt_area = bio.total_km2.sum()
    protected = bio.protected_km2.sum()
    by_gov = {k: round(float(bio[f"{k}_km2"].sum()), 1) for k in GOV_KEYS}
    bio_s, sub_s = level_summary(bio), level_summary(sub)
    summary = {
        "source": "CAPAD 2024 (protected areas as at 30 June 2024); IBRA v7 bioregions and subregions",
        "target_pct": TARGET_PCT,
        "rank_min_nt_share": RANK_MIN_NT_SHARE,
        "nt_area_km2": round(float(nt_area), 1),
        "protected_km2": round(float(protected), 1),
        "pct_protected": round(float(protected / nt_area * 100), 2),
        "by_governance_km2": by_gov,
        "by_governance_pct_of_protected": {k: round(v / protected * 100, 2) for k, v in by_gov.items()},
        "governance_labels": {k: lbl for k, lbl in GOVERNANCE.values()},
        # Bioregion figures stay top-level so existing clients keep working
        "n_bioregions": bio_s["n"],
        "n_meeting_target": bio_s["n_meeting_target"],
        "least_protected": bio_s["least_protected"],
        "most_protected": bio_s["most_protected"],
        "levels": {"bioregion": bio_s, "subregion": sub_s},
    }
    (OUT / "summary.json").write_text(json.dumps(summary, indent=2, default=float))
    print(f"  wrote backend/app_data/summary.json")

    cols = ["code", "name", "bioregion", "total_km2", "nt_share", "pct_protected", "ipa_km2",
            "joint_km2", "rankable", "gi_class"]
    with pd.option_context("display.width", 220, "display.max_columns", 20, "display.max_rows", 100):
        print(sub[cols].sort_values("pct_protected", ascending=False).round(2).to_string(index=False))
    print(json.dumps(summary["levels"], indent=2, default=float))


if __name__ == "__main__":
    main()
