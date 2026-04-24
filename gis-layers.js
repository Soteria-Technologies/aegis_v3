/**
 * AEGIS V3 — Custom GIS Layers + Slope Overlay
 *
 * Manages:
 *  - User-uploaded GIS files (GeoJSON / KML / PNG / JPG / GeoTIFF*)
 *  - Live slope heatmap from AWS Terrain Tiles (Mapzen terrarium encoding)
 *
 * Server state (persistence) lives in: custom_layers table + data/projects/{id}/layers/
 *
 * * GeoTIFF rendering requires the optional 'georaster-layer-for-leaflet'
 *   library; this module leaves a well-defined seam so it can be added
 *   without touching the rest of the code.
 */
'use strict';

// ── State ────────────────────────────────────────────────────────
const _customLayers = new Map(); // layerId → { meta, leafletLayer }
let   _slopeLayer   = null;
let   _customGisMap = null;

function initCustomGis(map) {
  _customGisMap = map;
}

// ── Load persisted layers (called after project loads) ──────────
async function loadCustomGisLayers() {
  const project = window.AEGIS_PROJECT;
  if (!project || !_customGisMap) return;
  try {
    const r = await axios.get(`${window.AEGIS_API}/api/projects/${project.id}/layers`);
    const layers = r.data || [];
    for (const meta of layers) {
      _customLayers.set(meta.id, { meta, leafletLayer: null });
      if (meta.is_visible) await showCustomLayer(meta.id);
    }
    renderCustomLayerList();
  } catch (err) {
    console.warn('[GIS] Load layers failed:', err.message);
  }
}

// ── Upload a file ───────────────────────────────────────────────
async function uploadCustomLayer(file, name) {
  const project = window.AEGIS_PROJECT;
  if (!project) return;

  const fd = new FormData();
  fd.append('file', file);
  fd.append('name', name || file.name);
  fd.append('opacity', '0.85');

  try {
    const r = await axios.post(
      `${window.AEGIS_API}/api/projects/${project.id}/layers`,
      fd,
      { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 60000 }
    );
    // Refresh list and auto-enable new layer
    await loadCustomGisLayers();
    if (r.data?.id) await showCustomLayer(r.data.id);
    return r.data;
  } catch (err) {
    alert('Upload failed: ' + (err.response?.data?.error || err.message));
  }
}

// ── Show a layer on the map ─────────────────────────────────────
async function showCustomLayer(layerId) {
  const entry = _customLayers.get(layerId);
  if (!entry || !_customGisMap) return;
  if (entry.leafletLayer) {
    _customGisMap.addLayer(entry.leafletLayer);
    return;
  }
  const meta = entry.meta;
  const project = window.AEGIS_PROJECT;
  const dataUrl = `${window.AEGIS_API}/api/projects/${project.id}/layers/${meta.id}/data`;

  try {
    if (meta.file_format === 'geojson' || meta.file_format === 'json') {
      const r = await axios.get(dataUrl);
      entry.leafletLayer = L.geoJSON(r.data, {
        style: () => ({ color: '#c084fc', weight: 2, fillColor: '#c084fc',
                        fillOpacity: 0.25 * (meta.opacity ?? 1) }),
        onEachFeature: (f, l) => {
          const p = f.properties || {};
          const rows = Object.entries(p)
            .filter(([k]) => k !== 'styleUrl' && k !== 'styleHash')
            .slice(0, 8)
            .map(([k, v]) => `<div><b>${_h(k)}:</b> ${_h(String(v)).slice(0, 80)}</div>`)
            .join('');
          if (rows) l.bindPopup(`<div style="font-family:Roboto Mono,monospace;font-size:10px;background:var(--c-panel,#0b0f1c);color:var(--c-text,#c8d0e0);padding:8px;">${rows}</div>`, { className:'aegis-popup' });
        }
      });
    } else if (meta.file_format === 'kml') {
      const r = await axios.get(dataUrl);
      const geojson = kmlToGeoJSON(r.data);
      entry.leafletLayer = L.geoJSON(geojson, {
        style: () => ({ color: '#c084fc', weight: 2, fillColor: '#c084fc',
                        fillOpacity: 0.25 * (meta.opacity ?? 1) })
      });
    } else if (['png', 'jpg', 'jpeg'].includes(meta.file_format) && meta.bounds) {
      // Georeferenced raster overlay
      entry.leafletLayer = L.imageOverlay(dataUrl, meta.bounds, { opacity: meta.opacity ?? 1 });
    } else if (meta.file_format === 'tif' || meta.file_format === 'tiff') {
      // GeoTIFF — future hook
      alert('GeoTIFF rendering requires georaster-layer-for-leaflet library (not yet installed). File was uploaded and will render when the library is added.');
      return;
    }
    if (entry.leafletLayer) {
      _customGisMap.addLayer(entry.leafletLayer);
      // Apply z-order (higher z_order renders on top)
      if (entry.leafletLayer.bringToFront && meta.z_order > 0) entry.leafletLayer.bringToFront();
    }
  } catch (err) {
    console.warn(`[GIS] Failed to render layer ${meta.name}:`, err.message);
  }
}

function hideCustomLayer(layerId) {
  const entry = _customLayers.get(layerId);
  if (!entry?.leafletLayer || !_customGisMap) return;
  _customGisMap.removeLayer(entry.leafletLayer);
}

