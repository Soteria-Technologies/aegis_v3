/**
 * AEGIS V3 — Relationship Engine
 * Computes facility-to-facility and natural-hazard-to-facility relationships.
 *
 * Architecture:
 *  Phase 1 — Geometry filter:  spatial index, distance thresholds per rule
 *  Phase 2 — Rulebook match:   pattern match by category pair + conditions
 *  Phase 3 — TST assignment:   derive Type/Spatial/Temporal from rule + context
 *  Phase 4 — Natural hazards:  inject external hazard nodes from env_context
 *
 * TST framework adapted from Wenzel et al. (2026) Natural Hazards 122:82
 * to asset-propagation semantics:
 *   HCA = failure of A directly causes/enables failure of B
 *   HTC = A and B fail from same external trigger
 *   HPC = degradation of A increases B's vulnerability
 *   HIN = proximity without propagation mechanism
 */
'use strict';

const { v4: uuidv4 } = require('uuid');

// ── Haversine distance (metres) ───────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R  = 6371000;
  const dL = (lat2 - lat1) * Math.PI / 180;
  const dl = (lng2 - lng1) * Math.PI / 180;
  const a  = Math.sin(dL/2)**2 +
             Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dl/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── Default facility schedules (24h clock, days 0=Sun) ────────
const DEFAULT_SCHEDULES = {
  hospital:      { hours:[0,24],  days:[0,1,2,3,4,5,6], peak_occ:1.0,  always_active:true  },
  clinic:        { hours:[8,19],  days:[1,2,3,4,5],      peak_occ:0.85, always_active:false },
  fire_station:  { hours:[0,24],  days:[0,1,2,3,4,5,6], peak_occ:1.0,  always_active:true  },
  police:        { hours:[0,24],  days:[0,1,2,3,4,5,6], peak_occ:1.0,  always_active:true  },
  school:        { hours:[8,17],  days:[1,2,3,4,5],      peak_occ:0.90, always_active:false },
  gymnasium:     { hours:[7,22],  days:[0,1,2,3,4,5,6], peak_occ:0.60, always_active:false },
  shelter:       { hours:[0,24],  days:[0,1,2,3,4,5,6], peak_occ:0.80, always_active:true  },
  power_plant:   { hours:[0,24],  days:[0,1,2,3,4,5,6], peak_occ:1.0,  always_active:true  },
  substation:    { hours:[0,24],  days:[0,1,2,3,4,5,6], peak_occ:1.0,  always_active:true  },
  chemical_plant:{ hours:[6,22],  days:[1,2,3,4,5],      peak_occ:0.90, always_active:false },
  petroleum:     { hours:[0,24],  days:[0,1,2,3,4,5,6], peak_occ:0.90, always_active:true  },
  waste:         { hours:[6,20],  days:[1,2,3,4,5,6],   peak_occ:0.70, always_active:false },
  water:         { hours:[0,24],  days:[0,1,2,3,4,5,6], peak_occ:1.0,  always_active:true  },
  airport:       { hours:[4,24],  days:[0,1,2,3,4,5,6], peak_occ:0.85, always_active:true  },
  train_station: { hours:[5,24],  days:[0,1,2,3,4,5,6], peak_occ:0.80, always_active:false },
  communication: { hours:[0,24],  days:[0,1,2,3,4,5,6], peak_occ:1.0,  always_active:true  },
  military:      { hours:[0,24],  days:[0,1,2,3,4,5,6], peak_occ:1.0,  always_active:true  },
  storage_tank:  { hours:[0,24],  days:[0,1,2,3,4,5,6], peak_occ:1.0,  always_active:true  },
};

