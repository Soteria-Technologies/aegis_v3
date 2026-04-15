/**
 * AEGIS V3 — server-project-routes.js
 * ──────────────────────────────────────────────────────────────────────────
 * DROP-IN ADDITIONS for server.js
 *
 * HOW TO USE:
 *   1. npm install uuid fs-extra
 *   2. Add the requires below after existing requires in server.js
 *   3. Paste the route blocks into server.js before app.listen()
 * ──────────────────────────────────────────────────────────────────────────
 */

// ── Additional requires (add to top of server.js) ────────────────────────────
const { v4: uuidv4 } = require('uuid');
const fse            = require('fs-extra');   // npm install fs-extra

const PROJECTS_DIR   = path.join(__dirname, 'data', 'projects');
const ProjectDB      = require('./project-db-manager');  // new per-project DB class

// Ensure projects directory exists on startup
fse.ensureDirSync(PROJECTS_DIR);

// ═══════════════════════════════════════════════════════════════════════════
// PROJECT REGISTRY HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Read metadata for all projects. Filters by mode if provided.
 * Each project lives in:   data/projects/{uuid}/metadata.json
 *                          data/projects/{uuid}/area.geojson
 *                          data/projects/{uuid}/aegis.db
 */
async function readAllProjects(mode = null) {
    let entries;
    try {
        entries = await fse.readdir(PROJECTS_DIR);
    } catch {
        return [];
    }

    const projects = [];

    for (const entry of entries) {
        const metaPath = path.join(PROJECTS_DIR, entry, 'metadata.json');
        if (!await fse.pathExists(metaPath)) continue;

        try {
            const meta = await fse.readJson(metaPath);
            if (mode && meta.mode !== mode) continue;
            projects.push(meta);
        } catch {
            // Corrupted metadata — skip silently
        }
    }

    return projects.sort((a, b) =>
        new Date(b.updatedAt) - new Date(a.updatedAt)
    );
}

async function readProjectMeta(id) {
    const metaPath = path.join(PROJECTS_DIR, id, 'metadata.json');
    if (!await fse.pathExists(metaPath)) return null;
    return fse.readJson(metaPath);
}

async function writeProjectMeta(id, meta) {
    const dir = path.join(PROJECTS_DIR, id);
    await fse.ensureDir(dir);
    await fse.writeJson(path.join(dir, 'metadata.json'), meta, { spaces: 2 });
}

// ═══════════════════════════════════════════════════════════════════════════
// ROUTES — PROJECT CRUD
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/projects
 * List all projects, optionally filtered by mode.
 */
app.get('/api/projects', async (req, res) => {
    try {
        const { mode } = req.query;
        const projects = await readAllProjects(mode || null);
        res.json({ projects, count: projects.length });
    } catch (err) {
        console.error('[API] GET /api/projects error:', err.message);
        res.status(500).json({ error: 'Failed to list projects.' });
    }
});

/**
 * POST /api/projects
 * Create a new project. Body:
 * {
 *   name:        string,
 *   mode:        'simulation'|'risk_analysis',
 *   description: string,
 *   area:        GeoJSON FeatureCollection,
 *   areaSource:  'geojson'|'shapefile'|'kml'|'osm',
 *   areaName:    string,
 *   areaMeta:    object
 * }
 */
app.post('/api/projects', async (req, res) => {
    try {
        const { name, mode, description, area, areaSource, areaName, areaMeta } = req.body;

        if (!name || !mode || !area) {
            return res.status(400).json({ error: 'name, mode and area are required.' });
        }

        if (!['simulation', 'risk_analysis'].includes(mode)) {
            return res.status(400).json({ error: 'mode must be simulation or risk_analysis.' });
        }

        const id  = uuidv4();
        const now = new Date().toISOString();
        const dir = path.join(PROJECTS_DIR, id);

        await fse.ensureDir(dir);

        // Write area GeoJSON
        await fse.writeJson(path.join(dir, 'area.geojson'), area, { spaces: 2 });

        // If area has pending OSM data, resolve it via Overpass
        let resolvedArea = area;
        if (area._osmPending) {
            try {
                resolvedArea = await hydrateOSMArea(area._osmPending);
                await fse.writeJson(path.join(dir, 'area.geojson'), resolvedArea, { spaces: 2 });
            } catch (e) {
                console.warn('[API] OSM hydration failed, saving pending area:', e.message);
            }
        }

        // Metadata
        const meta = {
            id,
            name:        name.trim(),
            mode,
            description: description?.trim() || '',
            areaSource:  areaSource || 'unknown',
            areaName:    areaName   || 'Unnamed Area',
            areaMeta:    areaMeta   || {},
            createdAt:   now,
            updatedAt:   now,
            status:      'active',
            dbVersion:   '3.0'
        };

        await writeProjectMeta(id, meta);

        // Initialize per-project SQLite database
        const pdb = new ProjectDB(path.join(dir, 'aegis.db'));
        await pdb.initialize();
        await pdb.close();

        logStatus('success', `Project created: ${name} [${id}]`);
        res.status(201).json(meta);

    } catch (err) {
        console.error('[API] POST /api/projects error:', err.message);
        res.status(500).json({ error: `Failed to create project: ${err.message}` });
    }
});

