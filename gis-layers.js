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
let _slopeVisible = false;
function toggleSlopeLayer(btn) {
  _slopeVisible = !_slopeVisible;
  if (btn) btn.classList.toggle('infra-btn--active', _slopeVisible);
  if (!_slopeVisible) {
    if (_slopeLayer) { _customGisMap.removeLayer(_slopeLayer); }
    return;
  }
  if (!_slopeLayer) _slopeLayer = createSlopeLayer();
  _slopeLayer.addTo(_customGisMap);
}

function createSlopeLayer() {
  // Custom Leaflet GridLayer that fetches terrarium tiles and renders slope to canvas
  const SlopeLayer = L.GridLayer.extend({
    options: { maxZoom: 15, minZoom: 8, opacity: 0.65, pane: 'overlayPane' },

    createTile: function (coords, done) {
      const tile = document.createElement('canvas');
      const size = this.getTileSize();
      tile.width = size.x; tile.height = size.y;
      const ctx = tile.getContext('2d', { willReadFrequently: true });

      // AWS Terrain Tiles (Mapzen terrarium PNG) — free, no key
      const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${coords.z}/${coords.x}/${coords.y}.png`;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        ctx.drawImage(img, 0, 0, size.x, size.y);
        try {
          const id = ctx.getImageData(0, 0, size.x, size.y);
          renderSlopeFromElevation(ctx, id, size.x, size.y);
        } catch (e) {
          // CORS-tainted canvas — fail silently, tile stays gray
        }
        done(null, tile);
      };
      img.onerror = () => done(null, tile);
      img.src = url;
      return tile;
    },
  });
  return new SlopeLayer();
}

// ── Slope rendering ─────────────────────────────────────────────
// Mapzen terrarium encoding: elevation = (R * 256 + G + B / 256) - 32768
// We compute per-pixel slope with a simple Sobel-like gradient.
function renderSlopeFromElevation(ctx, imageData, w, h) {
  const src = imageData.data;
  const elev = new Float32Array(w * h);

  for (let i = 0, p = 0; i < src.length; i += 4, p++) {
    elev[p] = (src[i] * 256 + src[i + 1] + src[i + 2] / 256) - 32768;
  }

  const out = ctx.createImageData(w, h);
  const od  = out.data;

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i  = y * w + x;
      // Central difference gradient
      const dx = elev[i + 1] - elev[i - 1];
      const dy = elev[i + w] - elev[i - w];
      // Slope magnitude (meters per pixel — approximate)
      const slope = Math.sqrt(dx * dx + dy * dy);
      // Map slope to color: green (flat) → yellow → red (steep)
      const s = Math.min(1, slope / 20); // 20m over 2px = ~steep
      const oi = i * 4;
      if (s < 0.05) { od[oi+3] = 0; continue; } // transparent on flat
      if (s < 0.4) {
        od[oi]     = Math.round(120 + s * 280);   // R 120→255
        od[oi + 1] = 200;                         // G hold
        od[oi + 2] = 60;                          // B low
      } else {
        od[oi]     = 230;
        od[oi + 1] = Math.round(200 - (s - 0.4) * 300); // G falloff
        od[oi + 2] = 40;
      }
      od[oi + 3] = Math.round(140 + s * 115);    // alpha 140→255
    }
  }
  ctx.putImageData(out, 0, 0);
}

// ── Minimal KML → GeoJSON (Point / LineString / Polygon) ────────
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
