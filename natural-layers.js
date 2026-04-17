/**
 * AEGIS V3 — Natural Feature Layers
 * Rivers (OSM via server cache) · Wind Currents (OpenMeteo) · Sea Currents (OpenMeteo Marine)
 * Same toggle/persistence pattern as infra-layers.js
 */

const NATURAL_STYLES = {
  rivers: {
    color: '#38bdf8', weight: 2, opacity: 0.75,
    label: 'RIVERS', dash: null,
  },
  wind: {
    color: '#a3e635', weight: 1.5, opacity: 0.8,
    label: 'WIND', dash: '4 2',
  },
  sea_currents: {
    color: '#818cf8', weight: 1.5, opacity: 0.75,
    label: 'SEA CURRENTS', dash: '6 3',
  },
};

const naturalGroups  = {};
const naturalVisible = {};
const naturalLoaded  = {};

const NATURAL_PREFS_KEY = 'aegis-natural-';

function initNaturalLayers(map) {
  for (const type of Object.keys(NATURAL_STYLES)) {
    naturalGroups[type]  = L.layerGroup();
    naturalLoaded[type]  = false;
    naturalVisible[type] = false;
  }
  window._naturalMap = map;
}

// ── Restore persisted toggle state (called after project loads) ───
async function restoreNaturalLayers(projectId) {
  const key = NATURAL_PREFS_KEY + projectId;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(key) || '{}'); } catch {}
  for (const type of Object.keys(NATURAL_STYLES)) {
    if (saved[type]) {
      const btn = document.getElementById(`nat-btn-${type}`);
      await toggleNaturalLayer(type, btn, true); // silent restore
    }
  }
}

function saveNaturalPrefs(projectId) {
  const key = NATURAL_PREFS_KEY + projectId;
  const state = {};
  for (const type of Object.keys(NATURAL_STYLES)) state[type] = naturalVisible[type];
  try { localStorage.setItem(key, JSON.stringify(state)); } catch {}
}

// ── Toggle ────────────────────────────────────────────────────────
async function toggleNaturalLayer(type, btn, silent = false) {
  const map = window._naturalMap;
  if (!map) return;

  if (!silent) naturalVisible[type] = !naturalVisible[type];

  if (btn) btn.classList.toggle('infra-btn--active', naturalVisible[type]);

  if (!naturalVisible[type]) {
    map.removeLayer(naturalGroups[type]);
    if (!silent) saveNaturalPrefs(window.AEGIS_PROJECT?.id);
    return;
  }

  if (!naturalLoaded[type]) {
    if (btn) { btn.disabled = true; btn.setAttribute('data-orig', btn.textContent); btn.textContent = '⟳'; }
    try {
      await loadNaturalLayer(type);
    } catch (err) {
      console.warn(`[NATURAL] Failed to load ${type}:`, err.message);
      naturalVisible[type] = false;
      if (btn) { btn.disabled = false; btn.textContent = btn.getAttribute('data-orig') || ''; btn.classList.remove('infra-btn--active'); }
      return;
    }
    if (btn) { btn.disabled = false; btn.textContent = btn.getAttribute('data-orig') || ''; }
  }

  naturalGroups[type].addTo(map);
  if (!silent) saveNaturalPrefs(window.AEGIS_PROJECT?.id);
}

// ── Load a layer ──────────────────────────────────────────────────
async function loadNaturalLayer(type) {
  const project = window.AEGIS_PROJECT;
  if (!project) throw new Error('No project loaded');
  const group  = naturalGroups[type];
  group.clearLayers();

  if (type === 'rivers')      await loadRiversLayer(group, project);
  if (type === 'wind')        await loadWindLayer(group, project);
  if (type === 'sea_currents') await loadSeaCurrentsLayer(group, project);

  naturalLoaded[type] = true;
}

