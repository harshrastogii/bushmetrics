// Central place for the backend URL — change this one line when you deploy
const API_BASE = "http://127.0.0.1:8000";

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