// ── Default rulebook ──────────────────────────────────────────
// Each rule: from, to, link_type, tst_type, tst_spatial, tst_temporal,
//            max_dist (m), confidence, bidirectional, note
const DEFAULT_RULEBOOK = [
  // ── Power dependencies ──
  { id:'R01', from:'power_plant',   to:'substation',     link:'DEPS', tst:'HCA', sp:'SSP', tm:'TSI', dist:50000, conf:0.90, note:'Power transmission to distribution node' },
  { id:'R02', from:'substation',    to:'hospital',       link:'DEPS', tst:'HCA', sp:'SO',  tm:'TSI', dist:10000, conf:0.92, note:'Critical medical power dependency' },
  { id:'R03', from:'substation',    to:'water',          link:'DEPS', tst:'HCA', sp:'SO',  tm:'TSI', dist:8000,  conf:0.88, note:'Pump station power' },
  { id:'R04', from:'substation',    to:'communication',  link:'DEPS', tst:'HCA', sp:'SO',  tm:'TSI', dist:12000, conf:0.85, note:'Telecom tower power feed' },
  { id:'R05', from:'substation',    to:'fire_station',   link:'DEPS', tst:'HCA', sp:'SO',  tm:'TSI', dist:8000,  conf:0.80, note:'Emergency services power' },
  { id:'R06', from:'substation',    to:'police',         link:'DEPS', tst:'HCA', sp:'SO',  tm:'TSI', dist:8000,  conf:0.80, note:'Police station power' },
  { id:'R07', from:'substation',    to:'train_station',  link:'DEPS', tst:'HCA', sp:'SSP', tm:'TSI', dist:15000, conf:0.85, note:'Electric rail power' },
  { id:'R08', from:'substation',    to:'airport',        link:'DEPS', tst:'HCA', sp:'SO',  tm:'TSI', dist:20000, conf:0.82, note:'Airport power grid' },
  // ── Water dependencies ──
  { id:'R09', from:'water',         to:'hospital',       link:'DEPS', tst:'HCA', sp:'SO',  tm:'TCO', dist:5000,  conf:0.90, note:'Medical water supply' },
  { id:'R10', from:'water',         to:'clinic',         link:'DEPS', tst:'HCA', sp:'SO',  tm:'TCO', dist:4000,  conf:0.80, note:'Clinical water supply' },
  { id:'R11', from:'water',         to:'shelter',        link:'DEPS', tst:'HCA', sp:'SO',  tm:'TCO', dist:5000,  conf:0.75, note:'Emergency shelter water' },
  { id:'R12', from:'water',         to:'school',         link:'DEPS', tst:'HCA', sp:'SO',  tm:'TDI', dist:3000,  conf:0.70, note:'School water supply' },
  // ── Fire & emergency service coverage ──
  { id:'R13', from:'fire_station',  to:'hospital',       link:'MECH', tst:'HCA', sp:'SO',  tm:'TSI', dist:5000,  conf:0.85, note:'First responder to critical asset' },
  { id:'R14', from:'fire_station',  to:'chemical_plant', link:'MECH', tst:'HCA', sp:'SO',  tm:'TSI', dist:8000,  conf:0.90, note:'Fire response to hazmat site' },
  { id:'R15', from:'fire_station',  to:'petroleum',      link:'MECH', tst:'HCA', sp:'SO',  tm:'TSI', dist:8000,  conf:0.90, note:'Fire response to petroleum' },
  { id:'R16', from:'police',        to:'hospital',       link:'MECH', tst:'HCA', sp:'SO',  tm:'TSI', dist:5000,  conf:0.75, note:'Security and crowd control at medical' },
  // ── Chemical / exposure chains ──
  { id:'R17', from:'chemical_plant',to:'water',          link:'EXPO', tst:'HCA', sp:'SSP', tm:'TCO', dist:5000,  conf:0.90, note:'Chemical spill contaminates water supply' },
  { id:'R18', from:'chemical_plant',to:'hospital',       link:'EXPO', tst:'HCA', sp:'SO',  tm:'TSI', dist:3000,  conf:0.85, note:'Toxic release, hospital mass casualties' },
  { id:'R19', from:'chemical_plant',to:'school',         link:'EXPO', tst:'HCA', sp:'SO',  tm:'TSI', dist:2000,  conf:0.88, note:'Child vulnerability to toxic release' },
  { id:'R20', from:'petroleum',     to:'water',          link:'EXPO', tst:'HCA', sp:'SSP', tm:'TCO', dist:5000,  conf:0.88, note:'Oil spill to water treatment' },
  { id:'R21', from:'petroleum',     to:'chemical_plant', link:'VICN', tst:'HTC', sp:'SO',  tm:'TSI', dist:500,   conf:0.85, bidir:true, note:'Adjacent hazardous industrial — ignition amplification' },
  { id:'R22', from:'storage_tank',  to:'hospital',       link:'EXPO', tst:'HCA', sp:'SO',  tm:'TSI', dist:2000,  conf:0.80, note:'Tank failure blast/toxic to hospital' },
  { id:'R23', from:'storage_tank',  to:'chemical_plant', link:'VICN', tst:'HTC', sp:'SO',  tm:'TSI', dist:800,   conf:0.82, bidir:true, note:'Co-located storage and process hazards' },
  // ── Waste / environmental ──
  { id:'R24', from:'waste',         to:'water',          link:'EXPO', tst:'HPC', sp:'SSP', tm:'TDI', dist:3000,  conf:0.75, note:'Leachate contaminates groundwater over time' },
  { id:'R25', from:'waste',         to:'hospital',       link:'EXPO', tst:'HPC', sp:'SO',  tm:'TDI', dist:2000,  conf:0.65, note:'Long-term air/water quality impact on patients' },
  // ── Transport mechanism chains ──
  { id:'R26', from:'airport',       to:'hospital',       link:'MECH', tst:'HCA', sp:'SO',  tm:'TSI', dist:30000, conf:0.80, note:'Mass casualty / medical evacuation role' },
  { id:'R27', from:'train_station', to:'hospital',       link:'MECH', tst:'HCA', sp:'SO',  tm:'TCO', dist:10000, conf:0.70, note:'Casualty transport by rail' },
  { id:'R28', from:'train_station', to:'airport',        link:'MECH', tst:'HTC', sp:'SSP', tm:'TCO', dist:30000, conf:0.75, note:'Intermodal transport disruption chain' },
  // ── Telecom dependencies ──
  { id:'R29', from:'communication', to:'hospital',       link:'DEPS', tst:'HCA', sp:'SO',  tm:'TSI', dist:15000, conf:0.80, note:'Emergency coordination depends on comms' },
  { id:'R30', from:'communication', to:'fire_station',   link:'DEPS', tst:'HCA', sp:'SO',  tm:'TSI', dist:15000, conf:0.80, note:'Dispatch / radio depends on comms' },
  { id:'R31', from:'communication', to:'police',         link:'DEPS', tst:'HCA', sp:'SO',  tm:'TSI', dist:15000, conf:0.80, note:'Police dispatch comms' },
  { id:'R32', from:'communication', to:'airport',        link:'DEPS', tst:'HCA', sp:'SO',  tm:'TSI', dist:20000, conf:0.85, note:'ATC and airport comms' },
  // ── Shelter / refuge logic ──
  { id:'R33', from:'school',        to:'shelter',        link:'MECH', tst:'HPC', sp:'SO',  tm:'TCO', dist:500,   conf:0.70, note:'School often designated disaster shelter' },
  { id:'R34', from:'gymnasium',     to:'shelter',        link:'MECH', tst:'HPC', sp:'SO',  tm:'TCO', dist:200,   conf:0.75, note:'Gymnasium converted to shelter in emergency' },
  // ── Shared resource chains ──
  { id:'R35', from:'hospital',      to:'hospital',       link:'SRES', tst:'HIN', sp:'SO',  tm:'TSI', dist:10000, conf:0.70, bidir:true, note:'Shared blood supply / specialist capacity' },
  { id:'R36', from:'water',         to:'water',          link:'SRES', tst:'HTC', sp:'SSP', tm:'TCO', dist:20000, conf:0.65, bidir:true, note:'Shared watershed / interconnected network' },
  // ── Military ──
  { id:'R37', from:'military',      to:'airport',        link:'MECH', tst:'HTC', sp:'SO',  tm:'TSI', dist:20000, conf:0.75, note:'Military use of civil airport in emergency' },
  { id:'R38', from:'military',      to:'chemical_plant', link:'EXPO', tst:'HPC', sp:'SO',  tm:'TCO', dist:3000,  conf:0.70, note:'Ordnance risk to adjacent industrial' },
  // ── Vicinity pairs (proximity-based hazard amplification) ──
  { id:'R39', from:'petroleum',     to:'water',          link:'VICN', tst:'HCA', sp:'SO',  tm:'TCO', dist:1000,  conf:0.80, bidir:false, note:'Adjacent petroleum to water intake' },
  { id:'R40', from:'chemical_plant',to:'petroleum',      link:'VICN', tst:'HTC', sp:'SO',  tm:'TSI', dist:1000,  conf:0.82, bidir:true,  note:'Co-located process/storage hazard' },
];

