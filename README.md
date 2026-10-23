# BushMetrics — Northern Territory Protected-Area Coverage

**[🌐 Live app](https://bushmetrics.vercel.app/) · [🔌 API](https://bushmetrics-api-975b47c8fabf.herokuapp.com) · [📖 API docs](https://bushmetrics-api-975b47c8fabf.herokuapp.com/docs)**

A full-stack spatial data project measuring how much of each Northern Territory
bioregion sits inside a protected area, who manages that protection, and which regions
fall short of the 30% global target.

> **Headline finding:** 24.6% of the NT is protected, and 78.7% of that protected land is
> Indigenous Protected Areas. Another 13.9% is national parks jointly managed with
> Traditional Owners, so Traditional Owners manage or co-manage 92.6% of the Territory's
> protected estate. 8 of 25 bioregions meet the 30% target. The largest shortfalls run
> through the pastoral middle of the Territory: Sturt Plateau (0.7%), Mitchell Grass Downs
> (1.8%) and Davenport Murchison Ranges (2.2%).

---

## Version 2 (September 2026): what changed and why

The first version of this project reported the NT as 5.1% protected and the Tanami as
0.6%. Both figures were wrong, for two reasons:

1. **It counted NT parks and reserves only.** The protected-area layer was the NT
   Government's parks dataset, which excludes Indigenous Protected Areas. IPAs make up
   78.7% of the NT's protected estate, so the analysis missed most of it. The Tanami,
   reported at 0.6%, is 48.5% protected: it contains the Southern Tanami IPA
   (101,549 km², the NT's largest) and the Northern Tanami IPA.
2. **Its regions were not IBRA bioregions.** The regions came from the `GEO_ZONE` field of
   the NT Land Systems dataset. They carry IBRA-style names but draw different
   boundaries: the old "Tanami" was 2.3 times the size of the IBRA Tanami bioregion's NT
   portion, and the old "Simpson Strzelecki Dunefields" was a 23rd of it. That made the
   results incomparable with published NT conservation research.

Version 2 rebuilds the data on CAPAD 2024 and IBRA v7, the same framework used by
McGinley, Edwards & Garnett (2026), *Gaps in conservation planning in the Northern
Territory of Australia: preparing for the energy transition*, Australasian Journal of
Environmental Management 33(1): 30–47,
[doi:10.1080/14486563.2025.2575948](https://doi.org/10.1080/14486563.2025.2575948).

## Data

| Dataset | Source | Use |
|---|---|---|
| CAPAD 2024, terrestrial, NT | DCCEEW [CAPAD FeatureServer](https://gis.environment.gov.au/gispubmap/rest/services/ogc_services/CAPAD/FeatureServer), `STATE='NT'` (282 polygons) | Protected areas and who manages them |
| CAPAD 2024 NT summary | DCCEEW [`capad-2024-terrestrial-nt.xlsx`](https://www.dcceew.gov.au/environment/land/nrs/science/capad/2024) | Validation only |
| IBRA v7 regions | [data.gov.au](https://data.gov.au/data/dataset/interim-biogeographic-regionalisation-for-australia-ibra-version-7-regions), split by state | Bioregion boundaries and national extent |

CAPAD 2024 records protected areas as at 30 June 2024. Its `GOVERNANCE` field gives the
management categories the app shows: every NT IPA is coded `C` (community), jointly
managed parks `J`, government-managed `G`, private `P`. The app uses CAPAD's own coding;
nothing is reclassified.

## Method

`analysis/build_bioregions.py` rebuilds everything in `backend/app_data/` from the raw
downloads:

1. Take the NT pieces of each IBRA v7 bioregion, and sum every state's pieces to get
   each bioregion's national extent. The ratio is the share of the bioregion inside the
   NT.
2. Intersect the NT bioregions with CAPAD polygons in Australian Albers (EPSG:3577).
   Features CAPAD flags `OVERLAP=2` lie entirely inside other features and are excluded,
   exactly as CAPAD's own totals exclude them, so no area is counted twice.
3. **Validate against DCCEEW's published table.** The script fails if any bioregion's
   protected share differs from the published figure by 0.1 percentage points or more.
   Current result: the largest difference is 0.006 points, and NT areas agree within
   0.19%.
4. Run Getis-Ord Gi\* on percent protected (Queen contiguity plus each region's nearest
   neighbour, so island regions are not isolated; 9,999 permutations).
5. Simplify geometry for the web. Shared borders are simplified together
   (`shapely.coverage_simplify`) so neighbouring bioregions stay gap-free.

**Cross-border bioregions.** Of the 25 IBRA bioregions in the NT, only seven lie entirely
inside it. All figures describe the NT portion, and the app labels every cross-border
region with its NT share. Bioregions where the NT holds under 10% (Mount Isa Inlier, Gulf
Plains, Stony Plains, Channel Country) are kept on the map but left out of
most/least-protected rankings, since their NT figures describe small fragments of
bioregions managed mostly by other states.

## Key results

| | km² | Share of NT protected estate |
|---|---:|---:|
| Indigenous Protected Areas | 260,948 | 78.7% |
| Jointly managed with Traditional Owners | 46,179 | 13.9% |
| Government managed | 16,642 | 5.0% |
| Privately managed | 7,898 | 2.4% |
| **Total protected** | **331,666** | **24.6% of the NT** |

**Meet the 30% target (8):** Central Ranges (93.8%), Arnhem Plateau (75.0%), Great Sandy
Desert (55.8%), Arnhem Coast (54.2%), Tanami (48.5%), Pine Creek (42.7%), Central Arnhem
(34.1%), Darwin Coastal (30.9%).

**Least protected** (excluding NT slivers): Simpson Strzelecki Dunefields (0.03%), Sturt
Plateau (0.7%), Mitchell Grass Downs (1.8%), Davenport Murchison Ranges (2.2%), Finke
(6.2%).

**Spatial clustering is weak at this scale.** Gi\* finds one significant hot spot
(Central Arnhem) and one cold spot (Simpson Strzelecki Dunefields). At bioregion level,
protection follows individual large IPAs more than regional clusters. Version 1 reported
several hot and cold spots; those came from the parks-only data.

## Architecture

```
┌─────────────────────┐      HTTPS / JSON      ┌──────────────────────┐
│  React + Leaflet     │  ───────────────────▶  │  FastAPI (Python)     │
│  frontend (Vercel)   │                        │  backend (Heroku)     │
│  interactive map     │  ◀───────────────────  │  serves analysis JSON │
└─────────────────────┘                        └──────────────────────┘
```

- **Backend** (`backend/`): FastAPI serving `/bioregions`, `/protected-areas`, `/summary`
  and a natural-language `/ask` endpoint from pre-computed output. OpenAPI docs at
  `/docs`. `/by-class` and `/by-cluster` still serve version 1 output (see Limitations).
- **Frontend** (`frontend/`): React (Vite) + react-leaflet, with three map views
  (percent protected, who manages it, Gi\* hot/cold spots) and click-to-inspect
  bioregion detail.

## Limitations

- **Snapshot date.** CAPAD 2024 reflects 30 June 2024. IPAs dedicated since then,
  including the Central Western Desert IPA declared in 2025, are not yet included.
- **Bioregion level.** Averages hide variation inside bioregions: McGinley et al. find
  Tanami subregions at 0% protection even though the bioregion as a whole is 48.5%.
- **Area, not representativeness.** The 30% target is area-based. Whether protected
  areas cover each ecosystem type is a separate question (see Future work).
- **Version 1 endpoints.** `/by-class` and `/by-cluster` were computed from NT parks only
  and exclude IPAs. They are not shown in the app. Recomputing them needs the NT Land
  Systems source data.
- **Gi\* with 25 units** has limited statistical power; treat the hot/cold view as
  descriptive.

## Future work (phase 2)

- IBRA v7 subregions (61 in the NT), matching McGinley et al.'s resolution, validated
  against their Table S1.
- Ecosystem representativeness using NVIS v7 major vegetation sub-groups and the JANIS
  15% threshold.
- Context layers for pastoral leasehold, Aboriginal freehold and Native Title. These are
  shown as land tenure, not counted as protection.

## Running locally

**Rebuild the data** (optional; outputs are committed):
```bash
# download the IBRA v7 regions zip into data/raw/ibra7/ibra7_regions/,
# the CAPAD NT polygons into data/raw/capad/capad2024_nt.geojson,
# and the NT summary xlsx into data/raw/capad/ (see Data above)
python analysis/build_bioregions.py
```
Needs geopandas, shapely ≥ 2.1, esda, libpysal, openpyxl.

**Backend:**
```bash
cd backend
conda create -n ntapi python=3.11 -y
conda activate ntapi
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

**Frontend:**
```bash
cd frontend
npm install
VITE_API_BASE=http://localhost:8000 npm run dev   # opens on http://localhost:5173
```

## Version 1: original analysis

`nt_protection_analysis.ipynb` is the original analysis: protection by NT land class,
TF-IDF clustering of land-system descriptions into six ecological groups, and Moran's I /
Gi\* on land-system zones. Its methods still hold. Its protection figures do not, because
they use NT parks only and exclude IPAs. The figures in `figures/` come from version 1.

## Tools

**Analysis:** Python · GeoPandas · Shapely · esda / libpysal (PySAL) · scikit-learn (v1)
**App:** FastAPI · React (Vite) · Leaflet · deployed on Heroku + Vercel

---

*Protected areas: Collaborative Australian Protected Areas Database (CAPAD) 2024, ©
Commonwealth of Australia (DCCEEW), CC BY 4.0. Bioregions: IBRA v7, © Commonwealth of
Australia, CC BY 4.0. Version 1 data: © Northern Territory Government, NT Open Data
Portal, CC BY.*
