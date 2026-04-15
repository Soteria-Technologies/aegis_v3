/**
 * AEGIS V3 — Infrastructure Layers
 * Roads · Highways · Railways · Power Network · Telecom Network
 * Rendered as Leaflet overlays, toggled independently.
 * Data fetched from server (Overpass-cached) or derived from facilities DB.
 */

const INFRA_STYLES = {
  roads: {
    color: '#8899aa', weight: 1.2, opacity: 0.65,
    label: 'ROADS', icon: '─'
  },
  highways: {
    color: '#e2c97e', weight: 3.5, opacity: 0.8,
    label: 'HIGHWAYS', icon: '═'
  },
  railways: {
    color: '#b07fff', weight: 2, opacity: 0.8,
    dashArray: '8 4',
    label: 'RAILWAYS', icon: '─'
  },
  power: {
    color: '#f59e0b', weight: 1.5, opacity: 0.75,
    dashArray: '10 5',
    label: 'POWER GRID', icon: '┄'
  },
  telecom: {
    color: '#38bdf8', weight: 1.2, opacity: 0.70,
    dashArray: '6 5',
    label: 'TELECOM', icon: '┄'
  },
};

// Layer group per type
const infraGroups = {};
const infraVisible = {};
const infraLoaded  = {};

function initInfraLayers(map) {
  for (const type of Object.keys(INFRA_STYLES)) {
    infraGroups[type] = L.layerGroup();
    infraVisible[type] = false;
    infraLoaded[type]  = false;
  }
  window._infraMap = map;
}

// ── Toggle a layer on/off ────────────────────────────────────────
async function toggleInfraLayer(type, btn) {
  const map = window._infraMap;
  if (!map) return;

  infraVisible[type] = !infraVisible[type];

  // Update button state
  if (btn) btn.classList.toggle('infra-btn--active', infraVisible[type]);

  if (!infraVisible[type]) {
    map.removeLayer(infraGroups[type]);
    return;
  }

  // Load data if not yet loaded
  if (!infraLoaded[type]) {
    setInfraBtnLoading(btn, true);
    try {
      await loadInfraLayer(type);
    } catch (err) {
      console.warn(`[INFRA] Failed to load ${type}:`, err.message);
      setInfraBtnLoading(btn, false);
      infraVisible[type] = false;
      if (btn) btn.classList.remove('infra-btn--active');
      return;
    }
    setInfraBtnLoading(btn, false);
  }

  infraGroups[type].addTo(map);
}

function setInfraBtnLoading(btn, loading) {
  if (!btn) return;
  btn.disabled = loading;
  if (loading) btn.setAttribute('data-orig', btn.textContent);
  else btn.textContent = btn.getAttribute('data-orig') || btn.textContent;
  if (loading) {
    const orig = btn.textContent;
    btn.setAttribute('data-orig', orig);
    btn.textContent = '⟳';
  }
}

// ── Fetch + render a layer ───────────────────────────────────────
async function loadInfraLayer(type) {
  const project = window.AEGIS_PROJECT;
  if (!project) throw new Error('No project loaded');

  const group = infraGroups[type];
  group.clearLayers();

  const style = INFRA_STYLES[type];
  const lineOpts = {
    color:     style.color,
    weight:    style.weight,
    opacity:   style.opacity,
    dashArray: style.dashArray || null,
    interactive: false,
  };

  // Power and telecom can be derived from facilities — try OSM first, fallback to derived
  if (type === 'power' || type === 'telecom') {
    await loadNetworkLayer(type, group, lineOpts, project);
  } else {
    await loadOsmLayer(type, group, lineOpts, project);
  }

  infraLoaded[type] = true;
}