// ── Rivers + water bodies from OSM (via server cache) ───────────
async function loadRiversLayer(group, project) {
  const r = await axios.get(
    `${window.AEGIS_API}/api/projects/${project.id}/natural/rivers`,
    { timeout: 60000 }
  );
  const geojson = r.data;
  if (!geojson?.features?.length) { console.info('[NATURAL] No river data'); return; }

  // Waterways (lines): rivers thicker, streams thinner
  const WATERWAY_WEIGHTS = { river: 3.5, canal: 2.5, stream: 1.5, drain: 1 };
  const WATER_COLOR      = '#3b82f6';      // main blue
  const WATER_FILL       = 'rgba(56,189,248,0.35)'; // lighter for polygon fills

  // Split features by geometry type and render separately for correct styling
  const lines    = geojson.features.filter(f => f.geometry?.type === 'LineString' || f.geometry?.type === 'MultiLineString');
  const polygons = geojson.features.filter(f => f.geometry?.type === 'Polygon'    || f.geometry?.type === 'MultiPolygon');

  if (lines.length) {
    L.geoJSON({ type:'FeatureCollection', features: lines }, {
      style: f => ({
        color:   WATER_COLOR,
        weight:  WATERWAY_WEIGHTS[f.properties?.waterway] || 2,
        opacity: 0.85,
        lineCap: 'round',
        lineJoin:'round',
        interactive: false,
      }),
      interactive: false,
    }).addTo(group);
  }

  if (polygons.length) {
    L.geoJSON({ type:'FeatureCollection', features: polygons }, {
      style: {
        color:       WATER_COLOR,
        weight:      1.5,
        opacity:     0.9,
        fillColor:   WATER_FILL,
        fillOpacity: 1,  // rgba in fillColor already controls alpha
        interactive: false,
      },
      interactive: false,
    }).addTo(group);
  }

  console.info(`[NATURAL] Rivers: ${lines.length} lines + ${polygons.length} water bodies`);
}

// ── Wind currents — OpenMeteo grid ───────────────────────────────
async function loadWindLayer(group, project) {
  const bbox  = projectBbox(project);
  if (!bbox) return;

  // Sample a grid of points across the project area
  const GRID = 4; // 4x4 sample grid
  const latStep = (bbox.north - bbox.south) / (GRID - 1);
  const lngStep = (bbox.east  - bbox.west)  / (GRID - 1);

  const samplePoints = [];
  for (let i = 0; i < GRID; i++)
    for (let j = 0; j < GRID; j++)
      samplePoints.push({ lat: bbox.south + i * latStep, lng: bbox.west + j * lngStep });

  // Batch fetch — OpenMeteo allows multiple lat/lng as arrays
  const lats = samplePoints.map(p => p.lat).join(',');
  const lngs = samplePoints.map(p => p.lng).join(',');

  const r = await axios.get('https://api.open-meteo.com/v1/forecast', {
    params: {
      latitude:  lats, longitude: lngs,
      current:   'wind_speed_10m,wind_direction_10m',
      wind_speed_unit: 'ms',
    },
    timeout: 15000,
  });

  // Response is array when multiple points
  const results = Array.isArray(r.data) ? r.data : [r.data];
  results.forEach((res, i) => {
    const pt    = samplePoints[i];
    const speed = res.current?.wind_speed_10m;
    const dir   = res.current?.wind_direction_10m;
    if (speed == null || dir == null) return;

    // Draw arrow: compute endpoint from direction + speed-scaled length
    const len    = Math.max(0.004, Math.min(0.018, speed * 0.0025)); // deg
    const rad    = (dir - 90) * Math.PI / 180; // convert met direction to cartesian
    const endLat = pt.lat + len * Math.cos(rad + Math.PI);
    const endLng = pt.lng + len * Math.sin(rad + Math.PI);

    const arrow = L.polyline([[pt.lat, pt.lng], [endLat, endLng]], {
      color: '#a3e635', weight: 1.5, opacity: 0.8, interactive: false,
    }).addTo(group);

    // Arrowhead
    drawArrowhead([pt.lat, pt.lng], [endLat, endLng], '#a3e635', group);

    // Tooltip
    arrow.bindTooltip(
      `<div style="font-family:Roboto Mono,monospace;font-size:9px;background:#0b0f1c;color:#a3e635;padding:4px 8px;border:1px solid rgba(163,230,53,.3);">
        WIND ${dir}° · ${speed.toFixed(1)} m/s
      </div>`, { permanent: false, className: '' }
    );
  });
}