// ── Natural hazard node templates ─────────────────────────────
// Injected based on env_context detection
const NATURAL_HAZARD_NODES = {
  flood_zone:          { name:'Flood Zone',                risk_level:'high',      affects:['hospital','water','substation','waste','chemical_plant','petroleum'] },
  landslide_zone:      { name:'Landslide Susceptibility',  risk_level:'hazardous', affects:['hospital','road_infra','train_station','communication'] },
  seismic_zone:        { name:'Seismic Hazard Zone',       risk_level:'critical',  affects:['hospital','chemical_plant','petroleum','power_plant','substation','storage_tank'] },
  coastal_surge:       { name:'Coastal Storm Surge',       risk_level:'high',      affects:['hospital','water','communication','military','airport'] },
  wind_corridor:       { name:'High Wind Corridor',        risk_level:'medium',    affects:['communication','airport','power_plant','chemical_plant'] },
  industrial_cluster:  { name:'Industrial Risk Cluster',   risk_level:'hazardous', affects:['hospital','school','water','shelter'] },
};

// Natural hazard → facility link rules
const NATURAL_RULES = [
  { env:'flood_zone',        to_cat:null, link:'EXPO', tst:'HCA', sp:'SO',  tm:'TCO', conf:0.80 },
  { env:'landslide_zone',    to_cat:null, link:'EXPO', tst:'HCA', sp:'SSP', tm:'TCO', conf:0.75 },
  { env:'seismic_zone',      to_cat:null, link:'EXPO', tst:'HTC', sp:'SO',  tm:'TSI', conf:0.85 },
  { env:'coastal_surge',     to_cat:null, link:'EXPO', tst:'HCA', sp:'SO',  tm:'TSI', conf:0.80 },
  { env:'wind_corridor',     to_cat:null, link:'EXPO', tst:'HTC', sp:'SO',  tm:'TSI', conf:0.70 },
  { env:'industrial_cluster',to_cat:null, link:'EXPO', tst:'HPC', sp:'SO',  tm:'TDI', conf:0.65 },
];

