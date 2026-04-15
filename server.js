/**
 * AEGIS V3 — Backend Server
 * Express · SQLite per-project · Auth · OSM · Overpass
 */

const express  = require('express');
const cors     = require('cors');
const axios    = require('axios');
const path     = require('path');
const fs       = require('fs');
const fsp      = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const cookieParser = require('cookie-parser');
require('dotenv').config();

const FacilityDatabaseManager = require('./facility-db-manager');
const {
  initUsersDb,
  requireAuth,
  registerAuthRoutes,
} = require('./server-auth');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Data dirs ────────────────────────────────────────────────────
const DATA_DIR       = path.join(__dirname, 'data');
const PROJECTS_DIR   = path.join(DATA_DIR, 'projects');
const PROJECTS_INDEX = path.join(DATA_DIR, 'projects.json');

async function ensureDataDirs() {
  await fsp.mkdir(DATA_DIR,     { recursive: true });
  await fsp.mkdir(PROJECTS_DIR, { recursive: true });
  if (!fs.existsSync(PROJECTS_INDEX)) {
    await fsp.writeFile(PROJECTS_INDEX, '[]', 'utf8');
  }
}

// ── Middleware ───────────────────────────────────────────────────
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname)));

// ── Nominatim rate-limit guard (1 req / 1 s per OSM ToS) ────────
let lastNominatimCall = 0;
async function nominatimGet(url, params) {
  const now = Date.now();
  const wait = 1050 - (now - lastNominatimCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastNominatimCall = Date.now();
  return axios.get(url, {
    params,
    headers: { 'User-Agent': 'AEGIS-V3/1.0 (cascading-risk-analysis-tool; contact@aegis.local)' },
    timeout: 12000
  });
}

// ════════════════════════════════════════════════════════════════
// PROJECT MANAGEMENT ROUTES (all protected by requireAuth)
// ════════════════════════════════════════════════════════════════

/** Read the project index */
async function readIndex() {
  try { return JSON.parse(await fsp.readFile(PROJECTS_INDEX, 'utf8')); } catch { return []; }
}
async function writeIndex(data) {
  await fsp.writeFile(PROJECTS_INDEX, JSON.stringify(data, null, 2), 'utf8');
}
async function readProject(id) {
  const file = path.join(PROJECTS_DIR, id, 'project.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}
async function writeProject(id, data) {
  await fsp.writeFile(path.join(PROJECTS_DIR, id, 'project.json'), JSON.stringify(data, null, 2), 'utf8');
}

/** Verify ownership — returns project or sends 403/404. */
async function verifyOwnership(req, res) {
  const project = await readProject(req.params.id);
  if (!project) { res.status(404).json({ error: 'Project not found' }); return null; }
  if (project.owner_id && project.owner_id !== req.user.userId && req.user.role !== 'admin') {
    res.status(403).json({ error: 'Access denied' }); return null;
  }
  return project;
}

// Register auth routes BEFORE project routes (public endpoints)
registerAuthRoutes(app);

/** GET /api/projects — list user's projects */
app.get('/api/projects', requireAuth, async (req, res) => {
  try {
    let index = await readIndex();
    // Filter to this user's projects (or all for admin)
    if (req.user.role !== 'admin') {
      index = index.filter(p => p.owner_id === req.user.userId);
    }
    if (req.query.mode) index = index.filter(p => p.mode === req.query.mode);
    index.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    res.json(index);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** POST /api/projects */
app.post('/api/projects', requireAuth, async (req, res) => {
  try {
    const { name, mode, description, area_name, area } = req.body;
    if (!name || !mode) return res.status(400).json({ error: 'name and mode required' });
    if (!['simulation','risk_analysis','realtime'].includes(mode))
      return res.status(400).json({ error: 'Invalid mode' });

    const id         = uuidv4();
    const now        = new Date().toISOString();
    const projectDir = path.join(PROJECTS_DIR, id);
    await fsp.mkdir(projectDir, { recursive: true });

    const project = {
      id, name, mode,
      owner_id:    req.user.userId,   // ← user scoping
      description: description || '',
      area_name:   area_name || 'Undefined area',
      area:        area || null,
      grid:        { type: 'auto', config: {} },
      db_path:     path.join(projectDir, 'facilities.db'),
      created_at:  now,
      updated_at:  now,
    };

    await writeProject(id, project);
    const db = new FacilityDatabaseManager(project.db_path);
    await db.initialize();

    const index = await readIndex();
    index.push({ id, name, mode, owner_id: req.user.userId, area_name: project.area_name, created_at: now, updated_at: now });
    await writeIndex(index);

    logStatus('success', `Project created: [${mode.toUpperCase()}] ${name} (${req.user.username})`);
    res.status(201).json(project);
  } catch (err) {
    logStatus('error', `Project create: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/projects/:id */
app.get('/api/projects/:id', requireAuth, async (req, res) => {
  try {
    const project = await verifyOwnership(req, res);
    if (project) res.json(project);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** PUT /api/projects/:id */
app.put('/api/projects/:id', requireAuth, async (req, res) => {
  try {
    const project = await verifyOwnership(req, res);
    if (!project) return;
    const PROTECTED = ['id','mode','db_path','created_at','owner_id'];
    const updates   = Object.fromEntries(Object.entries(req.body).filter(([k]) => !PROTECTED.includes(k)));
    const updated   = { ...project, ...updates, updated_at: new Date().toISOString() };
    await writeProject(req.params.id, updated);
    const index = await readIndex();
    const idx   = index.findIndex(p => p.id === req.params.id);
    if (idx >= 0) { index[idx] = { ...index[idx], ...updates, updated_at: updated.updated_at }; await writeIndex(index); }
    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** DELETE /api/projects/:id */
app.delete('/api/projects/:id', requireAuth, async (req, res) => {
  try {
    const project = await verifyOwnership(req, res);
    if (!project) return;
    await fsp.rm(path.join(PROJECTS_DIR, req.params.id), { recursive: true, force: true });
    const index = await readIndex();
    await writeIndex(index.filter(p => p.id !== req.params.id));
    logStatus('info', `Project deleted: ${req.params.id.slice(0,8)}`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Hazard Scale routes ───────────────────────────────────────────

const DEFAULT_HAZARD_SCALE = {
  hospital:'critical', clinic:'high', fire_station:'critical',
  police:'critical', school:'high', gymnasium:'medium', shelter:'medium',
  power_plant:'hazardous', substation:'hazardous', chemical_plant:'hazardous',
  petroleum:'hazardous', water:'high', waste:'medium',
  airport:'high', train_station:'medium', communication:'medium',
  military:'hazardous', storage_tank:'hazardous',
};

/** GET /api/projects/:id/hazard-scale */
app.get('/api/projects/:id/hazard-scale', requireAuth, async (req, res) => {
  try {
    const project = await verifyOwnership(req, res);
    if (!project) return;
    const scaleFile = path.join(PROJECTS_DIR, req.params.id, 'hazard_scale.json');
    if (fs.existsSync(scaleFile)) {
      const scale = JSON.parse(await fsp.readFile(scaleFile, 'utf8'));
      return res.json({ scale });
    }
    res.json({ scale: DEFAULT_HAZARD_SCALE });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** PUT /api/projects/:id/hazard-scale — saves scale + updates facilities in DB */
app.put('/api/projects/:id/hazard-scale', requireAuth, async (req, res) => {
  try {
    const project = await verifyOwnership(req, res);
    if (!project) return;
    const { scale } = req.body;
    if (!scale || typeof scale !== 'object') return res.status(400).json({ error: 'scale object required' });

    // Validate risk levels
    const VALID = ['critical','hazardous','high','medium','low'];
    for (const [cat, lvl] of Object.entries(scale)) {
      if (!VALID.includes(lvl)) return res.status(400).json({ error: `Invalid risk level for ${cat}: ${lvl}` });
    }

    // Save to file
    const scaleFile = path.join(PROJECTS_DIR, req.params.id, 'hazard_scale.json');
    await fsp.writeFile(scaleFile, JSON.stringify(scale, null, 2));

    // Update all facilities in DB to match new scale
    const db = new FacilityDatabaseManager(project.db_path);
    await db.initialize();
    for (const [category, riskLevel] of Object.entries(scale)) {
      await new Promise((res, rej) => db.db.run(
        'UPDATE facilities SET risk_level = ?, updated_at = CURRENT_TIMESTAMP WHERE category = ?',
        [riskLevel, category], err => err ? rej(err) : res()
      ));
    }

    logStatus('success', `Hazard scale updated for project ${req.params.id.slice(0,8)}`);
    res.json({ ok: true, updated: Object.keys(scale).length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════════════
// OSM / NOMINATIM PROXY ROUTES
// ════════════════════════════════════════════════════════════════

/**
 * GET /api/osm/search?q=...&limit=...
 * Proxy to Nominatim search; returns polygon_geojson for boundary preview
 */
app.get('/api/osm/search', async (req, res) => {
  const { q, limit = 7 } = req.query;
  if (!q || q.length < 2) return res.status(400).json({ error: 'Query too short' });

  try {
    const r = await nominatimGet('https://nominatim.openstreetmap.org/search', {
      q,
      format:         'json',
      limit,
      addressdetails: 1,
      polygon_geojson: 1,
      featuretype:    'settlement'   // cities, towns, villages
    });
    // Also try without featuretype for admin areas (regions, etc.)
    if (r.data.length === 0) {
      const r2 = await nominatimGet('https://nominatim.openstreetmap.org/search', {
        q, format: 'json', limit, addressdetails: 1, polygon_geojson: 1
      });
      return res.json(r2.data);
    }
    res.json(r.data);
  } catch (err) {
    res.status(502).json({ error: `Nominatim error: ${err.message}` });
  }
});

/**
 * GET /api/osm/boundary/:osmType/:osmId
 * Fetch a specific OSM boundary polygon via Nominatim lookup
 * osmType: node | way | relation (N, W, R)
 */
app.get('/api/osm/boundary/:osmType/:osmId', async (req, res) => {
  const { osmType, osmId } = req.params;
  const prefixes = { node:'N', way:'W', relation:'R', n:'N', w:'W', r:'R' };
  const prefix   = prefixes[osmType.toLowerCase()];
  if (!prefix) return res.status(400).json({ error: 'osmType must be node | way | relation' });

  try {
    const r = await nominatimGet('https://nominatim.openstreetmap.org/lookup', {
      osm_ids:        `${prefix}${osmId}`,
      format:         'json',
      polygon_geojson: 1,
      addressdetails:  1
    });
    res.json(r.data);
  } catch (err) {
    res.status(502).json({ error: `Nominatim lookup error: ${err.message}` });
  }
});

/**
 * POST /api/osm/districts
 * Fetch sub-admin boundaries (districts / arrondissements) via Overpass
 * Body: { osmRelationId } OR { bbox: [south, west, north, east] }
 * Returns GeoJSON FeatureCollection
 */
app.post('/api/osm/districts', async (req, res) => {
  const { osmRelationId, bbox } = req.body;
  if (!osmRelationId && !bbox)
    return res.status(400).json({ error: 'Provide osmRelationId or bbox' });

  try {
    let query;
    if (osmRelationId) {
      // Fetch children of the given relation at admin_level 8–10
      query = `[out:json][timeout:40];
rel(${osmRelationId})->.parent;
(
  rel(r.parent)["boundary"="administrative"]["admin_level"~"^(8|9|10)$"];
);
out geom;`;
    } else {
      const [s, w, n, e] = bbox;
      query = `[out:json][timeout:40];
(
  relation["boundary"="administrative"]["admin_level"~"^(8|9|10)$"](${s},${w},${n},${e});
);
out geom;`;
    }

    const r = await axios.post('https://overpass-api.de/api/interpreter', query, {
      headers: { 'Content-Type': 'text/plain' },
      timeout: 40000
    });

    const features = osmElementsToGeoJSON(r.data.elements || []);
    res.json({ type: 'FeatureCollection', features });
  } catch (err) {
    res.status(502).json({ error: `Overpass error: ${err.message}` });
  }
});

/**
 * Convert Overpass `out geom` elements to GeoJSON Features
 * Handles relations with outer/inner ways
 */
function osmElementsToGeoJSON(elements) {
  const features = [];

  for (const el of elements) {
    if (el.type !== 'relation') continue;
    const props = {
      osm_id:      el.id,
      name:        el.tags?.name || el.tags?.['name:en'] || `Area ${el.id}`,
      admin_level: el.tags?.admin_level || null,
      boundary:    el.tags?.boundary    || null,
      ...el.tags
    };

    try {
      // Build rings from members
      const outerWays = (el.members || []).filter(m => m.type === 'way' && m.role === 'outer');
      const innerWays = (el.members || []).filter(m => m.type === 'way' && m.role === 'inner');

      if (!outerWays.length) continue;

      // Chain outer ways into a ring
      const outerRings = chainWaysToRings(outerWays);
      const innerRings = chainWaysToRings(innerWays);

      if (!outerRings.length) continue;

      const geometry = outerRings.length === 1 && innerRings.length === 0
        ? { type: 'Polygon',   coordinates: [outerRings[0], ...innerRings] }
        : { type: 'MultiPolygon', coordinates: outerRings.map(r => [r]) };

      features.push({ type: 'Feature', properties: props, geometry });
    } catch { /* skip malformed element */ }
  }

  return features;
}

function chainWaysToRings(ways) {
  if (!ways.length) return [];
  const rings = [];

  // Clone ways array
  let remaining = ways.map(w => ({
    nodes: (w.geometry || []).map(n => [n.lon, n.lat])
  })).filter(w => w.nodes.length >= 2);

  while (remaining.length) {
    let ring = [...remaining[0].nodes];
    remaining = remaining.slice(1);
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < remaining.length; i++) {
        const w = remaining[i];
        const ringEnd   = ring[ring.length - 1];
        const wStart    = w.nodes[0];
        const wEnd      = w.nodes[w.nodes.length - 1];

        if (coordsEqual(ringEnd, wStart)) {
          ring = [...ring, ...w.nodes.slice(1)];
          remaining.splice(i, 1); changed = true; break;
        } else if (coordsEqual(ringEnd, wEnd)) {
          ring = [...ring, ...[...w.nodes].reverse().slice(1)];
          remaining.splice(i, 1); changed = true; break;
        }
      }
    }
    // Close ring
    if (!coordsEqual(ring[0], ring[ring.length - 1])) ring.push(ring[0]);
    if (ring.length >= 4) rings.push(ring);
  }

  return rings;
}

function coordsEqual([ax, ay], [bx, by]) {
  return Math.abs(ax - bx) < 0.000001 && Math.abs(ay - by) < 0.000001;
}

// ════════════════════════════════════════════════════════════════
// SCAN & FACILITY ROUTES (per-project, DB-backed)
// ════════════════════════════════════════════════════════════════

/**
 * GET /api/projects/:id/facilities
 * Returns all facilities stored in the project's SQLite DB.
 */
app.get('/api/projects/:id/facilities', requireAuth, async (req, res) => {
  try {
    const project = await readProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const db = new FacilityDatabaseManager(project.db_path);
    await db.initialize();
    const facilities = await db.getAllFacilities({});
    res.json(facilities);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/projects/:id/scan-status
 * Updates last_scan metadata in project.json (and DB sync_log).
 * Body: { last_scan, last_scan_cells, last_scan_facilities_found, last_scan_duration_s }
 */
app.put('/api/projects/:id/scan-status', requireAuth, async (req, res) => {
  try {
    const project = await readProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { last_scan, last_scan_cells, last_scan_facilities_found, last_scan_duration_s } = req.body;
    const updated = {
      ...project,
      last_scan,
      last_scan_cells,
      last_scan_facilities_found,
      last_scan_duration_s,
      updated_at: new Date().toISOString()
    };
    await writeProject(req.params.id, updated);

    // Also update index
    const index = await readIndex();
    const idx = index.findIndex(p => p.id === req.params.id);
    if (idx >= 0) { index[idx].updated_at = updated.updated_at; await writeIndex(index); }

    logStatus('info', `Scan status updated for project ${req.params.id.slice(0,8)} — ${last_scan_facilities_found} facilities in ${last_scan_cells} cells`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/projects/:id/scan/cell
 * Scans one 1km² grid cell using Overpass API, classifies results,
 * and upserts all detected facilities into the project DB.
 * Body: { cell: { south, north, west, east }, cellIndex, totalCells }
 * Returns: { count: number, facilities: [...] }
 */
app.post('/api/projects/:id/scan/cell', requireAuth, async (req, res) => {
  try {
    const project = await readProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { cell, cellIndex, totalCells } = req.body;
    if (!cell) return res.status(400).json({ error: 'cell bbox required' });

    const { south, north, west, east } = cell;

    // Query Overpass for this cell
    const elements = await queryCellOverpass({ south, north, west, east });

    // Classify and upsert
    const db = new FacilityDatabaseManager(project.db_path);
    await db.initialize();

    let newCount = 0;
    const detected = [];

    for (const el of elements) {
      const cat = classifyOsmElement(el);
      if (!cat) continue;

      const lat = el.lat  || el.center?.lat;
      const lng = el.lon  || el.center?.lon;
      if (!lat || !lng) continue;

      const facilityData = {
        name:          el.tags?.name || cat.name,
        latitude:      lat,
        longitude:     lng,
        category:      cat.id,
        category_name: cat.name,
        risk_level:    cat.riskLevel,
        source:        'overpass',
        osm_id:        String(el.id),
        address:       buildAddress(el.tags),
        notes:         el.tags ? JSON.stringify(el.tags) : null,
      };

      try {
        await db.upsertFacility(facilityData);
        newCount++;
        detected.push(facilityData);
      } catch (dbErr) {
        logStatus('warning', `DB upsert failed for OSM ${el.id}: ${dbErr.message}`);
      }
    }

    // Optional: Google Places query per cell if API key available
    if (process.env.GOOGLE_PLACES_API_KEY && newCount < 5) {
      const googleResults = await queryCellGooglePlaces({ south, north, west, east });
      for (const gr of googleResults) {
        try {
          await db.upsertFacility(gr);
          newCount++;
          detected.push(gr);
        } catch { /* skip dupes */ }
      }
    }

    logStatus('info', `Cell ${(cellIndex||0)+1}/${totalCells||'?'} → ${newCount} facilities [${south.toFixed(4)},${west.toFixed(4)}]`);
    res.json({ count: newCount, facilities: detected });

  } catch (err) {
    logStatus('error', `Scan cell error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── Cell Overpass query (targeted, comprehensive) ─────────────────
async function queryCellOverpass({ south, north, west, east }) {
  const bb = `${south},${west},${north},${east}`;
  const query = `[out:json][timeout:28];
(
  node["amenity"="hospital"](${bb});
  way["amenity"="hospital"](${bb});
  node["amenity"="clinic"](${bb});
  way["amenity"="clinic"](${bb});
  node["amenity"="fire_station"](${bb});
  way["amenity"="fire_station"](${bb});
  node["amenity"="police"](${bb});
  way["amenity"="police"](${bb});
  node["amenity"="school"](${bb});
  way["amenity"="school"](${bb});
  node["amenity"="waste_transfer_station"](${bb});
  way["amenity"="waste_transfer_station"](${bb});
  node["power"="plant"](${bb});
  way["power"="plant"](${bb});
  node["power"="substation"](${bb});
  way["power"="substation"](${bb});
  node["industrial"="chemical"](${bb});
  way["industrial"="chemical"](${bb});
  node["industrial"="oil_refinery"](${bb});
  way["industrial"="oil_refinery"](${bb});
  node["man_made"="petroleum_well"](${bb});
  way["man_made"="petroleum_well"](${bb});
  node["man_made"="water_treatment_plant"](${bb});
  way["man_made"="water_treatment_plant"](${bb});
  node["man_made"="water_tower"](${bb});
  way["man_made"="water_tower"](${bb});
  node["man_made"="reservoir"](${bb});
  way["man_made"="reservoir"](${bb});
  node["man_made"="mast"](${bb});
  node["man_made"="tower"]["tower:type"="communication"](${bb});
  node["aeroway"="aerodrome"](${bb});
  way["aeroway"="aerodrome"](${bb});
  node["railway"="station"](${bb});
  way["railway"="station"](${bb});
  node["landuse"="military"](${bb});
  way["landuse"="military"](${bb});
  node["man_made"="storage_tank"](${bb});
  way["man_made"="storage_tank"](${bb});
);
out center;`;

  try {
    const r = await axios.post('https://overpass-api.de/api/interpreter', query, {
      headers: { 'Content-Type': 'text/plain' },
      timeout: 30000
    });
    return r.data.elements || [];
  } catch (err) {
    logStatus('warning', `Overpass cell error: ${err.message}`);
    return [];
  }
}

// ── Optional Google Places per cell ──────────────────────────────
async function queryCellGooglePlaces({ south, north, west, east }) {
  if (!process.env.GOOGLE_PLACES_API_KEY) return [];
  const centerLat = (south + north) / 2;
  const centerLng = (west  + east)  / 2;
  const radius    = 800; // ~1km cell radius
  const types     = ['hospital', 'fire_station', 'police', 'airport'];
  const results   = [];

  for (const type of types) {
    try {
      const r = await axios.get('https://maps.googleapis.com/maps/api/place/nearbysearch/json', {
        params: {
          location: `${centerLat},${centerLng}`,
          radius,
          type,
          key: process.env.GOOGLE_PLACES_API_KEY
        },
        timeout: 10000
      });
      for (const place of (r.data.results || [])) {
        const cat = FACILITY_CATEGORIES[type.toUpperCase()] || FACILITY_CATEGORIES.HOSPITAL;
        results.push({
          name:          place.name,
          latitude:      place.geometry.location.lat,
          longitude:     place.geometry.location.lng,
          category:      cat.id,
          category_name: cat.name,
          risk_level:    cat.riskLevel,
          source:        'google_places',
          address:       place.vicinity,
          notes:         JSON.stringify({ place_id: place.place_id, types: place.types }),
        });
      }
      await new Promise(r => setTimeout(r, 200)); // Google rate-limit
    } catch { /* skip type on error */ }
  }
  return results;
}

// ── Address helper ────────────────────────────────────────────────
function buildAddress(tags) {
  if (!tags) return null;
  const parts = [
    tags['addr:housenumber'],
    tags['addr:street'],
    tags['addr:city'],
    tags['addr:country']
  ].filter(Boolean);
  return parts.length ? parts.join(' ') : (tags['name:en'] || null);
}

// ════════════════════════════════════════════════════════════════
// V2 FACILITY DETECTION ROUTES (preserved from previous version)
// ════════════════════════════════════════════════════════════════

const FACILITY_CATEGORIES = {
  HOSPITAL:         { id:'hospital',       name:'Hospital',          riskLevel:'critical',  googleTypes:['hospital'],        osmTags:['amenity=hospital'] },
  CLINIC:           { id:'clinic',         name:'Clinic',            riskLevel:'high',      googleTypes:['doctor'],          osmTags:['amenity=clinic'] },
  FIRE_STATION:     { id:'fire_station',   name:'Fire Station',      riskLevel:'critical',  googleTypes:['fire_station'],    osmTags:['amenity=fire_station'] },
  POLICE:           { id:'police',         name:'Police Station',    riskLevel:'critical',  googleTypes:['police'],          osmTags:['amenity=police'] },
  SCHOOL:           { id:'school',         name:'School',            riskLevel:'high',      googleTypes:['school'],          osmTags:['amenity=school'] },
  GYMNASIUM:        { id:'gymnasium',      name:'Gymnasium',         riskLevel:'high',      googleTypes:['gym'],             osmTags:['leisure=sports_centre'] },
  SHELTER:          { id:'shelter',        name:'Shelter',           riskLevel:'high',      googleTypes:[],                  osmTags:['amenity=shelter','amenity=community_centre'] },
  POWER_PLANT:      { id:'power_plant',    name:'Power Plant',       riskLevel:'hazardous', googleTypes:[],                  osmTags:['power=plant'] },
  SUBSTATION:       { id:'substation',     name:'Power Substation',  riskLevel:'hazardous', googleTypes:[],                  osmTags:['power=substation'] },
  CHEMICAL_PLANT:   { id:'chemical_plant', name:'Chemical Plant',    riskLevel:'hazardous', googleTypes:[],                  osmTags:['industrial=chemical'] },
  PETROLEUM:        { id:'petroleum',      name:'Petroleum Facility', riskLevel:'hazardous',googleTypes:[],                  osmTags:['industrial=oil_refinery','man_made=petroleum_well'] },
  WASTE_MANAGEMENT: { id:'waste',          name:'Waste Facility',    riskLevel:'hazardous', googleTypes:[],                  osmTags:['amenity=waste_transfer_station','waste=landfill'] },
  WATER_TREATMENT:  { id:'water',          name:'Water Treatment',   riskLevel:'hazardous', googleTypes:[],                  osmTags:['man_made=water_treatment_plant'] },
  AIRPORT:          { id:'airport',        name:'Airport',           riskLevel:'high',      googleTypes:['airport'],         osmTags:['aeroway=aerodrome'] },
  TRAIN_STATION:    { id:'train_station',  name:'Train Station',     riskLevel:'medium',    googleTypes:['train_station'],   osmTags:['railway=station'] },
  WATER_SUPPLY:     { id:'water_supply',   name:'Water Supply',      riskLevel:'medium',    googleTypes:[],                  osmTags:['man_made=reservoir','man_made=water_tower'] },
  COMMUNICATION:    { id:'communication',  name:'Telecom Tower',     riskLevel:'medium',    googleTypes:[],                  osmTags:['man_made=mast','man_made=tower'] },
};

async function queryOverpassAPI(bounds) {
  const { north, south, east, west } = bounds;
  const query = `[out:json][timeout:30];
(
  node["amenity"="hospital"](${south},${west},${north},${east});
  way["amenity"="hospital"](${south},${west},${north},${east});
  node["amenity"="fire_station"](${south},${west},${north},${east});
  way["amenity"="fire_station"](${south},${west},${north},${east});
  node["amenity"="police"](${south},${west},${north},${east});
  way["amenity"="police"](${south},${west},${north},${east});
  node["amenity"="school"](${south},${west},${north},${east});
  way["amenity"="school"](${south},${west},${north},${east});
  node["power"="plant"](${south},${west},${north},${east});
  way["power"="plant"](${south},${west},${north},${east});
  node["power"="substation"](${south},${west},${north},${east});
  way["power"="substation"](${south},${west},${north},${east});
  node["industrial"="chemical"](${south},${west},${north},${east});
  way["industrial"="chemical"](${south},${west},${north},${east});
  node["industrial"="oil_refinery"](${south},${west},${north},${east});
  way["industrial"="oil_refinery"](${south},${west},${north},${east});
  node["man_made"="water_treatment_plant"](${south},${west},${north},${east});
  way["man_made"="water_treatment_plant"](${south},${west},${north},${east});
);
out center;`;

  try {
    const r = await axios.post('https://overpass-api.de/api/interpreter', query, {
      timeout: 30000,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    return r.data.elements || [];
  } catch (err) {
    logStatus('error', `Overpass query failed: ${err.message}`);
    return [];
  }
}

function classifyOsmElement(el) {
  const tags = el.tags || {};
  for (const [, cat] of Object.entries(FACILITY_CATEGORIES)) {
    for (const osmTag of cat.osmTags) {
      const [k, v] = osmTag.split('=');
      if (tags[k] === v) return cat;
    }
  }
  return null;
}

function getRiskColor(level) {
  return { critical:'#d32f2f', hazardous:'#f57c00', high:'#fbc02d', medium:'#1976d2', low:'#388e3c' }[level] || '#757575';
}

/**
 * POST /api/detect-facilities
 * V2-compatible facility detection; now accepts optional projectId
 */
app.post('/api/detect-facilities', requireAuth, async (req, res) => {
  try {
    const { bounds, projectId } = req.body;
    if (!bounds) return res.status(400).json({ error: 'bounds required' });

    const osmElements = await queryOverpassAPI(bounds);
    const facilities  = [];

    for (const el of osmElements) {
      const cat = classifyOsmElement(el);
      if (!cat) continue;

      const lat = el.lat  || el.center?.lat;
      const lng = el.lon  || el.center?.lon;
      if (!lat || !lng) continue;

      const id = uuidv4();
      facilities.push({
        id,
        source:    'overpass',
        osm_id:    el.id,
        name:      el.tags?.name || cat.name,
        category:  cat.id,
        category_name: cat.name,
        risk_level: cat.riskLevel,
        color:     getRiskColor(cat.riskLevel),
        latitude:  lat,
        longitude: lng,
        tags:      el.tags || {},
        detected_at: new Date().toISOString()
      });
    }

    // If projectId provided, persist to project DB
    if (projectId) {
      const project = await readProject(projectId);
      if (project?.db_path) {
        try {
          const db = new FacilityDatabaseManager(project.db_path);
          await db.initialize();
          for (const f of facilities) await db.addFacility(f);
          logStatus('info', `Persisted ${facilities.length} facilities to project ${projectId}`);
        } catch (dbErr) {
          logStatus('error', `DB persist error: ${dbErr.message}`);
        }
      }
    }

    res.json({ facilities, count: facilities.length, timestamp: new Date().toISOString() });
  } catch (err) {
    logStatus('error', `detect-facilities: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// SERVER-SIDE SCAN ENGINE
// Runs in background. Client polls /scan/status for progress.
// Grid: 1km² cells, batched 4-at-a-time → fewer Overpass requests.
// 429 handling: Retry-After header + endpoint rotation.
// ════════════════════════════════════════════════════════════════

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',          // primary, most stable
  'https://overpass.kumi.systems/api/interpreter',    // community, reliable
  'https://overpass.private.coffee/api/interpreter',  // newer community endpoint
];
// Track which endpoints are healthy this session
const endpointHealth = OVERPASS_ENDPOINTS.map(() => ({ failures: 0, lastFailure: 0 }));
let overpassEndpointIdx = 0;

const projectScans = new Map(); // projectId → scan state object

// ── Grid helpers (ported from client scan-engine.js) ─────────────
function _raycast(point, ring) {
  const [x, y] = point; let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi))
      inside = !inside;
  }
  return inside;
}
function _pointInGeoJSON(point, geojson) {
  for (const f of (geojson.features || [])) {
    const g = f.geometry; if (!g) continue;
    if (g.type === 'Polygon' && _raycast(point, g.coordinates[0])) return true;
    if (g.type === 'MultiPolygon') for (const p of g.coordinates) if (_raycast(point, p[0])) return true;
  }
  return false;
}
function _cellIntersects(cell, geojson) {
  const { south, north, west, east } = cell;
  return [[( west+east)/2,(south+north)/2],[west,south],[east,south],[west,north],[east,north]]
    .some(p => _pointInGeoJSON(p, geojson));
}
function generateScanGrid(geojson, km = 1) {
  let minLat=Infinity, maxLat=-Infinity, minLng=Infinity, maxLng=-Infinity;
  function walk(c) {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number') {
      const [lng, lat] = c;
      if (!isNaN(lat) && !isNaN(lng)) { minLat=Math.min(minLat,lat); maxLat=Math.max(maxLat,lat); minLng=Math.min(minLng,lng); maxLng=Math.max(maxLng,lng); }
    } else c.forEach(walk);
  }
  for (const f of (geojson.features||[])) if (f.geometry?.coordinates) walk(f.geometry.coordinates);
  const cLat   = (minLat+maxLat)/2;
  const latStep = km / 111.32;
  const lngStep = km / (111.32 * Math.cos(cLat * Math.PI / 180));
  const cells = []; let idx = 0;
  for (let lat = minLat; lat < maxLat; lat += latStep)
    for (let lng = minLng; lng < maxLng; lng += lngStep) {
      const cell = { south:lat, north:lat+latStep, west:lng, east:lng+lngStep };
      if (_cellIntersects(cell, geojson)) cells.push({ ...cell, index:idx++, status:'pending', found:0 });
    }
  return cells;
}
function batchCells(cells, size = 4) {
  const batches = [];
  for (let i = 0; i < cells.length; i += size) {
    const batch = cells.slice(i, i + size);
    batches.push({
      bbox: { south:Math.min(...batch.map(c=>c.south)), north:Math.max(...batch.map(c=>c.north)),
               west: Math.min(...batch.map(c=>c.west)),  east: Math.max(...batch.map(c=>c.east)) },
      cells: batch
    });
  }
  return batches;
}

// ── Overpass batch query with 429 backoff & health-aware endpoint rotation ────
async function queryOverpassBatch(bbox, attempt = 0) {
  // Pick healthiest endpoint (fewest recent failures)
  function pickEndpoint() {
    const now = Date.now();
    // Reset failure count after 10 minutes
    endpointHealth.forEach(h => { if (now - h.lastFailure > 600000) h.failures = 0; });
    // Pick the one with fewest failures, starting from current idx
    let best = overpassEndpointIdx;
    let bestFails = endpointHealth[best].failures;
    for (let i = 0; i < OVERPASS_ENDPOINTS.length; i++) {
      const idx = (overpassEndpointIdx + i) % OVERPASS_ENDPOINTS.length;
      if (endpointHealth[idx].failures < bestFails) { best = idx; bestFails = endpointHealth[idx].failures; }
    }
    return best;
  }

  const epIdx = pickEndpoint();
  const ep    = OVERPASS_ENDPOINTS[epIdx];
  const { south, north, west, east } = bbox;
  const bb = `${south},${west},${north},${east}`;

  const query = `[out:json][timeout:35];
(
  node["amenity"~"^(hospital|clinic|fire_station|police|school|waste_transfer_station)"](${bb});
  way["amenity"~"^(hospital|clinic|fire_station|police|school|waste_transfer_station)"](${bb});
  node["power"~"^(plant|substation)"](${bb});
  way["power"~"^(plant|substation)"](${bb});
  node["industrial"~"^(chemical|oil_refinery)"](${bb});
  way["industrial"~"^(chemical|oil_refinery)"](${bb});
  node["man_made"~"^(water_treatment_plant|water_tower|reservoir|petroleum_well|mast)"](${bb});
  way["man_made"~"^(water_treatment_plant|water_tower|reservoir|petroleum_well)"](${bb});
  node["aeroway"="aerodrome"](${bb});
  way["aeroway"="aerodrome"](${bb});
  node["railway"="station"](${bb});
  way["railway"="station"](${bb});
  node["landuse"="military"](${bb});
  way["landuse"="military"](${bb});
  node["man_made"="storage_tank"](${bb});
  way["man_made"="storage_tank"](${bb});
);
out center;`;

  try {
    const r = await axios.post(ep, query, {
      headers: { 'Content-Type': 'text/plain', 'User-Agent': 'AEGIS-V3/1.0' },
      timeout: 40000
    });
    // Success — reset failure count for this endpoint
    endpointHealth[epIdx].failures = 0;
    return r.data.elements || [];
  } catch (err) {
    const status = err.response?.status;
    endpointHealth[epIdx].failures++;
    endpointHealth[epIdx].lastFailure = Date.now();

    if (status === 429) {
      // Rotate to next endpoint
      overpassEndpointIdx = (epIdx + 1) % OVERPASS_ENDPOINTS.length;
      const retryAfter = parseInt(err.response?.headers?.['retry-after'] || '45');
      const waitMs = (retryAfter + 10) * 1000;
      logStatus('warning', `Overpass 429 on ${ep.split('/')[2]} — waiting ${retryAfter + 10}s, switching to ${OVERPASS_ENDPOINTS[overpassEndpointIdx].split('/')[2]}`);
      if (attempt < 4) {
        await new Promise(r => setTimeout(r, waitMs));
        return queryOverpassBatch(bbox, attempt + 1);
      }
    }

    if (status === 504 || err.code === 'ECONNREFUSED' || err.code === 'ECONNABORTED') {
      // Hard failure on this endpoint — immediately try next
      overpassEndpointIdx = (epIdx + 1) % OVERPASS_ENDPOINTS.length;
      logStatus('warning', `Overpass ${err.code || status} on ${ep.split('/')[2]} — failing over to ${OVERPASS_ENDPOINTS[overpassEndpointIdx].split('/')[2]}`);
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
        return queryOverpassBatch(bbox, attempt + 1);
      }
    }

    logStatus('warning', `Overpass giving up after ${attempt + 1} attempts: ${err.message}`);
    return [];
  }
}

// ── Background scan runner ────────────────────────────────────────
async function runProjectScan(projectId) {
  const scan = projectScans.get(projectId);
  if (!scan) return;

  scan.status    = 'running';
  scan.startTime = new Date().toISOString();

  const project = await readProject(projectId);
  if (!project?.area?.geojson) {
    scan.status = 'done'; scan.error = 'No area GeoJSON'; return;
  }

  // ── Open DB ONCE for the entire scan (not per batch) ──────────
  const db = new FacilityDatabaseManager(project.db_path);
  await db.initialize();

  for (let bi = 0; bi < scan.batches.length; bi++) {
    if (scan.status === 'aborted') break;

    const batch = scan.batches[bi];
    scan.currentBatchIdx = bi;

    // Mark cells as scanning
    batch.cells.forEach(c => { scan.cells[c.index].status = 'scanning'; });

    let batchFound = 0;
    try {
      const elements = await queryOverpassBatch(batch.bbox);
      for (const el of elements) {
        const cat = classifyOsmElement(el);
        if (!cat) continue;
        const lat = el.lat || el.center?.lat;
        const lng = el.lon || el.center?.lon;
        if (!lat || !lng) continue;
        try {
          await db.upsertFacility({
            name:el.tags?.name||cat.name, latitude:lat, longitude:lng,
            category:cat.id, category_name:cat.name, risk_level:cat.riskLevel,
            source:'overpass', address:buildAddress(el.tags), notes:el.tags?JSON.stringify(el.tags):null
          });
          batchFound++;
        } catch { /* skip dupes */ }
      }
    } catch (err) {
      logStatus('error', `Batch ${bi} error: ${err.message}`);
    }

    // Mark cells done
    batch.cells.forEach(c => { scan.cells[c.index].status = 'done'; scan.cells[c.index].found = batchFound; });
    scan.found += batchFound;

    const done = scan.cells.filter(c => c.status === 'done' || c.status === 'failed').length;
    logStatus('info', `Scan batch ${bi+1}/${scan.batches.length} → ${batchFound} fac. [${done}/${scan.cells.length} cells]`);

    // ETA
    if (bi < scan.batches.length - 1) {
      const elapsed = Date.now() - new Date(scan.startTime).getTime();
      scan.etaMs = (scan.batches.length - bi - 1) * (elapsed / (bi + 1));
      await new Promise(r => setTimeout(r, 3500));
    }
  }

  scan.status  = scan.status === 'aborted' ? 'aborted' : 'done';
  scan.endTime = new Date().toISOString();
  // DB closed naturally by GC — SQLite handles this gracefully

  if (scan.status === 'done') {
    const durationS = Math.round((new Date(scan.endTime) - new Date(scan.startTime)) / 1000);
    const updated = { ...project, last_scan:scan.endTime, last_scan_cells:scan.cells.length,
      last_scan_facilities_found:scan.found, last_scan_duration_s:durationS, updated_at:scan.endTime };
    await writeProject(projectId, updated).catch(()=>{});
    const index = await readIndex();
    const idx = index.findIndex(p => p.id === projectId);
    if (idx >= 0) { index[idx].updated_at = scan.endTime; await writeIndex(index).catch(()=>{}); }
    logStatus('success', `Scan complete: ${scan.found} facilities in ${scan.cells.length} cells (${durationS}s)`);
  }
}

// ── POST /api/projects/:id/scan/start ────────────────────────────
app.post('/api/projects/:id/scan/start', requireAuth, async (req, res) => {
  const { force = false } = req.body;
  const projectId = req.params.id;

  const project = await readProject(projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!project.area?.geojson) return res.status(400).json({ error: 'No area GeoJSON' });

  // 24h throttle
  if (!force && project.last_scan) {
    const elapsed = Date.now() - new Date(project.last_scan).getTime();
    const waitMs  = Math.max(0, 24*3600*1000 - elapsed);
    if (waitMs > 0) {
      const h = Math.floor(waitMs/3600000), m = Math.floor((waitMs%3600000)/60000);
      return res.json({ throttled: true, message: `Next scan allowed in ${h}h ${m}m. Use force=true to override.` });
    }
  }

  // If already running, reject
  const existing = projectScans.get(projectId);
  if (existing?.status === 'running') {
    return res.json({ started: false, message: 'Scan already running', progress: existing.progress });
  }

  // Generate grid and batches
  const cells   = generateScanGrid(project.area.geojson);
  const batches = batchCells(cells, 4);

  const scan = {
    projectId, cells, batches,
    status: 'pending', found: 0,
    startTime: null, endTime: null, etaMs: null,
    currentBatchIdx: 0, error: null,
    get progress() {
      const done = this.cells.filter(c=>c.status==='done'||c.status==='failed').length;
      return { done, total:this.cells.length, pct: this.cells.length ? Math.round(done/this.cells.length*100) : 0 };
    },
    get currentCell() {
      const ci = this.batches[this.currentBatchIdx]?.cells?.[0];
      return ci ? this.cells[ci.index] : null;
    }
  };

  projectScans.set(projectId, scan);
  logStatus('info', `Scan started for ${projectId.slice(0,8)} — ${cells.length} cells / ${batches.length} batches`);

  res.json({ started: true, cells: cells.length, batches: batches.length });

  // Fire background scan (no await — runs independently)
  runProjectScan(projectId).catch(err => {
    logStatus('error', `Scan crashed: ${err.message}`);
    const s = projectScans.get(projectId);
    if (s) { s.status = 'done'; s.error = err.message; }
  });
});

// ── POST /api/projects/:id/scan/preview ──────────────────────────
app.post('/api/projects/:id/scan/preview', requireAuth, async (req, res) => {
  try {
    const project = await readProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!project.area?.geojson) return res.status(400).json({ error: 'No area' });
    const cells = generateScanGrid(project.area.geojson);
    res.json({ cells, batches: Math.ceil(cells.length / 4) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/projects/:id/scan/status ────────────────────────────
app.get('/api/projects/:id/scan/status', requireAuth, async (req, res) => {
  const scan = projectScans.get(req.params.id);
  if (!scan) {
    // No active scan — return idle with last_scan from project.json
    const p = await readProject(req.params.id).catch(()=>null);
    return res.json({ status:'idle', found:0, cells:[], progress:{done:0,total:0,pct:0}, lastScan: p?.last_scan||null });
  }
  res.json({
    status:       scan.status,
    found:        scan.found,
    cells:        scan.cells,
    progress:     scan.progress,
    startTime:    scan.startTime,
    endTime:      scan.endTime,
    etaMs:        scan.etaMs,
    currentCell:  scan.currentCell,
    error:        scan.error,
    totalBatches: scan.batches.length,
    currentBatch: scan.currentBatchIdx,
  });
});

// ── POST /api/projects/:id/scan/abort ────────────────────────────
app.post('/api/projects/:id/scan/abort', requireAuth, async (req, res) => {
  const scan = projectScans.get(req.params.id);
  if (scan) { scan.status = 'aborted'; logStatus('warning', `Scan aborted for ${req.params.id.slice(0,8)}`); }
  res.json({ aborted: true });
});

// ════════════════════════════════════════════════════════════════
// FACILITY IMPORT / EXPORT
// ════════════════════════════════════════════════════════════════

/** GET /api/projects/:id/facilities/export/sql */
app.get('/api/projects/:id/facilities/export/sql', requireAuth, async (req, res) => {
  try {
    const project = await readProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    const db = new FacilityDatabaseManager(project.db_path);
    await db.initialize();
    const facilities = await db.getAllFacilities({});

    const lines = [
      '-- AEGIS V3 Facility Export',
      `-- Project: ${project.name}`,
      `-- Generated: ${new Date().toISOString()}`,
      `-- Total: ${facilities.length} facilities`,
      '',
      'CREATE TABLE IF NOT EXISTS facilities (',
      '  id TEXT PRIMARY KEY, name TEXT, latitude REAL, longitude REAL,',
      '  category TEXT, category_name TEXT, risk_level TEXT, source TEXT,',
      '  address TEXT, notes TEXT, status TEXT DEFAULT \'active\',',
      '  created_at TEXT, updated_at TEXT, last_verified TEXT',
      ');',
      '',
    ];

    for (const f of facilities) {
      const vals = [f.id, f.name, f.latitude, f.longitude, f.category, f.category_name,
        f.risk_level, f.source, f.address, f.notes, f.status, f.created_at, f.updated_at, f.last_verified]
        .map(v => v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`)
        .join(', ');
      lines.push(`INSERT OR REPLACE INTO facilities VALUES (${vals});`);
    }

    const sql = lines.join('\n');
    res.setHeader('Content-Disposition', `attachment; filename="facilities_${project.name.replace(/\s/g,'_')}.sql"`);
    res.setHeader('Content-Type', 'text/plain');
    res.send(sql);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** POST /api/projects/:id/facilities/import/geojson */
app.post('/api/projects/:id/facilities/import/geojson', requireAuth, async (req, res) => {
  try {
    const project = await readProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    const geojson = req.body.geojson;
    if (!geojson?.features) return res.status(400).json({ error: 'Invalid GeoJSON' });

    const db = new FacilityDatabaseManager(project.db_path);
    await db.initialize();

    let imported = 0;
    for (const feature of geojson.features) {
      const geom = feature.geometry;
      const props = feature.properties || {};
      if (!geom || geom.type !== 'Point') continue;
      const [lng, lat] = geom.coordinates;
      if (!lat || !lng) continue;

      try {
        await db.upsertFacility({
          name:          props.name || props.label || 'Imported facility',
          latitude:      lat,
          longitude:     lng,
          category:      props.category || props.type || 'unknown',
          category_name: props.category_name || props.name || 'Unknown',
          risk_level:    props.risk_level || props.riskLevel || 'medium',
          source:        'import_geojson',
          address:       props.address || props.addr || null,
          notes:         JSON.stringify(props),
        });
        imported++;
      } catch { /* skip malformed */ }
    }

    logStatus('success', `GeoJSON import: ${imported} facilities → project ${req.params.id.slice(0,8)}`);
    res.json({ imported, total: geojson.features.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** POST /api/projects/:id/facilities/import/sql */
app.post('/api/projects/:id/facilities/import/sql', requireAuth, async (req, res) => {
  try {
    const project = await readProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    const sql = req.body.sql;
    if (!sql || typeof sql !== 'string') return res.status(400).json({ error: 'No SQL provided' });

    const db = new FacilityDatabaseManager(project.db_path);
    await db.initialize();

    // Extract INSERT statements and execute them
    const insertRe = /INSERT\s+(?:OR\s+REPLACE\s+)?INTO\s+facilities\s+VALUES\s*\(([^;]+)\);/gi;
    let match, imported = 0;
    while ((match = insertRe.exec(sql)) !== null) {
      try {
        await new Promise((resolve, reject) => {
          db.db.run(`INSERT OR REPLACE INTO facilities VALUES (${match[1]})`, err => err ? reject(err) : resolve());
        });
        imported++;
      } catch { /* skip bad rows */ }
    }

    logStatus('success', `SQL import: ${imported} facilities → project ${req.params.id.slice(0,8)}`);
    res.json({ imported });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════════════
// INFRASTRUCTURE LAYER ROUTES
// ════════════════════════════════════════════════════════════════

// Overpass queries per infrastructure type
const INFRA_QUERIES = {
  roads: (bb) => `[out:json][timeout:50];
(
  way["highway"~"^(primary|secondary|tertiary|unclassified|residential)"](${bb});
);
out geom;`,

  highways: (bb) => `[out:json][timeout:50];
(
  way["highway"~"^(motorway|trunk|motorway_link|trunk_link)"](${bb});
);
out geom;`,

  railways: (bb) => `[out:json][timeout:50];
(
  way["railway"~"^(rail|light_rail|subway|tram)"](${bb});
);
out geom;`,

  power: (bb) => `[out:json][timeout:50];
(
  way["power"="line"](${bb});
  relation["power"="line"](${bb});
);
out geom;`,

  telecom: (bb) => `[out:json][timeout:50];
(
  way["telecom"](${bb});
  way["man_made"="pipeline"]["type"="telecom"](${bb});
);
out geom;`,
};

/**
 * GET /api/projects/:id/infrastructure/:type
 * Returns GeoJSON FeatureCollection for the given infrastructure type.
 * File-cached per project — only fetches Overpass once.
 */
app.get('/api/projects/:id/infrastructure/:type', requireAuth, async (req, res) => {
  const { id, type } = req.params;
  if (!INFRA_QUERIES[type]) return res.status(400).json({ error: `Unknown type: ${type}` });

  try {
    const project = await readProject(id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const cacheFile = path.join(PROJECTS_DIR, id, `infra_${type}.json`);

    // Return cached version if exists
    if (fs.existsSync(cacheFile)) {
      const cached = JSON.parse(await fsp.readFile(cacheFile, 'utf8'));
      logStatus('info', `[INFRA] Serving cached ${type} for ${id.slice(0,8)}`);
      return res.json(cached);
    }

    // Compute bounding box from project area GeoJSON
    const bbox = infraBbox(project.area?.geojson);
    if (!bbox) return res.status(400).json({ error: 'No project area defined' });
    const { south, north, west, east } = bbox;
    const bb = `${south},${west},${north},${east}`;

    logStatus('info', `[INFRA] Fetching ${type} from Overpass for ${id.slice(0,8)}`);
    const query = INFRA_QUERIES[type](bb);

    const ovResp = await axios.post(
      OVERPASS_ENDPOINTS[overpassEndpointIdx % OVERPASS_ENDPOINTS.length],
      query,
      { headers: { 'Content-Type': 'text/plain', 'User-Agent': 'AEGIS-V3/1.0' }, timeout: 55000 }
    );

    const elements = ovResp.data.elements || [];
    const geojson = infraElementsToGeoJSON(elements, type);

    // Cache to disk
    await fsp.writeFile(cacheFile, JSON.stringify(geojson), 'utf8');
    logStatus('success', `[INFRA] ${type}: ${geojson.features.length} features cached for ${id.slice(0,8)}`);

    res.json(geojson);
  } catch (err) {
    logStatus('error', `[INFRA] ${type} fetch error: ${err.message}`);
    // Return empty rather than crashing client
    res.json({ type: 'FeatureCollection', features: [] });
  }
});

/**
 * DELETE /api/projects/:id/infrastructure/:type/cache
 * Clears the cache file so the next GET re-fetches from Overpass.
 */
app.delete('/api/projects/:id/infrastructure/:type/cache', requireAuth, async (req, res) => {
  const { id, type } = req.params;
  const cacheFile = path.join(PROJECTS_DIR, id, `infra_${type}.json`);
  try {
    if (fs.existsSync(cacheFile)) await fsp.unlink(cacheFile);
    logStatus('info', `[INFRA] Cache cleared: ${type} for ${id.slice(0,8)}`);
    res.json({ cleared: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Convert Overpass way/relation elements → GeoJSON ─────────────
function infraElementsToGeoJSON(elements, type) {
  const features = [];

  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry?.length) continue;

    const coords = el.geometry.map(n => [n.lon, n.lat]);
    if (coords.length < 2) continue;

    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords },
      properties: {
        osm_id:   el.id,
        highway:  el.tags?.highway  || null,
        railway:  el.tags?.railway  || null,
        power:    el.tags?.power    || null,
        name:     el.tags?.name     || null,
        ref:      el.tags?.ref      || null,
        voltage:  el.tags?.voltage  || null,
        infra_type: type,
      },
    });
  }

  return { type: 'FeatureCollection', features };
}

// ── Extract bounding box from project area GeoJSON ───────────────
function infraBbox(geojson) {
  if (!geojson?.features?.length) return null;
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;

  function walk(coords) {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === 'number') {
      const [lng, lat] = coords;
      if (!isNaN(lat) && !isNaN(lng)) {
        minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
        minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng);
      }
    } else coords.forEach(walk);
  }

  for (const f of geojson.features) if (f.geometry?.coordinates) walk(f.geometry.coordinates);
  if (!isFinite(minLat)) return null;
  return { south: minLat, north: maxLat, west: minLng, east: maxLng };
}

// ════════════════════════════════════════════════════════════════
// HEALTH CHECK
// ════════════════════════════════════════════════════════════════

app.get('/api/health', async (req, res) => {
  const index = await readIndex().catch(() => []);
  res.json({
    status:            'ok',
    version:           '3.0.0-alpha',
    timestamp:         new Date().toISOString(),
    project_count:     index.length,
    google_places_key: !!process.env.GOOGLE_PLACES_API_KEY,
    overpass:          true,
    nominatim:         true
  });
});

// ── Error handler ─────────────────────────────────────────────────
app.use((err, req, res, next) => {
  logStatus('error', `Unhandled: ${err.message}`);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// ── Logging helpers ───────────────────────────────────────────────
const C = {
  reset:'\x1b[0m', bright:'\x1b[1m', dim:'\x1b[2m',
  red:'\x1b[31m', green:'\x1b[32m', yellow:'\x1b[33m',
  blue:'\x1b[34m', magenta:'\x1b[35m', cyan:'\x1b[36m', white:'\x1b[37m'
};

function logStatus(type, msg) {
  const ts = new Date().toISOString().slice(11, 19);
  const prefix = `${C.dim}[${ts}]${C.reset}`;
  switch(type) {
    case 'success': console.log(`${prefix} ${C.green}✓${C.reset} ${C.green}${msg}${C.reset}`); break;
    case 'info':    console.log(`${prefix} ${C.cyan}ℹ${C.reset} ${C.cyan}${msg}${C.reset}`);  break;
    case 'warning': console.log(`${prefix} ${C.yellow}⚠${C.reset} ${C.yellow}${msg}${C.reset}`); break;
    case 'error':   console.log(`${prefix} ${C.red}✗${C.reset} ${C.red}${msg}${C.reset}`);   break;
    case 'server':  console.log(`${prefix} ${C.magenta}◆${C.reset} ${C.magenta}${msg}${C.reset}`); break;
    default:        console.log(`${prefix} ${msg}`);
  }
}

function printBanner() {
  console.log('');
  console.log(`${C.cyan}${C.bright}╔═══════════════════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.cyan}${C.bright}║${C.reset}  ${C.white}${C.bright}AEGIS V3 — Adaptive Emergency Geospatial Intelligence${C.reset}  ${C.cyan}${C.bright}║${C.reset}`);
  console.log(`${C.cyan}${C.bright}║${C.reset}  ${C.dim}Cascading Risk Analysis · Predictive Modelling · DRR${C.reset}    ${C.cyan}${C.bright}║${C.reset}`);
  console.log(`${C.cyan}${C.bright}╚═══════════════════════════════════════════════════════════╝${C.reset}`);
  console.log('');
}

// ── Start ─────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  printBanner();
  await ensureDataDirs();
  try {
    await initUsersDb();
    logStatus('success', 'Users database ready');
  } catch (err) {
    logStatus('error', `Users DB: ${err.message}`);
  }
  // Validate JWT_SECRET early — crash with clear message if missing
  try {
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
      logStatus('error', 'JWT_SECRET missing or too short!');
      logStatus('error', 'Run: node admin-cli.js generate-secret');
      logStatus('error', 'Then add JWT_SECRET=<value> to your .env file');
      process.exit(1);
    }
    logStatus('success', 'JWT auth configured');
  } catch (err) {
    logStatus('error', `Auth config: ${err.message}`);
    process.exit(1);
  }
  logStatus('server', `Listening on port ${C.bright}${PORT}${C.reset}`);
  logStatus('success', 'Project management: ready (user-scoped)');
  logStatus('success', 'OSM Nominatim proxy: ready');
  logStatus('success', 'Overpass API: ready');
  if (process.env.GOOGLE_PLACES_API_KEY) {
    logStatus('success', 'Google Places API: configured');
  } else {
    logStatus('warning', 'Google Places API: no key — Overpass only');
  }
  console.log('');
  logStatus('success', `${C.bright}Server ready.${C.reset} http://localhost:${PORT}/login.html`);
  console.log('');
});

module.exports = app;