async function toggleCustomLayer(layerId) {
  const entry = _customLayers.get(layerId);
  if (!entry) return;
  const next = !entry.meta.is_visible;
  entry.meta.is_visible = next;
  if (next) await showCustomLayer(layerId); else hideCustomLayer(layerId);
  await patchCustomLayer(layerId, { is_visible: next });
  renderCustomLayerList();
}

async function setLayerOpacity(layerId, opacity) {
  const entry = _customLayers.get(layerId);
  if (!entry) return;
  entry.meta.opacity = opacity;
  if (entry.leafletLayer) {
    if (entry.leafletLayer.setOpacity) entry.leafletLayer.setOpacity(opacity);
    else if (entry.leafletLayer.setStyle) entry.leafletLayer.setStyle({ fillOpacity: 0.25 * opacity });
  }
  await patchCustomLayer(layerId, { opacity });
}

async function moveLayerOrder(layerId, delta) {
  const entry = _customLayers.get(layerId);
  if (!entry) return;
  const next = (entry.meta.z_order || 0) + delta;
  entry.meta.z_order = next;
  if (entry.leafletLayer?.bringToFront && delta > 0) entry.leafletLayer.bringToFront();
  if (entry.leafletLayer?.bringToBack  && delta < 0) entry.leafletLayer.bringToBack();
  await patchCustomLayer(layerId, { z_order: next });
  renderCustomLayerList();
}

async function deleteCustomLayer(layerId) {
  if (!confirm('Delete this layer permanently? The file will be removed from the project.')) return;
  const project = window.AEGIS_PROJECT;
  const entry = _customLayers.get(layerId);
  hideCustomLayer(layerId);
  try {
    await axios.delete(`${window.AEGIS_API}/api/projects/${project.id}/layers/${layerId}`);
    _customLayers.delete(layerId);
    renderCustomLayerList();
  } catch (err) { alert('Delete failed: ' + err.message); }
}

async function zoomToLayer(layerId) {
  const entry = _customLayers.get(layerId);
  if (!entry) return;
  if (entry.leafletLayer?.getBounds) {
    try { _customGisMap.fitBounds(entry.leafletLayer.getBounds(), { padding: [40, 40] }); return; } catch {}
  }
  if (entry.meta.bounds) _customGisMap.fitBounds(entry.meta.bounds, { padding: [40, 40] });
}

async function patchCustomLayer(layerId, patch) {
  const project = window.AEGIS_PROJECT;
  try {
    await axios.patch(`${window.AEGIS_API}/api/projects/${project.id}/layers/${layerId}`, patch);
  } catch (err) { console.warn('[GIS] Patch failed:', err.message); }
}

// ── Render the panel list ───────────────────────────────────────
function renderCustomLayerList() {
  const listEl = document.getElementById('gis-layers-list');
  if (!listEl) return;
  const layers = [..._customLayers.values()]
    .sort((a, b) => (b.meta.z_order || 0) - (a.meta.z_order || 0));
  if (!layers.length) {
    listEl.innerHTML = `<div style="font-size:8px;color:var(--c-dim);letter-spacing:1px;padding:8px;text-align:center;">NO LAYERS — UPLOAD ONE ABOVE</div>`;
    return;
  }
  listEl.innerHTML = layers.map(({ meta }) => {
    const vis = meta.is_visible;
    return `<div class="gis-layer-row">
      <div class="gis-layer-head">
        <button class="gis-layer-vis ${vis?'on':''}" onclick="toggleCustomLayer('${meta.id}')" title="Show/hide">${vis?'◉':'○'}</button>
        <span class="gis-layer-name" title="${_h(meta.name)}">${_h(meta.name)}</span>
        <span class="gis-layer-fmt">${_h(meta.file_format)}</span>
      </div>
      <div class="gis-layer-ctrls">
        <input type="range" min="0" max="1" step="0.05" value="${meta.opacity ?? 1}"
          oninput="setLayerOpacity('${meta.id}', parseFloat(this.value))"
          title="Opacity" style="flex:1;accent-color:var(--c-amber);">
        <button class="gis-btn-xs" onclick="moveLayerOrder('${meta.id}', 1)"  title="Bring forward">▲</button>
        <button class="gis-btn-xs" onclick="moveLayerOrder('${meta.id}', -1)" title="Send back">▼</button>
        <button class="gis-btn-xs" onclick="zoomToLayer('${meta.id}')"         title="Zoom to">⊕</button>
        <button class="gis-btn-xs gis-btn-del" onclick="deleteCustomLayer('${meta.id}')" title="Delete">✕</button>
      </div>
    </div>`;
  }).join('');
}

// ── Slope overlay (AWS Terrain Tiles, Mapzen terrarium encoding) ────
// Uses canvas-based tile layer that decodes terrarium RGB to elevation,
// then computes slope per-pixel. Rendered as a transparent heatmap.
// ── Terrain layer (slope OR elevation, user-configurable) ─────
let _slopeVisible = false;
let _terrainMode  = 'slope'; // 'slope' | 'elevation'

