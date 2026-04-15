/**
 * AEGIS V3 — Shared Navigation Component
 * Self-injects context bar, nav bar, and mini scan status into any page.
 * Polls scan status every 2s; bridges to map grid if on map page.
 */
(function () {
  'use strict';

  const API = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ? 'http://localhost:3001' : window.location.origin;
  window.AEGIS_API = API;

  // Global: send cookies with every request
  axios.defaults.withCredentials = true;

  const params     = new URLSearchParams(window.location.search);
  const projectId  = params.get('project');
  const activePage = params.get('page') || 'map';

  // ── Auth guard — redirect to login if session is invalid ──────
  async function checkAuth() {
    try {
      await axios.get(`${API}/api/auth/me`);
    } catch (err) {
      if (err.response?.status === 401) {
        window.location.href = 'login.html';
        return false;
      }
    }
    return true;
  }

  if (!projectId && !window.location.pathname.includes('index')) {
    window.location.href = 'index.html';
    return;
  }

  // ── URL helpers ──────────────────────────────────────────────
  function mapUrl()         { return `app-map.html?project=${projectId}`; }
  function pagesUrl(page)   { return `app-pages.html?project=${projectId}&page=${page}`; }
  function navTo(page)      { window.location.href = page === 'map' ? mapUrl() : pagesUrl(page); }

  // ── Inject HTML ──────────────────────────────────────────────
  function injectNav() {
    // Context bar
    const ctxEl = document.createElement('div');
    ctxEl.id = 'ctx-bar';
    ctxEl.innerHTML = `
      <div class="ctx-left">
        <span class="ctx-mode" id="ctx-mode-badge">---</span>
        <span class="ctx-name" id="ctx-name">---</span>
        <span class="ctx-sep">·</span>
        <span class="ctx-area" id="ctx-area">---</span>
      </div>
      <button class="ctx-back" onclick="window.location.href='index.html'">← HOME</button>`;
    document.body.prepend(ctxEl);

    // Nav bar
    const navEl = document.createElement('nav');
    navEl.id = 'main-nav';

    const pages = [
      { id: 'map',              label: 'MAP',              icon: '◉', disabled: false },
      { id: 'facilities',       label: 'FACILITY DATABASE', icon: '⬡', disabled: false },
      { id: 'risk-inventory',   label: 'RISK INVENTORY',   icon: '⚠', disabled: true  },
      { id: 'entities-network', label: 'ENTITIES NETWORK', icon: '◈', disabled: true  },
      { id: 'risk-network',     label: 'RISK NETWORK',     icon: '⬡', disabled: true  },
      { id: 'settings',         label: 'SETTINGS',         icon: '⚙', disabled: false },
    ];

    const currentId = window.location.pathname.includes('app-map') ? 'map' : activePage;

    navEl.innerHTML = pages.map(p => {
      const active   = p.id === currentId ? 'nav-btn--active' : '';
      const disabled = p.disabled ? 'nav-btn--disabled nav-btn--stub' : '';
      const click    = p.disabled ? '' : `onclick="window.AEGIS_NAV.navTo('${p.id}')"`;
      return `<button class="nav-btn ${active} ${disabled}" data-page="${p.id}" ${click}>
        <span class="nav-icon">${p.icon}</span> ${p.label}
      </button>`;
    }).join('') +
    `<div id="nav-scan-indicator">
       <div class="pulse-dot"></div>
       <span>SCAN RUNNING</span>
       <span id="nav-scan-pct">0%</span>
       <span id="nav-scan-found" style="color:var(--c-muted)">0 fac.</span>
     </div>`;

    ctxEl.after(navEl);

    // Mini scan panel (shown on non-map pages, or as fallback)
    const scanEl = document.createElement('div');
    scanEl.id = 'scan-panel';
    scanEl.innerHTML = `
      <div class="scan-panel__head">
        <span class="scan-panel__head-title">AREA SCAN</span>
        <div class="scan-panel__head-right">
          <span class="scan-phase" id="scan-phase">IDLE</span>
          <span id="scan-eta" style="font-size:9px;color:var(--c-muted)">—</span>
          <button class="scan-panel__close" onclick="this.closest('#scan-panel').style.display='none'">✕</button>
        </div>
      </div>
      <div class="scan-bar-wrap"><div id="scan-bar-fill"></div></div>
      <div class="scan-stats">
        <div class="scan-stat"><div class="scan-stat__label">CELLS</div><div class="scan-stat__val" id="scan-counter">0/0</div></div>
        <div class="scan-stat"><div class="scan-stat__label">FOUND</div><div class="scan-stat__val" id="scan-found">0</div></div>
        <div class="scan-stat"><div class="scan-stat__label">ELAPSED</div><div class="scan-stat__val" id="scan-elapsed">0s</div></div>
      </div>
      <div class="scan-coords" id="scan-cell-coords">—</div>
      <div id="scan-log"></div>
      <div class="scan-panel__foot">
        <button class="app-btn app-btn--sm" onclick="window.location.href=window.AEGIS_NAV.mapUrl()">VIEW MAP →</button>
        <button class="app-btn app-btn--danger app-btn--sm" onclick="AEGIS_NAV.abortScan()">ABORT</button>
      </div>`;
    document.body.appendChild(scanEl);
  }

  // ── Project context ──────────────────────────────────────────
  async function loadProject() {
    if (!projectId) return;
    try {
      const r = await axios.get(`${API}/api/projects/${projectId}`);
      window.AEGIS_PROJECT = r.data;
      applyProject(r.data);
    } catch { applyProject(null); }
  }

  function applyProject(p) {
    const badge = document.getElementById('ctx-mode-badge');
    const name  = document.getElementById('ctx-name');
    const area  = document.getElementById('ctx-area');
    if (!badge) return;

    if (!p) { badge.textContent = '?'; name.textContent = 'Offline'; return; }
    const isSim  = p.mode === 'simulation';
    badge.textContent = isSim ? 'SIM' : 'RA';
    badge.className   = 'ctx-mode ' + (isSim ? 'ctx-mode--sim' : 'ctx-mode--ra');
    name.textContent  = p.name;
    area.textContent  = p.area_name || '—';
    document.title    = 'AEGIS V3 — ' + p.name;
  }

  // ── Scan status polling ──────────────────────────────────────
  let pollTimer    = null;
  let lastScanStatus = 'idle';
  let dismissTimer   = null;

  function startPolling() {
    pollScan();
    pollTimer = setInterval(pollScan, 2000);
  }

  async function pollScan() {
    if (!projectId) return;
    try {
      const r = await axios.get(`${API}/api/projects/${projectId}/scan/status`);
      const data = r.data;

      // Detect transition to 'done'
      if (lastScanStatus === 'running' && data.status === 'done') {
        onScanComplete(data);
      }
      lastScanStatus = data.status;

      updateScanUI(data);
      if (typeof window.updateMapScanGrid === 'function') {
        window.updateMapScanGrid(data);
      }
    } catch { /* silent */ }
  }

  function onScanComplete(data) {
    // Announce completion — green state
    const panel = document.getElementById('scan-panel');
    if (panel) {
      panel.classList.add('scan-panel--visible');
      panel.style.borderColor = 'rgba(34,197,94,0.5)';
    }
    const phase = document.getElementById('scan-phase');
    if (phase) { phase.textContent = 'COMPLETE'; phase.className = 'scan-phase scan-phase--complete'; }
    const fill = document.getElementById('scan-bar-fill');
    if (fill) { fill.style.width = '100%'; fill.style.background = '#22c55e'; }
    const counter = document.getElementById('scan-counter');
    if (counter) counter.textContent = data.progress?.total + '/' + data.progress?.total;
    const found = document.getElementById('scan-found');
    if (found) found.textContent = data.found ?? 0;
    const eta = document.getElementById('scan-eta');
    if (eta) eta.textContent = 'DONE';

    // Nav indicator off
    const ind = document.getElementById('nav-scan-indicator');
    if (ind) ind.classList.remove('active');

    // Auto-dismiss after 6 seconds
    clearTimeout(dismissTimer);
    dismissTimer = setTimeout(() => {
      if (panel) {
        panel.style.transition = 'opacity .6s';
        panel.style.opacity    = '0';
        setTimeout(() => {
          panel.classList.remove('scan-panel--visible');
          panel.style.opacity    = '';
          panel.style.transition = '';
          panel.style.borderColor = '';
          // Reset bar color for next scan
          if (fill) { fill.style.background = ''; }
        }, 600);
      }
    }, 6000);
  }

  function updateScanUI(s) {
    const active = s.status === 'running';

    const ind = document.getElementById('nav-scan-indicator');
    if (ind) ind.classList.toggle('active', active);
    if (active) {
      const pctEl = document.getElementById('nav-scan-pct');
      if (pctEl) pctEl.textContent = (s.progress?.pct ?? 0) + '%';
      const fndEl = document.getElementById('nav-scan-found');
      if (fndEl) fndEl.textContent = (s.found ?? 0) + ' fac.';
    }

    const panel = document.getElementById('scan-panel');
    if (!panel) return;

    // Only show panel for active scans (completion handled by onScanComplete)
    if (active) panel.classList.add('scan-panel--visible');

    if (s.status === 'running') {
      const phase = document.getElementById('scan-phase');
      if (phase) { phase.textContent = 'SCANNING'; phase.className = 'scan-phase scan-phase--scanning'; }
    }

    if (!active && s.status !== 'done') return; // idle — don't update counts

    const pct     = s.progress?.pct  ?? 0;
    const done    = s.progress?.done  ?? 0;
    const tot     = s.progress?.total ?? 0;
    const fill    = document.getElementById('scan-bar-fill');
    if (fill && s.status !== 'done')    fill.style.width = pct + '%';
    const counter = document.getElementById('scan-counter');
    if (counter && s.status !== 'done') counter.textContent = done + '/' + tot;
    const found   = document.getElementById('scan-found');
    if (found && s.status !== 'done')   found.textContent = s.found ?? 0;
    const eta     = document.getElementById('scan-eta');
    if (eta && s.etaMs != null && s.status === 'running') {
      const m = Math.floor(s.etaMs / 60000), sec = Math.floor((s.etaMs % 60000) / 1000);
      eta.textContent = 'ETA ' + m + 'm ' + sec + 's';
    }
    if (s.startTime && s.status === 'running') {
      const el = document.getElementById('scan-elapsed');
      if (el) el.textContent = Math.round((Date.now() - new Date(s.startTime).getTime()) / 1000) + 's';
    }
    const cellCoord = document.getElementById('scan-cell-coords');
    if (cellCoord && s.currentCell) {
      const c = s.currentCell;
      cellCoord.textContent = (c.south?.toFixed(4)||'?') + '°N ' + (c.west?.toFixed(4)||'?') + '°E → ' + (c.north?.toFixed(4)||'?') + '°N ' + (c.east?.toFixed(4)||'?') + '°E';
    }
  }

  // ── Scan control ─────────────────────────────────────────────
  async function startScan(force = false) {
    if (!window.AEGIS_PROJECT) { alert('No project loaded.'); return; }
    if (!window.AEGIS_PROJECT.area?.geojson) { alert('Project has no area defined.'); return; }
    try {
      const r = await axios.post(`${API}/api/projects/${projectId}/scan/start`, { force });
      if (r.data.throttled) {
        alert(r.data.message);
      } else {
        // Clear old log
        const log = document.getElementById('scan-log');
        if (log) log.innerHTML = '';
        document.getElementById('scan-panel')?.classList.add('scan-panel--visible');
        pollScan();
      }
    } catch (err) {
      alert('Failed to start scan: ' + (err.response?.data?.error || err.message));
    }
  }

  async function abortScan() {
    try {
      await axios.post(`${API}/api/projects/${projectId}/scan/abort`);
    } catch { }
  }

  // ── Public API ───────────────────────────────────────────────
  window.AEGIS_NAV = { navTo, mapUrl, pagesUrl, startScan, abortScan, projectId, API };

  // ── Boot ─────────────────────────────────────────────────────
  async function boot() {
    const ok = await checkAuth();
    if (!ok) return; // redirecting to login
    injectNav();
    loadProject();
    startPolling();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
