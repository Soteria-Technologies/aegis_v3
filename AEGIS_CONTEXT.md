# AEGIS V3 — Project Context & Coding Instructions

> **Adaptive Emergency Geospatial Intelligence System**  
> Full-stack GIS risk management platform for cascading risk analysis, facility mapping, and infrastructure interdependency modelling.  
> Last updated: April 2026

---

## 1. Project Identity

AEGIS V3 is a **disaster risk reduction tool** built for practitioners — civil protection agencies, emergency managers, critical infrastructure operators. Its purpose is to map, classify, analyse, and predict cascading risks across a defined geographic area.

The intellectual backbone is the **TST framework** (Wenzel et al., 2026, *Natural Hazards* 122:82) — a Type × Spatial × Temporal classification of hazard interrelations, adapted in AEGIS to model **asset-level propagation** (failure of asset A causing or enabling failure of asset B) rather than purely natural hazard-to-hazard chains.

**Design aesthetic:** Tactical dark UI. Roboto Mono throughout. Dark navy backgrounds (`#050810`, `#0b0f1c`), amber accents (`#f59e0b`), muted blue-grey text (`#c8d0e0`). Think operational command centre, not consumer app.

---

## 2. Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js ≥ 18, Express 4 |
| Database | SQLite 3 — **per-project** (`data/projects/{uuid}/facilities.db`) + shared `data/users.db` |
| Frontend | Vanilla JS, Leaflet.js 1.9.4 + **leaflet-rotate** 0.2.8, Three.js r128 |
| Auth | JWT in httpOnly cookies, bcryptjs (12 rounds), invite-only registration |
| External APIs | Overpass API (via optional Cloudflare Worker proxy), NASA GIBS, OpenAerialMap, AWS Terrain Tiles (Mapzen terrarium) |
| Deploy | Render (free tier) — requires `OVERPASS_PROXY` env var for Overpass TLS |
| File uploads | multer 1.4.5-lts, max 50 MB, stored in `data/projects/{id}/layers/` |

---

## 3. File Map

```
aegis-v3/
├── server.js               ~2400 lines — all API routes + WebSocket log stream
├── server-auth.js          JWT auth, invite flow, admin routes
├── admin-cli.js            CLI: generate-secret, create-admin, create-invite
├── facility-db-manager.js  SQLite adapter — all tables, migrations, CRUD
├── relations-engine.js     40-rule relationship engine, TST framework, graph metrics
├── gis-layers.js           Terrain (slope/elevation), land use, choropleth,
│                           feature filter, OSM library, custom layer upload
├── infra-layers.js         Infrastructure layers (roads/highways/rail/power/telecom)
│                           with localStorage persistence per project
├── natural-layers.js       Rivers/water bodies + wind + sea currents
├── app-nav.js              Shared navigation, scan control, post-scan triggers
├── homepage.js             Auth guard, logout, admin link
├── app-map.html            Map workspace (~2200 lines — all map features)
├── app-pages.html          Facilities DB, settings, hazard scale, rel graph card
├── app-relations.html      3D relationship graph (Three.js r128)
├── app-3d.html             MapLibre GL 3D view (building extrusion + DEM terrain)
├── admin.html              Admin panel — user management, invite links
├── login.html              Auth page (invite flow)
├── index.html              Homepage — mode selection + project management
├── style-app.css           App-level styles
├── style-home.css          Homepage styles
└── data/
    ├── users.db            User accounts (shared)
    ├── invites.json        Invite tokens
    ├── projects.json       Project index
    └── projects/{uuid}/
        ├── project.json    Metadata + owner_id + area GeoJSON
        ├── facilities.db   Per-project SQLite (ALL tables)
        ├── hazard_scale.json
        └── layers/         User-uploaded GIS files
```

---

## 4. Database Schema (per-project `facilities.db`)

All tables are created with `CREATE TABLE IF NOT EXISTS` and silently migrate with `ALTER TABLE ... ADD COLUMN` (duplicate column errors suppressed).