// ── Sea currents — OpenMeteo Marine ──────────────────────────────
async function loadSeaCurrentsLayer(group, project) {
  const bbox   = projectBbox(project);
  if (!bbox) return;
  const cLat   = (bbox.south + bbox.north) / 2;
  const cLng   = (bbox.west  + bbox.east)  / 2;

  // Sample center + 4 corners
  const pts = [
    { lat: cLat, lng: cLng },
    { lat: bbox.south, lng: bbox.west },
    { lat: bbox.north, lng: bbox.east },
    { lat: bbox.south, lng: bbox.east },
    { lat: bbox.north, lng: bbox.west },
  ];

  let anyData = false;
  for (const pt of pts) {
    try {
      const r = await axios.get('https://marine-api.open-meteo.com/v1/marine', {
        params: {
          latitude:  pt.lat, longitude: pt.lng,
          current:   'ocean_current_velocity,ocean_current_direction',
        },
        timeout: 10000,
      });
      const vel = r.data.current?.ocean_current_velocity;
      const dir = r.data.current?.ocean_current_direction;
      if (vel == null || dir == null) continue;

      anyData = true;
      const len    = Math.max(0.003, Math.min(0.015, vel * 0.005));
      const rad    = (dir - 90) * Math.PI / 180;
      const endLat = pt.lat + len * Math.cos(rad + Math.PI);
      const endLng = pt.lng + len * Math.sin(rad + Math.PI);

      const arrow = L.polyline([[pt.lat, pt.lng], [endLat, endLng]], {
        color: '#818cf8', weight: 1.5, opacity: 0.8, interactive: false,
      }).addTo(group);
      drawArrowhead([pt.lat, pt.lng], [endLat, endLng], '#818cf8', group);
      arrow.bindTooltip(
        `<div style="font-family:Roboto Mono,monospace;font-size:9px;background:#0b0f1c;color:#818cf8;padding:4px 8px;border:1px solid rgba(129,140,248,.3);">
          CURRENT ${dir}° · ${vel.toFixed(2)} m/s
        </div>`, { permanent: false }
      );
    } catch { /* inland point — no marine data */ }
  }

  if (!anyData) {
    console.info('[NATURAL] No sea current data — project area may be inland');
  }
}

// ── Arrow helper ──────────────────────────────────────────────────
function drawArrowhead(from, to, color, group) {
  const dLat  = to[0] - from[0];
  const dLng  = to[1] - from[1];
  const angle = Math.atan2(dLat, dLng);
  const len   = 0.003;
  const a1    = angle + Math.PI * 0.8;
  const a2    = angle - Math.PI * 0.8;
  const p1    = [to[0] + len * Math.sin(a1), to[1] + len * Math.cos(a1)];
  const p2    = [to[0] + len * Math.sin(a2), to[1] + len * Math.cos(a2)];
  L.polygon([to, p1, p2], {
    color, fillColor: color, fillOpacity: 0.9, weight: 0, interactive: false,
  }).addTo(group);
}

// ── Reload a natural layer ────────────────────────────────────────
async function reloadNaturalLayer(type, btn) {
  const project = window.AEGIS_PROJECT;
  if (!project) return;
  // Only rivers are server-cached
  if (type === 'rivers') {
    try { await axios.delete(`${window.AEGIS_API}/api/projects/${project.id}/natural/rivers/cache`); } catch {}
  }
  naturalLoaded[type] = false;
  const map = window._naturalMap;
  if (naturalVisible[type] && map) {
    map.removeLayer(naturalGroups[type]);
    naturalGroups[type].clearLayers();
    await toggleNaturalLayer(type, btn, true);
    naturalGroups[type].addTo(map);
  }
}

// ── Bbox helper ───────────────────────────────────────────────────
function projectBbox(project) {
  const geojson = project.area?.geojson;
  if (!geojson) return null;
  let s=90, n=-90, w=180, e=-180;
  function walk(c) {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number') {
      w=Math.min(w,c[0]); e=Math.max(e,c[0]);
      s=Math.min(s,c[1]); n=Math.max(n,c[1]);
    } else c.forEach(walk);
  }
  for (const f of (geojson.features||[])) if (f.geometry?.coordinates) walk(f.geometry.coordinates);
  return isFinite(s) ? { south:s, north:n, west:w, east:e } : null;
}
