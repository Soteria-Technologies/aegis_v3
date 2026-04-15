/**
 * AEGIS V3 — Grid Scan Engine
 * Divides the project area into 1km² cells, queries Overpass per cell,
 * persists results to the project SQLite DB via server API.
 */

const SCAN_CELL_SIZE_KM = 1;
const SCAN_CELL_DELAY_MS = 2200;   // Overpass ToS: ~1 req/s, we're cautious
const SCAN_MAX_RETRIES   = 2;

class ScanEngine {
  constructor() {
    this.projectId   = null;
    this.areaGeoJSON = null;
    this.cells       = [];
    this.currentIdx  = 0;
    this.isRunning   = false;
    this.aborted     = false;
    this.totalFacilitiesFound = 0;
    this.startTime   = null;
    this._onProgress = null;
    this._onComplete = null;
    this._onError    = null;
  }

  /** Attach callbacks */
  on(event, fn) {
    if (event === 'progress') this._onProgress = fn;
    if (event === 'complete') this._onComplete = fn;
    if (event === 'error')    this._onError    = fn;
    return this;
  }

  // ── Grid Generation ───────────────────────────────────────────

  /**
   * Extract bounding box from any GeoJSON FeatureCollection
   */
  getBoundingBox(geojson) {
    let minLat = Infinity, maxLat = -Infinity;
    let minLng = Infinity, maxLng = -Infinity;

    function walk(coords) {
      if (!Array.isArray(coords)) return;
      if (typeof coords[0] === 'number') {
        // It's a coordinate pair [lng, lat]
        const [lng, lat] = coords;
        if (!isNaN(lat) && !isNaN(lng)) {
          minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
          minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng);
        }
      } else {
        coords.forEach(walk);
      }
    }

    for (const feature of geojson.features || []) {
      if (feature.geometry?.coordinates) walk(feature.geometry.coordinates);
    }

