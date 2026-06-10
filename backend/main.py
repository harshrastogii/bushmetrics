from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import json, os
from pathlib import Path
from google import genai

app = FastAPI(title="NT Protected Areas API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

DATA = Path(__file__).parent / "app_data"

def load(name):
    with open(DATA / name) as f:
        return json.load(f)

GEMINI_KEY = os.environ.get("GEMINI_API_KEY")
client = genai.Client(api_key=GEMINI_KEY) if GEMINI_KEY else None

@app.get("/")
def root():
    return {"status": "ok", "endpoints": ["/bioregions", "/by-class", "/by-cluster", "/ask"]}

@app.get("/bioregions")
def bioregions():
    return JSONResponse(load("bioregions.geojson"))

@app.get("/by-class")
def by_class():
    return JSONResponse(load("by_class.json"))

@app.get("/by-cluster")
def by_cluster():
    return JSONResponse(load("by_cluster.json"))

class Question(BaseModel):
    question: str

VALID_METRICS = {"pct_protected", "total_km2", "protected_km2"}
VALID_GI = {"Hot spot (high protection)", "Cold spot (low protection)", "Not significant"}

SYSTEM_PROMPT = """You translate a user's question about Northern Territory bioregions into a JSON filter.
Available data per region: name, pct_protected (percent of land protected), total_km2, protected_km2,
and gi_class (one of "Hot spot (high protection)", "Cold spot (low protection)", "Not significant").

Return ONLY a JSON object, no other text, with these optional keys:
- "metric": one of "pct_protected", "total_km2", "protected_km2"
- "order": "ascending" or "descending"
- "limit": integer 1-10
- "gi_filter": one of the gi_class values, if the user asks about hot/cold spots
- "answerable": true or false

If the question cannot be answered from this data, return {"answerable": false}.

Examples:
"which regions are least protected?" -> {"metric":"pct_protected","order":"ascending","limit":5,"answerable":true}
"show me the cold spots" -> {"gi_filter":"Cold spot (low protection)","answerable":true}
"biggest regions" -> {"metric":"total_km2","order":"descending","limit":5,"answerable":true}
"how many kangaroos" -> {"answerable":false}
"""

@app.post("/ask")
def ask(q: Question):
    if not client:
        return {"ok": False, "message": "AI query is not configured on this server."}

    try:
        resp = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=SYSTEM_PROMPT + "\n\nQuestion: " + q.question,
        )
        raw = (resp.text or "").strip().replace("```json", "").replace("```", "").strip()
        spec = json.loads(raw)
    except Exception as e:
        msg = str(e)
        if "RESOURCE_EXHAUSTED" in msg or "429" in msg:
            return {"ok": False, "message": "The AI is busy right now (rate limit). Please wait a few seconds and try again."}
        return {"ok": False, "message": "I couldn't understand that. Try asking which regions are most or least protected."}

    try:
        if not spec.get("answerable", False):
            return {"ok": False, "message": "I can only answer questions about protection coverage, area, and hot/cold spots for NT bioregions. Try: 'which regions are least protected?'"}

        geo = load("bioregions.geojson")
        rows = [f["properties"] for f in geo["features"]]

        gi = spec.get("gi_filter")
        if gi in VALID_GI:
            rows = [r for r in rows if r.get("gi_class") == gi]

        metric = spec.get("metric")
        if metric in VALID_METRICS:
            order = spec.get("order", "descending")
            rows.sort(key=lambda r: r.get(metric, 0), reverse=(order != "ascending"))

        limit = spec.get("limit", 5)
        if not isinstance(limit, int) or limit < 1 or limit > 10:
            limit = 5
        rows = rows[:limit]

        results = [{
            "name": r["GEO_ZONE"],
            "pct_protected": round(r["pct_protected"], 1),
            "total_km2": round(r["total_km2"]),
            "gi_class": r["gi_class"],
        } for r in rows]

        return {"ok": True, "count": len(results), "results": results, "names": [r["GEO_ZONE"] for r in rows]}
    except Exception as e:
        return {"ok": False, "message": "Something went wrong processing that question. Try rephrasing it."}
