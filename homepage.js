/* ================================================================
   AEGIS V3 — Homepage Controller
================================================================ */

const API = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3001'
  : window.location.origin;

// Send cookies with every request
axios.defaults.withCredentials = true;

// ── Auth guard ────────────────────────────────────────────────────
async function checkAuth() {
  try {
    const r = await axios.get(`${API}/api/auth/me`);
    // Show username in header if element exists
    const userEl = document.getElementById('hp-username');
    if (userEl) userEl.textContent = r.data.username;
  } catch {
    window.location.href = 'login.html';
  }
}

async function doLogout() {
  try { await axios.post(`${API}/api/auth/logout`); } catch {}
  window.location.href = 'login.html';
}

checkAuth();

// ── Clock ─────────────────────────────────────────────────────────
function updateClock() {
  const now = new Date();
  document.getElementById('clock').textContent =
    now.toLocaleTimeString('fr-FR', { hour12: false });
  document.getElementById('utc-date').textContent =
    now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();
  document.getElementById('footer-build').textContent =
    `BUILD: ${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
}
setInterval(updateClock, 1000);
updateClock();

// ── System health check ───────────────────────────────────────────
async function checkHealth() {
  try {
    const r = await axios.get(`${API}/api/health`, { timeout: 3000 });
    const dbDot = document.getElementById('db-status');
    dbDot.className = 'status-dot status-dot--ok';
    if (r.data?.google_places_key) {
      document.getElementById('places-status').className = 'status-dot status-dot--ok';
      document.getElementById('places-label').textContent = 'PLACES';
    } else {
      document.getElementById('places-status').className = 'status-dot status-dot--warn';
      document.getElementById('places-label').textContent = 'PLACES — NO KEY';
    }
  } catch {
    document.getElementById('db-status').className = 'status-dot status-dot--err';
  }
}
checkHealth();

// ── State ─────────────────────────────────────────────────────────
let selectedMode    = null;
let allProjects     = [];
let previewMap      = null;
let drawnLayer      = null;
let areaGeoJSON     = null;
let selectedOsmCity = null;
let selectedDistricts = [];
let osmSearchTimer  = null;

// ── Mode selection ────────────────────────────────────────────────
function selectMode(mode) {
  selectedMode = mode;
  document.querySelectorAll('.mode-card--active')
    .forEach(c => c.classList.remove('mode-card--selected'));
  document.querySelector(`[data-mode="${mode}"]`)
    .classList.add('mode-card--selected');

  const cfg = {
    simulation:   { label: 'SIMULATION',   tag: 'SIM', cls: 'mode-tag--sim' },
    risk_analysis:{ label: 'RISK ANALYSIS', tag: 'RA',  cls: 'mode-tag--ra'  },
  };
  const m = cfg[mode] || { label: mode.toUpperCase(), tag: '?', cls: '' };
  const badge = document.getElementById('panel-mode-badge');
  badge.textContent = m.tag;
  badge.className = `mode-tag ${m.cls}`;
  document.getElementById('panel-title').textContent = `${m.label} — PROJECT MANAGER`;

  loadProjectList(mode);
  openProjectPanel();
}

// ── Project panel ─────────────────────────────────────────────────
function openProjectPanel() {
  document.getElementById('project-panel').classList.add('project-panel--open');
  document.getElementById('panel-backdrop').classList.add('panel-backdrop--visible');
}
function closeProjectPanel() {
  document.getElementById('project-panel').classList.remove('project-panel--open');
  document.getElementById('panel-backdrop').classList.remove('panel-backdrop--visible');
  document.querySelectorAll('.mode-card').forEach(c => c.classList.remove('mode-card--selected'));
  selectedMode = null;
}

// ── Load & render project list ────────────────────────────────────
async function loadProjectList(mode) {
  const list = document.getElementById('project-list');
  list.innerHTML = '<div class="project-list__loading"><span class="spinner"></span> Loading…</div>';
  try {
    const r = await axios.get(`${API}/api/projects?mode=${mode}`);
    allProjects = r.data;
    renderProjectList(allProjects);
  } catch {
    list.innerHTML = '<div class="project-list__empty">⚠ Could not reach server.</div>';
  }
}

function renderProjectList(projects) {
  const list = document.getElementById('project-list');
  if (!projects.length) {
    list.innerHTML = '<div class="project-list__empty">No saved projects. Create one above.</div>';
    return;
  }
  list.innerHTML = projects.map(p => `
    <div class="project-row" onclick="openProject('${p.id}')">
      <div class="project-row__left">
        <span class="project-row__name">${escHtml(p.name)}</span>
        <span class="project-row__area">${escHtml(p.area_name || '— no area defined —')}</span>
      </div>
      <div class="project-row__right">
        <span class="project-row__date">${formatDate(p.updated_at)}</span>
        <button class="project-del-btn" title="Delete project"
          onclick="event.stopPropagation(); deleteProject('${p.id}', '${escHtml(p.name)}')">✕</button>
      </div>
    </div>
  `).join('');
}

async function deleteProject(id, name) {
  if (!confirm(`Delete project "${name}"?\n\nThis removes all facilities and scan data. Cannot be undone.`)) return;
  try {
    await axios.delete(`${API}/api/projects/${id}`);
    // Remove from local list and re-render immediately (no server round-trip)
    allProjects = allProjects.filter(p => p.id !== id);
    renderProjectList(allProjects);
  } catch (err) {
    alert('Delete failed: ' + (err.response?.data?.error || err.message));
  }
}

function filterProjects(q) {
  const lq = q.toLowerCase();
  renderProjectList(allProjects.filter(p =>
    p.name.toLowerCase().includes(lq) ||
    (p.area_name || '').toLowerCase().includes(lq)
  ));
}

function openProject(id) {
  window.location.href = `app-map.html?project=${id}`;
}

// ── Wizard ────────────────────────────────────────────────────────
function showNewProjectWizard() {
  // Reset state
  areaGeoJSON = null; selectedOsmCity = null; selectedDistricts = [];
  document.getElementById('w-name').value = '';
  document.getElementById('w-desc').value = '';
  document.getElementById('w-step2-next').disabled = true;
  document.getElementById('area-preview-wrap').style.display = 'none';
  document.getElementById('district-section').style.display = 'none';
  document.getElementById('osm-results').innerHTML = '';
  document.getElementById('file-status').style.display = 'none';
  document.getElementById('create-error').style.display = 'none';

  const isSim = selectedMode === 'simulation';
  const lbl = document.getElementById('w-mode-label');
  lbl.textContent  = isSim ? 'SIMULATION' : 'RISK ANALYSIS';
  lbl.className    = `mode-badge-inline ${isSim ? 'mode-badge-inline--sim' : 'mode-badge-inline--ra'}`;

  switchAreaTab('file');
  goToWizardStep(1);
  document.getElementById('wizard-modal').style.display = 'flex';
}

function closeWizard() {
  document.getElementById('wizard-modal').style.display = 'none';
  if (previewMap) { previewMap.remove(); previewMap = null; drawnLayer = null; }
}

function wizardNext(from) {
  if (from === 1) {
    if (!document.getElementById('w-name').value.trim()) {
      alert('Project name is required.'); return;
    }
    goToWizardStep(2);
    setTimeout(initPreviewMap, 120);
  } else if (from === 2) {
    if (!areaGeoJSON) { alert('Please define an area.'); return; }
    buildReviewCard();
    goToWizardStep(3);
  }
}
function wizardBack(from) { goToWizardStep(from - 1); }

function goToWizardStep(n) {
  [1, 2, 3].forEach(i => {
    document.getElementById(`wizard-step-${i}`).style.display = i === n ? '' : 'none';
    const el = document.getElementById(`wstep-${i}`);
    el.classList.toggle('wizard-step--active', i === n);
    el.classList.toggle('wizard-step--done',   i < n);
  });
}

// ── Preview map ───────────────────────────────────────────────────
function initPreviewMap() {
  const container = document.getElementById('preview-map-container');
  if (previewMap) { previewMap.remove(); previewMap = null; drawnLayer = null; }
  previewMap = L.map(container, { zoomControl: false, attributionControl: false });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(previewMap);
  L.control.zoom({ position: 'bottomright' }).addTo(previewMap);
  previewMap.setView([20, 0], 2);
  if (areaGeoJSON) showAreaOnMap(areaGeoJSON);
}

function showAreaOnMap(geojson) {
  if (!previewMap) return;
  if (drawnLayer) { previewMap.removeLayer(drawnLayer); drawnLayer = null; }

  drawnLayer = L.geoJSON(geojson, {
    style: { color: '#f59e0b', weight: 2, fillColor: '#f59e0b', fillOpacity: 0.10 }
  }).addTo(previewMap);

  const bounds = drawnLayer.getBounds();
  if (bounds.isValid()) previewMap.fitBounds(bounds, { padding: [16, 16] });

  document.getElementById('area-preview-wrap').style.display = '';
  document.getElementById('w-step2-next').disabled = false;

  if (bounds.isValid()) {
    const s = bounds.getSouth().toFixed(4), n = bounds.getNorth().toFixed(4);
    const w = bounds.getWest().toFixed(4),  e = bounds.getEast().toFixed(4);
    document.getElementById('preview-stats').textContent =
      `BBOX: ${s}°N ${w}°E — ${n}°N ${e}°E`;
  }
}

// ── Area tabs ─────────────────────────────────────────────────────
function switchAreaTab(tab) {
  document.getElementById('area-file-pane').style.display = tab === 'file' ? '' : 'none';
  document.getElementById('area-osm-pane').style.display  = tab === 'osm'  ? '' : 'none';
  document.getElementById('tab-file').classList.toggle('source-tab--active', tab === 'file');
  document.getElementById('tab-osm').classList.toggle('source-tab--active', tab === 'osm');
}

// ── File upload ───────────────────────────────────────────────────
function handleDragOver(e) {
  e.preventDefault();
  document.getElementById('dropzone').classList.add('dropzone--hover');
}
function handleDragLeave() {
  document.getElementById('dropzone').classList.remove('dropzone--hover');
}
function handleDrop(e) {
  e.preventDefault();
  document.getElementById('dropzone').classList.remove('dropzone--hover');
  const file = e.dataTransfer.files[0];
  if (file) processAreaFile(file);
}
function handleFileSelect(e) {
  if (e.target.files[0]) processAreaFile(e.target.files[0]);
}

async function processAreaFile(file) {
  setFileStatus('loading', `⟳ Parsing ${file.name}…`);
  try {
    const ext = file.name.split('.').pop().toLowerCase();
    let geojson = null;

    if (ext === 'geojson' || ext === 'json') {
      geojson = JSON.parse(await file.text());

    } else if (ext === 'zip') {
      if (typeof shp === 'undefined') throw new Error('shpjs library not loaded.');
      const ab = await file.arrayBuffer();
      geojson = await shp(ab);

    } else if (ext === 'kml') {
      geojson = kmlToGeoJSON(await file.text());

    } else {
      throw new Error(`Unsupported format: .${ext}. Use .geojson, .json, .zip (SHP) or .kml`);
    }

    if (!geojson) throw new Error('Could not parse file — empty or invalid geometry.');

    // Normalize to FeatureCollection
    if (geojson.type === 'Feature') {
      geojson = { type: 'FeatureCollection', features: [geojson] };
    } else if (geojson.type !== 'FeatureCollection') {
      geojson = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: geojson, properties: { name: file.name } }] };
    }

    areaGeoJSON = geojson;
    const n = geojson.features?.length || 0;
    setFileStatus('ok', `✓ ${file.name} — ${n} feature${n !== 1 ? 's' : ''} loaded`);
    showAreaOnMap(geojson);

  } catch (err) {
    setFileStatus('error', `✗ ${err.message}`);
  }
}

function setFileStatus(type, msg) {
  const el = document.getElementById('file-status');
  el.style.display = '';
  el.className = `file-status file-status--${type}`;
  el.textContent = msg;
}

// ── KML → GeoJSON (lightweight native parser) ─────────────────────
function kmlToGeoJSON(kmlText) {
  const kml = new DOMParser().parseFromString(kmlText, 'text/xml');
  const features = [];

  function coords(str) {
    return str.trim().split(/\s+/).map(c => {
      const [lng, lat, alt] = c.split(',').map(Number);
      return alt !== undefined ? [lng, lat, alt] : [lng, lat];
    });
  }

  kml.querySelectorAll('Placemark').forEach(pm => {
    const name = pm.querySelector('name')?.textContent || '';
    const poly  = pm.querySelector('Polygon');
    const line  = pm.querySelector('LineString');
    const point = pm.querySelector('Point');

    if (poly) {
      const outer = poly.querySelector('outerBoundaryIs coordinates');
      if (!outer) return;
      const rings = [coords(outer.textContent)];
      poly.querySelectorAll('innerBoundaryIs coordinates').forEach(inner => {
        rings.push(coords(inner.textContent));
      });
      features.push({ type:'Feature', properties:{ name }, geometry:{ type:'Polygon', coordinates: rings } });
    } else if (line) {
      const c = line.querySelector('coordinates');
      if (c) features.push({ type:'Feature', properties:{ name }, geometry:{ type:'LineString', coordinates: coords(c.textContent) } });
    } else if (point) {
      const c = point.querySelector('coordinates');
      if (c) {
        const [lng, lat] = c.textContent.trim().split(',').map(Number);
        features.push({ type:'Feature', properties:{ name }, geometry:{ type:'Point', coordinates:[lng, lat] } });
      }
    }
  });
  return { type: 'FeatureCollection', features };
}

// ── OSM search ────────────────────────────────────────────────────
function debounceOsmSearch(q) {
  clearTimeout(osmSearchTimer);
  if (q.length < 2) { document.getElementById('osm-results').innerHTML = ''; return; }
  osmSearchTimer = setTimeout(() => doOsmSearch(q), 380);
}

async function doOsmSearch(q) {
  const spinner = document.getElementById('osm-spinner');
  const resultsEl = document.getElementById('osm-results');
  spinner.style.display = 'inline';
  resultsEl.innerHTML = '';
  try {
    const r = await axios.get(`${API}/api/osm/search`, { params: { q, limit: 7 } });
    renderOsmResults(r.data);
  } catch {
    resultsEl.innerHTML = '<div class="osm-result-empty">Search failed — check server connection.</div>';
  } finally {
    spinner.style.display = 'none';
  }
}

function renderOsmResults(results) {
  const el = document.getElementById('osm-results');
  if (!results.length) {
    el.innerHTML = '<div class="osm-result-empty">No results found.</div>';
    return;
  }
  // Filter to meaningful boundary types
  const filtered = results.filter(r => ['city','town','village','municipality','suburb','county','administrative'].includes(r.type) || r.class === 'boundary');
  const list = filtered.length ? filtered : results.slice(0, 6);

  el.innerHTML = list.map(r => {
    const shortName = r.display_name.split(',').slice(0, 3).join(', ');
    const typeTag   = `${r.type || r.class} · ${(r.osm_type || '').toUpperCase()}${r.osm_id}`;
    // Encode result data as a safe JSON string
    const encoded = encodeURIComponent(JSON.stringify(r));
    return `
      <div class="osm-result-item" onclick="selectOsmBoundary(JSON.parse(decodeURIComponent('${encoded}')))">
        <span class="osm-result-name">${escHtml(shortName)}</span>
        <span class="osm-result-type">${escHtml(typeTag)}</span>
      </div>`;
  }).join('');
}

async function selectOsmBoundary(result) {
  selectedOsmCity = result;
  const shortName = result.display_name.split(',').slice(0, 3).join(', ');

  document.getElementById('osm-results').innerHTML = `
    <div class="osm-selected">
      ✓ ${escHtml(shortName)}
      <button class="btn btn--ghost btn--xs" onclick="clearOsmSelection()">✕ CHANGE</button>
    </div>`;
  document.getElementById('osm-search-input').value = '';

  // Build GeoJSON from polygon returned by Nominatim
  let geojson = null;
  if (result.geojson) {
    geojson = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: {
          name: result.display_name,
          osm_id: result.osm_id,
          osm_type: result.osm_type,
          osm_class: result.class,
          country_code: result.address?.country_code || null
        },
        geometry: result.geojson
      }]
    };
  } else {
    // Fallback: fetch boundary separately
    try {
      const r = await axios.get(`${API}/api/osm/boundary/${result.osm_type}/${result.osm_id}`);
      if (r.data?.[0]?.geojson) {
        geojson = {
          type: 'FeatureCollection',
          features: [{ type: 'Feature', properties: { name: result.display_name }, geometry: r.data[0].geojson }]
        };
      }
    } catch { /* use bbox as last resort — no preview */ }
  }

  if (geojson) {
    areaGeoJSON = geojson;
    showAreaOnMap(geojson);
  }

  // Attempt to load districts
  await loadDistricts(result);
}

function clearOsmSelection() {
  selectedOsmCity = null; areaGeoJSON = null; selectedDistricts = [];
  document.getElementById('osm-results').innerHTML = '';
  document.getElementById('osm-search-input').value = '';
  document.getElementById('district-section').style.display = 'none';
  document.getElementById('area-preview-wrap').style.display = 'none';
  document.getElementById('w-step2-next').disabled = true;
  if (drawnLayer && previewMap) { previewMap.removeLayer(drawnLayer); drawnLayer = null; }
}

// ── District loading ──────────────────────────────────────────────
async function loadDistricts(cityResult) {
  const section = document.getElementById('district-section');
  const list    = document.getElementById('district-list');
  section.style.display = '';
  list.innerHTML = '<span class="spinner"></span> Loading districts…';

  try {
    const payload = cityResult.osm_type === 'relation'
      ? { osmRelationId: cityResult.osm_id }
      : {
          bbox: [
            parseFloat(cityResult.boundingbox[0]),
            parseFloat(cityResult.boundingbox[2]),
            parseFloat(cityResult.boundingbox[1]),
            parseFloat(cityResult.boundingbox[3])
          ]
        };

    const r = await axios.post(`${API}/api/osm/districts`, payload, { timeout: 35000 });
    const features = r.data?.features || [];

    if (!features.length) {
      list.innerHTML = '<div class="osm-result-empty">No district data found for this area in OSM.</div>';
      return;
    }

    // Store features on window for checkbox access
    window._districtFeatures = features;
    selectedDistricts = [];

    list.innerHTML = features.map((f, i) => {
      const name = f.properties?.name || f.properties?.['name:en'] || `Area ${i+1}`;
      const lvl  = f.properties?.admin_level || '?';
      return `
        <label class="district-item">
          <input type="checkbox" class="district-cb" value="${i}" onchange="toggleDistrict(${i}, this.checked)">
          <span class="district-item__name">${escHtml(name)}</span>
          <span class="district-item__lvl">lvl ${lvl}</span>
        </label>`;
    }).join('');
  } catch (err) {
    list.innerHTML = `<div class="osm-result-empty">Could not load districts: ${escHtml(err.message)}</div>`;
  }
}

function toggleDistrict(idx, checked) {
  const feature = window._districtFeatures?.[idx];
  if (!feature) return;

  if (checked) {
    selectedDistricts.push(feature);
  } else {
    selectedDistricts = selectedDistricts.filter(f => f !== feature);
  }

  if (selectedDistricts.length > 0) {
    const distGeoJSON = { type: 'FeatureCollection', features: selectedDistricts };
    areaGeoJSON = distGeoJSON;
    showAreaOnMap(distGeoJSON);
  } else {
    // Revert to city boundary
    if (selectedOsmCity?.geojson) {
      const cityGeoJSON = {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: { name: selectedOsmCity.display_name }, geometry: selectedOsmCity.geojson }]
      };
      areaGeoJSON = cityGeoJSON;
      showAreaOnMap(cityGeoJSON);
    }
  }
}

function clearDistrictSelection() {
  document.querySelectorAll('.district-cb').forEach(cb => cb.checked = false);
  selectedDistricts = [];
  // Revert to full city boundary
  if (selectedOsmCity?.geojson) {
    const cityGeoJSON = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: { name: selectedOsmCity.display_name }, geometry: selectedOsmCity.geojson }]
    };
    areaGeoJSON = cityGeoJSON;
    showAreaOnMap(cityGeoJSON);
  }
}

// ── Review card ───────────────────────────────────────────────────
function buildReviewCard() {
  const name = document.getElementById('w-name').value.trim();
  const desc = document.getElementById('w-desc').value.trim();
  const modeLabel  = selectedMode === 'simulation' ? 'SIMULATION' : 'RISK ANALYSIS';
  const areaSource = selectedOsmCity ? 'OSM BOUNDARY' : 'UPLOADED FILE';
  const areaName   = selectedOsmCity
    ? selectedOsmCity.display_name.split(',').slice(0, 3).join(', ')
    : (areaGeoJSON?.features?.[0]?.properties?.name || 'Custom area');

  document.getElementById('review-card').innerHTML = `
    <div class="review-row"><span class="review-label">MODE</span><span class="review-val">${modeLabel}</span></div>
    <div class="review-row"><span class="review-label">NAME</span><span class="review-val">${escHtml(name)}</span></div>
    ${desc ? `<div class="review-row"><span class="review-label">DESCRIPTION</span><span class="review-val">${escHtml(desc)}</span></div>` : ''}
    <div class="review-row"><span class="review-label">AREA SOURCE</span><span class="review-val">${areaSource}</span></div>
    <div class="review-row"><span class="review-label">AREA</span><span class="review-val">${escHtml(areaName)}</span></div>
    ${selectedDistricts.length > 0 ? `<div class="review-row"><span class="review-label">DISTRICTS</span><span class="review-val">${selectedDistricts.length} selected</span></div>` : ''}
    <div class="review-row"><span class="review-label">FEATURES</span><span class="review-val">${areaGeoJSON?.features?.length || 0} polygon(s)</span></div>
    <div class="review-row review-row--info"><span class="review-label">NEXT STEPS</span><span class="review-val">Grid/district subdivision → Facility detection (once/day) → Risk indexing</span></div>
  `;
}

// ── Create project ────────────────────────────────────────────────
async function createProject() {
  const btn    = document.getElementById('create-btn');
  const errEl  = document.getElementById('create-error');
  btn.disabled = true;
  btn.textContent = '⟳ CREATING…';
  errEl.style.display = 'none';

  const name = document.getElementById('w-name').value.trim();
  const desc = document.getElementById('w-desc').value.trim();
  const areaName = selectedOsmCity
    ? selectedOsmCity.display_name.split(',').slice(0, 3).join(', ')
    : (areaGeoJSON?.features?.[0]?.properties?.name || 'Custom area');

  const payload = {
    name,
    mode: selectedMode,
    description: desc,
    area_name: areaName,
    area: {
      source: selectedOsmCity ? 'osm' : 'file',
      geojson: areaGeoJSON,
      meta: selectedOsmCity ? {
        osm_id:       selectedOsmCity.osm_id,
        osm_type:     selectedOsmCity.osm_type,
        display_name: selectedOsmCity.display_name,
        country_code: selectedOsmCity.address?.country_code || null,
        districts: selectedDistricts.map(f => ({
          name: f.properties?.name || '',
          admin_level: f.properties?.admin_level || null
        }))
      } : { file_name: areaGeoJSON?.features?.[0]?.properties?.name || 'Uploaded area' }
    }
  };

  try {
    const r = await axios.post(`${API}/api/projects`, payload);
    // Navigate to app with project loaded
    window.location.href = `app-map.html?project=${r.data.id}`;
  } catch (err) {
    const msg = err.response?.data?.error || err.message;
    errEl.textContent = `✗ ${msg}`;
    errEl.style.display = '';
    btn.disabled = false;
    btn.textContent = '⬡ INITIALIZE PROJECT';
  }
}

// ── Utils ─────────────────────────────────────────────────────────
function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = String(str || '');
  return d.innerHTML;
}
function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' })
       + ' ' + d.toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' });
}
