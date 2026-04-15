/**
 * AEGIS V3 — project-manager.js
 * Handles project CRUD operations against the AEGIS server API.
 * Each project has its own isolated SQLite database on the server.
 */

'use strict';

class ProjectManager {
    /**
     * @param {string} apiBase - e.g. 'http://localhost:3001'
     */
    constructor(apiBase) {
        this.api      = apiBase;
        this._cache   = {}; // mode → projects[]
    }

    // ────────────────────────────────────────────────────────
    // LIST
    // ────────────────────────────────────────────────────────

    /**
     * Load all projects for a given mode.
     * @param {'simulation'|'risk_analysis'} mode
     * @returns {Promise<Project[]>}
     */
    async loadProjects(mode) {
        const res = await axios.get(`${this.api}/api/projects`, {
            params: { mode },
            timeout: 8000
        });
        const projects = res.data?.projects ?? [];
        this._cache[mode] = projects;
        return projects;
    }

    // ────────────────────────────────────────────────────────
    // CREATE
    // ────────────────────────────────────────────────────────

    /**
     * Create a new project. Server will:
     *   - Assign a UUID
     *   - Create  ./data/projects/{uuid}/  directory
     *   - Write   metadata.json
     *   - Write   area.geojson
     *   - Init    aegis.db  with baseline schema
     *
     * @param {object} data
     * @param {string}  data.name
     * @param {'simulation'|'risk_analysis'} data.mode
     * @param {string}  [data.description]
     * @param {object}  data.area          - GeoJSON FeatureCollection
     * @param {string}  data.areaSource    - 'geojson'|'shapefile'|'kml'|'osm'
     * @param {string}  data.areaName      - Human-readable label
     * @param {object}  [data.areaMeta]    - OSM IDs, admin levels, etc.
     * @returns {Promise<{id:string, name:string, mode:string}>}
     */
    async createProject(data) {
        const res = await axios.post(`${this.api}/api/projects`, data, {
            timeout: 15000
        });
        // Invalidate cache
        delete this._cache[data.mode];
        return res.data;
    }

    // ────────────────────────────────────────────────────────
    // READ
    // ────────────────────────────────────────────────────────

    /**
     * Get full project metadata + area GeoJSON.
     * @param {string} id
     * @returns {Promise<ProjectFull>}
     */
    async getProject(id) {
        const res = await axios.get(`${this.api}/api/projects/${id}`, { timeout: 8000 });
        return res.data;
    }

    // ────────────────────────────────────────────────────────
    // UPDATE
    // ────────────────────────────────────────────────────────

    /**
     * Update mutable project fields (name, description).
     * @param {string} id
     * @param {object} patch
     * @returns {Promise<void>}
     */
    async updateProject(id, patch) {
        await axios.put(`${this.api}/api/projects/${id}`, patch, { timeout: 8000 });
        // Clear cache
        Object.keys(this._cache).forEach(k => delete this._cache[k]);
    }

    // ────────────────────────────────────────────────────────
    // DELETE
    // ────────────────────────────────────────────────────────

    /**
     * Delete a project and its entire data directory.
     * @param {string} id
     * @returns {Promise<void>}
     */
    async deleteProject(id) {
        await axios.delete(`${this.api}/api/projects/${id}`, { timeout: 10000 });
        // Clear cache
        Object.keys(this._cache).forEach(k => delete this._cache[k]);
    }

    // ────────────────────────────────────────────────────────
    // NAVIGATION
    // ────────────────────────────────────────────────────────

    /**
     * Navigate to the main app with project context.
     * @param {string} id
     * @param {'simulation'|'risk_analysis'} mode
     */
    openProject(id, mode) {
        window.location.href = `app.html?project=${encodeURIComponent(id)}&mode=${encodeURIComponent(mode)}`;
    }

    // ────────────────────────────────────────────────────────
    // UTILS
    // ────────────────────────────────────────────────────────

    /**
     * Format an ISO date string for display.
     * @param {string} iso
     * @returns {string}
     */
    formatDate(iso) {
        if (!iso) return '—';
        try {
            const d = new Date(iso);
            return d.toLocaleDateString('en-CA', {   // YYYY-MM-DD locale
                year: 'numeric', month: '2-digit', day: '2-digit'
            }) + '  ' + d.toLocaleTimeString('en-GB', {
                hour: '2-digit', minute: '2-digit'
            });
        } catch {
            return iso;
        }
    }
}

/* ─── Type hints (JSDoc only, no TS) ────────────────────────────────────────
 * @typedef {{
 *   id:         string,
 *   name:       string,
 *   mode:       'simulation'|'risk_analysis',
 *   description:string,
 *   areaName:   string,
 *   areaSource: string,
 *   createdAt:  string,
 *   updatedAt:  string
 * }} Project
 *
 * @typedef {Project & {
 *   area:     object,   // GeoJSON
 *   areaMeta: object,
 * }} ProjectFull
 * ─────────────────────────────────────────────────────────────────────────── */