/**
 * GET /api/projects/:id
 * Get full project metadata + area GeoJSON.
 */
app.get('/api/projects/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const meta = await readProjectMeta(id);

        if (!meta) {
            return res.status(404).json({ error: 'Project not found.' });
        }

        // Read area GeoJSON
        const areaPath = path.join(PROJECTS_DIR, id, 'area.geojson');
        let area = null;
        if (await fse.pathExists(areaPath)) {
            area = await fse.readJson(areaPath);
        }

        res.json({ ...meta, area });
    } catch (err) {
        console.error('[API] GET /api/projects/:id error:', err.message);
        res.status(500).json({ error: 'Failed to read project.' });
    }
});

/**
 * PUT /api/projects/:id
 * Update mutable fields: name, description.
 */
app.put('/api/projects/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const meta = await readProjectMeta(id);

        if (!meta) {
            return res.status(404).json({ error: 'Project not found.' });
        }

        const { name, description } = req.body;
        if (name) meta.name = name.trim();
        if (description !== undefined) meta.description = description.trim();
        meta.updatedAt = new Date().toISOString();

        await writeProjectMeta(id, meta);
        res.json(meta);
    } catch (err) {
        console.error('[API] PUT /api/projects/:id error:', err.message);
        res.status(500).json({ error: 'Failed to update project.' });
    }
});

/**
 * DELETE /api/projects/:id
 * Delete project directory (metadata + DB + area).
 */