```sql
-- Core facility inventory
facilities (
  id TEXT PRIMARY KEY,          -- UUID
  name TEXT,
  category TEXT,                -- machine-readable type (hospital, substation, etc.)
  category_name TEXT,           -- human label
  latitude REAL, longitude REAL,
  address TEXT,
  risk_level TEXT,              -- critical | hazardous | high | medium | low
  source TEXT,                  -- google_places | overpass | manual
  status TEXT DEFAULT 'active',
  properties TEXT,              -- JSON blob of extra attributes
  created_at DATETIME, updated_at DATETIME
)

-- Drawn shapes, infrastructure/natural feature geometry
map_features (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feature_group TEXT,           -- infrastructure | natural | land_use | osm_library | facilities
  feature_type TEXT,            -- roads | rivers | landuse | protected_areas | etc.
  osm_id TEXT,
  name TEXT,
  geometry TEXT,                -- GeoJSON geometry JSON
  properties TEXT,              -- JSON
  bbox_south REAL, bbox_north REAL, bbox_west REAL, bbox_east REAL,
  created_at DATETIME
)

-- User-uploaded GIS files
custom_layers (
  id TEXT PRIMARY KEY,          -- UUID (= stored filename without extension)
  name TEXT, file_name TEXT, file_format TEXT,
  file_size INTEGER, stored_path TEXT,
  is_visible INTEGER DEFAULT 1,
  z_order INTEGER DEFAULT 0,
  opacity REAL DEFAULT 1.0,
  style TEXT,                   -- JSON
  bounds TEXT,                  -- JSON [[s,w],[n,e]]
  feature_count INTEGER,
  uploaded_by TEXT,
  created_at DATETIME
)

-- Relationship graph nodes
rel_nodes (
  id TEXT PRIMARY KEY,          -- fac_{uuid} | nat_{env_key}
  node_type TEXT,               -- facility | infrastructure | natural_hazard
  entity_id TEXT,               -- FK to facilities.id (nullable for natural_hazard)
  name TEXT, category TEXT,
  latitude REAL, longitude REAL,
  risk_level TEXT,
  is_external INTEGER DEFAULT 0, -- 1 = natural hazard node (source-only)
  properties TEXT,              -- JSON: degree, risk_score, dep_depth, etc.
  created_at DATETIME, updated_at DATETIME
)

-- Relationship graph edges
rel_edges (
  id TEXT PRIMARY KEY,
  from_node TEXT REFERENCES rel_nodes(id) ON DELETE CASCADE,
  to_node   TEXT REFERENCES rel_nodes(id) ON DELETE CASCADE,
  link_type TEXT,               -- MECH | VICN | DEPS | EXPO | SRES
  tst_type TEXT,                -- HCA | HTC | HPC | HIN
  tst_spatial TEXT,             -- SO | SSP | SNO
  tst_temporal TEXT,            -- TSI | TCO | TDI
  is_bidirectional INTEGER DEFAULT 0,
  distance_m REAL,
  confidence REAL DEFAULT 0.5,
  rule_id TEXT,
  source TEXT DEFAULT 'auto',   -- auto | manual
  notes TEXT,
  properties TEXT,              -- JSON
  created_at DATETIME, updated_at DATETIME
)

-- Per-facility operational schedules (for TST temporal classification)
facility_schedules (
  facility_id TEXT PRIMARY KEY REFERENCES facilities(id),
  hours_json TEXT,              -- [{ days:[0..6], open:8, close:18, peak_occ:0.9 }]
  always_active INTEGER DEFAULT 0,
  notes TEXT,
  updated_at DATETIME
)

-- Environmental context flags (auto-detected + manual override)
env_context (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  context_key TEXT UNIQUE,      -- flood_zone | coastal_surge | landslide_zone | etc.
  value TEXT,                   -- 'true' | 'false'
  source TEXT DEFAULT 'auto',   -- auto | osm | manual
  confidence REAL,
  updated_at DATETIME
)
```

**Migration pattern:** Always `ALTER TABLE ... ADD COLUMN` wrapped in try/catch ignoring `SQLITE_ERROR: duplicate column name`. Never DROP columns.

---

## 5. API Routes

All routes require `requireAuth` middleware (JWT from httpOnly cookie) unless marked `[public]`.

### Auth (server-auth.js)
```
[public] POST /api/auth/login
[public] POST /api/auth/logout
         GET  /api/auth/me
[public] GET  /api/invite/check/:token
[public] POST /api/invite/use
```

### Admin
```
GET    /admin/users
GET    /admin/invites
POST   /admin/invite
POST   /admin/create-user
PATCH  /admin/users/:id
POST   /admin/users/:id/reset-password
DELETE /admin/invite/:token
```

### Projects
```
GET    /api/projects               — list (user-scoped by owner_id)
POST   /api/projects               — create
PUT    /api/projects/:id           — update
DELETE /api/projects/:id           — delete
```