// ── Temporal overlap classification ───────────────────────────
function classifyTemporalOverlap(schedA, schedB, ruleDefault) {
  if (schedA.always_active && schedB.always_active) return 'TSI';
  if (!schedA.always_active && !schedB.always_active) {
    const sharedDays = schedA.days.filter(d => schedB.days.includes(d));
    if (!sharedDays.length) return 'TDI';
    const overlapHours = Math.min(schedA.hours[1], schedB.hours[1]) -
                         Math.max(schedA.hours[0], schedB.hours[0]);
    if (overlapHours >= 4) return 'TSI';
    if (overlapHours > 0)  return 'TCO';
    return 'TDI';
  }
  return 'TCO'; // one always-on, one part-time
}

// ── Main computation ──────────────────────────────────────────
/**
 * Compute all relationships for a set of facilities.
 * @param {Array}  facilities - array of facility rows from DB
 * @param {Object} envContext - { flood_zone: {value:'true',...}, ... }
 * @param {Array}  rulebook   - override rulebook (optional, defaults to DEFAULT_RULEBOOK)
 * @param {Object} schedules  - { facility_id: scheduleRow } per-facility overrides
 * @returns {{ nodes: [], edges: [] }}
 */
function computeRelationships(facilities, envContext = {}, rulebook = null, schedules = {}) {
  const rules = rulebook || DEFAULT_RULEBOOK;
  const nodes = [];
  const edges = [];
  const edgeSet = new Set(); // dedup

  // ── Build facility nodes ──────────────────────────────────
  for (const fac of facilities) {
    if (!fac.latitude || !fac.longitude) continue;
    nodes.push({
      id:         `fac_${fac.id}`,
      node_type:  'facility',
      entity_id:  fac.id,
      name:       fac.name || fac.category_name || fac.category,
      category:   fac.category,
      latitude:   parseFloat(fac.latitude),
      longitude:  parseFloat(fac.longitude),
      risk_level: fac.risk_level || 'medium',
      is_external:false,
      properties: { category_name: fac.category_name, source: fac.source },
    });
  }

  const facById = Object.fromEntries(nodes.map(n => [n.entity_id, n]));

  // Schedule lookup: per-facility override → type default
  function getSchedule(fac) {
    const override = schedules[fac.id];
    if (override) return override.hours_json;
    return DEFAULT_SCHEDULES[fac.category] ||
           { hours:[0,24], days:[0,1,2,3,4,5,6], peak_occ:1.0, always_active:true };
  }

  // ── Phase 1 + 2: Geometry filter + rulebook match ─────────
  const facList = facilities.filter(f => f.latitude && f.longitude);

  for (let i = 0; i < facList.length; i++) {
    for (let j = 0; j < facList.length; j++) {
      if (i === j) continue;
      const a = facList[i], b = facList[j];

      // Find matching rules for this category pair
      const matching = rules.filter(r =>
        r.from === a.category && r.to === b.category
      );
      if (!matching.length) continue;

      const distM = haversine(
        parseFloat(a.latitude), parseFloat(a.longitude),
        parseFloat(b.latitude), parseFloat(b.longitude)
      );

      for (const rule of matching) {
        if (distM > rule.dist) continue; // outside threshold

        // Skip duplicate undirected edges
        const edgeKey = rule.bidir
          ? [rule.id, [a.id, b.id].sort().join('_')].join('_')
          : `${rule.id}_${a.id}_${b.id}`;
        if (edgeSet.has(edgeKey)) continue;
        edgeSet.add(edgeKey);

        // Temporal classification
        const schedA = getSchedule(a);
        const schedB = getSchedule(b);
        const temporal = classifyTemporalOverlap(schedA, schedB, rule.tm);

        // Spatial classification based on distance
        let spatial = rule.sp;
        if (distM < 200) spatial = 'SO';
        else if (distM < 2000) spatial = spatial || 'SO';

        edges.push({
          id:              `edge_${uuidv4()}`,
          from_node:       `fac_${a.id}`,
          to_node:         `fac_${b.id}`,
          link_type:       rule.link,
          tst_type:        rule.tst,
          tst_spatial:     spatial,
          tst_temporal:    temporal,
          is_bidirectional: rule.bidir ? 1 : 0,
          distance_m:      Math.round(distM),
          confidence:      rule.conf,
          rule_id:         rule.id,
          source:          'auto',
          notes:           rule.note,
          properties: {
            from_category: a.category,
            to_category:   b.category,
            peak_occ_a:    schedA.peak_occ,
            peak_occ_b:    schedB.peak_occ,
          },
        });
      }
    }
  }

  // ── Phase 3: Natural hazard nodes ────────────────────────
  const activeEnvs = Object.entries(envContext)
    .filter(([, v]) => v?.value === 'true' || v?.value === true)
    .map(([k]) => k);

  for (const envKey of activeEnvs) {
    const template = NATURAL_HAZARD_NODES[envKey];
    if (!template) continue;

    // Place natural hazard node at bbox centroid (approximate)
    const lats = facList.map(f => parseFloat(f.latitude));
    const lngs = facList.map(f => parseFloat(f.longitude));
    const cLat  = lats.length ? (Math.min(...lats) + Math.max(...lats)) / 2 : 0;
    const cLng  = lngs.length ? (Math.min(...lngs) + Math.max(...lngs)) / 2 : 0;

    const natNode = {
      id:         `nat_${envKey}`,
      node_type:  'natural_hazard',
      entity_id:  null,
      name:       template.name,
      category:   envKey,
      latitude:   cLat,
      longitude:  cLng,
      risk_level: template.risk_level,
      is_external: true,
      properties: { env_key: envKey },
    };
    nodes.push(natNode);

    // Connect to affected facility types
    const natRule = NATURAL_RULES.find(r => r.env === envKey);
    if (!natRule) continue;

    for (const fac of facList) {
      if (!template.affects.includes(fac.category)) continue;
      const edgeKey = `nat_${envKey}_${fac.id}`;
      if (edgeSet.has(edgeKey)) continue;
      edgeSet.add(edgeKey);

      edges.push({
        id:              `edge_${uuidv4()}`,
        from_node:       `nat_${envKey}`,
        to_node:         `fac_${fac.id}`,
        link_type:       natRule.link,
        tst_type:        natRule.tst,
        tst_spatial:     natRule.sp,
        tst_temporal:    natRule.tm,
        is_bidirectional:0,
        distance_m:      null,
        confidence:      natRule.conf,
        rule_id:         `NAT_${envKey}`,
        source:          'auto',
        notes:           `${template.name} exposure to ${fac.category}`,
        properties:      { env_key: envKey },
      });
    }
  }

  return { nodes, edges };
}