// ── OSM layer (roads / highways / railways) ──────────────────────
async function loadOsmLayer(type, group, lineOpts, project) {
  const r = await axios.get(
    `${window.AEGIS_API}/api/projects/${project.id}/infrastructure/${type}`,
    { timeout: 60000 }
  );
  const geojson = r.data;
  if (!geojson?.features?.length) {
    console.info(`[INFRA] No ${type} data returned`);
    return;
  }

  // Roads: color-code by highway class
  const ROAD_COLORS = {
    motorway: '#f59e0b', trunk: '#f97316', primary: '#d4d4d4',
    secondary: '#a3a3a3', tertiary: '#6b7280', default: '#4b5563',
  };

  L.geoJSON(geojson, {
    style: (feature) => {
      if (type === 'roads') {
        const hw = feature.properties?.highway || 'default';
        return { ...lineOpts, color: ROAD_COLORS[hw] || ROAD_COLORS.default };
      }
      return lineOpts;
    },
    interactive: false,
  }).addTo(group);
}

// ── Network layer (power / telecom) — OSM first, derived fallback ──
async function loadNetworkLayer(type, group, lineOpts, project) {
  // 1. Try OSM cached data first
  try {
    const r = await axios.get(
      `${window.AEGIS_API}/api/projects/${project.id}/infrastructure/${type}`,
      { timeout: 45000 }
    );
    if (r.data?.features?.length) {
      L.geoJSON(r.data, { style: () => lineOpts, interactive: false }).addTo(group);
      return;
    }
  } catch { /* fallthrough to derived */ }

  // 2. Derive from facilities DB — nearest-neighbour spanning tree
  const r = await axios.get(`${window.AEGIS_API}/api/projects/${project.id}/facilities`);
  const all = r.data || [];

  let nodes = [];
  if (type === 'power') {
    nodes = all.filter(f => ['power_plant','substation'].includes(f.category));
  } else if (type === 'telecom') {
    // Primary: category match
    nodes = all.filter(f => f.category === 'communication');
    // Fallback: name contains telecom/tower
    if (nodes.length < 2) {
      nodes = all.filter(f => {
        const nm  = (f.name || '').toLowerCase();
        const cat = (f.category_name || '').toLowerCase();
        return nm.includes('telecom') || nm.includes('tower') ||
               nm.includes('antenn') || nm.includes('relay')  ||
               cat.includes('telecom') || cat.includes('communication');
      });
    }
  }

  if (nodes.length < 2) {
    console.info(`[INFRA] Not enough ${type} nodes to derive network (${nodes.length})`);
    return;
  }

  // Build spanning chain with nearest-neighbour greedy algorithm
  nearestNeighbourChain(nodes).forEach(([a, b]) => {
    L.polyline(
      [[a.latitude, a.longitude], [b.latitude, b.longitude]],
      lineOpts
    ).addTo(group);
  });
}

// ── Nearest-neighbour chain (greedy MST approximation) ─────────
function nearestNeighbourChain(nodes) {
  const edges = [];
  const visited = new Set();
  let current = nodes[0];
  visited.add(0);

  while (visited.size < nodes.length) {
    let bestDist = Infinity, bestIdx = -1;
    for (let i = 0; i < nodes.length; i++) {
      if (visited.has(i)) continue;
      const d = haversineKm(current.latitude, current.longitude, nodes[i].latitude, nodes[i].longitude);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    if (bestIdx === -1) break;
    edges.push([current, nodes[bestIdx]]);
    visited.add(bestIdx);
    current = nodes[bestIdx];
  }
  return edges;
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── Force reload a layer (clears cache on server) ───────────────
async function reloadInfraLayer(type, btn) {
  const project = window.AEGIS_PROJECT;
  if (!project) return;
  try {
    await axios.delete(
      `${window.AEGIS_API}/api/projects/${project.id}/infrastructure/${type}/cache`
    );
  } catch { /* cache may not exist */ }
  infraLoaded[type] = false;
  if (infraVisible[type]) {
    const map = window._infraMap;
    if (map) map.removeLayer(infraGroups[type]);
    infraGroups[type].clearLayers();
    // Re-add
    setInfraBtnLoading(btn, true);
    try { await loadInfraLayer(type); infraGroups[type].addTo(map); }
    finally { setInfraBtnLoading(btn, false); }
  }
}
