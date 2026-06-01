from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import json
from pathlib import Path

app = FastAPI(title="NT Protected Areas API")

# Allow the React frontend (different port) to call this API
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # fine for a public read-only demo
    allow_methods=["GET"],
    allow_headers=["*"],
)

DATA = Path(__file__).parent / "app_data"

def load(name):
    with open(DATA / name) as f:
        return json.load(f)

@app.get("/")
def root():
    return {"status": "ok", "endpoints": ["/bioregions", "/by-class", "/by-cluster"]}

@app.get("/bioregions")
def bioregions():
    """Bioregion polygons with protection stats and hot/cold-spot classification."""
    return JSONResponse(load("bioregions.geojson"))

@app.get("/by-class")
def by_class():
    """Protection percentage by land class."""
    return JSONResponse(load("by_class.json"))

@app.get("/by-cluster")
def by_cluster():
    """Protection percentage by ecological cluster (from text mining)."""
    return JSONResponse(load("by_cluster.json"))