### Scan
```
POST   /api/projects/:id/scan/start     body: { batchSize:1-16, force:bool }
GET    /api/projects/:id/scan/status
POST   /api/projects/:id/scan/abort
GET    /api/projects/:id/scan/preview   — grid preview
```

### Facilities
```
GET    /api/projects/:id/facilities
GET    /api/projects/:id/facilities/export/sql
POST   /api/projects/:id/facilities/import/geojson
POST   /api/projects/:id/facilities/import/sql
POST   /api/projects/:id/facilities/landuse-filter  body: { landuse_type, distance_m }
```

### Infrastructure (OSM, cached in map_features DB)
```
GET    /api/projects/:id/infrastructure/:type        — roads|highways|railways|power|telecom
DELETE /api/projects/:id/infrastructure/:type/cache
```

### Natural Layers
```
GET    /api/projects/:id/natural/rivers
DELETE /api/projects/:id/natural/rivers/cache
```

### Land Use
```
GET    /api/projects/:id/landuse                     — ?refresh=1 to force refetch
```

### OSM Library (10 curated layers, per-project cache in map_features)
```
GET    /api/projects/:id/osm-library/:layerId
DELETE /api/projects/:id/osm-library/:layerId/cache
```
Layer IDs: `protected_areas | wetlands | industrial_zones | farmland | forest | residential | military_zones | flood_prone | bare_rock | scrubland`

### Aerial Imagery
```
GET    /api/aerial/search?lat=&lng=&radius=          — OAM → NASA GIBS fallback
GET    /api/aerial/thumbnail?url=<encoded>           — image proxy (whitelisted hosts)
```

### Custom GIS Layers
```
POST   /api/projects/:id/layers                      — multipart upload
GET    /api/projects/:id/layers
GET    /api/projects/:id/layers/:layerId/data
PATCH  /api/projects/:id/layers/:layerId
DELETE /api/projects/:id/layers/:layerId
```

### Relationship Graph
```
POST   /api/projects/:id/relationships/compute
GET    /api/projects/:id/relationships/graph
GET    /api/projects/:id/relationships/stats
PATCH  /api/projects/:id/relationships/edges/:edgeId
GET    /api/projects/:id/relationships/rulebook
PUT    /api/projects/:id/relationships/schedule/:facilityId
POST   /api/projects/:id/relationships/env-context
```

### Hazard Scale
```
GET    /api/projects/:id/hazard-scale
PUT    /api/projects/:id/hazard-scale
```

### System
```
GET    /api/health
WS     /ws/logs                                      — admin-only log stream
```

---

## 6. Relationship Engine (`relations-engine.js`)

### TST Framework — Asset-Level Mapping

| Original (Wenzel 2026) | AEGIS asset-propagation meaning |
|---|---|
| **HCA** Cascading | Failure of A directly causes/enables failure of B |
| **HTC** Trigger-coupled | A and B fail simultaneously from same external shock |
| **HPC** Pre-conditioning | Degradation of A increases B's vulnerability without directly triggering |
| **HIN** Independent | Proximity without propagation mechanism |

### Link Types

| Code | Name | Direction | Example |
|---|---|---|---|
| `MECH` | Mechanism | Directed | Bridge → Hospital (sole access route) |
| `VICN` | Vicinity | Undirected | Timber storage ↔ Oil depot (ignition amplification) |
| `DEPS` | Dependency | Directed | Substation → Hospital (power) |
| `EXPO` | Exposure | Directed | Chemical plant → Downstream water treatment |
| `SRES` | Shared Resource | Undirected | Hospital A ↔ Hospital B (same water supply) |

### Spatial Types (from TST)
- `SO` — Overlapping (same impact footprint)
- `SSP` — Source to Spread (originates at A, propagates to B)
- `SNO` — Non-overlapping (different spatial domains, indirect interaction)

### Temporal Types (from TST, re-interpreted for assets)
- `TSI` — Simultaneous (both assets active/at-risk at same time)
- `TCO` — Consecutive (B fails while A is still in disrupted state)
- `TDI` — Temporally Distant (full recovery between events)

Temporal classification is computed from operational schedules: if both facilities `always_active = true` → TSI; staggered hours with overlap → TCO; rarely co-active → TDI.

### Default Rulebook (40 rules)
Rules match `{ from_category, to_category }` pairs with `max_distance_m` thresholds. Example entries:

