/**
 * Facility Database Manager
 * Handles SQLite operations for AEGIS facility storage and retrieval
 * Supports offline caching with IndexedDB and multi-station sync
 */

const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

class FacilityDatabaseManager {
  constructor(dbPath = './aegis_facilities.db') {
    this.dbPath = dbPath;
    this.db = null;
    this.isConnected = false;
    this.stationId = process.env.STATION_ID || 'STATION-001';
  }

  /**
   * Initialize database connection and create tables if needed
   */
  async initialize() {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbPath, async (err) => {
        if (err) {
          console.error('[DB] Connection error:', err.message);
          reject(err);
          return;
        }
        console.log('[DB] Connected to SQLite database:', this.dbPath);
        this.isConnected = true;

        // Initialize schema
        await this.initializeSchema();
        resolve();
      });
    });
  }

  /**
   * Initialize database schema
   */
  async initializeSchema() {
    const schemaPath = path.join(__dirname, 'database-schema.sql');
    
    return new Promise((resolve, reject) => {
      fs.readFile(schemaPath, 'utf8', (err, data) => {
        if (err) {
          console.warn('[DB] Schema file not found, creating inline schema');
          this.createInlineSchema().then(resolve).catch(reject);
          return;
        }

        // Execute schema SQL
        this.db.exec(data, (err) => {
          if (err) {
            console.error('[DB] Schema initialization error:', err.message);
            reject(err);
            return;
          }
          console.log('[DB] Schema initialized successfully');
          resolve();
        });
      });
    });
  }

  /**
   * Create schema inline if file not found
   */
  async createInlineSchema() {
    // ── Phase 1: Create tables (fatal on real errors) ─────────────
    const tables = [
      `CREATE TABLE IF NOT EXISTS facilities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        category TEXT NOT NULL,
        category_name TEXT,
        risk_level TEXT,
        source TEXT,
        address TEXT,
        phone TEXT,
        website TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_verified DATETIME,
        status TEXT DEFAULT 'active',
        notes TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS inspections (
        id TEXT PRIMARY KEY,
        facility_id TEXT NOT NULL,
        inspection_date DATETIME DEFAULT CURRENT_TIMESTAMP,
        inspector_name TEXT,
        status TEXT,
        hazard_level TEXT,
        observations TEXT,
        photos_count INTEGER DEFAULT 0,
        documents_count INTEGER DEFAULT 0,
        recommendations TEXT,
        follow_up_required BOOLEAN DEFAULT 0,
        follow_up_date DATETIME,
        FOREIGN KEY (facility_id) REFERENCES facilities(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS facility_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        facility_id TEXT NOT NULL,
        change_type TEXT,
        field_name TEXT,
        old_value TEXT,
        new_value TEXT,
        changed_by TEXT,
        changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (facility_id) REFERENCES facilities(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS risk_assessments (
        id TEXT PRIMARY KEY,
        facility_id TEXT NOT NULL,
        assessment_date DATETIME DEFAULT CURRENT_TIMESTAMP,
        risk_score INTEGER,
        vulnerability_indicators TEXT,
        priority_score INTEGER,
        threat_vectors TEXT,
        mitigation_measures TEXT,
        assessed_by TEXT,
        expires_at DATETIME,
        FOREIGN KEY (facility_id) REFERENCES facilities(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS sync_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        station_id TEXT,
        facility_id TEXT,
        operation TEXT,
        sync_status TEXT,
        synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        error_message TEXT,
        attempt_count INTEGER DEFAULT 1,
        FOREIGN KEY (facility_id) REFERENCES facilities(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS station_config (
        station_id TEXT PRIMARY KEY,
        station_name TEXT,
        location TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_sync DATETIME,
        is_primary BOOLEAN DEFAULT 0,
        api_url TEXT,
        api_key TEXT
      )`
    ];

    for (const stmt of tables) {
      await new Promise((resolve, reject) => {
        this.db.run(stmt, (err) => {
          if (err) { console.error('[DB] Table create error:', err.message); reject(err); }
          else resolve();
        });
      });
    }

    // ── Phase 2: Migrations — add columns that may be missing in old DBs
    // SQLite does not support IF NOT EXISTS on ALTER TABLE, so we always attempt
    // and silently ignore "duplicate column name" errors.
    const migrations = [
      `ALTER TABLE facilities ADD COLUMN status TEXT DEFAULT 'active'`,
      `ALTER TABLE facilities ADD COLUMN last_verified DATETIME`,
      `ALTER TABLE facilities ADD COLUMN phone TEXT`,
      `ALTER TABLE facilities ADD COLUMN website TEXT`,
      `ALTER TABLE facilities ADD COLUMN notes TEXT`,
    ];

    for (const stmt of migrations) {
      await new Promise((resolve) => {
        this.db.run(stmt, (err) => {
          // "duplicate column name" = column already exists, perfectly fine
          if (err && !err.message.includes('duplicate column name')) {
            console.warn('[DB] Migration warning (non-fatal):', err.message);
          }
          resolve(); // always continue — migrations are non-fatal
        });
      });
    }

    // ── Phase 3: Indexes — non-fatal (columns guaranteed to exist now)
    const indexes = [
      `CREATE INDEX IF NOT EXISTS idx_facility_category   ON facilities(category)`,
      `CREATE INDEX IF NOT EXISTS idx_facility_risk_level ON facilities(risk_level)`,
      `CREATE INDEX IF NOT EXISTS idx_facility_status     ON facilities(status)`,
      `CREATE INDEX IF NOT EXISTS idx_inspection_facility ON inspections(facility_id)`,
      `CREATE INDEX IF NOT EXISTS idx_history_facility    ON facility_history(facility_id)`,
      `CREATE INDEX IF NOT EXISTS idx_risk_facility       ON risk_assessments(facility_id)`
    ];

    for (const stmt of indexes) {
      await new Promise((resolve) => {
        this.db.run(stmt, (err) => {
          if (err) console.warn('[DB] Index warning (non-fatal):', err.message);
          resolve(); // always continue
        });
      });
    }

    console.log('[DB] Schema initialized (tables + migrations + indexes)');
  }

  /**
   * Generate unique facility ID using hash of coordinates + name
   */
  generateFacilityId(lat, lon, name) {
    const combined = `${lat.toFixed(6)}-${lon.toFixed(6)}-${name.toLowerCase()}`;
    const hash = crypto.createHash('sha256').update(combined).digest('hex').substring(0, 16);
    return `FAC-${hash.toUpperCase()}`;
  }

  /**
   * Upsert a facility — insert or update ALL fields on conflict.
   * Uses deterministic ID for deduplication across scans.
   */
  async upsertFacility(facilityData) {
    return new Promise((resolve, reject) => {
      const {
        name, latitude, longitude, category, category_name, risk_level,
        source, address, phone, website, notes
      } = facilityData;

      const lat = parseFloat(latitude);
      const lng = parseFloat(longitude);
      const id = this.generateFacilityId(lat, lng, (name || '').toLowerCase());

      const sql = `
        INSERT INTO facilities (
          id, name, latitude, longitude, category, category_name, risk_level,
          source, address, phone, website, notes, updated_at, last_verified
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          name          = COALESCE(excluded.name, name),
          category      = COALESCE(excluded.category, category),
          category_name = COALESCE(excluded.category_name, category_name),
          risk_level    = COALESCE(excluded.risk_level, risk_level),
          source        = COALESCE(excluded.source, source),
          address       = COALESCE(excluded.address, address),
          notes         = COALESCE(excluded.notes, notes),
          updated_at    = CURRENT_TIMESTAMP,
          last_verified = CURRENT_TIMESTAMP
      `;

      this.db.run(sql, [
        id, name, lat, lng, category, category_name, risk_level,
        source, address, phone || null, website || null, notes
      ], function(err) {
        if (err) { reject(err); return; }
        resolve({ id, name, lat, lng });
      });
    });
  }

  /**
   * Get facility stats for this project
   */
  async getStats() {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT COUNT(*) as total,
         SUM(CASE WHEN risk_level='critical'  THEN 1 ELSE 0 END) as critical,
         SUM(CASE WHEN risk_level='hazardous' THEN 1 ELSE 0 END) as hazardous,
         SUM(CASE WHEN risk_level='high'      THEN 1 ELSE 0 END) as high,
         SUM(CASE WHEN risk_level='medium'    THEN 1 ELSE 0 END) as medium,
         SUM(CASE WHEN risk_level='low'       THEN 1 ELSE 0 END) as low
         FROM facilities WHERE status = 'active'`,
        (err, row) => err ? reject(err) : resolve(row)
      );
    });
  }

  /**
   * Add or update facility
   */
  async addFacility(facilityData) {
    return new Promise((resolve, reject) => {
      const {
        name, latitude, longitude, category, category_name, risk_level,
        source, address, phone, website, notes
      } = facilityData;

      // Generate unique ID
      const id = this.generateFacilityId(latitude, longitude, name);

      const sql = `
        INSERT INTO facilities (
          id, name, latitude, longitude, category, category_name, risk_level,
          source, address, phone, website, notes, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          updated_at = CURRENT_TIMESTAMP,
          notes = COALESCE(excluded.notes, notes)
      `;

      this.db.run(sql, [
        id, name, latitude, longitude, category, category_name, risk_level,
        source, address, phone, website, notes
      ], function(err) {
        if (err) {
          console.error('[DB] Add facility error:', err.message);
          reject(err);
          return;
        }
        
        // Log to sync table
        this.logSync(id, 'INSERT');
        resolve({ id, name, latitude, longitude });
      }.bind(this));
    });
  }

  /**
   * Get facility by ID
   */
  async getFacility(facilityId) {
    return new Promise((resolve, reject) => {
      const sql = `SELECT * FROM facilities WHERE id = ?`;
      this.db.get(sql, [facilityId], (err, row) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(row || null);
      });
    });
  }

  /**
   * Get all facilities with optional filters
   */
  async getAllFacilities(filters = {}) {
    return new Promise((resolve, reject) => {
      let sql = 'SELECT * FROM facilities WHERE 1=1';
      const params = [];

      if (filters.category) {
        sql += ' AND category = ?';
        params.push(filters.category);
      }

      if (filters.risk_level) {
        sql += ' AND risk_level = ?';
        params.push(filters.risk_level);
      }

      if (filters.status) {
        sql += ' AND status = ?';
        params.push(filters.status);
      }

      if (filters.bbox) {
        const { north, south, east, west } = filters.bbox;
        sql += ` AND latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?`;
        params.push(south, north, west, east);
      }

      sql += ' ORDER BY created_at DESC';

      this.db.all(sql, params, (err, rows) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(rows || []);
      });
    });
  }

  /**
   * Add inspection record
   */
  async addInspection(facilityId, inspectionData) {
    return new Promise((resolve, reject) => {
      const inspectionId = `INS-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
      const {
        inspector_name, status, hazard_level, observations,
        recommendations, follow_up_required, follow_up_date
      } = inspectionData;

      const sql = `
        INSERT INTO inspections (
          id, facility_id, inspector_name, status, hazard_level,
          observations, recommendations, follow_up_required, follow_up_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      this.db.run(sql, [
        inspectionId, facilityId, inspector_name, status, hazard_level,
        observations, recommendations, follow_up_required, follow_up_date
      ], function(err) {
        if (err) {
          reject(err);
          return;
        }
        resolve({ id: inspectionId, facility_id: facilityId });
      });
    });
  }

  /**
   * Get inspections for facility
   */
  async getInspections(facilityId) {
    return new Promise((resolve, reject) => {
      const sql = `
        SELECT * FROM inspections 
        WHERE facility_id = ? 
        ORDER BY inspection_date DESC
      `;
      this.db.all(sql, [facilityId], (err, rows) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(rows || []);
      });
    });
  }

  /**
   * Add risk assessment
   */
  async addRiskAssessment(facilityId, assessmentData) {
    return new Promise((resolve, reject) => {
      const assessmentId = `RSK-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
      const {
        risk_score, vulnerability_indicators, priority_score,
        threat_vectors, mitigation_measures, assessed_by, expires_at
      } = assessmentData;

      const sql = `
        INSERT INTO risk_assessments (
          id, facility_id, risk_score, vulnerability_indicators,
          priority_score, threat_vectors, mitigation_measures,
          assessed_by, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      this.db.run(sql, [
        assessmentId, facilityId, risk_score,
        JSON.stringify(vulnerability_indicators), priority_score,
        JSON.stringify(threat_vectors), mitigation_measures,
        assessed_by, expires_at
      ], function(err) {
        if (err) {
          reject(err);
          return;
        }
        resolve({ id: assessmentId, facility_id: facilityId });
      });
    });
  }

  /**
   * Get history for facility
   */
  async getFacilityHistory(facilityId) {
    return new Promise((resolve, reject) => {
      const sql = `
        SELECT * FROM facility_history
        WHERE facility_id = ?
        ORDER BY changed_at DESC
      `;
      this.db.all(sql, [facilityId], (err, rows) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(rows || []);
      });
    });
  }

  /**
   * Get all facilities as GeoJSON for export
   */
  async exportAsGeoJSON() {
    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT * FROM facilities WHERE status = "active"',
        (err, facilities) => {
          if (err) {
            reject(err);
            return;
          }

          const features = facilities.map(f => ({
            type: 'Feature',
            geometry: {
              type: 'Point',
              coordinates: [f.longitude, f.latitude]
            },
            properties: {
              id: f.id,
              name: f.name,
              category: f.category,
              category_name: f.category_name,
              risk_level: f.risk_level,
              source: f.source,
              address: f.address,
              created_at: f.created_at,
              updated_at: f.updated_at
            }
          }));

          resolve({
            type: 'FeatureCollection',
            features: features,
            timestamp: new Date().toISOString(),
            count: features.length
          });
        }
      );
    });
  }

  /**
   * Log sync operation
   */
  async logSync(facilityId, operation, status = 'completed', errorMsg = null) {
    return new Promise((resolve) => {
      const sql = `
        INSERT INTO sync_log (station_id, facility_id, operation, sync_status, error_message)
        VALUES (?, ?, ?, ?, ?)
      `;

      this.db.run(sql, [this.stationId, facilityId, operation, status, errorMsg], (err) => {
        if (err) {
          console.error('[DB] Sync log error:', err.message);
        }
        resolve();
      });
    });
  }

  /**
   * Close database connection
   */
  close() {
    return new Promise((resolve, reject) => {
      if (this.db) {
        this.db.close((err) => {
          if (err) reject(err);
          else {
            this.isConnected = false;
            console.log('[DB] Database connection closed');
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }
}

module.exports = FacilityDatabaseManager;