// ── Compute graph metrics (centrality, risk score) ────────────
function computeGraphMetrics(nodes, edges) {
  const metrics = {};

  for (const n of nodes) {
    metrics[n.id] = { degree: 0, in_degree: 0, out_degree: 0,
                      betweenness: 0, risk_score: 0, dep_depth: 0 };
  }

  for (const e of edges) {
    if (metrics[e.from_node]) {
      metrics[e.from_node].out_degree++;
      metrics[e.from_node].degree++;
    }
    if (metrics[e.to_node]) {
      metrics[e.to_node].in_degree++;
      metrics[e.to_node].degree++;
    }
  }

  // Risk score: intrinsic level × incoming cascading links
  const RISK_WEIGHTS = { critical:5, hazardous:4, high:3, medium:2, low:1 };
  for (const n of nodes) {
    const rw = RISK_WEIGHTS[n.risk_level] || 2;
    const cascIn = edges.filter(e => e.to_node === n.id && e.tst_type === 'HCA').length;
    const exposIn = edges.filter(e => e.to_node === n.id && e.link_type === 'EXPO').length;
    metrics[n.id].risk_score = rw * (1 + cascIn * 0.4 + exposIn * 0.2);
  }

  // Dependency depth: BFS from each node following DEPS edges
  const depEdges = edges.filter(e => e.link_type === 'DEPS' || e.link_type === 'MECH');
  for (const n of nodes) {
    let depth = 0, frontier = [n.id], visited = new Set([n.id]);
    while (frontier.length) {
      const next = [];
      for (const nid of frontier) {
        for (const e of depEdges) {
          if (e.to_node === nid && !visited.has(e.from_node)) {
            visited.add(e.from_node); next.push(e.from_node);
          }
        }
      }
      if (next.length) depth++;
      frontier = next;
    }
    metrics[n.id].dep_depth = depth;
  }

  return metrics;
}

module.exports = {
  computeRelationships,
  computeGraphMetrics,
  DEFAULT_RULEBOOK,
  DEFAULT_SCHEDULES,
  NATURAL_HAZARD_NODES,
  haversine,
};