app.delete('/api/projects/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const dir = path.join(PROJECTS_DIR, id);

        if (!await fse.pathExists(dir)) {
            return res.status(404).json({ error: 'Project not found.' });
        }

        await fse.remove(dir);
        logStatus('info', `Project deleted: ${id}`);
        res.json({ deleted: id });
    } catch (err) {
        console.error('[API] DELETE /api/projects/:id error:', err.message);
        res.status(500).json({ error: `Failed to delete project: ${err.message}` });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// ROUTES — OSM / NOMINATIM PROXY
// ═══════════════════════════════════════════════════════════════════════════

const NOMINATIM_UA = 'AEGIS-V3/3.0 (risk-analysis-poc; contact@example.com)';

/**
 * GET /api/osm/search?q=Paris&limit=7
 * Proxy to Nominatim with polygon_geojson=1.
 * Required because browsers can't set User-Agent.
 */
app.get('/api/osm/search', async (req, res) => {
    try {
        const { q, limit = 7 } = req.query;

        if (!q || q.trim().length < 2) {
            return res.status(400).json({ error: 'Query too short.' });
        }

        const response = await axios.get('https://nominatim.openstreetmap.org/search', {
            params: {
                q:               q.trim(),
                format:          'json',
                addressdetails:  1,
                polygon_geojson: 1,
                limit:           Math.min(Number(limit) || 7, 10)
            },
            headers: {
                'User-Agent': NOMINATIM_UA,
                'Accept-Language': 'en'
            },
            timeout: 10000
        });

        res.json({ results: response.data || [] });
    } catch (err) {
        console.error('[OSM] Search error:', err.message);
        res.status(502).json({ error: `Nominatim error: ${err.message}` });
    }
});

/**
 * GET /api/osm/ping
 * Health-check for OSM reachability.
 */
app.get('/api/osm/ping', async (req, res) => {
    try {
        await axios.get('https://nominatim.openstreetmap.org/status.php', {
            params: { format: 'json' },
            headers: { 'User-Agent': NOMINATIM_UA },
            timeout: 4000
        });
        res.json({ ok: true });
    } catch {
        res.status(502).json({ ok: false });
    }
});

/**
 * GET /api/osm/subdivisions?osmId=71525&osmType=relation
 * Returns district/arrondissement level admin boundaries via Overpass.
 */
app.get('/api/osm/subdivisions', async (req, res) => {
    try {
        const { osmId, osmType } = req.query;

        if (!osmId) {
            return res.status(400).json({ error: 'osmId required.' });
        }

        const relId = String(osmId).replace(/^[nwr]/, '');

        // Try admin_level 9, 10, and 11 to catch most subdivision schemes
        // (arrondissements in France = 9, districts = 10 or 11, etc.)
        const overpassQuery = `
[out:json][timeout:25];
rel(${relId});
map_to_area->.parent;
(
  rel(area.parent)["admin_level"~"^(9|10|11)$"]["boundary"="administrative"];
);
out tags geom;
`.trim();

        const response = await axios.post(
            'https://overpass-api.de/api/interpreter',
            overpassQuery,
            {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 25000
            }
        );

        const elements = response.data?.elements ?? [];

        const subdivisions = elements.map(el => ({
            osmId:   String(el.id),
            osmType: 'relation',
            name:    el.tags?.name || el.tags?.['name:en'] || `District ${el.id}`,
            adminLevel: el.tags?.admin_level,
            geojson: overpassElementToGeoJSON(el)
        })).filter(s => s.name);

        res.json({ subdivisions, count: subdivisions.length });
    } catch (err) {
        console.error('[OSM] Subdivisions error:', err.message);
        res.status(502).json({ error: `Overpass error: ${err.message}` });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// ROUTES — STATUS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/status
 * Returns system configuration status.
 */
app.get('/api/status', async (req, res) => {
    const projectCount = (await readAllProjects()).length;

    res.json({
        version:                 '3.0.0',
        googlePlacesConfigured:  !!process.env.GOOGLE_PLACES_API_KEY,
        overpassEnabled:         true,
        nominatimEnabled:        true,
        projectCount
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Convert an Overpass element (with geometry) to a GeoJSON feature.
 * @param {object} el - Overpass element
 * @returns {object|null}
 */
function overpassElementToGeoJSON(el) {
    if (!el.geometry && !el.members) return null;

    try {
        // Relation with members that have geometry
        if (el.type === 'relation' && el.members) {
            const outerRings = el.members
                .filter(m => m.role === 'outer' && m.geometry)
                .map(m => m.geometry.map(pt => [pt.lon, pt.lat]));

            if (!outerRings.length) return null;

            return {
                type: 'Feature',
                geometry: { type: 'MultiPolygon', coordinates: outerRings.map(r => [r]) },
                properties: el.tags || {}
            };
        }

        // Way with geometry
        if (el.type === 'way' && el.geometry) {
            return {
                type: 'Feature',
                geometry: {
                    type: 'Polygon',
                    coordinates: [el.geometry.map(pt => [pt.lon, pt.lat])]
                },
                properties: el.tags || {}
            };
        }
    } catch {
        return null;
    }

    return null;
}

/**
 * Hydrate an OSM pending area by fetching actual boundary polygons
 * from Overpass using stored OSM IDs.
 * @param {{ areas: {osmId,osmType}[], subdivisions: {osmId}[] }} pending
 * @returns {Promise<object>} GeoJSON FeatureCollection
 */
async function hydrateOSMArea(pending) {
    const features = [];

    for (const area of (pending.areas || [])) {
        try {
            const relId = area.osmId.replace(/^[nwr]/, '');
            const q = `[out:json][timeout:20];rel(${relId});out geom;`;

            const r = await axios.post(
                'https://overpass-api.de/api/interpreter', q,
                { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20000 }
            );

            const els = r.data?.elements ?? [];
            els.forEach(el => {
                const f = overpassElementToGeoJSON(el);
                if (f) {
                    f.properties.aegis_source = 'osm';
                    f.properties.aegis_osmid  = area.osmId;
                    features.push(f);
                }
            });
        } catch (e) {
            console.warn(`[OSM] Hydration failed for ${area.osmId}:`, e.message);
        }
    }

    return { type: 'FeatureCollection', features };
}