function setTerrainMode(mode) {
  _terrainMode = mode;
  document.getElementById('terrain-mode-slope')?.classList.toggle('active', mode === 'slope');
  document.getElementById('terrain-mode-elev')?.classList.toggle('active',  mode === 'elevation');
  // Rebuild layer with new mode
  if (_slopeVisible && _customGisMap) {
    if (_slopeLayer) { _customGisMap.removeLayer(_slopeLayer); _slopeLayer = null; }
    _slopeLayer = createSlopeLayer(_terrainMode);
    _slopeLayer.addTo(_customGisMap);
  }
}

function toggleSlopeLayer(btn) {
  _slopeVisible = !_slopeVisible;
  if (btn) btn.classList.toggle('infra-btn--active', _slopeVisible);
  if (!_slopeVisible) {
    if (_slopeLayer) { _customGisMap.removeLayer(_slopeLayer); }
    return;
  }
  if (!_slopeLayer) _slopeLayer = createSlopeLayer(_terrainMode);
  _slopeLayer.addTo(_customGisMap);
}

function createSlopeLayer(mode = 'slope') {
  const TerrainLayer = L.GridLayer.extend({
    options: { maxZoom: 15, minZoom: 7, opacity: 0.70, pane: 'overlayPane' },
    createTile(coords, done) {
      const tile = document.createElement('canvas');
      const size = this.getTileSize();
      tile.width = size.x; tile.height = size.y;
      const ctx = tile.getContext('2d', { willReadFrequently: true });
      const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${coords.z}/${coords.x}/${coords.y}.png`;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        ctx.drawImage(img, 0, 0, size.x, size.y);
        try {
          const id = ctx.getImageData(0, 0, size.x, size.y);
          if (mode === 'slope')     renderSlopePixels(ctx, id, size.x, size.y);
          else                      renderElevationPixels(ctx, id, size.x, size.y);
        } catch { /* CORS */ }
        done(null, tile);
      };
      img.onerror = () => done(null, tile);
      img.src = url;
      return tile;
    },
  });
  return new TerrainLayer();
}

// Slope: green(flat) → yellow → red(steep)
function renderSlopePixels(ctx, imageData, w, h) {
  const src  = imageData.data;
  const elev = new Float32Array(w * h);
  for (let i = 0, p = 0; i < src.length; i += 4, p++) {
    elev[p] = (src[i] * 256 + src[i+1] + src[i+2] / 256) - 32768;
  }
  const out = ctx.createImageData(w, h);
  const od  = out.data;
  for (let y = 1; y < h-1; y++) {
    for (let x = 1; x < w-1; x++) {
      const i   = y * w + x;
      const dx  = elev[i+1] - elev[i-1];
      const dy  = elev[i+w] - elev[i-w];
      const s   = Math.min(1, Math.sqrt(dx*dx + dy*dy) / 20);
      const oi  = i * 4;
      if (s < 0.05) { od[oi+3] = 0; continue; }
      if (s < 0.4) {
        od[oi]   = Math.round(80 + s * 440);
        od[oi+1] = Math.round(200 - s * 100);
        od[oi+2] = 30;
      } else {
        od[oi]   = 235;
        od[oi+1] = Math.round(120 - (s - 0.4) * 200);
        od[oi+2] = 20;
      }
      od[oi+3] = Math.round(130 + s * 125);
    }
  }
  ctx.putImageData(out, 0, 0);
}

// Elevation: absolute colour ramp (metres above sea level)
// blue(deep sea) → cyan(coast) → green(lowland) → yellow(hills) → orange(mountain) → white(snow)
const ELEV_RAMP = [
  { e:-500,  r:10,  g:20,  b:120 }, // deep sea
  { e:0,     r:30,  g:80,  b:200 }, // sea level / coast
  { e:50,    r:60,  g:180, b:160 }, // coastal lowland
  { e:200,   r:80,  g:200, b:80  }, // lowland
  { e:500,   r:150, g:210, b:60  }, // hills
  { e:1000,  r:220, g:220, b:60  }, // highland
  { e:2000,  r:200, g:120, b:40  }, // mountain
  { e:3500,  r:180, g:60,  b:30  }, // high mountain
  { e:5500,  r:240, g:240, b:255 }, // snow cap
];

function _elevRampColor(e) {
  if (e <= ELEV_RAMP[0].e) { const c = ELEV_RAMP[0]; return [c.r, c.g, c.b]; }
  const last = ELEV_RAMP[ELEV_RAMP.length - 1];
  if (e >= last.e) return [last.r, last.g, last.b];
  let lo = ELEV_RAMP[0], hi = last;
  for (let k = 0; k < ELEV_RAMP.length - 1; k++) {
    if (e >= ELEV_RAMP[k].e && e <= ELEV_RAMP[k+1].e) { lo = ELEV_RAMP[k]; hi = ELEV_RAMP[k+1]; break; }
  }
  const f = (e - lo.e) / (hi.e - lo.e);
  return [Math.round(lo.r + f*(hi.r-lo.r)), Math.round(lo.g + f*(hi.g-lo.g)), Math.round(lo.b + f*(hi.b-lo.b))];
}

function renderElevationPixels(ctx, imageData, w, h) {
  const src  = imageData.data;
  const out  = ctx.createImageData(w, h);
  const od   = out.data;
  for (let i = 0, p = 0; i < src.length; i += 4, p++) {
    const e = (src[i] * 256 + src[i+1] + src[i+2] / 256) - 32768;
    if (e < -500 || e > 9000) { od[p*4+3] = 0; continue; }
    const [r,g,b] = _elevRampColor(e);
    od[p*4]   = r; od[p*4+1] = g; od[p*4+2] = b;
    od[p*4+3] = 170;
  }
  ctx.putImageData(out, 0, 0);
}

// ── Land Use layer ────────────────────────────────────────────
let _landUseLayer   = null;
let _landUseVisible = false;
let _landUseData    = null; // cached GeoJSON

const LAND_USE_COLORS = {
  forest:       { fill:'rgba(34,197,94,0.35)',  stroke:'#16a34a', label:'Forest' },
  wood:         { fill:'rgba(34,197,94,0.28)',  stroke:'#15803d', label:'Woodland' },
  residential:  { fill:'rgba(251,191,36,0.25)', stroke:'#d97706', label:'Residential' },
  commercial:   { fill:'rgba(251,146,60,0.30)', stroke:'#ea580c', label:'Commercial' },
  industrial:   { fill:'rgba(239,68,68,0.30)',  stroke:'#dc2626', label:'Industrial' },
  farmland:     { fill:'rgba(163,230,53,0.28)', stroke:'#65a30d', label:'Farmland' },
  meadow:       { fill:'rgba(134,239,172,0.28)',stroke:'#22c55e', label:'Meadow' },
  wetland:      { fill:'rgba(56,189,248,0.30)', stroke:'#0284c7', label:'Wetland' },
  water:        { fill:'rgba(59,130,246,0.40)', stroke:'#2563eb', label:'Water' },
  military:     { fill:'rgba(239,68,68,0.35)',  stroke:'#991b1b', label:'Military' },
  scrub:        { fill:'rgba(180,220,100,0.25)',stroke:'#84cc16', label:'Scrub' },
  bare_rock:    { fill:'rgba(156,163,175,0.30)',stroke:'#6b7280', label:'Bare Rock' },
  default:      { fill:'rgba(100,116,139,0.15)',stroke:'#475569', label:'Other' },
};

async function toggleLandUseLayer(btn) {
  _landUseVisible = !_landUseVisible;
  if (btn) btn.classList.toggle('infra-btn--active', _landUseVisible);
  if (!_landUseVisible) {
    if (_landUseLayer) { _customGisMap.removeLayer(_landUseLayer); }
    return;
  }
  if (!_landUseData) await loadLandUseData();
  if (_landUseData) renderLandUseLayer();
}

async function loadLandUseData(force = false) {
  const project = window.AEGIS_PROJECT;
  if (!project) return;
  try {
    const r = await axios.get(`${window.AEGIS_API}/api/projects/${project.id}/landuse${force ? '?refresh=1' : ''}`, { timeout: 60000 });
    _landUseData = r.data;
    console.info(`[LANDUSE] Loaded ${_landUseData?.features?.length || 0} features`);
  } catch (err) {
    console.warn('[LANDUSE] Load failed:', err.message);
  }
}

function renderLandUseLayer() {
  if (!_landUseData || !_customGisMap) return;
  if (_landUseLayer) _customGisMap.removeLayer(_landUseLayer);

  _landUseLayer = L.geoJSON(_landUseData, {
    style: f => {
      const lu   = f.properties?.landuse || f.properties?.natural || 'default';
      const cfg  = LAND_USE_COLORS[lu] || LAND_USE_COLORS.default;
      return { fillColor: cfg.fill, color: cfg.stroke, weight: 1, fillOpacity: 1, interactive: true };
    },
    onEachFeature: (f, layer) => {
      const lu   = f.properties?.landuse || f.properties?.natural || 'other';
      const cfg  = LAND_USE_COLORS[lu] || LAND_USE_COLORS.default;
      const name = f.properties?.name || cfg.label || lu;
      layer.bindTooltip(
        `<div style="font-family:Roboto Mono,monospace;font-size:9px;background:var(--c-panel,#0b0f1c);color:var(--c-text,#c8d0e0);padding:4px 8px;border:1px solid ${cfg.stroke};">
          <b>${_h(name)}</b><br>${cfg.label || lu}
        </div>`,
        { sticky: true }
      );
    }
  }).addTo(_customGisMap);
}

// ── Choropleth rendering for uploaded layers ───────────────────
// Called when user picks a property to visualize as gradient fill
function renderChoropleth(layerId, propertyKey) {
  const entry = _customLayers.get(layerId);
  if (!entry?.leafletLayer) return;
  const features = entry.leafletLayer.getLayers ? entry.leafletLayer.getLayers() : [];

  // Compute value range
  const vals = features.map(l => parseFloat(l.feature?.properties?.[propertyKey])).filter(v => !isNaN(v));
  if (!vals.length) { alert('No numeric values found for property: ' + propertyKey); return; }
  const vMin = Math.min(...vals), vMax = Math.max(...vals), range = vMax - vMin || 1;

  // Sequential blue → red choropleth
  features.forEach(l => {
    const raw = l.feature?.properties?.[propertyKey];
    const v   = parseFloat(raw);
    if (isNaN(v)) return;
    const t = (v - vMin) / range;
    const r = Math.round(20  + t * 220);
    const g = Math.round(100 - t * 80);
    const b = Math.round(200 - t * 180);
    if (l.setStyle) l.setStyle({ fillColor: `rgb(${r},${g},${b})`, fillOpacity: 0.65, color: '#1e293b', weight: 1 });
  });

  // Add legend
  addChoroplethLegend(propertyKey, vMin, vMax);
  entry.meta.choropleth = { property: propertyKey, min: vMin, max: vMax };
}

let _choroplethLegend = null;
function addChoroplethLegend(property, min, max) {
  if (_choroplethLegend) _customGisMap.removeControl(_choroplethLegend);
  _choroplethLegend = L.control({ position: 'bottomright' });
  _choroplethLegend.onAdd = () => {
    const div = L.DomUtil.create('div');
    div.style.cssText = 'background:var(--c-panel,rgba(11,15,28,.97));border:1px solid rgba(255,255,255,.12);padding:8px 12px;font-family:Roboto Mono,monospace;font-size:9px;color:var(--c-text,#c8d0e0);';
    div.innerHTML = `
      <div style="letter-spacing:1px;margin-bottom:6px;color:var(--c-muted,#5a6378);">${_h(property.toUpperCase())}</div>
      <div style="display:flex;align-items:center;gap:6px;">
        <span>${_fmtVal(min)}</span>
        <div style="width:80px;height:10px;background:linear-gradient(90deg,rgb(20,100,200),rgb(240,20,20));border-radius:2px;"></div>
        <span>${_fmtVal(max)}</span>
      </div>`;
    return div;
  };
  _choroplethLegend.addTo(_customGisMap);
}

function resetChoropleth(layerId) {
  const entry = _customLayers.get(layerId);
  if (!entry?.leafletLayer) return;
  entry.leafletLayer.resetStyle?.();
  if (_choroplethLegend) { _customGisMap.removeControl(_choroplethLegend); _choroplethLegend = null; }
  delete entry.meta.choropleth;
}

// ── Feature filter / selection within a layer ─────────────────
// Filters visible features in a GIS layer by property condition
// Acts as a temporary display filter (does not delete features)
const _layerFilters = new Map(); // layerId → { property, op, value }

function applyLayerFilter(layerId, property, op, value) {
  if (!property) { clearLayerFilter(layerId); return; }
  _layerFilters.set(layerId, { property, op, value });
  _applyFilterToLayer(layerId);
}

function clearLayerFilter(layerId) {
  _layerFilters.delete(layerId);
  const entry = _customLayers.get(layerId);
  if (entry?.leafletLayer?.eachLayer) {
    entry.leafletLayer.eachLayer(l => { if (l.getElement) l.getElement()?.classList.remove('gis-hidden'); });
  }
}

function _applyFilterToLayer(layerId) {
  const entry  = _customLayers.get(layerId);
  const filter = _layerFilters.get(layerId);
  if (!entry?.leafletLayer || !filter) return;
  entry.leafletLayer.eachLayer(l => {
    const raw   = l.feature?.properties?.[filter.property];
    const val   = parseFloat(raw);
    let   show  = true;
    switch (filter.op) {
      case '=':   show = String(raw) === String(filter.value); break;
      case '!=':  show = String(raw) !== String(filter.value); break;
      case '>':   show = !isNaN(val) && val >  parseFloat(filter.value); break;
      case '>=':  show = !isNaN(val) && val >= parseFloat(filter.value); break;
      case '<':   show = !isNaN(val) && val <  parseFloat(filter.value); break;
      case '<=':  show = !isNaN(val) && val <= parseFloat(filter.value); break;
      case 'contains': show = String(raw).toLowerCase().includes(String(filter.value).toLowerCase()); break;
    }
    // Toggle visibility on the leaflet layer
    if (l.setStyle) l.setStyle({ display: show ? '' : 'none' });
    const el = l.getElement?.();
    if (el) el.style.display = show ? '' : 'none';
    if (l._path) l._path.style.display = show ? '' : 'none';
  });
}

// Spatial analysis: count/list facilities within a feature polygon
function facilitiesInFeature(feature) {
  if (!window.S?.facilities?.length) return [];
  const geom = feature.geometry;
  if (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon') return [];
  // Simple point-in-polygon using turf.js logic (inline, no dependency)
  return window.S.facilities.filter(f => {
    const pt = [parseFloat(f.longitude), parseFloat(f.latitude)];
    if (geom.type === 'Polygon') return _pointInPoly(pt, geom.coordinates[0]);
    return geom.coordinates.some(poly => _pointInPoly(pt, poly[0]));
  });
}

function _pointInPoly(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length-1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < (xj-xi)*(pt[1]-yi)/(yj-yi)+xi)) inside = !inside;
  }
  return inside;
}

// ── OSM Library — full catalogue ───────────────────────────────
// section: default panel ('natural' | 'infrastructure')
// section_override set at runtime from pinned_layers DB record
const OSM_LIBRARY = [
  // Natural
  { id:'protected_areas',   section:'natural',        label:'Protected Areas',
    desc:'Nature reserves, national parks, protected land boundaries.',
    style: { color:'#22c55e', fillColor:'rgba(34,197,94,0.20)',   weight:2, dashArray:'6 3' } },
  { id:'wetlands',          section:'natural',        label:'Wetlands',
    desc:'Marshes, swamps, bogs and other wetland types.',
    style: { color:'#38bdf8', fillColor:'rgba(56,189,248,0.25)',  weight:1.5 } },
  { id:'forest',            section:'natural',        label:'Forest / Woodland',
    desc:'Forested land and natural woodland areas.',
    style: { color:'#16a34a', fillColor:'rgba(34,197,94,0.25)',   weight:1 } },
  { id:'scrubland',         section:'natural',        label:'Scrubland',
    desc:'Low shrub vegetation and heathland.',
    style: { color:'#84cc16', fillColor:'rgba(132,204,22,0.20)',  weight:1 } },
  { id:'grassland',         section:'natural',        label:'Grassland / Meadow',
    desc:'Natural grassland, pasture and meadow zones.',
    style: { color:'#a3e635', fillColor:'rgba(163,230,53,0.18)',  weight:1 } },
  { id:'bare_rock',         section:'natural',        label:'Bare Rock / Arid',
    desc:'Bare rock, scree, sand and desert surfaces.',
    style: { color:'#9ca3af', fillColor:'rgba(156,163,175,0.25)', weight:1 } },
  { id:'flood_prone',       section:'natural',        label:'Flood-Prone Areas',
    desc:'Floodplains and areas tagged as flood-prone in OSM.',
    style: { color:'#60a5fa', fillColor:'rgba(96,165,250,0.28)',  weight:1.5 } },
  { id:'mangroves',         section:'natural',        label:'Mangroves',
    desc:'Mangrove wetland coastal zones.',
    style: { color:'#059669', fillColor:'rgba(5,150,105,0.28)',   weight:1.5 } },
  { id:'glaciers',          section:'natural',        label:'Glaciers / Snowfields',
    desc:'Glaciers and permanent snow cover.',
    style: { color:'#bae6fd', fillColor:'rgba(186,230,253,0.35)', weight:1 } },
  { id:'water_bodies',      section:'natural',        label:'Water Bodies',
    desc:'Lakes, ponds, basins and other standing water.',
    style: { color:'#3b82f6', fillColor:'rgba(59,130,246,0.30)',  weight:1.5 } },
  { id:'coastline',         section:'natural',        label:'Coastline',
    desc:'Coastal boundary lines from OSM.',
    style: { color:'#0284c7', fillColor:'rgba(2,132,199,0.10)',   weight:2 } },
  // Land Use
  { id:'farmland',          section:'natural',        label:'Agricultural Land',
    desc:'Farmland, orchards, vineyards, allotments and greenhouses.',
    style: { color:'#a3e635', fillColor:'rgba(163,230,53,0.20)',  weight:1 } },
  { id:'residential',       section:'natural',        label:'Residential Areas',
    desc:'Residential land use zones.',
    style: { color:'#fbbf24', fillColor:'rgba(251,191,36,0.18)',  weight:1 } },
  { id:'recreation',        section:'natural',        label:'Recreation / Parks',
    desc:'Parks, sports grounds, nature recreation areas.',
    style: { color:'#4ade80', fillColor:'rgba(74,222,128,0.18)',  weight:1 } },
  { id:'cemetery',          section:'natural',        label:'Cemeteries',
    desc:'Cemeteries and grave yards.',
    style: { color:'#a8a29e', fillColor:'rgba(168,162,158,0.22)', weight:1, dashArray:'3 3' } },
  // Infrastructure / Risk
  { id:'industrial_zones',  section:'infrastructure', label:'Industrial Zones',
    desc:'General industrial land use areas.',
    style: { color:'#f87171', fillColor:'rgba(239,68,68,0.20)',   weight:1.5 } },
  { id:'military_zones',    section:'infrastructure', label:'Military Zones',
    desc:'Military installations, bases and restricted areas.',
    style: { color:'#dc2626', fillColor:'rgba(220,38,38,0.25)',   weight:2, dashArray:'4 2' } },
  { id:'commercial_zones',  section:'infrastructure', label:'Commercial Zones',
    desc:'Commercial and retail land use areas.',
    style: { color:'#fb923c', fillColor:'rgba(251,146,60,0.18)',  weight:1 } },
  { id:'ports_harbors',     section:'infrastructure', label:'Ports / Harbors',
    desc:'Port areas, harbors and docking infrastructure.',
    style: { color:'#0ea5e9', fillColor:'rgba(14,165,233,0.25)',  weight:2 } },
  { id:'airport_zones',     section:'infrastructure', label:'Airport Zones',
    desc:'Aerodromes, runways, taxiways and apron areas.',
    style: { color:'#f59e0b', fillColor:'rgba(245,158,11,0.18)',  weight:1.5, dashArray:'5 3' } },
  { id:'landfill',          section:'infrastructure', label:'Landfill / Waste Sites',
    desc:'Landfill sites and waste disposal areas.',
    style: { color:'#78716c', fillColor:'rgba(120,113,108,0.30)', weight:1.5 } },
  { id:'quarry',            section:'infrastructure', label:'Quarry / Mining',
    desc:'Quarries and surface mining operations.',
    style: { color:'#92400e', fillColor:'rgba(146,64,14,0.25)',   weight:1.5 } },
  { id:'construction',      section:'infrastructure', label:'Construction Sites',
    desc:'Active construction and development zones.',
    style: { color:'#fcd34d', fillColor:'rgba(252,211,77,0.20)',  weight:1, dashArray:'3 3' } },
  { id:'power_stations',    section:'infrastructure', label:'Power Stations',
    desc:'Power plants and generation facilities.',
    style: { color:'#f59e0b', fillColor:'rgba(245,158,11,0.25)',  weight:2 } },
  { id:'substations',       section:'infrastructure', label:'Power Substations',
    desc:'Electrical substations and transformer stations.',
    style: { color:'#fbbf24', fillColor:'rgba(251,191,36,0.22)',  weight:1.5 } },
  { id:'pipelines',         section:'infrastructure', label:'Pipelines',
    desc:'Gas, oil and water pipeline routes.',
    style: { color:'#64748b', fillColor:'rgba(100,116,139,0.10)', weight:2, dashArray:'8 4' } },
  { id:'reservoirs',        section:'infrastructure', label:'Water Reservoirs',
    desc:'Reservoirs and managed water storage bodies.',
    style: { color:'#2563eb', fillColor:'rgba(37,99,235,0.28)',   weight:1.5 } },
  { id:'healthcare_zones',  section:'infrastructure', label:'Healthcare Areas',
    desc:'Hospital campuses, clinics and medical facility zones.',
    style: { color:'#f43f5e', fillColor:'rgba(244,63,94,0.18)',   weight:1.5 } },
  { id:'education_zones',   section:'infrastructure', label:'Education Areas',
    desc:'Schools, universities and educational campus zones.',
    style: { color:'#818cf8', fillColor:'rgba(129,140,248,0.18)', weight:1.5 } },
  { id:'emergency_services',section:'infrastructure', label:'Emergency Services',
    desc:'Fire stations, police stations and emergency response zones.',
    style: { color:'#ef4444', fillColor:'rgba(239,68,68,0.18)',   weight:2 } },
  { id:'fuel_storage',      section:'infrastructure', label:'Fuel Storage / Depots',
    desc:'Storage tanks, fuel depots and petroleum facilities.',
    style: { color:'#dc2626', fillColor:'rgba(220,38,38,0.30)',   weight:2, dashArray:'4 2' } },
  { id:'chemical_zones',    section:'infrastructure', label:'Chemical Industry',
    desc:'Chemical plants, petrochemical and refinery zones.',
    style: { color:'#9f1239', fillColor:'rgba(159,18,57,0.28)',   weight:2 } },
  { id:'nuclear',           section:'infrastructure', label:'Nuclear Facilities',
    desc:'Nuclear power plants and related installations.',
    style: { color:'#7c3aed', fillColor:'rgba(124,58,237,0.25)',  weight:2, dashArray:'6 2' } },
];

const _osmLibLayers  = new Map(); // id → { leafletLayer, visible }
let   _pinnedLayers  = [];        // [ { layer_id, section, section_override } ]

// ── Load pinned layers from server and render side panel sections ──
async function loadPinnedLayers() {
  const project = window.AEGIS_PROJECT;
  if (!project || !_customGisMap) return;
  try {
    const r = await axios.get(`${window.AEGIS_API}/api/projects/${project.id}/pinned-layers`);
    _pinnedLayers = r.data || [];
  } catch (err) {
    console.warn('[OSM-LIB] Could not load pinned layers:', err.message);
    _pinnedLayers = [];
  }
  renderPinnedOsmPanel('natural',        'pinned-natural-list');
  renderPinnedOsmPanel('infrastructure', 'pinned-infra-list');
  updateLandUseFilterDropdown();
}

// ── Render pinned layers into a side-panel container ──────────────
function renderPinnedOsmPanel(section, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;

  const pinned = _pinnedLayers.filter(p => (p.section_override || p.section) === section);
  if (!pinned.length) {
    el.innerHTML = `<div style="font-size:7px;color:var(--c-dim);letter-spacing:1px;padding:4px 0;">
      No layers pinned to this section. Open the OSM Library to add layers.</div>`;
    return;
  }

  el.innerHTML = pinned.map(p => {
    const def = OSM_LIBRARY.find(d => d.id === p.layer_id);
    if (!def) return '';
    const active = _osmLibLayers.get(def.id)?.visible;
    return `<div class="infra-row">
      <button class="infra-btn ${active ? 'infra-btn--active' : ''}"
        id="osm-pin-btn-${def.id}"
        onclick="toggleOsmLibLayer('${def.id}', this)">
        <span class="infra-line" style="background:${def.style.color};height:3px;flex-shrink:0;width:28px;
          ${def.style.dashArray ? 'border-top:2px dashed '+def.style.color+';background:none;height:0;' : ''}"></span>
        <span class="infra-lbl">${_h(def.label)}</span>
      </button>
      <button class="infra-reload" title="Reload from OSM"
        onclick="reloadOsmLibLayer('${def.id}', document.getElementById('osm-pin-btn-${def.id}'))">
        <span style="font-family:monospace;font-size:10px;">&#8635;</span>
      </button>
    </div>`;
  }).join('');
}

async function toggleOsmLibLayer(id, btn) {
  const def = OSM_LIBRARY.find(l => l.id === id);
  if (!def) return;

  const existing = _osmLibLayers.get(id);
  if (existing?.visible) {
    _customGisMap.removeLayer(existing.leafletLayer);
    _osmLibLayers.set(id, { ...existing, visible: false });
    if (btn) btn.classList.remove('infra-btn--active');
    updateLandUseFilterDropdown();
    return;
  }

  if (btn) { btn.disabled = true; btn.querySelector('.infra-lbl').textContent = '... ' + def.label; }

  try {
    const project = window.AEGIS_PROJECT;
    if (!project) throw new Error('No project');
    const r = await axios.get(
      `${window.AEGIS_API}/api/projects/${project.id}/osm-library/${id}`,
      { timeout: 90000 }
    );
    const geojson = r.data;
    const layer = L.geoJSON(geojson, {
      style: def.style,
      interactive: true,
      onEachFeature: (f, l) => {
        const name = f.properties?.name || f.properties?.['name:en'] || def.label;
        l.bindTooltip(
          `<div style="font-family:Roboto Mono,monospace;font-size:9px;background:var(--c-panel,#0b0f1c);color:var(--c-text,#c8d0e0);padding:4px 8px;border:1px solid ${def.style.color};">
            <b>${_h(name)}</b><br>
            <span style="color:var(--c-muted,#5a6378);">${_h(def.label)}</span>
          </div>`, { sticky: true }
        );
        // Make features selectable by the SELECT tool
        l.on('click', (ev) => { if (window._selectToolActive) onSelectFeatureClick(ev, f, l, def.label); });
      }
    }).addTo(_customGisMap);

    _osmLibLayers.set(id, { leafletLayer: layer, visible: true, def });
    if (btn) btn.classList.add('infra-btn--active');
    updateLandUseFilterDropdown();
    console.info(`[OSM-LIB] ${def.label}: ${geojson.features?.length || 0} features`);
  } catch (err) {
    console.warn(`[OSM-LIB] Failed to load ${id}:`, err.message);
    alert(`Could not load ${def.label}: ${err.response?.data?.error || err.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.querySelector('.infra-lbl').textContent = def.label; }
  }
}

function reloadOsmLibLayer(id, btn) {
  const existing = _osmLibLayers.get(id);
  if (existing?.leafletLayer) _customGisMap.removeLayer(existing.leafletLayer);
  _osmLibLayers.delete(id);
  const project = window.AEGIS_PROJECT;
  if (project) axios.delete(`${window.AEGIS_API}/api/projects/${project.id}/osm-library/${id}/cache`).catch(() => {});
  toggleOsmLibLayer(id, btn);
}

// ── Land-use filter: populate dropdown with currently-loaded layers ─
function updateLandUseFilterDropdown() {
  const sel = document.getElementById('lu-filter-type');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">— select loaded layer —</option>';
  for (const [id, entry] of _osmLibLayers) {
    if (!entry.visible) continue;
    const def = OSM_LIBRARY.find(d => d.id === id);
    if (!def) continue;
    const opt = document.createElement('option');
    opt.value = id; opt.textContent = def.label;
    if (id === current) opt.selected = true;
    sel.appendChild(opt);
  }
}

// ── Utility ────────────────────────────────────────────────────
function _h(s) { const d=document.createElement('div'); d.textContent=String(s||''); return d.innerHTML; }
function _fmtVal(v) { return Number.isInteger(v) ? String(v) : v.toFixed(2); }
function kmlToGeoJSON(kmlText) {
  const parser = new DOMParser();
  const doc    = parser.parseFromString(kmlText, 'application/xml');
  const features = [];
  const placemarks = doc.getElementsByTagName('Placemark');
  for (const pm of placemarks) {
    const name = pm.getElementsByTagName('name')[0]?.textContent || '';

    for (const el of pm.getElementsByTagName('Point')) {
      const c = el.getElementsByTagName('coordinates')[0]?.textContent?.trim().split(',').map(parseFloat);
      if (c?.length >= 2) features.push({ type:'Feature', geometry:{ type:'Point', coordinates:[c[0], c[1]] }, properties:{ name } });
    }
    for (const el of pm.getElementsByTagName('LineString')) {
      const coords = (el.getElementsByTagName('coordinates')[0]?.textContent || '').trim().split(/\s+/)
        .map(s => s.split(',').map(parseFloat)).filter(c => c.length >= 2).map(c => [c[0], c[1]]);
      if (coords.length >= 2) features.push({ type:'Feature', geometry:{ type:'LineString', coordinates:coords }, properties:{ name } });
    }
    for (const el of pm.getElementsByTagName('Polygon')) {
      const outerEl = el.getElementsByTagName('outerBoundaryIs')[0]?.getElementsByTagName('LinearRing')[0];
      const coords  = (outerEl?.getElementsByTagName('coordinates')[0]?.textContent || '').trim().split(/\s+/)
        .map(s => s.split(',').map(parseFloat)).filter(c => c.length >= 2).map(c => [c[0], c[1]]);
      if (coords.length >= 3) features.push({ type:'Feature', geometry:{ type:'Polygon', coordinates:[coords] }, properties:{ name } });
    }
  }
  return { type:'FeatureCollection', features };
}

// ── File input handler (wired from HTML) ────────────────────────
function handleLayerUpload(input) {
  const file = input.files?.[0];
  if (!file) return;
  uploadCustomLayer(file);
  input.value = '';
}

function _h(s) { const d=document.createElement('div'); d.textContent=String(s||''); return d.innerHTML; }
