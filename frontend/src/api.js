// Backend URL — Render in production, localhost for local dev
const API_BASE = import.meta.env.VITE_API_BASE || "https://bushmetrics-api-975b47c8fabf.herokuapp.com";

export async function getBioregions() {
  const res = await fetch(`${API_BASE}/bioregions`);
  if (!res.ok) throw new Error("Failed to load bioregions");
  return res.json();
}

export async function getByClass() {
  const res = await fetch(`${API_BASE}/by-class`);
  if (!res.ok) throw new Error("Failed to load class data");
  return res.json();
}

export async function askQuestion(question) {
  const API_BASE = import.meta.env.VITE_API_BASE || "https://bushmetrics-api-975b47c8fabf.herokuapp.com";
  const res = await fetch(`${API_BASE}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  if (!res.ok) throw new Error("Query failed");
  return res.json();
}