```js
{ id:'R01', from:'power_plant', to:'substation',  link:'DEPS', tst:'HCA', sp:'SSP', tm:'TSI', dist:50000, conf:0.90 }
{ id:'R17', from:'chemical_plant', to:'water',    link:'EXPO', tst:'HCA', sp:'SSP', tm:'TCO', dist:5000,  conf:0.90 }
{ id:'R21', from:'petroleum', to:'chemical_plant',link:'VICN', tst:'HTC', sp:'SO',  tm:'TSI', dist:500,   conf:0.85, bidir:true }
{ id:'R35', from:'hospital',  to:'hospital',      link:'SRES', tst:'HIN', sp:'SO',  tm:'TSI', dist:10000, conf:0.70, bidir:true }
```

### Natural Hazard Nodes
Injected from `env_context` table. They are **source-only** (never receive edges), placed at the project bbox centroid, connected to affected facility types via `EXPO` links:
- `flood_zone` → affects: hospital, water, substation, waste, chemical_plant, petroleum
- `landslide_zone` → affects: hospital, train_station, communication
- `seismic_zone` → affects: hospital, chemical_plant, petroleum, power_plant, substation, storage_tank
- `coastal_surge` → affects: hospital, water, communication, military, airport
- `wind_corridor` → affects: communication, airport, power_plant, chemical_plant
- `industrial_cluster` → affects: hospital, school, water, shelter

### Graph Metrics
Computed after each graph build:
- **degree** = total edge count per node
- **in_degree / out_degree** = directed edge counts
- **risk_score** = `risk_weight × (1 + cascading_in × 0.4 + exposure_in × 0.2)`
- **dep_depth** = BFS depth following DEPS + MECH edges upstream

---

## 7. Frontend Architecture

### Map Workspace (`app-map.html`)

**Single-page application** — all tool state in `window.S = {}`.

#### Left Panel Sections (top to bottom)
1. **Facilities** — risk filter buttons (CRIT/HAZ/HIGH/MED/LOW), count
2. **Infrastructure** — roads, highways, railways, power grid, telecom (each with ⟳ reload)
3. **Natural Features** — rivers & water, wind currents, sea currents, terrain (slope/elevation toggle), land use
4. **Land Use Filter** — land use type selector + distance input → facility filter
5. **OSM Layer Library** — 10 curated layers, download on demand, cached per project
6. **Custom Layers** — file upload + layer list + QUERY/FILTER panel (choropleth, attribute filter)

#### Tools (toolbar at top)
`PAN | MARKER | RECTANGLE | CIRCLE (facility count) | POLYGON | MEASURE | 🛰 AERIAL`

#### Key Global State (`window.S`)
```js
S.facilities      // array of facility objects from DB
S.activeRisks     // Set of visible risk levels
S.pendingLatlng   // Leaflet LatLng for marker placement
S.pendingColor    // Current marker color
S.tool            // 'pan' | 'marker' | 'rect' | 'circle' | 'poly' | 'measure'
```

#### Leaflet Configuration
- `rotate: true` — **leaflet-rotate** plugin enabled; use `map.setBearing(deg)` NOT CSS transform
- Compass drag calls `map.setBearing()` — panels/overlays stay upright
- Base layers: OSM, Satellite (Esri), Terrain (OpenTopoMap), Dark, Archive (NASA GIBS WMTS year slider)
- Custom panes: standard Leaflet overlay/marker panes

### 3D Relationship Graph (`app-relations.html`)
- **Three.js r128** (NOT THREE.OrbitControls — not on CDN at r128)
- Manual orbit: left-drag rotates (theta/phi), right-drag pans, scroll zooms
- Camera: `camTheta`, `camPhi`, `camRadius`, `camTarget` → `camera.position` computed each frame
- Nodes: `SphereGeometry`, colored by `risk_level`
- Edges: `QuadraticBezierCurve3` → `BufferGeometry` → `Line`, colored by `link_type`

#### Axis System
5 computable dimensions assignable to X, Y, Z independently:
- `longitude` — geographic east-west
- `latitude` — geographic north-south
- `centrality` — degree + in_degree (number of connections)
- `risk_score` — intrinsic risk × cascading links
- `dep_depth` — BFS depth upstream

Default: X=centrality, Y=latitude, Z=risk_score. All values normalized 0→1 per dimension.

### 3D MapLibre View (`app-3d.html`)
- MapLibre GL JS 3.6.2
- Base: OSM raster + hillshade
- Buildings: OpenFreeMap vector tiles (free, no key) — `fill-extrusion` from `render_height` or `levels × 3m`
- DEM: AWS terrarium tiles (encoding: `'terrarium'`)
- Controls: pitch 0–85°, bearing 0–360°, terrain exaggeration 1–3×, building opacity

