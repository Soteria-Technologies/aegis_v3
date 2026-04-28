/**
 * AEGIS V3 — Relationship Engine
 * Computes facility-to-facility, infrastructure-to-facility, and
 * natural-hazard-to-facility relationships.
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
 *
 * Link types:
 *   DEPS = A provides a critical service that B depends on
 *   MECH = A is the operative mechanism enabling B's function
 *   EXPO = A failure creates a physical exposure hazard for B
 *   VICN = Co-location creates mutual hazard amplification
 *   SRES = A and B share a common resource pool
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

// ── Default facility & infrastructure schedules ───────────────
// hours: [open, close] 24h clock, days: 0=Sun … 6=Sat
const DEFAULT_SCHEDULES = {
  // ── Facilities ──
  hospital:         { hours:[0,24],  days:[0,1,2,3,4,5,6], peak_occ:1.0,  always_active:true  },
  clinic:           { hours:[8,19],  days:[1,2,3,4,5],      peak_occ:0.85, always_active:false },
  fire_station:     { hours:[0,24],  days:[0,1,2,3,4,5,6], peak_occ:1.0,  always_active:true  },
  police:           { hours:[0,24],  days:[0,1,2,3,4,5,6], peak_occ:1.0,  always_active:true  },
  school:           { hours:[8,17],  days:[1,2,3,4,5],      peak_occ:0.90, always_active:false },
  gymnasium:        { hours:[7,22],  days:[0,1,2,3,4,5,6], peak_occ:0.60, always_active:false },
  shelter:          { hours:[0,24],  days:[0,1,2,3,4,5,6], peak_occ:0.80, always_active:true  },
  power_plant:      { hours:[0,24],  days:[0,1,2,3,4,5,6], peak_occ:1.0,  always_active:true  },
  substation:       { hours:[0,24],  days:[0,1,2,3,4,5,6], peak_occ:1.0,  always_active:true  },
  chemical_plant:   { hours:[6,22],  days:[1,2,3,4,5],      peak_occ:0.90, always_active:false },
  petroleum:        { hours:[0,24],  days:[0,1,2,3,4,5,6], peak_occ:0.90, always_active:true  },
  waste:            { hours:[6,20],  days:[1,2,3,4,5,6],   peak_occ:0.70, always_active:false },
  water:            { hours:[0,24],  days:[0,1,2,3,4,5,6], peak_occ:1.0,  always_active:true  },
  airport:          { hours:[4,24],  days:[0,1,2,3,4,5,6], peak_occ:0.85, always_active:true  },
  train_station:    { hours:[5,24],  days:[0,1,2,3,4,5,6], peak_occ:0.80, always_active:false },
  communication:    { hours:[0,24],  days:[0,1,2,3,4,5,6], peak_occ:1.0,  always_active:true  },
  military:         { hours:[0,24],  days:[0,1,2,3,4,5,6], peak_occ:1.0,  always_active:true  },
  storage_tank:     { hours:[0,24],  days:[0,1,2,3,4,5,6], peak_occ:1.0,  always_active:true  },
  // ── Infrastructure nodes ──
  road_infra:       { hours:[0,24],  days:[0,1,2,3,4,5,6], peak_occ:1.0,  always_active:true  },
  bridge:           { hours:[0,24],  days:[0,1,2,3,4,5,6], peak_occ:1.0,  always_active:true  },
  dam:              { hours:[0,24],  days:[0,1,2,3,4,5,6], peak_occ:1.0,  always_active:true  },
  pipeline:         { hours:[0,24],  days:[0,1,2,3,4,5,6], peak_occ:1.0,  always_active:true  },
  fuel_storage:     { hours:[0,24],  days:[0,1,2,3,4,5,6], peak_occ:0.90, always_active:true  },
  port:             { hours:[6,22],  days:[0,1,2,3,4,5,6], peak_occ:0.80, always_active:false },
  nuclear:          { hours:[0,24],  days:[0,1,2,3,4,5,6], peak_occ:1.0,  always_active:true  },
  railway:          { hours:[5,23],  days:[0,1,2,3,4,5,6], peak_occ:0.75, always_active:false },
  electricity_tower:{ hours:[0,24],  days:[0,1,2,3,4,5,6], peak_occ:1.0,  always_active:true  },
  water_tower:      { hours:[0,24],  days:[0,1,2,3,4,5,6], peak_occ:1.0,  always_active:true  },
  telecom_tower:    { hours:[0,24],  days:[0,1,2,3,4,5,6], peak_occ:1.0,  always_active:true  },
  pumping_station:  { hours:[0,24],  days:[0,1,2,3,4,5,6], peak_occ:1.0,  always_active:true  },
  cooling_tower:    { hours:[0,24],  days:[0,1,2,3,4,5,6], peak_occ:1.0,  always_active:true  },
};

// ── Default rulebook ──────────────────────────────────────────
// Fields: id, from, to, link, tst, sp, tm, dist (m), conf [0-1], bidir, note
// sp  → SSP=same system path, SO=spatial overlap
// tm  → TSI=simultaneous, TCO=concurrent, TDI=delayed independent
const DEFAULT_RULEBOOK = [

  // ════════════════════════════════════════════
  // BLOCK A — Power grid dependencies
  // ════════════════════════════════════════════
  { id:'R01', from:'power_plant',      to:'substation',        link:'DEPS', tst:'HCA', sp:'SSP', tm:'TSI', dist:50000, conf:0.90, note:'Power transmission from plant to distribution node' },
  { id:'R02', from:'substation',       to:'hospital',          link:'DEPS', tst:'HCA', sp:'SO',  tm:'TSI', dist:10000, conf:0.92, note:'Hospital power grid dependency' },
  { id:'R03', from:'substation',       to:'water',             link:'DEPS', tst:'HCA', sp:'SO',  tm:'TSI', dist:8000,  conf:0.88, note:'Pump station power feed' },
  { id:'R04', from:'substation',       to:'communication',     link:'DEPS', tst:'HCA', sp:'SO',  tm:'TSI', dist:12000, conf:0.85, note:'Telecom node power feed' },
  { id:'R05', from:'substation',       to:'fire_station',      link:'DEPS', tst:'HCA', sp:'SO',  tm:'TSI', dist:8000,  conf:0.80, note:'Emergency services power supply' },
  { id:'R06', from:'substation',       to:'police',            link:'DEPS', tst:'HCA', sp:'SO',  tm:'TSI', dist:8000,  conf:0.80, note:'Police station power supply' },
  { id:'R07', from:'substation',       to:'train_station',     link:'DEPS', tst:'HCA', sp:'SSP', tm:'TSI', dist:15000, conf:0.85, note:'Electric rail traction power' },
  { id:'R08', from:'substation',       to:'airport',           link:'DEPS', tst:'HCA', sp:'SO',  tm:'TSI', dist:20000, conf:0.82, note:'Airport electrical infrastructure' },
  { id:'R09', from:'substation',       to:'military',          link:'DEPS', tst:'HCA', sp:'SO',  tm:'TSI', dist:15000, conf:0.78, note:'Military base power grid' },
  { id:'R10', from:'substation',       to:'shelter',           link:'DEPS', tst:'HCA', sp:'SO',  tm:'TSI', dist:5000,  conf:0.75, note:'Shelter electrical supply during emergency' },
  { id:'R11', from:'substation',       to:'school',            link:'DEPS', tst:'HCA', sp:'SO',  tm:'TSI', dist:6000,  conf:0.70, note:'School power dependency' },
  { id:'R12', from:'substation',       to:'nuclear',           link:'DEPS', tst:'HCA', sp:'SO',  tm:'TSI', dist:20000, conf:0.88, note:'Grid power to nuclear auxiliary systems' },
  { id:'R13', from:'electricity_tower',to:'substation',        link:'DEPS', tst:'HCA', sp:'SSP', tm:'TSI', dist:80000, conf:0.88, note:'Transmission tower routes power to substation' },
  { id:'R14', from:'electricity_tower',to:'power_plant',       link:'DEPS', tst:'HCA', sp:'SSP', tm:'TSI', dist:80000, conf:0.85, note:'Tower failure disrupts generation output path' },
  { id:'R15', from:'power_plant',      to:'electricity_tower', link:'DEPS', tst:'HCA', sp:'SSP', tm:'TSI', dist:80000, conf:0.85, note:'Generation output requires tower network' },
  { id:'R16', from:'substation',       to:'pumping_station',   link:'DEPS', tst:'HCA', sp:'SO',  tm:'TSI', dist:10000, conf:0.88, note:'Pumping station requires electrical power' },
  { id:'R17', from:'substation',       to:'cooling_tower',     link:'DEPS', tst:'HCA', sp:'SO',  tm:'TSI', dist:5000,  conf:0.85, note:'Cooling systems require grid power' },

  // ════════════════════════════════════════════
  // BLOCK B — Water supply chain
  // ════════════════════════════════════════════
  { id:'R18', from:'water',            to:'hospital',          link:'DEPS', tst:'HCA', sp:'SO',  tm:'TCO', dist:5000,  conf:0.90, note:'Medical water supply dependency' },
  { id:'R19', from:'water',            to:'clinic',            link:'DEPS', tst:'HCA', sp:'SO',  tm:'TCO', dist:4000,  conf:0.80, note:'Clinical water supply' },
  { id:'R20', from:'water',            to:'shelter',           link:'DEPS', tst:'HCA', sp:'SO',  tm:'TCO', dist:5000,  conf:0.75, note:'Shelter potable water supply' },
  { id:'R21', from:'water',            to:'school',            link:'DEPS', tst:'HCA', sp:'SO',  tm:'TDI', dist:3000,  conf:0.70, note:'School water supply dependency' },
  { id:'R22', from:'water',            to:'fire_station',      link:'DEPS', tst:'HCA', sp:'SO',  tm:'TSI', dist:5000,  conf:0.80, note:'Firefighting water supply' },
  { id:'R23', from:'water_tower',      to:'hospital',          link:'DEPS', tst:'HCA', sp:'SSP', tm:'TSI', dist:8000,  conf:0.85, note:'Pressurized water delivery to hospital' },
  { id:'R24', from:'water_tower',      to:'fire_station',      link:'DEPS', tst:'HCA', sp:'SSP', tm:'TSI', dist:6000,  conf:0.85, note:'Water tower feeds fire hydrant pressure' },
  { id:'R25', from:'water_tower',      to:'shelter',           link:'DEPS', tst:'HCA', sp:'SSP', tm:'TCO', dist:5000,  conf:0.78, note:'Emergency water storage for shelter' },
  { id:'R26', from:'water_tower',      to:'water',             link:'DEPS', tst:'HCA', sp:'SSP', tm:'TSI', dist:15000, conf:0.80, note:'Tower is part of water distribution network' },
  { id:'R27', from:'pumping_station',  to:'water',             link:'DEPS', tst:'HCA', sp:'SSP', tm:'TSI', dist:20000, conf:0.88, note:'Pumping station drives water network pressure' },
  { id:'R28', from:'pumping_station',  to:'hospital',          link:'DEPS', tst:'HCA', sp:'SSP', tm:'TSI', dist:10000, conf:0.80, note:'Pump failure interrupts hospital water' },
  { id:'R29', from:'dam',              to:'water',             link:'DEPS', tst:'HCA', sp:'SSP', tm:'TCO', dist:100000,conf:0.85, note:'Dam regulates catchment water supply' },
  { id:'R30', from:'dam',              to:'power_plant',       link:'DEPS', tst:'HCA', sp:'SSP', tm:'TSI', dist:100000,conf:0.80, note:'Hydroelectric dam as generation source' },

  // ════════════════════════════════════════════
  // BLOCK C — Emergency services coverage
  // ════════════════════════════════════════════
  { id:'R31', from:'fire_station',     to:'hospital',          link:'MECH', tst:'HCA', sp:'SO',  tm:'TSI', dist:5000,  conf:0.85, note:'First responder rapid access to hospital' },
  { id:'R32', from:'fire_station',     to:'chemical_plant',    link:'MECH', tst:'HCA', sp:'SO',  tm:'TSI', dist:8000,  conf:0.90, note:'Hazmat fire response to chemical facility' },
  { id:'R33', from:'fire_station',     to:'petroleum',         link:'MECH', tst:'HCA', sp:'SO',  tm:'TSI', dist:8000,  conf:0.90, note:'Fire response to petroleum site' },
  { id:'R34', from:'fire_station',     to:'nuclear',           link:'MECH', tst:'HCA', sp:'SO',  tm:'TSI', dist:10000, conf:0.88, note:'Radiological fire response to nuclear facility' },
  { id:'R35', from:'fire_station',     to:'fuel_storage',      link:'MECH', tst:'HCA', sp:'SO',  tm:'TSI', dist:6000,  conf:0.85, note:'Fire response to fuel depot' },
  { id:'R36', from:'fire_station',     to:'shelter',           link:'MECH', tst:'HCA', sp:'SO',  tm:'TCO', dist:5000,  conf:0.78, note:'Fire station supports shelter in emergency' },
  { id:'R37', from:'fire_station',     to:'port',              link:'MECH', tst:'HCA', sp:'SO',  tm:'TSI', dist:10000, conf:0.80, note:'Port fire and rescue coverage' },
  { id:'R38', from:'police',           to:'hospital',          link:'MECH', tst:'HCA', sp:'SO',  tm:'TSI', dist:5000,  conf:0.75, note:'Security and crowd control at medical facility' },
  { id:'R39', from:'police',           to:'shelter',           link:'MECH', tst:'HCA', sp:'SO',  tm:'TCO', dist:5000,  conf:0.75, note:'Security provision at emergency shelters' },
  { id:'R40', from:'police',           to:'nuclear',           link:'MECH', tst:'HCA', sp:'SO',  tm:'TSI', dist:8000,  conf:0.80, note:'Security perimeter for nuclear facility' },
  { id:'R41', from:'hospital',         to:'clinic',            link:'SRES', tst:'HCA', sp:'SO',  tm:'TSI', dist:10000, conf:0.70, bidir:true, note:'Patient overflow and resource sharing' },
  { id:'R42', from:'clinic',           to:'hospital',          link:'DEPS', tst:'HCA', sp:'SO',  tm:'TCO', dist:10000, conf:0.72, note:'Critical case referral from clinic to hospital' },

  // ════════════════════════════════════════════
  // BLOCK D — Chemical, petroleum, exposure chains
  // ════════════════════════════════════════════
  { id:'R43', from:'chemical_plant',   to:'water',             link:'EXPO', tst:'HCA', sp:'SSP', tm:'TCO', dist:5000,  conf:0.90, note:'Chemical spill contaminates water source' },
  { id:'R44', from:'chemical_plant',   to:'hospital',          link:'EXPO', tst:'HCA', sp:'SO',  tm:'TSI', dist:3000,  conf:0.85, note:'Toxic release triggers mass casualties at hospital' },
  { id:'R45', from:'chemical_plant',   to:'school',            link:'EXPO', tst:'HCA', sp:'SO',  tm:'TSI', dist:2000,  conf:0.88, note:'Child vulnerability within toxic release zone' },
  { id:'R46', from:'chemical_plant',   to:'shelter',           link:'EXPO', tst:'HCA', sp:'SO',  tm:'TSI', dist:3000,  conf:0.82, note:'Toxic plume threatens shelter occupants' },
  { id:'R47', from:'chemical_plant',   to:'petroleum',         link:'VICN', tst:'HTC', sp:'SO',  tm:'TSI', dist:1000,  conf:0.82, bidir:true, note:'Co-located process and storage — ignition chain' },
  { id:'R48', from:'petroleum',        to:'water',             link:'EXPO', tst:'HCA', sp:'SSP', tm:'TCO', dist:5000,  conf:0.88, note:'Oil spill to water treatment input' },
  { id:'R49', from:'petroleum',        to:'hospital',          link:'EXPO', tst:'HCA', sp:'SO',  tm:'TSI', dist:2000,  conf:0.80, note:'Petroleum fire blast/vapour cloud to hospital' },
  { id:'R50', from:'petroleum',        to:'chemical_plant',    link:'VICN', tst:'HTC', sp:'SO',  tm:'TSI', dist:1000,  conf:0.82, bidir:true, note:'Adjacent petroleum amplifies chemical process risk' },
  { id:'R51', from:'petroleum',        to:'water',             link:'VICN', tst:'HCA', sp:'SO',  tm:'TCO', dist:1000,  conf:0.80, note:'Adjacent petroleum to water intake' },
  { id:'R52', from:'storage_tank',     to:'hospital',          link:'EXPO', tst:'HCA', sp:'SO',  tm:'TSI', dist:2000,  conf:0.80, note:'Tank failure blast / toxic cloud reaches hospital' },
  { id:'R53', from:'storage_tank',     to:'chemical_plant',    link:'VICN', tst:'HTC', sp:'SO',  tm:'TSI', dist:800,   conf:0.82, bidir:true, note:'Co-located storage and process hazard cluster' },
  { id:'R54', from:'storage_tank',     to:'water',             link:'EXPO', tst:'HCA', sp:'SSP', tm:'TCO', dist:3000,  conf:0.78, note:'Tank spill leaches to groundwater / surface water' },

  // ════════════════════════════════════════════
  // BLOCK E — Pipeline infrastructure
  // ════════════════════════════════════════════
  { id:'R55', from:'pipeline',         to:'chemical_plant',    link:'DEPS', tst:'HCA', sp:'SSP', tm:'TSI', dist:20000, conf:0.85, note:'Pipeline supplies feedstock to chemical plant' },
  { id:'R56', from:'pipeline',         to:'petroleum',         link:'DEPS', tst:'HCA', sp:'SSP', tm:'TSI', dist:20000, conf:0.88, note:'Pipeline transports crude / refined products' },
  { id:'R57', from:'pipeline',         to:'power_plant',       link:'DEPS', tst:'HCA', sp:'SSP', tm:'TSI', dist:30000, conf:0.85, note:'Gas pipeline fuels gas-fired power station' },
  { id:'R58', from:'pipeline',         to:'water',             link:'EXPO', tst:'HCA', sp:'SSP', tm:'TCO', dist:2000,  conf:0.82, note:'Pipeline rupture / leak contaminates water supply' },
  { id:'R59', from:'pipeline',         to:'hospital',          link:'EXPO', tst:'HCA', sp:'SO',  tm:'TSI', dist:1000,  conf:0.80, note:'Pipeline rupture fire/explosion threatens hospital' },
  { id:'R60', from:'pipeline',         to:'school',            link:'EXPO', tst:'HCA', sp:'SO',  tm:'TSI', dist:800,   conf:0.82, note:'Pipeline rupture within school proximity' },
  { id:'R61', from:'pipeline',         to:'shelter',           link:'EXPO', tst:'HCA', sp:'SO',  tm:'TSI', dist:1000,  conf:0.78, note:'Pipeline rupture endangers emergency shelter' },
  { id:'R62', from:'pipeline',         to:'fuel_storage',      link:'DEPS', tst:'HCA', sp:'SSP', tm:'TSI', dist:15000, conf:0.82, note:'Pipeline fills fuel storage depot' },

  // ════════════════════════════════════════════
  // BLOCK F — Fuel storage
  // ════════════════════════════════════════════
  { id:'R63', from:'fuel_storage',     to:'airport',           link:'DEPS', tst:'HCA', sp:'SSP', tm:'TSI', dist:10000, conf:0.90, note:'Aviation fuel supply critical to airport ops' },
  { id:'R64', from:'fuel_storage',     to:'hospital',          link:'DEPS', tst:'HCA', sp:'SSP', tm:'TCO', dist:10000, conf:0.80, note:'Generator fuel for hospital backup power' },
  { id:'R65', from:'fuel_storage',     to:'military',          link:'DEPS', tst:'HCA', sp:'SSP', tm:'TSI', dist:15000, conf:0.85, note:'Military operational fuel supply' },
  { id:'R66', from:'fuel_storage',     to:'fire_station',      link:'DEPS', tst:'HCA', sp:'SSP', tm:'TSI', dist:8000,  conf:0.80, note:'Emergency vehicle fuel supply from depot' },
  { id:'R67', from:'fuel_storage',     to:'water',             link:'EXPO', tst:'HCA', sp:'SSP', tm:'TCO', dist:2000,  conf:0.82, note:'Fuel spill to surface / groundwater source' },
  { id:'R68', from:'fuel_storage',     to:'chemical_plant',    link:'VICN', tst:'HTC', sp:'SO',  tm:'TSI', dist:1000,  conf:0.80, bidir:true, note:'Co-located fuel and chemical — ignition chain' },
  { id:'R69', from:'fuel_storage',     to:'substation',        link:'DEPS', tst:'HCA', sp:'SSP', tm:'TCO', dist:5000,  conf:0.75, note:'Substation backup generator fuel supply' },
  { id:'R70', from:'fuel_storage',     to:'shelter',           link:'DEPS', tst:'HCA', sp:'SSP', tm:'TCO', dist:8000,  conf:0.72, note:'Generator fuel for shelter emergency power' },

  // ════════════════════════════════════════════
  // BLOCK G — Transport infrastructure
  // ════════════════════════════════════════════
  { id:'R71', from:'road_infra',       to:'hospital',          link:'MECH', tst:'HCA', sp:'SSP', tm:'TSI', dist:3000,  conf:0.88, note:'Primary road access for ambulances and patients' },
  { id:'R72', from:'road_infra',       to:'fire_station',      link:'MECH', tst:'HCA', sp:'SSP', tm:'TSI', dist:3000,  conf:0.88, note:'Fire engine response route' },
  { id:'R73', from:'road_infra',       to:'shelter',           link:'MECH', tst:'HCA', sp:'SSP', tm:'TCO', dist:2000,  conf:0.85, note:'Evacuation route to shelter' },
  { id:'R74', from:'road_infra',       to:'airport',           link:'MECH', tst:'HTC', sp:'SSP', tm:'TCO', dist:5000,  conf:0.82, note:'Ground access road to airport terminal' },
  { id:'R75', from:'road_infra',       to:'school',            link:'MECH', tst:'HCA', sp:'SSP', tm:'TCO', dist:2000,  conf:0.78, note:'Evacuation and access route for school' },
  { id:'R76', from:'road_infra',       to:'train_station',     link:'MECH', tst:'HTC', sp:'SSP', tm:'TCO', dist:3000,  conf:0.80, note:'Road intermodal access to rail station' },
  { id:'R77', from:'road_infra',       to:'military',          link:'MECH', tst:'HCA', sp:'SSP', tm:'TSI', dist:5000,  conf:0.82, note:'Military convoy and logistics route' },
  { id:'R78', from:'road_infra',       to:'port',              link:'MECH', tst:'HCA', sp:'SSP', tm:'TCO', dist:5000,  conf:0.80, note:'Road access for port freight and personnel' },
  { id:'R79', from:'bridge',           to:'hospital',          link:'MECH', tst:'HCA', sp:'SSP', tm:'TSI', dist:5000,  conf:0.90, note:'Bridge on critical hospital access route' },
  { id:'R80', from:'bridge',           to:'fire_station',      link:'MECH', tst:'HCA', sp:'SSP', tm:'TSI', dist:5000,  conf:0.88, note:'Bridge on emergency response route' },
  { id:'R81', from:'bridge',           to:'train_station',     link:'MECH', tst:'HCA', sp:'SSP', tm:'TCO', dist:8000,  conf:0.85, note:'Rail bridge carrying trains to station' },
  { id:'R82', from:'bridge',           to:'road_infra',        link:'DEPS', tst:'HCA', sp:'SSP', tm:'TSI', dist:5000,  conf:0.88, note:'Road bridge as critical link in road network' },
  { id:'R83', from:'bridge',           to:'shelter',           link:'MECH', tst:'HCA', sp:'SSP', tm:'TCO', dist:5000,  conf:0.82, note:'Bridge on evacuation corridor to shelter' },
  { id:'R84', from:'railway',          to:'train_station',     link:'DEPS', tst:'HCA', sp:'SSP', tm:'TSI', dist:30000, conf:0.90, note:'Track serves station — track failure halts service' },
  { id:'R85', from:'railway',          to:'bridge',            link:'DEPS', tst:'HCA', sp:'SSP', tm:'TSI', dist:10000, conf:0.82, note:'Railway runs on bridges — bridge failure halts rail' },
  { id:'R86', from:'railway',          to:'airport',           link:'MECH', tst:'HTC', sp:'SSP', tm:'TCO', dist:20000, conf:0.75, note:'Rail link to airport — intermodal disruption' },
  { id:'R87', from:'train_station',    to:'hospital',          link:'MECH', tst:'HCA', sp:'SO',  tm:'TCO', dist:10000, conf:0.70, note:'Mass casualty rail transport to hospital' },
  { id:'R88', from:'train_station',    to:'airport',           link:'MECH', tst:'HTC', sp:'SSP', tm:'TCO', dist:30000, conf:0.75, note:'Intermodal disruption chain' },
  { id:'R89', from:'train_station',    to:'shelter',           link:'MECH', tst:'HPC', sp:'SO',  tm:'TCO', dist:2000,  conf:0.68, note:'Station as temporary shelter hub' },
  { id:'R90', from:'airport',          to:'hospital',          link:'MECH', tst:'HCA', sp:'SO',  tm:'TSI', dist:30000, conf:0.80, note:'Medical evacuation and mass casualty air transport' },
  { id:'R91', from:'airport',          to:'military',          link:'MECH', tst:'HTC', sp:'SO',  tm:'TSI', dist:20000, conf:0.75, note:'Military use of civil airport in emergency' },
  { id:'R92', from:'port',             to:'hospital',          link:'MECH', tst:'HCA', sp:'SO',  tm:'TCO', dist:15000, conf:0.72, note:'Port as entry point for disaster relief supplies' },
  { id:'R93', from:'port',             to:'military',          link:'MECH', tst:'HTC', sp:'SO',  tm:'TSI', dist:20000, conf:0.78, note:'Strategic naval/logistics asset' },
  { id:'R94', from:'port',             to:'petroleum',         link:'VICN', tst:'HTC', sp:'SO',  tm:'TCO', dist:3000,  conf:0.80, note:'Fuel terminal proximity — spill and fire risk' },
  { id:'R95', from:'port',             to:'chemical_plant',    link:'VICN', tst:'HTC', sp:'SO',  tm:'TCO', dist:5000,  conf:0.78, note:'Chemical import/export — spill and fire chain' },
  { id:'R96', from:'port',             to:'water',             link:'EXPO', tst:'HCA', sp:'SO',  tm:'TCO', dist:3000,  conf:0.75, note:'Port fuel/chemical spill to coastal water intake' },

  // ════════════════════════════════════════════
  // BLOCK H — Telecom infrastructure
  // ════════════════════════════════════════════
  { id:'R97', from:'telecom_tower',    to:'communication',     link:'DEPS', tst:'HCA', sp:'SSP', tm:'TSI', dist:30000, conf:0.88, note:'Tower provides backbone to local comms node' },
  { id:'R98', from:'telecom_tower',    to:'hospital',          link:'DEPS', tst:'HCA', sp:'SSP', tm:'TSI', dist:20000, conf:0.82, note:'Emergency coordination telecoms for hospital' },
  { id:'R99', from:'telecom_tower',    to:'fire_station',      link:'DEPS', tst:'HCA', sp:'SSP', tm:'TSI', dist:20000, conf:0.82, note:'Radio dispatch via tower for fire services' },
  { id:'R100',from:'telecom_tower',    to:'military',          link:'DEPS', tst:'HCA', sp:'SSP', tm:'TSI', dist:30000, conf:0.85, note:'Military secure comms via tower' },
  { id:'R101',from:'electricity_tower',to:'telecom_tower',     link:'DEPS', tst:'HCA', sp:'SO',  tm:'TSI', dist:5000,  conf:0.75, note:'Tower co-location — power tower carries telecom lines' },
  { id:'R102',from:'communication',    to:'hospital',          link:'DEPS', tst:'HCA', sp:'SO',  tm:'TSI', dist:15000, conf:0.80, note:'Emergency coordination depends on comms node' },
  { id:'R103',from:'communication',    to:'fire_station',      link:'DEPS', tst:'HCA', sp:'SO',  tm:'TSI', dist:15000, conf:0.80, note:'Dispatch and radio rely on comms node' },
  { id:'R104',from:'communication',    to:'police',            link:'DEPS', tst:'HCA', sp:'SO',  tm:'TSI', dist:15000, conf:0.80, note:'Police dispatch and surveillance comms' },
  { id:'R105',from:'communication',    to:'airport',           link:'DEPS', tst:'HCA', sp:'SO',  tm:'TSI', dist:20000, conf:0.85, note:'ATC and airport operations comms dependency' },

  // ════════════════════════════════════════════
  // BLOCK I — Dam and water body risks
  // ════════════════════════════════════════════
  { id:'R106',from:'dam',              to:'hospital',          link:'EXPO', tst:'HCA', sp:'SO',  tm:'TSI', dist:30000, conf:0.85, note:'Dam breach — downstream flood inundates hospital' },
  { id:'R107',from:'dam',              to:'chemical_plant',    link:'EXPO', tst:'HCA', sp:'SSP', tm:'TSI', dist:30000, conf:0.88, note:'Dam breach flood reaches chemical plant' },
  { id:'R108',from:'dam',              to:'shelter',           link:'EXPO', tst:'HCA', sp:'SO',  tm:'TSI', dist:20000, conf:0.82, note:'Downstream shelter inundated by dam breach' },
  { id:'R109',from:'dam',              to:'petroleum',         link:'EXPO', tst:'HCA', sp:'SSP', tm:'TSI', dist:20000, conf:0.85, note:'Dam breach flood ignites / disperses petroleum' },
  { id:'R110',from:'dam',              to:'military',          link:'EXPO', tst:'HCA', sp:'SO',  tm:'TSI', dist:20000, conf:0.78, note:'Flood impacts military base in downstream zone' },

  // ════════════════════════════════════════════
  // BLOCK J — Nuclear facility
  // ════════════════════════════════════════════
  { id:'R111',from:'nuclear',          to:'hospital',          link:'EXPO', tst:'HCA', sp:'SO',  tm:'TSI', dist:30000, conf:0.90, note:'Radiation release — hospital mass casualty surge' },
  { id:'R112',from:'nuclear',          to:'water',             link:'EXPO', tst:'HCA', sp:'SSP', tm:'TCO', dist:20000, conf:0.88, note:'Radioactive effluent / thermal pollution to water' },
  { id:'R113',from:'nuclear',          to:'school',            link:'EXPO', tst:'HCA', sp:'SO',  tm:'TSI', dist:15000, conf:0.90, note:'Immediate evacuation zone for school' },
  { id:'R114',from:'nuclear',          to:'shelter',           link:'MECH', tst:'HCA', sp:'SO',  tm:'TSI', dist:30000, conf:0.85, note:'Designated fallout shelter activation' },
  { id:'R115',from:'nuclear',          to:'military',          link:'VICN', tst:'HTC', sp:'SO',  tm:'TSI', dist:20000, conf:0.75, bidir:true, note:'Nuclear-military security zone co-location' },
  { id:'R116',from:'nuclear',          to:'chemical_plant',    link:'EXPO', tst:'HTC', sp:'SO',  tm:'TSI', dist:10000, conf:0.82, note:'Nuclear event triggers chemical plant evacuation zone' },
  { id:'R117',from:'nuclear',          to:'power_plant',       link:'SRES', tst:'HTC', sp:'SSP', tm:'TSI', dist:50000, conf:0.72, bidir:true, note:'Nuclear IS a power plant — grid and cooling interdependency' },

  // ════════════════════════════════════════════
  // BLOCK K — Cooling tower
  // ════════════════════════════════════════════
  { id:'R118',from:'cooling_tower',    to:'power_plant',       link:'DEPS', tst:'HCA', sp:'SO',  tm:'TSI', dist:2000,  conf:0.92, note:'Cooling failure triggers power plant shutdown' },
  { id:'R119',from:'cooling_tower',    to:'nuclear',           link:'DEPS', tst:'HCA', sp:'SO',  tm:'TSI', dist:2000,  conf:0.95, note:'Cooling failure is primary nuclear safety risk' },
  { id:'R120',from:'cooling_tower',    to:'chemical_plant',    link:'DEPS', tst:'HCA', sp:'SO',  tm:'TSI', dist:3000,  conf:0.85, note:'Process cooling dependency for chemical plant' },
  { id:'R121',from:'water',            to:'cooling_tower',     link:'DEPS', tst:'HCA', sp:'SSP', tm:'TSI', dist:10000, conf:0.90, note:'Cooling tower requires continuous water supply' },

  // ════════════════════════════════════════════
  // BLOCK L — Waste and environmental degradation
  // ════════════════════════════════════════════
  { id:'R122',from:'waste',            to:'water',             link:'EXPO', tst:'HPC', sp:'SSP', tm:'TDI', dist:3000,  conf:0.75, note:'Leachate contaminates groundwater over time' },
  { id:'R123',from:'waste',            to:'hospital',          link:'EXPO', tst:'HPC', sp:'SO',  tm:'TDI', dist:2000,  conf:0.65, note:'Long-term air and water quality impact on patients' },
  { id:'R124',from:'waste',            to:'shelter',           link:'EXPO', tst:'HPC', sp:'SO',  tm:'TDI', dist:1500,  conf:0.68, note:'Waste site air quality degrades shelter habitability' },
  { id:'R125',from:'waste',            to:'school',            link:'EXPO', tst:'HPC', sp:'SO',  tm:'TDI', dist:2000,  conf:0.72, note:'Long-term pollutant exposure to children' },

  // ════════════════════════════════════════════
  // BLOCK M — Shelter and refuge logic
  // ════════════════════════════════════════════
  { id:'R126',from:'school',           to:'shelter',           link:'MECH', tst:'HPC', sp:'SO',  tm:'TCO', dist:500,   conf:0.70, note:'School often designated as disaster shelter' },
  { id:'R127',from:'gymnasium',        to:'shelter',           link:'MECH', tst:'HPC', sp:'SO',  tm:'TCO', dist:200,   conf:0.75, note:'Gymnasium converted to mass care shelter' },

  // ════════════════════════════════════════════
  // BLOCK N — Shared resource networks
  // ════════════════════════════════════════════
  { id:'R128',from:'hospital',         to:'hospital',          link:'SRES', tst:'HIN', sp:'SO',  tm:'TSI', dist:15000, conf:0.70, bidir:true, note:'Shared blood bank, specialist and ICU capacity' },
  { id:'R129',from:'water',            to:'water',             link:'SRES', tst:'HTC', sp:'SSP', tm:'TCO', dist:20000, conf:0.65, bidir:true, note:'Shared watershed or interconnected supply network' },
  { id:'R130',from:'substation',       to:'substation',        link:'SRES', tst:'HTC', sp:'SSP', tm:'TSI', dist:30000, conf:0.72, bidir:true, note:'Grid load balancing — cascade across substations' },
  { id:'R131',from:'communication',    to:'communication',     link:'SRES', tst:'HTC', sp:'SSP', tm:'TSI', dist:30000, conf:0.68, bidir:true, note:'Shared network backbone — single point of failure' },

  // ════════════════════════════════════════════
  // BLOCK O — Military interdependencies
  // ════════════════════════════════════════════
  { id:'R132',from:'military',         to:'chemical_plant',    link:'EXPO', tst:'HPC', sp:'SO',  tm:'TCO', dist:3000,  conf:0.70, note:'Ordnance risk and security incident to adjacent industrial' },
  { id:'R133',from:'military',         to:'airport',           link:'MECH', tst:'HTC', sp:'SO',  tm:'TSI', dist:20000, conf:0.75, note:'Military commandeers civil airport in emergency' },
  { id:'R134',from:'military',         to:'port',              link:'MECH', tst:'HTC', sp:'SO',  tm:'TSI', dist:20000, conf:0.78, note:'Military logistics via civilian port' },
  { id:'R135',from:'military',         to:'road_infra',        link:'MECH', tst:'HCA', sp:'SSP', tm:'TSI', dist:5000,  conf:0.75, note:'Military controls / blocks road access in emergency' },
];

// ── Natural hazard node templates ─────────────────────────────
// Injected as virtual nodes based on env_context detection.
// 'affects' lists categories that receive an EXPO edge from this hazard node.
const NATURAL_HAZARD_NODES = {
  flood_zone:        {
    name:'Flood Zone',
    risk_level:'high',
    affects:['hospital','water','substation','waste','chemical_plant','petroleum',
             'road_infra','bridge','railway','shelter','fuel_storage','pumping_station'] },
  landslide_zone:    {
    name:'Landslide Susceptibility Zone',
    risk_level:'hazardous',
    affects:['hospital','road_infra','bridge','train_station','communication',
             'railway','pipeline','electricity_tower'] },
  seismic_zone:      {
    name:'Seismic Hazard Zone',
    risk_level:'critical',
    affects:['hospital','chemical_plant','petroleum','power_plant','substation',
             'storage_tank','dam','nuclear','bridge','pipeline','cooling_tower'] },
  coastal_surge:     {
    name:'Coastal Storm Surge',
    risk_level:'high',
    affects:['hospital','water','communication','military','airport','port',
             'road_infra','bridge','fuel_storage','petroleum'] },
  wind_corridor:     {
    name:'High Wind Corridor',
    risk_level:'medium',
    affects:['communication','airport','power_plant','chemical_plant',
             'electricity_tower','telecom_tower','cooling_tower'] },
  industrial_cluster:{
    name:'Industrial Risk Cluster',
    risk_level:'hazardous',
    affects:['hospital','school','water','shelter','clinic','waste'] },
  tsunami_zone:      {
    name:'Tsunami Inundation Zone',
    risk_level:'critical',
    affects:['hospital','water','port','military','airport','fuel_storage',
             'chemical_plant','petroleum','road_infra','bridge','railway'] },
  wildfire_zone:     {
    name:'Wildfire Risk Zone',
    risk_level:'high',
    affects:['communication','power_plant','electricity_tower','telecom_tower',
             'substation','hospital','shelter','road_infra'] },
  drought_zone:      {
    name:'Drought / Water Scarcity Zone',
    risk_level:'medium',
    affects:['water','dam','pumping_station','water_tower','cooling_tower',
             'hospital','power_plant','nuclear'] },
  volcano_zone:      {
    name:'Volcanic Hazard Zone',
    risk_level:'critical',
    affects:['hospital','airport','road_infra','bridge','water','communication',
             'electricity_tower','shelter','school'] },
};

// Natural hazard → facility link rules (one per env key)
const NATURAL_RULES = [
  { env:'flood_zone',        to_cat:null, link:'EXPO', tst:'HCA', sp:'SO',  tm:'TCO', conf:0.80 },
  { env:'landslide_zone',    to_cat:null, link:'EXPO', tst:'HCA', sp:'SSP', tm:'TCO', conf:0.75 },
  { env:'seismic_zone',      to_cat:null, link:'EXPO', tst:'HTC', sp:'SO',  tm:'TSI', conf:0.85 },
  { env:'coastal_surge',     to_cat:null, link:'EXPO', tst:'HCA', sp:'SO',  tm:'TSI', conf:0.80 },
  { env:'wind_corridor',     to_cat:null, link:'EXPO', tst:'HTC', sp:'SO',  tm:'TSI', conf:0.70 },
  { env:'industrial_cluster',to_cat:null, link:'EXPO', tst:'HPC', sp:'SO',  tm:'TDI', conf:0.65 },
  { env:'tsunami_zone',      to_cat:null, link:'EXPO', tst:'HCA', sp:'SO',  tm:'TSI', conf:0.88 },
  { env:'wildfire_zone',     to_cat:null, link:'EXPO', tst:'HCA', sp:'SO',  tm:'TCO', conf:0.78 },
  { env:'drought_zone',      to_cat:null, link:'EXPO', tst:'HPC', sp:'SO',  tm:'TDI', conf:0.72 },
  { env:'volcano_zone',      to_cat:null, link:'EXPO', tst:'HCA', sp:'SO',  tm:'TSI', conf:0.90 },
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
 * @param {Array}  rulebook   - override rulebook (optional)
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
    // Determine node_type: infrastructure categories are typed accordingly
    const infraCats = new Set([
      'road_infra','bridge','dam','pipeline','fuel_storage','port','railway',
      'electricity_tower','water_tower','telecom_tower','pumping_station','cooling_tower',
    ]);
    const nodeType = infraCats.has(fac.category) ? 'infrastructure' : 'facility';
    nodes.push({
      id:         `fac_${fac.id}`,
      node_type:  nodeType,
      entity_id:  fac.id,
      name:       fac.name || fac.category_name || fac.category,
      category:   fac.category,
      latitude:   parseFloat(fac.latitude),
      longitude:  parseFloat(fac.longitude),
      risk_level: fac.risk_level || 'medium',
      is_external:false,
      properties: { category_name: fac.category_name, source: fac.source, node_type: nodeType },
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

      const matching = rules.filter(r =>
        r.from === a.category && r.to === b.category
      );
      if (!matching.length) continue;

      const distM = haversine(
        parseFloat(a.latitude), parseFloat(a.longitude),
        parseFloat(b.latitude), parseFloat(b.longitude)
      );

      for (const rule of matching) {
        if (distM > rule.dist) continue;

        const edgeKey = rule.bidir
          ? [rule.id, [a.id, b.id].sort().join('_')].join('_')
          : `${rule.id}_${a.id}_${b.id}`;
        if (edgeSet.has(edgeKey)) continue;
        edgeSet.add(edgeKey);

        const schedA = getSchedule(a);
        const schedB = getSchedule(b);
        const temporal = classifyTemporalOverlap(schedA, schedB, rule.tm);

        // Spatial classification: refine based on actual distance
        let spatial = rule.sp;
        if      (distM < 200)  spatial = 'SO';
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

  // Risk score: intrinsic level × incoming cascading + exposure links
  const RISK_WEIGHTS = { critical:5, hazardous:4, high:3, medium:2, low:1 };
  for (const n of nodes) {
    const rw      = RISK_WEIGHTS[n.risk_level] || 2;
    const cascIn  = edges.filter(e => e.to_node === n.id && e.tst_type === 'HCA').length;
    const exposIn = edges.filter(e => e.to_node === n.id && e.link_type === 'EXPO').length;
    const depsOut = edges.filter(e => e.from_node === n.id && e.link_type === 'DEPS').length;
    // Infra nodes get a criticality bonus when many assets depend on them
    const infraBonus = n.node_type === 'infrastructure' ? depsOut * 0.3 : 0;
    metrics[n.id].risk_score = rw * (1 + cascIn * 0.4 + exposIn * 0.2 + infraBonus);
  }

  // Dependency depth: BFS from each node following DEPS + MECH edges
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
