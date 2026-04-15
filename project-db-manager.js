/**
 * AEGIS V3 — project-db-manager.js
 * ──────────────────────────────────────────────────────────────────────────
 * Manages a per-project SQLite database.
 * Each project in data/projects/{uuid}/ gets its own aegis.db.
 *
 * Schema covers:
 *   - facilities          : detected / manually added facilities (UUID-labeled)
 *   - facility_labels     : type + subset taxonomy
 *   - grid_cells          : analysis grid (or district polygons)
 *   - api_cache           : once-per-day API call results
 *   - risk_edges          : cascading risk relationships between facilities
 *   - scenarios           : simulation scenarios (Simulation mode only)
 *   - scenario_events     : events within a scenario
 *   - sync_log            : operation audit trail
 * ──────────────────────────────────────────────────────────────────────────
 */

'use strict';

const sqlite3 = require('sqlite3').verbose();
const crypto  = require('crypto');

class ProjectDB {
    /**
     * @param {string} dbPath - Full path to aegis.db for this project
     */
    constructor(dbPath) {
        this.dbPath      = dbPath;
        this.db          = null;
        this.isConnected = false;
    }

    // ════════════════════════════════════════════════════════════════════════
    // LIFECYCLE
    // ════════════════════════════════════════════════════════════════════════