---

## 8. GIS Layers (`gis-layers.js`)

### Terrain Layer
- Source: AWS Terrain Tiles (`s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`)
- Encoding: `elevation = (R × 256 + G + B/256) − 32768`
- **Slope mode**: central-difference gradient → green(flat) → yellow → red(steep)
- **Elevation mode**: per-tile normalized ramp → blue(low) → cyan → green → yellow → orange → red(high)
- Single `L.GridLayer` recreated when mode switches

### Land Use Layer
- Fetched from Overpass: `landuse=*` and `natural=*` polygons
- Stored in `map_features` table: `feature_group='land_use'`, `feature_type='landuse'`
- 11 styled classes with distinct translucent fills

### OSM Library
- 10 curated layers (see API section)
- Stored in `map_features`: `feature_group='osm_library'`, `feature_type={layerId}`
- Per-project cache, reload-on-demand

### Custom Layers
- Formats: GeoJSON, KML (inline parser, no library), PNG/JPG (image overlay), GeoTIFF (stub)
- Stored on disk at `data/projects/{id}/layers/{uuid}.{ext}`
- Metadata in `custom_layers` table
- Supports: opacity, z-order, visibility toggle, zoom-to, delete

### Feature Query / Choropleth
- Attribute filter: 7 operators (`= ≠ > ≥ < ≤ contains`) applied by toggling feature SVG path `display`
- Choropleth: value range computed from feature properties → blue→red sequential fill + legend control
- Point-in-polygon: inline Winding Number algorithm, no Turf.js dependency

### Facility Land-Use Proximity Filter
- Server-side: bbox pre-filter → point-in-polygon → nearest-vertex distance approximation
- Returns matched facility IDs + objects
- Client: amber circle overlays on matched, 18% opacity on others

---

## 9. Coding Rules & Patterns

### str_replace Discipline
**Always view the file immediately before editing.** After any successful edit, previous view output is stale — re-view before further edits to the same file. Never guess at context; the exact string must match.

### Error Handling Pattern
```js
// DB operations — always close on error/success
const db = new FacilityDatabaseManager(project.db_path);
await db.initialize();
try {
  // ... operations
  await db.close().catch(() => {});
  res.json(result);
} catch (err) {
  await db.close().catch(() => {});
  res.status(500).json({ error: err.message });
}
```

### FacilityDatabaseManager Usage
```js
// Always call initialize() before any method
const db = new FacilityDatabaseManager(project.db_path);
await db.initialize();

// Key methods:
db.upsertMapFeatures(group, type, features[])    // bulk replace
db.getMapFeatures(group, type)                   // → GeoJSON FeatureCollection
db.countMapFeatures(group, type)                 // → integer
db.clearMapFeatures(group, type)                 // → rows deleted
db.upsertRelNode(node)
db.upsertRelEdge(edge)
db.getRelGraph()                                 // → { nodes, edges }
db.setEnvContext(key, value, source, confidence)
db.getEnvContextAll()                            // → { key: row }
db.upsertSchedule(facilityId, hoursJson, alwaysActive, notes)
```

### Infrastructure Cache Pattern
All Overpass-fetched layers follow:
1. Check `countMapFeatures(group, type)` — serve from DB if > 0
2. Check for legacy JSON file — auto-migrate to DB if found
3. Fetch from Overpass → `upsertMapFeatures()` → respond

### Overpass Queries
```js
// Always use the rotating endpoint index
const ep = OVERPASS_ENDPOINTS[overpassEndpointIdx % OVERPASS_ENDPOINTS.length];
const r  = await axios.post(ep, query, {
  headers: { 'Content-Type': 'text/plain', 'User-Agent': 'AEGIS-V3/1.0' },
  timeout: 55000
});
```
If `OVERPASS_PROXY` env var is set, all queries route through the Cloudflare Worker (required on Render free tier due to outbound TLS blocking).

### Auth Middleware
```js
// Standard protected route
app.get('/api/projects/:id/something', requireAuth, async (req, res) => {
  const project = await verifyOwnership(req, res);
  if (!project) return; // verifyOwnership sends 403/404 itself
  // ...
});
```

### Client-Side axios
```js
// Always include credentials for JWT cookie
axios.defaults.withCredentials = true;
const API = window.AEGIS_API; // set by nav.js after project load
```

