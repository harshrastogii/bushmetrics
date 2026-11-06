# BushMetrics frontend

React (Vite) + react-leaflet single-page app for [bushmetrics.vercel.app](https://bushmetrics.vercel.app/).
See the [project README](../README.md) for the data, method and results.

## Run

```bash
npm install
VITE_API_BASE=http://localhost:8000 npm run dev   # against a local API
npm run dev                                       # against the live Heroku API
npm run lint
npm run build
```

`VITE_API_BASE` sets the API the app calls. Without it, `src/api.js` falls back to the
live Heroku API.

## Layout

- `src/App.jsx`: the whole app. Three map views (percent protected, who manages it,
  Gi\* hot/cold spots), the region detail panel, natural-language search, geolocation.
- `src/api.js`: calls to `/bioregions`, `/protected-areas`, `/summary` and `/ask`.
- `src/App.css`: styles and design tokens.
- `public/og-card-v2.jpg`: the link-preview image referenced from `index.html`. Give a
  replacement a new filename, since social sites cache preview images by URL.

Header figures come from `/summary`, so they update with the data and are not set in code.

## Deploy

Vercel builds this folder on every push to `main`. If a change needs new API endpoints,
deploy the backend first (it also deploys from `main`, through Heroku), otherwise the
new frontend briefly calls endpoints that don't exist yet.

## Notes

- Basemap: Esri World Light Gray (no key needed). CARTO tiles now require an API key.
- `._*` files are macOS metadata created on the exFAT drive this repo lives on; ESLint
  and git both ignore them.
