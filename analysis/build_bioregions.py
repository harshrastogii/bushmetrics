"""
Build BushMetrics bioregion data from IBRA7 and CAPAD 2024.

Replaces the original notebook pipeline, which used NT Land Systems zones
(not IBRA bioregions) and NT parks only (no Indigenous Protected Areas).

Inputs, downloaded into data/raw (gitignored):
  ibra7/ibra7_regions/IBRARegion_Aust70/IBRARegion_Aust70.shp
      IBRA v7 regions, split by state. data.gov.au, CC BY 4.0.
  capad/capad2024_nt.geojson
      CAPAD 2024 polygons where STATE='NT', from the DCCEEW CAPAD
      FeatureServer (gis.environment.gov.au/.../ogc_services/CAPAD). CC BY 4.0.
  capad/capad-2024-terrestrial-nt.xlsx
      DCCEEW's published NT summary. Used only to validate our numbers.

Outputs:
  backend/app_data/bioregions.geojson       NT portion of each IBRA7 bioregion
  backend/app_data/protected_areas.geojson  CAPAD 2024 NT polygons, for the map
  backend/app_data/summary.json             Territory-wide headline figures

Run from the repo root:  python analysis/build_bioregions.py
"""

import json
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely
from esda.getisord import G_Local
from libpysal.weights import Queen, KNN, w_union

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
OUT = ROOT / "backend" / "app_data"

ALBERS = 3577          # GDA94 / Australian Albers, equal-area, metres
TARGET_PCT = 30        # CBD Kunming-Montreal Target 3 ("30 by 30")
SIMPLIFY_M = 1000      # web geometry tolerance for bioregions
PA_SIMPLIFY_M = 250    # web geometry tolerance for protected areas

# Bioregions where the NT holds only a sliver are excluded from
# "most/least protected" rankings. Their NT figures are real but describe a
# fragment of a bioregion that is mostly managed by another state.
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


def load_ibra():
    ibra = gpd.read_file(RAW / "ibra7/ibra7_regions/IBRARegion_Aust70/IBRARegion_Aust70.shp")
    ibra = ibra.to_crs(ALBERS)
    ibra["area_km2"] = ibra.area / 1e6

    national = ibra.groupby("IBRA_REG_C").area_km2.sum().rename("national_km2")

    nt = ibra[ibra.STATE == "NT"].copy()
    nt = nt.dissolve(by="IBRA_REG_C", aggfunc={"IBRA_REG_N": "first"}).reset_index()
    nt = nt.rename(columns={"IBRA_REG_C": "code", "IBRA_REG_N": "name"})
    nt["total_km2"] = nt.area / 1e6
    nt = nt.join(national, on="code")
    nt["nt_share"] = nt.total_km2 / nt.national_km2
    return nt[["code", "name", "total_km2", "national_km2", "nt_share", "geometry"]]


def load_capad():
    pa = gpd.read_file(RAW / "capad/capad2024_nt.geojson").to_crs(ALBERS)
    # OVERLAP=2 features sit entirely inside OVERLAP=1 features. CAPAD's own
    # totals exclude them, and so do we, so no area is counted twice.
    pa = pa[pa.OVERLAP.astype(str) == "1"].copy()
    pa["governance"] = pa.GOVERNANCE.map(lambda g: GOVERNANCE[g][0])
    return pa


def protection_by_bioregion(nt, pa):
    pieces = gpd.overlay(nt[["code", "geometry"]], pa[["governance", "geometry"]], how="intersection")
    pieces["km2"] = pieces.area / 1e6
    by_gov = pieces.pivot_table(index="code", columns="governance", values="km2", aggfunc="sum")
    by_gov = by_gov.reindex(columns=GOV_KEYS).fillna(0)

    out = nt.set_index("code").join(by_gov.add_suffix("_km2")).fillna(
        {f"{k}_km2": 0 for k in GOV_KEYS})
    out["protected_km2"] = out[[f"{k}_km2" for k in GOV_KEYS]].sum(axis=1)
    out["pct_protected"] = out.protected_km2 / out.total_km2 * 100
    out["meets_target"] = out.pct_protected >= TARGET_PCT
    out["rankable"] = out.nt_share >= RANK_MIN_NT_SHARE
    return out.reset_index()