### HTML escaping
```js
// Always escape user-controlled strings in innerHTML
function h(s) { const d=document.createElement('div'); d.textContent=String(s||''); return d.innerHTML; }
```

### No CSS Transform Rotation on Map Container
**Never** do `map.getContainer().style.transform = rotate(...)`. This breaks all HTML overlays (panels, popups, status bars). Use `map.setBearing(deg)` from leaflet-rotate.

---

## 10. Environment Variables

```env
JWT_SECRET=<64-char hex>          # required — generate with admin-cli.js generate-secret
PORT=3001                         # optional, defaults to 3001
OVERPASS_PROXY=<Worker URL>       # required on Render; optional locally
NODE_ENV=production               # enables secure/sameSite cookies on HTTPS
GOOGLE_PLACES_API_KEY=<key>       # optional — facility scan falls back to Overpass if absent
```

---

## 11. Setup & First Run

```bash
npm install
node admin-cli.js generate-secret       # → paste into .env as JWT_SECRET
node admin-cli.js create-admin \
  --email admin@example.com \
  --username admin \
  --password yourpassword
npm start                               # → http://localhost:3001/login.html
```

---

## 12. Facility Categories

The scan engine and relationship engine use these `category` values:

```
hospital | clinic | fire_station | police | school | gymnasium | shelter
power_plant | substation | chemical_plant | petroleum | waste | water
airport | train_station | communication | military | storage_tank
```

Risk levels (stored in DB + `hazard_scale.json`): `critical | hazardous | high | medium | low`

---

## 13. Known Architectural Decisions & Why

| Decision | Reason |
|---|---|
| Per-project SQLite instead of shared DB | Enables single-file project export/import; isolates projects from each other |
| `map_features` unified table for infra/natural/landuse/osm_library | Single query pattern, single cache-bust mechanism, future spatial index ready |
| leaflet-rotate plugin instead of CSS transform | CSS transform on container breaks all HTML overlays; plugin rotates tiles only |
| Mapzen terrarium for terrain (not Mapbox) | Free, no API key, same encoding as Maplibre-GL terrarium sources |
| Relations stored as SQLite edges, not graph DB | Per-project portability, easy export to CSV/GeoJSON, equational loss calculation later |
| `relations-engine.js` is pure Node.js (no DB calls) | Can run server-side or be extracted to a worker; deterministic for testing |
| Overpass via Cloudflare Worker on Render | Render free tier blocks outbound TLS to some hosts; Worker acts as transparent proxy |
| JWT in httpOnly cookies, not localStorage | XSS-resistant; timing-attack-safe login comparison |
| Multer LTS branch (1.4.5-lts.1) | Non-LTS multer ≥ 2.x has breaking changes; LTS is the community-maintained safe branch |

---

## 14. What Is Not Yet Built (Roadmap)

- **Scenario builder** — compose multi-hazard scenarios from the TST matrix, assign probabilities, run loss estimation equations from Wenzel et al. Table 7
- **Risk inventory page** — aggregate risk scores per district/grid cell, choropleth output
- **Entities network page** — non-geographic network view (currently stub)
- **GeoTIFF rendering** — `georaster-layer-for-leaflet` integration (stub in gis-layers.js)
- **Shapefile upload** — convert SHP → GeoJSON server-side (needs `shpjs` or `ogr2ogr`)
- **PDF/DOCX export** — generate risk assessment reports from project data
- **Multi-user real-time collaboration** — WebSocket currently used for log streaming only
- **Quantitative risk equations** — implement the loss formulas from Wenzel et al. Table 7 against the facilities DB
- **Hazard interrelation index** — 0 (no relation) to 1 (fully dependent) score per edge
- **Time-series analysis** — track facility risk scores over time as context changes

---

## 15. TST Quick Reference

```
Type:    HCA (cascade) | HTC (trigger-coupled) | HPC (pre-conditioning) | HIN (independent)
Space:   SO (overlapping) | SSP (source→spread) | SNO (non-overlapping)
Time:    TSI (simultaneous) | TCO (consecutive) | TDI (temporally distant)

36 combinations = 4 × 3 × 3
Each combination implies a specific modelling approach (see Wenzel et al. Table 5)
and a specific exposure/vulnerability treatment (Table 6) and loss formula (Table 7).
```

---

*This file is the authoritative context document for AI-assisted development of AEGIS V3. When in doubt, read the code — the code is the truth.*