    return { south: minLat, north: maxLat, west: minLng, east: maxLng };
  }

  /**
   * Ray-casting point-in-polygon for a single ring (array of [lng,lat] pairs)
   */
  _raycast(point, ring) {
    const [x, y] = point;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (((yi > y) !== (yj > y)) &&
          (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  /**
   * Check if a [lng, lat] point is inside any polygon of the GeoJSON
   */
  pointInGeoJSON(point, geojson) {
    for (const feature of geojson.features || []) {
      const geom = feature.geometry;
      if (!geom) continue;
      if (geom.type === 'Polygon') {
        if (this._raycast(point, geom.coordinates[0])) return true;
      } else if (geom.type === 'MultiPolygon') {
        for (const poly of geom.coordinates) {
          if (this._raycast(point, poly[0])) return true;
        }
      }
    }
    return false;
  }

  /**
   * Check if a grid cell (bbox) intersects the project area polygon.
   * Tests cell center + all 4 corners — good enough for 1km cells.
   */
  cellIntersectsArea(cell) {
    const { south, north, west, east } = cell;
    const midLat = (south + north) / 2;
    const midLng = (west + east)  / 2;

    const testPoints = [
      [midLng, midLat],           // center
      [west,   south],            // SW corner
      [east,   south],            // SE corner
      [west,   north],            // NW corner
      [east,   north],            // NE corner
    ];

    return testPoints.some(p => this.pointInGeoJSON(p, this.areaGeoJSON));
  }

  /**
   * Generate 1km² grid cells clipped to the project polygon.
   * Returns array of {south, north, west, east, index} objects.
   */
  generateGrid(geojson) {
    this.areaGeoJSON = geojson;
    const bbox = this.getBoundingBox(geojson);

    if (!isFinite(bbox.south)) {
      throw new Error('Could not extract bounding box from project area GeoJSON.');
    }

    const centerLat  = (bbox.south + bbox.north) / 2;
    // 1° latitude ≈ 111.32 km — constant enough for our purpose
    const latStep    = SCAN_CELL_SIZE_KM / 111.32;
    // 1° longitude varies with latitude
    const lngStep    = SCAN_CELL_SIZE_KM / (111.32 * Math.cos(centerLat * Math.PI / 180));

    const cells = [];
    let idx = 0;

    for (let lat = bbox.south; lat < bbox.north; lat += latStep) {
      for (let lng = bbox.west; lng < bbox.east; lng += lngStep) {
        const cell = {
          south: lat,
          north: lat + latStep,
          west:  lng,
          east:  lng + lngStep,
        };
        if (this.cellIntersectsArea(cell)) {
          cells.push({ ...cell, index: idx++ });
        }
      }
    }

    this.cells = cells;
    console.log(`[SCAN] Grid generated: ${cells.length} cells for area of ~${(cells.length).toFixed(0)} km²`);
    return cells;
  }

  // ── 24h Throttle ─────────────────────────────────────────────

  /**
   * Check if a scan is allowed (24h has elapsed since last_scan).
   * Returns { allowed: bool, waitMs: number, lastScan: string|null }
   */
  async checkScanAllowed(projectId, forceUpdate = false) {
    if (forceUpdate) return { allowed: true, waitMs: 0, lastScan: null };

    try {
      const r = await axios.get(`${window.AEGIS_API}/api/projects/${projectId}`);
      const lastScan = r.data?.last_scan;
      if (!lastScan) return { allowed: true, waitMs: 0, lastScan: null };

      const elapsed = Date.now() - new Date(lastScan).getTime();
      const waitMs  = Math.max(0, 24 * 3600 * 1000 - elapsed);
      return { allowed: waitMs === 0, waitMs, lastScan };
    } catch {
      return { allowed: true, waitMs: 0, lastScan: null }; // fail open
    }
  }

  // ── Scan Loop ─────────────────────────────────────────────────

  /**
   * Start a full area scan.
   * @param {string} projectId
   * @param {object} geojson   — project area GeoJSON
   * @param {boolean} force    — skip 24h guard
   */
  async start(projectId, geojson, force = false) {
    if (this.isRunning) {
      console.warn('[SCAN] Already running.');
      return;
    }

    // 24h guard
    const { allowed, waitMs, lastScan } = await this.checkScanAllowed(projectId, force);
    if (!allowed) {
      const hrs  = Math.floor(waitMs / 3600000);
      const mins = Math.floor((waitMs % 3600000) / 60000);
      if (this._onError) this._onError(`Scan throttled: last scan was ${new Date(lastScan).toLocaleString()}. Next allowed in ${hrs}h ${mins}m. Use Force Scan to override.`);
      return;
    }

    this.projectId   = projectId;
    this.isRunning   = true;
    this.aborted     = false;
    this.currentIdx  = 0;
    this.totalFacilitiesFound = 0;
    this.startTime   = Date.now();

    // Generate grid
    let cells;
    try {
      cells = this.generateGrid(geojson);
    } catch (err) {
      this.isRunning = false;
      if (this._onError) this._onError(err.message);
      return;
    }

    if (cells.length === 0) {
      this.isRunning = false;
      if (this._onError) this._onError('No cells generated — check project area GeoJSON.');
      return;
    }

    // Emit initial state
    this._emitProgress({ phase: 'start', total: cells.length });

    // Process cells sequentially
    for (let i = 0; i < cells.length; i++) {
      if (this.aborted) break;

      this.currentIdx = i;
      const cell = cells[i];

      this._emitProgress({
        phase: 'scanning',
        cellIndex: i,
        total: cells.length,
        cell,
        facilitiesFound: this.totalFacilitiesFound,
        etaMs: this._estimateEta(i, cells.length),
      });

      let found = 0;
      for (let attempt = 0; attempt <= SCAN_MAX_RETRIES; attempt++) {
        try {
          found = await this._scanCell(projectId, cell, i, cells.length);
          break; // success
        } catch (err) {
          if (attempt === SCAN_MAX_RETRIES) {
            console.warn(`[SCAN] Cell ${i} failed after ${SCAN_MAX_RETRIES + 1} attempts:`, err.message);
          } else {
            await this._sleep(3000 * (attempt + 1)); // backoff
          }
        }
      }

      this.totalFacilitiesFound += found;

      // Delay between cells (skip after last cell)
      if (i < cells.length - 1 && !this.aborted) {
        await this._sleep(SCAN_CELL_DELAY_MS);
      }
    }

    this.isRunning = false;

    if (this.aborted) {
      this._emitProgress({ phase: 'aborted', cellIndex: this.currentIdx, total: cells.length });
      return;
    }

    // Update scan status on server
    const durationS = Math.round((Date.now() - this.startTime) / 1000);
    try {
      await axios.put(`${window.AEGIS_API}/api/projects/${projectId}/scan-status`, {
        last_scan:                   new Date().toISOString(),
        last_scan_cells:             cells.length,
        last_scan_facilities_found:  this.totalFacilitiesFound,
        last_scan_duration_s:        durationS,
      });
    } catch (err) {
      console.warn('[SCAN] Could not persist scan status:', err.message);
    }

    this._emitProgress({
      phase: 'complete',
      total: cells.length,
      facilitiesFound: this.totalFacilitiesFound,
      durationS,
    });
    if (this._onComplete) this._onComplete({ cells: cells.length, found: this.totalFacilitiesFound, durationS });
  }

  /** Abort the running scan */
  abort() {
    if (this.isRunning) {
      this.aborted = true;
      console.log('[SCAN] Abort requested.');
    }
  }

  // ── Cell Scanning ─────────────────────────────────────────────

  async _scanCell(projectId, cell, cellIndex, totalCells) {
    const r = await axios.post(
      `${window.AEGIS_API}/api/projects/${projectId}/scan/cell`,
      { cell, cellIndex, totalCells },
      { timeout: 35000 }
    );
    return r.data?.count || 0;
  }

  // ── Helpers ───────────────────────────────────────────────────

  _emitProgress(data) {
    if (this._onProgress) this._onProgress(data);
  }

  _estimateEta(doneIdx, total) {
    if (doneIdx === 0) return null;
    const elapsed   = Date.now() - this.startTime;
    const perCell   = elapsed / (doneIdx + 1);
    const remaining = (total - doneIdx - 1) * perCell;
    return remaining;
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Singleton
window.scanEngine = new ScanEngine();

// ── Scan Progress Panel Controller ───────────────────────────────

const ScanUI = {
  panel: null,

  init() {
    this.panel = document.getElementById('scan-panel');
  },

  show() {
    if (this.panel) this.panel.style.display = 'flex';
  },

  hide() {
    if (this.panel) this.panel.style.display = 'none';
  },

  update(data) {
    const { phase, cellIndex = 0, total = 0, cell, facilitiesFound = 0, etaMs } = data;

    const pct = total > 0 ? Math.round(((cellIndex + 1) / total) * 100) : 0;

    // Progress bar
    const fill = document.getElementById('scan-bar-fill');
    if (fill) fill.style.width = `${pct}%`;

    // Counter
    const counter = document.getElementById('scan-counter');
    if (counter) counter.textContent = `${cellIndex + 1} / ${total}`;

    // Facilities found
    const found = document.getElementById('scan-found');
    if (found) found.textContent = facilitiesFound;

    // ETA
    const eta = document.getElementById('scan-eta');
    if (eta) {
      if (etaMs != null && phase === 'scanning') {
        const mins = Math.floor(etaMs / 60000);
        const secs = Math.floor((etaMs % 60000) / 1000);
        eta.textContent = `ETA ${mins}m ${secs}s`;
      } else {
        eta.textContent = phase === 'complete' ? 'DONE' : '—';
      }
    }

    // Phase badge
    const badge = document.getElementById('scan-phase');
    if (badge) {
      const labels = { start: 'INITIALIZING', scanning: 'SCANNING', complete: 'COMPLETE', aborted: 'ABORTED' };
      badge.textContent = labels[phase] || phase.toUpperCase();
      badge.className   = `scan-phase scan-phase--${phase}`;
    }

    // Current cell coords
    if (cell) {
      const coords = document.getElementById('scan-cell-coords');
      if (coords) {
        coords.textContent = `${cell.south.toFixed(4)}°N ${cell.west.toFixed(4)}°E → ${cell.north.toFixed(4)}°N ${cell.east.toFixed(4)}°E`;
      }
    }

    // Log entry
    if (phase === 'scanning' && cell) {
      this._appendLog(`Cell ${cellIndex + 1}/${total} · ${facilitiesFound} facilities`);
    } else if (phase === 'complete') {
      this._appendLog(`✓ Scan complete — ${facilitiesFound} facilities in ${total} cells`);
    } else if (phase === 'aborted') {
      this._appendLog(`⚠ Scan aborted at cell ${cellIndex}`);
    }
  },

  _appendLog(msg) {
    const log = document.getElementById('scan-log');
    if (!log) return;
    const line = document.createElement('div');
    line.className = 'scan-log-line';
    line.textContent = `[${new Date().toLocaleTimeString('fr-FR', { hour12: false })}] ${msg}`;
    log.insertBefore(line, log.firstChild);
    // Keep max 60 lines
    while (log.children.length > 60) log.removeChild(log.lastChild);
  },
};

/**
 * Entry point called from UI buttons
 * @param {boolean} force — skip 24h throttle
 */
async function startFacilityScan(force = false) {
  const project = window.AEGIS_PROJECT;
  if (!project) {
    alert('No project loaded.');
    return;
  }
  if (!project.area?.geojson) {
    alert('Project has no area defined. Please re-create the project with an area.');
    return;
  }

  // Reset and show panel
  document.getElementById('scan-log').innerHTML = '';
  ScanUI.show();

  // Disable button while running
  const btn = document.getElementById('btn-scan-now');
  const forceBtn = document.getElementById('btn-scan-force');
  if (btn) btn.disabled = true;
  if (forceBtn) forceBtn.disabled = true;

  window.scanEngine
    .on('progress', (data) => {
      ScanUI.update(data);
      // Refresh facility table if it's open
      if (window.currentPage === 'facilities') loadFacilitiesPage();
    })
    .on('complete', (result) => {
      ScanUI.update({ phase: 'complete', total: result.cells, facilitiesFound: result.found });
      if (btn) btn.disabled = false;
      if (forceBtn) forceBtn.disabled = false;
      // Refresh scan status in settings
      refreshScanStatus();
      // Reload facilities on map
      if (typeof detectFacilities === 'function') detectFacilities();
    })
    .on('error', (msg) => {
      ScanUI.update({ phase: 'aborted', total: 0 });
      ScanUI._appendLog(`ERROR: ${msg}`);
      if (btn) btn.disabled = false;
      if (forceBtn) forceBtn.disabled = false;
      alert(`Scan error: ${msg}`);
    });

  // Reset engine state before new scan
  window.scanEngine.aborted = false;
  window.scanEngine.isRunning = false;

  await window.scanEngine.start(project.id, project.area.geojson, force);
}

function abortScan() {
  window.scanEngine.abort();
}

async function refreshScanStatus() {
  try {
    const r = await axios.get(`${window.AEGIS_API}/api/projects/${window.AEGIS_PROJECT?.id}`);
    const p = r.data;
    window.AEGIS_PROJECT = p; // update local copy

    const el = document.getElementById('settings-last-scan');
    if (el) {
      el.textContent = p.last_scan
        ? new Date(p.last_scan).toLocaleString()
        : 'Never';
    }
    const nextEl = document.getElementById('settings-next-scan');
    if (nextEl && p.last_scan) {
      const next = new Date(new Date(p.last_scan).getTime() + 24 * 3600 * 1000);
      nextEl.textContent = next.toLocaleString();
    }
    const cellEl = document.getElementById('settings-scan-cells');
    if (cellEl) cellEl.textContent = p.last_scan_cells || '—';
    const foundEl = document.getElementById('settings-scan-found');
    if (foundEl) foundEl.textContent = p.last_scan_facilities_found || '—';
  } catch { /* silent */ }
}