    async initialize() {
        return new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(this.dbPath, async (err) => {
                if (err) return reject(err);
                this.isConnected = true;
                try {
                    await this._applySchema();
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    async close() {
        if (!this.db) return;
        return new Promise((res, rej) => {
            this.db.close(err => {
                this.isConnected = false;
                err ? rej(err) : res();
            });
        });
    }

    // ════════════════════════════════════════════════════════════════════════
    // SCHEMA
    // ════════════════════════════════════════════════════════════════════════

    async _applySchema() {
        const statements = [
            'PRAGMA journal_mode=WAL',
            'PRAGMA foreign_keys=ON',

            // ── Facilities ──────────────────────────────────────────────────
            `CREATE TABLE IF NOT EXISTS facilities (
                id              TEXT PRIMARY KEY,       -- UUID (AEGIS-assigned)
                external_id     TEXT,                   -- Source ID (OSM, Google Places)
                source          TEXT NOT NULL,          -- 'osm'|'google'|'manual'

                name            TEXT NOT NULL,
                latitude        REAL NOT NULL,
                longitude       REAL NOT NULL,
                address         TEXT,

                -- Taxonomy (UUID label scheme)
                type_label      TEXT NOT NULL,          -- e.g. 'industrial-facility'
                subset_label    TEXT,                   -- e.g. 'oil-depot'
                risk_level      TEXT NOT NULL DEFAULT 'medium',
                                                        -- 'critical'|'hazardous'|'high'|'medium'|'low'

                -- Geospatial
                geometry        TEXT,                   -- GeoJSON geometry (polygon if known)
                grid_cell_id    TEXT REFERENCES grid_cells(id),

                -- Operational
                status          TEXT NOT NULL DEFAULT 'active',
                verified        INTEGER NOT NULL DEFAULT 0,
                notes           TEXT,
                attributes      TEXT,                   -- JSON blob for extra fields

                -- Audit
                created_at      TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
                api_cache_ref   TEXT                    -- links to api_cache.id
            )`,

            // ── Facility Label Taxonomy ──────────────────────────────────────
            `CREATE TABLE IF NOT EXISTS facility_labels (
                id          TEXT PRIMARY KEY,           -- UUID
                type_label  TEXT NOT NULL,              -- e.g. 'industrial-facility'
                subset_label TEXT,                      -- e.g. 'oil-depot'
                display_name TEXT NOT NULL,
                risk_level  TEXT NOT NULL DEFAULT 'medium',
                color       TEXT,                       -- hex color for UI
                icon        TEXT,                       -- emoji or icon key
                osm_tags    TEXT,                       -- JSON array of OSM tag patterns
                google_types TEXT,                      -- JSON array of Google Place types
                keywords    TEXT,                       -- JSON array of search keywords
                UNIQUE(type_label, subset_label)
            )`,

            // ── Grid Cells ───────────────────────────────────────────────────
            `CREATE TABLE IF NOT EXISTS grid_cells (
                id          TEXT PRIMARY KEY,           -- UUID
                index_row   INTEGER,
                index_col   INTEGER,
                geometry    TEXT NOT NULL,              -- GeoJSON polygon
                center_lat  REAL,
                center_lon  REAL,
                area_sqkm   REAL,
                district_name TEXT,                     -- if using admin subdivisions
                district_osm_id TEXT,
                created_at  TEXT NOT NULL DEFAULT (datetime('now'))
            )`,

            // ── API Cache ────────────────────────────────────────────────────
            // Ensures API is only called once per day per area/type combo
            `CREATE TABLE IF NOT EXISTS api_cache (
                id              TEXT PRIMARY KEY,
                source          TEXT NOT NULL,          -- 'overpass'|'google_places'
                query_hash      TEXT NOT NULL,          -- SHA-256 of the query params
                grid_cell_id    TEXT,
                facility_type   TEXT,
                raw_response    TEXT,                   -- JSON
                fetched_at      TEXT NOT NULL DEFAULT (datetime('now')),
                expires_at      TEXT NOT NULL,          -- fetched_at + 24h
                UNIQUE(source, query_hash)
            )`,

            // ── Risk Edges (Cascading Risk Graph) ────────────────────────────
            `CREATE TABLE IF NOT EXISTS risk_edges (
                id              TEXT PRIMARY KEY,
                source_facility TEXT NOT NULL REFERENCES facilities(id),
                target_facility TEXT NOT NULL REFERENCES facilities(id),
                edge_type       TEXT NOT NULL,          -- 'dependency'|'proximity'|'shared_resource'
                propagation_mode TEXT,                  -- 'direct'|'indirect'|'potential'
                severity        TEXT DEFAULT 'medium',
                confidence      REAL DEFAULT 1.0,       -- 0-1
                distance_m      REAL,
                notes           TEXT,
                created_at      TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(source_facility, target_facility, edge_type)
            )`,

            // ── Scenarios (Simulation mode only) ─────────────────────────────
            `CREATE TABLE IF NOT EXISTS scenarios (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                description TEXT,
                hazard_type TEXT NOT NULL,              -- 'flood'|'earthquake'|'industrial'|...
                status      TEXT NOT NULL DEFAULT 'draft',
                trigger_facility_id TEXT REFERENCES facilities(id),
                parameters  TEXT,                       -- JSON: intensity, extent, etc.
                created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
            )`,

            // ── Scenario Events (cascade timeline) ────────────────────────────
            `CREATE TABLE IF NOT EXISTS scenario_events (
                id              TEXT PRIMARY KEY,
                scenario_id     TEXT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
                facility_id     TEXT NOT NULL REFERENCES facilities(id),
                event_type      TEXT NOT NULL,          -- 'initial_impact'|'cascade'|'mitigation'
                time_offset_min REAL DEFAULT 0,         -- minutes from T0
                impact_level    TEXT NOT NULL DEFAULT 'medium',
                probability     REAL DEFAULT 1.0,
                notes           TEXT,
                created_at      TEXT NOT NULL DEFAULT (datetime('now'))
            )`,

            // ── Sync / Audit Log ─────────────────────────────────────────────
            `CREATE TABLE IF NOT EXISTS sync_log (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                entity_id   TEXT,
                entity_type TEXT,
                operation   TEXT NOT NULL,
                status      TEXT NOT NULL DEFAULT 'ok',
                detail      TEXT,
                created_at  TEXT NOT NULL DEFAULT (datetime('now'))
            )`,

            // ── Indexes ──────────────────────────────────────────────────────
            'CREATE INDEX IF NOT EXISTS idx_fac_type    ON facilities(type_label)',
            'CREATE INDEX IF NOT EXISTS idx_fac_risk    ON facilities(risk_level)',
            'CREATE INDEX IF NOT EXISTS idx_fac_cell    ON facilities(grid_cell_id)',
            'CREATE INDEX IF NOT EXISTS idx_fac_latlon  ON facilities(latitude, longitude)',
            'CREATE INDEX IF NOT EXISTS idx_cache_hash  ON api_cache(query_hash)',
            'CREATE INDEX IF NOT EXISTS idx_edges_src   ON risk_edges(source_facility)',
            'CREATE INDEX IF NOT EXISTS idx_edges_tgt   ON risk_edges(target_facility)',
            'CREATE INDEX IF NOT EXISTS idx_ev_scenario ON scenario_events(scenario_id)',

            // ── Seed Default Label Taxonomy ───────────────────────────────────
            // Will only insert if table is empty (INSERT OR IGNORE)
            ...DEFAULT_FACILITY_LABELS.map(l => `
                INSERT OR IGNORE INTO facility_labels
                (id, type_label, subset_label, display_name, risk_level, color, icon, osm_tags, google_types, keywords)
                VALUES (
                    '${l.id}', '${l.type}', ${l.subset ? `'${l.subset}'` : 'NULL'},
                    '${l.displayName}', '${l.riskLevel}',
                    '${l.color}', '${l.icon}',
                    '${JSON.stringify(l.osmTags || [])}',
                    '${JSON.stringify(l.googleTypes || [])}',
                    '${JSON.stringify(l.keywords || [])}'
                )
            `)
        ];

        for (const stmt of statements) {
            await this._run(stmt);
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // FACILITIES
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Upsert a facility. Generates UUID if id not provided.
     */
    async upsertFacility(facility) {
        const id = facility.id || this._uuid();
        const now = new Date().toISOString();

        await this._run(`
            INSERT INTO facilities (
                id, external_id, source, name, latitude, longitude, address,
                type_label, subset_label, risk_level, geometry, grid_cell_id,
                status, verified, notes, attributes, created_at, updated_at, api_cache_ref
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET
                name          = excluded.name,
                type_label    = excluded.type_label,
                subset_label  = excluded.subset_label,
                risk_level    = excluded.risk_level,
                geometry      = excluded.geometry,
                grid_cell_id  = excluded.grid_cell_id,
                notes         = excluded.notes,
                attributes    = excluded.attributes,
                updated_at    = excluded.updated_at
        `, [
            id,
            facility.externalId    || null,
            facility.source        || 'manual',
            facility.name,
            facility.latitude,
            facility.longitude,
            facility.address       || null,
            facility.typeLabel     || 'unknown',
            facility.subsetLabel   || null,
            facility.riskLevel     || 'medium',
            facility.geometry      ? JSON.stringify(facility.geometry) : null,
            facility.gridCellId    || null,
            facility.status        || 'active',
            facility.verified      ? 1 : 0,
            facility.notes         || null,
            facility.attributes    ? JSON.stringify(facility.attributes) : null,
            now,
            now,
            facility.apiCacheRef   || null
        ]);

        return id;
    }

    async getFacilities({ typeLabel, riskLevel, gridCellId, status = 'active' } = {}) {
        let sql = 'SELECT * FROM facilities WHERE 1=1';
        const params = [];

        if (status)      { sql += ' AND status = ?';        params.push(status); }
        if (typeLabel)   { sql += ' AND type_label = ?';    params.push(typeLabel); }
        if (riskLevel)   { sql += ' AND risk_level = ?';    params.push(riskLevel); }
        if (gridCellId)  { sql += ' AND grid_cell_id = ?';  params.push(gridCellId); }

        sql += ' ORDER BY risk_level DESC, name ASC';
        return this._all(sql, params);
    }

    // ════════════════════════════════════════════════════════════════════════
    // GRID
    // ════════════════════════════════════════════════════════════════════════

    async upsertGridCell(cell) {
        const id = cell.id || this._uuid();
        await this._run(`
            INSERT OR REPLACE INTO grid_cells
            (id, index_row, index_col, geometry, center_lat, center_lon,
             area_sqkm, district_name, district_osm_id, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))
        `, [
            id,
            cell.row          ?? null,
            cell.col          ?? null,
            JSON.stringify(cell.geometry),
            cell.centerLat    ?? null,
            cell.centerLon    ?? null,
            cell.areaSqkm     ?? null,
            cell.districtName ?? null,
            cell.districtOsmId?? null
        ]);
        return id;
    }

    async getGridCells() {
        return this._all('SELECT * FROM grid_cells ORDER BY index_row, index_col');
    }

    // ════════════════════════════════════════════════════════════════════════
    // API CACHE
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Check if a cached API response is still valid (< 24h old).
     */
    async getCachedResponse(source, queryParams) {
        const hash = this._hash(JSON.stringify(queryParams));
        const row  = await this._get(
            `SELECT * FROM api_cache WHERE source = ? AND query_hash = ?
             AND datetime(expires_at) > datetime('now')`,
            [source, hash]
        );
        return row ? JSON.parse(row.raw_response) : null;
    }

    /**
     * Store an API response. Expires in 24 hours.
     */
    async setCachedResponse(source, queryParams, data, gridCellId = null) {
        const hash     = this._hash(JSON.stringify(queryParams));
        const id       = this._uuid();
        const fetchedAt = new Date().toISOString();
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

        await this._run(`
            INSERT OR REPLACE INTO api_cache
            (id, source, query_hash, grid_cell_id, raw_response, fetched_at, expires_at)
            VALUES (?,?,?,?,?,?,?)
        `, [id, source, hash, gridCellId, JSON.stringify(data), fetchedAt, expiresAt]);
    }

    // ════════════════════════════════════════════════════════════════════════
    // RISK EDGES
    // ════════════════════════════════════════════════════════════════════════

    async upsertRiskEdge(edge) {
        const id = edge.id || this._uuid();
        await this._run(`
            INSERT OR REPLACE INTO risk_edges
            (id, source_facility, target_facility, edge_type, propagation_mode,
             severity, confidence, distance_m, notes, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))
        `, [
            id,
            edge.sourceFacility,
            edge.targetFacility,
            edge.edgeType         || 'proximity',
            edge.propagationMode  || 'potential',
            edge.severity         || 'medium',
            edge.confidence       ?? 1.0,
            edge.distanceM        ?? null,
            edge.notes            || null
        ]);
        return id;
    }

    async getRiskEdges(facilityId = null) {
        if (facilityId) {
            return this._all(
                'SELECT * FROM risk_edges WHERE source_facility = ? OR target_facility = ?',
                [facilityId, facilityId]
            );
        }
        return this._all('SELECT * FROM risk_edges');
    }

    // ════════════════════════════════════════════════════════════════════════
    // AUDIT LOG
    // ════════════════════════════════════════════════════════════════════════

    async log(entityId, entityType, operation, status = 'ok', detail = null) {
        await this._run(
            `INSERT INTO sync_log (entity_id, entity_type, operation, status, detail)
             VALUES (?,?,?,?,?)`,
            [entityId, entityType, operation, status, detail]
        );
    }

    // ════════════════════════════════════════════════════════════════════════
    // SQLITE WRAPPERS
    // ════════════════════════════════════════════════════════════════════════

    _run(sql, params = []) {
        return new Promise((res, rej) => {
            this.db.run(sql, params, err => err ? rej(err) : res());
        });
    }

    _all(sql, params = []) {
        return new Promise((res, rej) => {
            this.db.all(sql, params, (err, rows) => err ? rej(err) : res(rows));
        });
    }

    _get(sql, params = []) {
        return new Promise((res, rej) => {
            this.db.get(sql, params, (err, row) => err ? rej(err) : res(row));
        });
    }

    _uuid() {
        return crypto.randomUUID ? crypto.randomUUID()
             : ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
                 (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
    }

    _hash(str) {
        return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// DEFAULT FACILITY LABEL TAXONOMY
// Follows the pattern: type=<category> subset=<specific-type>
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_FACILITY_LABELS = [
    // ── Emergency Services ──────────────────────────────────────────────────
    { id:'fl-001', type:'emergency-service', subset:'hospital',        displayName:'Hospital',          riskLevel:'critical',  color:'#ef4444', icon:'🏥', osmTags:['amenity=hospital'],       googleTypes:['hospital'],      keywords:['hospital','hôpital'] },
    { id:'fl-002', type:'emergency-service', subset:'fire-station',    displayName:'Fire Station',       riskLevel:'critical',  color:'#f97316', icon:'🚒', osmTags:['amenity=fire_station'],   googleTypes:['fire_station'],   keywords:['fire station','caserne pompiers'] },
    { id:'fl-003', type:'emergency-service', subset:'police-station',  displayName:'Police Station',     riskLevel:'critical',  color:'#3b82f6', icon:'🚔', osmTags:['amenity=police'],         googleTypes:['police'],         keywords:['police','gendarmerie'] },
    { id:'fl-004', type:'emergency-service', subset:'clinic',          displayName:'Clinic / Health Ctr',riskLevel:'high',      color:'#f87171', icon:'🏨', osmTags:['amenity=clinic'],         googleTypes:['doctor'],         keywords:['clinic','medical center'] },

    // ── Critical Infrastructure ─────────────────────────────────────────────
    { id:'fl-010', type:'power-infrastructure', subset:'power-plant',      displayName:'Power Plant',        riskLevel:'hazardous', color:'#fbbf24', icon:'⚡', osmTags:['power=plant'],            googleTypes:[],                keywords:['power plant','centrale électrique'] },
    { id:'fl-011', type:'power-infrastructure', subset:'substation',        displayName:'Electrical Substation',riskLevel:'hazardous',color:'#fcd34d',icon:'🔌', osmTags:['power=substation'],      googleTypes:[],                keywords:['substation','poste électrique'] },
    { id:'fl-012', type:'water-infrastructure', subset:'water-treatment',   displayName:'Water Treatment Plant',riskLevel:'hazardous',color:'#38bdf8',icon:'💧', osmTags:['man_made=water_treatment_plant'], googleTypes:[], keywords:['water treatment','station épuration'] },
    { id:'fl-013', type:'water-infrastructure', subset:'pumping-station',   displayName:'Pumping Station',    riskLevel:'high',      color:'#7dd3fc', icon:'🚰', osmTags:['man_made=pumping_station'],googleTypes:[],               keywords:['pumping station','station pompage'] },
    { id:'fl-014', type:'water-infrastructure', subset:'reservoir',         displayName:'Water Reservoir',    riskLevel:'high',      color:'#93c5fd', icon:'🏊', osmTags:['man_made=reservoir'],     googleTypes:[],                keywords:['reservoir','réservoir eau'] },

    // ── Industrial Facilities ───────────────────────────────────────────────
    { id:'fl-020', type:'industrial-facility', subset:'oil-depot',         displayName:'Oil / Fuel Depot',   riskLevel:'hazardous', color:'#dc2626', icon:'🛢️', osmTags:['industrial=oil_storage'],  googleTypes:[],               keywords:['fuel depot','dépôt carburant','oil storage'] },
    { id:'fl-021', type:'industrial-facility', subset:'oil-refinery',      displayName:'Oil Refinery',       riskLevel:'hazardous', color:'#b91c1c', icon:'🏭', osmTags:['industrial=oil_refinery'], googleTypes:[],               keywords:['refinery','raffinerie'] },
    { id:'fl-022', type:'industrial-facility', subset:'chemical-plant',    displayName:'Chemical Plant',     riskLevel:'hazardous', color:'#7c3aed', icon:'⚗️', osmTags:['industrial=chemical'],    googleTypes:[],                keywords:['chemical','chimique','plant chimique'] },
    { id:'fl-023', type:'industrial-facility', subset:'lpg-storage',       displayName:'LPG / Gas Storage',  riskLevel:'hazardous', color:'#c026d3', icon:'🔥', osmTags:['man_made=gas_holder'],    googleTypes:[],                keywords:['LPG','GPL','gas storage','stockage gaz'] },
    { id:'fl-024', type:'industrial-facility', subset:'mine',              displayName:'Mine / Quarry',      riskLevel:'high',      color:'#78716c', icon:'⛏️', osmTags:['landuse=quarry'],         googleTypes:[],                keywords:['mine','quarry','carrière'] },
    { id:'fl-025', type:'industrial-facility', subset:'nuclear',           displayName:'Nuclear Facility',   riskLevel:'critical',  color:'#16a34a', icon:'☢️', osmTags:['power=nuclear'],          googleTypes:[],                keywords:['nuclear','nucléaire'] },

    // ── Waste Management ────────────────────────────────────────────────────
    { id:'fl-030', type:'waste-management', subset:'landfill',           displayName:'Landfill / Waste Site',riskLevel:'hazardous',color:'#a16207',icon:'🗑️', osmTags:['landuse=landfill'],        googleTypes:[],                keywords:['landfill','décharge'] },
    { id:'fl-031', type:'waste-management', subset:'waste-treatment',    displayName:'Waste Treatment Plant',riskLevel:'hazardous',color:'#b45309',icon:'♻️', osmTags:['amenity=waste_transfer_station'],googleTypes:[],         keywords:['waste treatment','incinérateur'] },

    // ── Transportation Hubs ─────────────────────────────────────────────────
    { id:'fl-040', type:'transportation', subset:'airport',             displayName:'Airport',             riskLevel:'high',      color:'#0284c7', icon:'✈️', osmTags:['aeroway=aerodrome'],      googleTypes:['airport'],       keywords:['airport','aéroport'] },
    { id:'fl-041', type:'transportation', subset:'rail-station',        displayName:'Rail Station',        riskLevel:'medium',    color:'#0369a1', icon:'🚂', osmTags:['railway=station'],        googleTypes:['train_station'], keywords:['gare','railway station','train'] },
    { id:'fl-042', type:'transportation', subset:'port',                displayName:'Port / Harbor',       riskLevel:'high',      color:'#0891b2', icon:'⚓', osmTags:['harbour=yes','waterway=dock'],googleTypes:[],          keywords:['port','harbour','dock'] },
    { id:'fl-043', type:'transportation', subset:'highway-interchange',  displayName:'Highway Interchange', riskLevel:'medium',    color:'#0e7490', icon:'🛣️', osmTags:['highway=motorway_junction'],googleTypes:[],           keywords:['interchange','échangeur'] },

    // ── Education & Community ───────────────────────────────────────────────
    { id:'fl-050', type:'community-facility', subset:'school',          displayName:'School',              riskLevel:'high',      color:'#16a34a', icon:'🏫', osmTags:['amenity=school'],         googleTypes:['school'],        keywords:['school','école'] },
    { id:'fl-051', type:'community-facility', subset:'university',      displayName:'University',          riskLevel:'medium',    color:'#15803d', icon:'🎓', osmTags:['amenity=university'],     googleTypes:['university'],    keywords:['university','université'] },
    { id:'fl-052', type:'community-facility', subset:'shelter',         displayName:'Emergency Shelter',   riskLevel:'high',      color:'#84cc16', icon:'🏠', osmTags:['amenity=shelter'],        googleTypes:[],                keywords:['shelter','abri','refugio'] },
    { id:'fl-053', type:'community-facility', subset:'community-center', displayName:'Community Center',   riskLevel:'medium',    color:'#65a30d', icon:'🏛️', osmTags:['amenity=community_centre'],googleTypes:[],             keywords:['community center','centre communautaire'] },

    // ── Telecom ─────────────────────────────────────────────────────────────
    { id:'fl-060', type:'telecom-infrastructure', subset:'data-center',  displayName:'Data Center',        riskLevel:'high',      color:'#6366f1', icon:'💾', osmTags:['facility=data_centre'],   googleTypes:[],                keywords:['data center','centre données'] },
    { id:'fl-061', type:'telecom-infrastructure', subset:'telecom-tower', displayName:'Telecom Tower',      riskLevel:'medium',    color:'#818cf8', icon:'📡', osmTags:['man_made=mast','man_made=tower'],googleTypes:[],       keywords:['telecom mast','antenne','tour telecom'] },
];

module.exports = ProjectDB;