def validate(bio):
    """Our spatial result must reproduce DCCEEW's published NT table."""
    pub = pd.read_excel(RAW / "capad/capad-2024-terrestrial-nt.xlsx",
                        sheet_name="IBRA Bioregions", header=1)
    pub = pub[pub["IBRA Region Code"].notna()].set_index("IBRA Region Code")
    pub_pct = pub["% IBRA Region Area in NT Protected"]
    pub_area = pub["1 IBRA Region Area in NT"] / 100  # ha -> km2

    ours = bio.set_index("code")
    missing = set(pub_pct.index) ^ set(ours.index)
    assert not missing, f"bioregion codes differ from published table: {missing}"

    d_pct = (ours.pct_protected - pub_pct).abs()
    d_area = (ours.total_km2 / pub_area - 1).abs()
    print(f"validation vs published CAPAD 2024 NT table ({len(ours)} bioregions):")
    print(f"  % protected: max abs diff {d_pct.max():.3f} pp ({d_pct.idxmax()})")
    print(f"  NT area:     max rel diff {d_area.max() * 100:.3f}% ({d_area.idxmax()})")
    assert d_pct.max() < 0.1, "protection % disagrees with published CAPAD table"
    assert d_area.max() < 0.005, "bioregion NT area disagrees with published CAPAD table"


def hotspots(bio):
    """Getis-Ord Gi* on % protected, as in the original app.

    Queen contiguity, with each region also linked to its nearest neighbour
    so island regions (Tiwi Cobourg) are not left without neighbours.
    """
    w = w_union(Queen.from_dataframe(bio, use_index=False, silence_warnings=True),
                KNN.from_dataframe(bio, k=1, use_index=False, silence_warnings=True),
                silence_warnings=True)
    g = G_Local(bio.pct_protected.values, w, transform="B", star=True,
                permutations=9999, seed=42)

    def label(z, p):
        if p >= 0.05:
            return "Not significant"
        return "Hot spot (high protection)" if z > 0 else "Cold spot (low protection)"

    bio["gi_z"] = g.Zs
    bio["gi_p"] = g.p_sim
    bio["gi_class"] = [label(z, p) for z, p in zip(g.Zs, g.p_sim)]
    return bio


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


def main():
    nt = load_ibra()
    pa = load_capad()
    bio = protection_by_bioregion(nt, pa)
    validate(bio)
    bio = hotspots(bio)

    # Simplify shared borders together so adjacent regions stay gap-free.
    bio["geometry"] = shapely.coverage_simplify(bio.geometry.values, SIMPLIFY_M)
    web = bio.copy()
    for c in ["total_km2", "national_km2", "protected_km2"] + [f"{k}_km2" for k in GOV_KEYS]:
        web[c] = web[c].round(1)
    for c in ["pct_protected", "gi_z"]:
        web[c] = web[c].round(2)
    web["nt_share"] = web.nt_share.round(4)
    write_geojson(web, OUT / "bioregions.geojson")

    pa_web = pa[["NAME", "TYPE", "TYPE_ABBR", "governance", "IUCN", "GIS_AREA", "geometry"]].copy()
    pa_web["area_km2"] = (pa_web.pop("GIS_AREA") / 100).round(1)
    pa_web["geometry"] = pa_web.geometry.simplify(PA_SIMPLIFY_M, preserve_topology=True).apply(polygonal)
    pa_web = pa_web[~pa_web.geometry.is_empty]
    write_geojson(pa_web, OUT / "protected_areas.geojson")

    nt_area = bio.total_km2.sum()
    protected = bio.protected_km2.sum()
    by_gov = {k: round(float(bio[f"{k}_km2"].sum()), 1) for k in GOV_KEYS}
    ranked = bio[bio.rankable].sort_values("pct_protected")

    def brief(row):
        return {"name": row["name"], "pct_protected": round(float(row.pct_protected), 2),
                "total_km2": round(float(row.total_km2), 1)}

    summary = {
        "source": "CAPAD 2024 (protected areas as at 30 June 2024); IBRA v7 bioregions",
        "target_pct": TARGET_PCT,
        "rank_min_nt_share": RANK_MIN_NT_SHARE,
        "nt_area_km2": round(float(nt_area), 1),
        "protected_km2": round(float(protected), 1),
        "pct_protected": round(float(protected / nt_area * 100), 2),
        "by_governance_km2": by_gov,
        "by_governance_pct_of_protected": {k: round(v / protected * 100, 2) for k, v in by_gov.items()},
        "governance_labels": {k: lbl for k, lbl in GOVERNANCE.values()},
        "n_bioregions": int(len(bio)),
        "n_meeting_target": int(bio.meets_target.sum()),
        "least_protected": brief(ranked.iloc[0]),
        "most_protected": brief(ranked.iloc[-1]),
    }
    (OUT / "summary.json").write_text(json.dumps(summary, indent=2, default=float))
    print(f"  wrote backend/app_data/summary.json")

    cols = ["name", "total_km2", "nt_share", "pct_protected", "ipa_km2", "joint_km2",
            "government_km2", "private_km2", "rankable", "gi_class"]
    with pd.option_context("display.width", 200, "display.max_columns", 20):
        print(bio[cols].sort_values("pct_protected", ascending=False).round(2).to_string(index=False))
    print(json.dumps(summary, indent=2, default=float))


if __name__ == "__main__":
    main()
