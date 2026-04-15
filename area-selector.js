/**
 * AEGIS V3 — area-selector.js
 * Handles:
 *   - File parsing : GeoJSON, SHP (via shpjs), KML (inline parser)
 *   - OSM search   : Nominatim proxy through AEGIS server
 *   - Subdivisions : Overpass proxy for districts/arrondissements
 *   - Area merging : combine multiple OSM areas + optional subdivisions
 */

'use strict';

class AreaSelector {
    /**
     * @param {string} apiBase
     */
    constructor(apiBase) {
        this.api           = apiBase;
        this._fileArea     = null;   // { geojson, source, name, featureCount }
        this._osmAreaMode  = false;

        /** @type {OsmAreaItem[]} */
        this.osmAreas      = [];     // selected OSM areas (cities)

        /** @type {SubdivisionItem[]} */
        this.subdivisions  = [];     // selected subdivisions

        this._osmSearchCache = {};
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PUBLIC STATE ACCESSORS
    // ══════════════════════════════════════════════════════════════════════════

    /** @returns {boolean} */
    hasArea() {
        return !!(this._fileArea || this.osmAreas.length > 0);
    }

    /**
     * Set area from a parsed file.
     * @param {{ geojson:object, source:string, name:string, featureCount:number }} result
     */
    setArea(result) {
        this._fileArea    = result;
        this._osmAreaMode = false;
        this.osmAreas     = [];
        this.subdivisions = [];
    }

    /**
     * Get consolidated area object for submission.
     * @returns {{ geojson:object, source:string, name:string, meta:object }|null}
     */
    getArea() {
        if (this._fileArea) {
            return {
                geojson: this._fileArea.geojson,
                source:  this._fileArea.source,
                name:    this._fileArea.name,
                meta:    { featureCount: this._fileArea.featureCount }
            };
        }

        if (this.osmAreas.length > 0) {
            const geojson = this._mergeOSMAreas();
            const names   = this.osmAreas.map(a => a.shortName).join(', ');
            const meta    = {
                osmAreas:     this.osmAreas.map(({ osmId, osmType, displayName, type }) =>
                              ({ osmId, osmType, displayName, type })),
                subdivisions: this.subdivisions.map(({ osmId, name }) => ({ osmId, name }))
            };
            return { geojson, source: 'osm', name: names, meta };
        }

        return null;
    }

    /** Reset all state. */
    reset() {
        this._fileArea    = null;
        this._osmAreaMode = false;
        this.osmAreas     = [];
        this.subdivisions = [];
    }

    // ══════════════════════════════════════════════════════════════════════════
    // FILE PARSING
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * Parse a file into a GeoJSON FeatureCollection.
     * @param {File} file
     * @returns {Promise<{geojson:object, source:string, name:string, featureCount:number}>}
     */
    async parseFile(file) {
        const ext = file.name.split('.').pop().toLowerCase();

        let result;
        switch (ext) {
            case 'json':
            case 'geojson':
                result = await this._parseGeoJSON(file);
                break;
            case 'zip':
                result = await this._parseSHP(file);
                break;
            case 'kml':
                result = await this._parseKML(file);
                break;
            default:
                throw new Error(`Unsupported format: .${ext} — Use GeoJSON, SHP (ZIP) or KML.`);
        }

        result.featureCount = this._countFeatures(result.geojson);
        return result;
    }

    // ── GeoJSON ──────────────────────────────────────────────────────────────

    async _parseGeoJSON(file) {
        const text = await this._readText(file);
        let geojson;
        try {
            geojson = JSON.parse(text);
        } catch {
            throw new Error('Invalid GeoJSON: could not parse as JSON.');
        }

        // Normalize to FeatureCollection
        geojson = this._normalizeGeoJSON(geojson);
        return { geojson, source: 'geojson', name: file.name };
    }

    _normalizeGeoJSON(g) {
        if (g.type === 'FeatureCollection') return g;
        if (g.type === 'Feature') return { type: 'FeatureCollection', features: [g] };
        if (g.type === 'GeometryCollection') {
            return {
                type: 'FeatureCollection',
                features: g.geometries.map(geo => ({ type: 'Feature', geometry: geo, properties: {} }))
            };
        }
        // Bare geometry
        return {
            type: 'FeatureCollection',
            features: [{ type: 'Feature', geometry: g, properties: {} }]
        };
    }

    // ── Shapefile (ZIP) ───────────────────────────────────────────────────────

    async _parseSHP(file) {
        if (typeof shp !== 'function') {
            throw new Error('shpjs library not loaded. Please refresh and try again.');
        }
        const buffer = await this._readBuffer(file);
        let geojson;
        try {
            geojson = await shp(buffer);
        } catch (e) {
            throw new Error(`Shapefile parse error: ${e.message}`);
        }

        // shpjs may return an array (multi-layer zip)
        if (Array.isArray(geojson)) {
            const features = geojson.flatMap(fc =>
                fc.type === 'FeatureCollection' ? fc.features : [fc]
            );
            geojson = { type: 'FeatureCollection', features };
        } else {
            geojson = this._normalizeGeoJSON(geojson);
        }

        return { geojson, source: 'shapefile', name: file.name };
    }

    // ── KML ──────────────────────────────────────────────────────────────────

    async _parseKML(file) {
        const text = await this._readText(file);
        const parser = new DOMParser();
        const doc = parser.parseFromString(text, 'text/xml');

        if (doc.documentElement.tagName === 'parseerror') {
            throw new Error('KML parse error: invalid XML.');
        }

        const features = [];

        // Handle Placemarks
        doc.querySelectorAll('Placemark').forEach(pm => {
            const name = pm.querySelector('name')?.textContent?.trim() || 'Unnamed';
            const props = { name };

            // Polygon
            pm.querySelectorAll('Polygon').forEach(poly => {
                const coords = this._kmlOuterBoundary(poly);
                const holes  = this._kmlInnerBoundaries(poly);
                if (coords.length) {
                    features.push({
                        type: 'Feature',
                        geometry: { type: 'Polygon', coordinates: holes.length ? [coords, ...holes] : [coords] },
                        properties: props
                    });
                }
            });

            // MultiGeometry > Polygon
            pm.querySelectorAll('MultiGeometry Polygon').forEach(poly => {
                const coords = this._kmlOuterBoundary(poly);
                if (coords.length) {
                    features.push({
                        type: 'Feature',
                        geometry: { type: 'Polygon', coordinates: [coords] },
                        properties: props
                    });
                }
            });

            // LineString
            pm.querySelectorAll('LineString').forEach(ls => {
                const coords = this._kmlParseCoords(ls.querySelector('coordinates')?.textContent);
                if (coords.length) {
                    features.push({
                        type: 'Feature',
                        geometry: { type: 'LineString', coordinates: coords },
                        properties: props
                    });
                }
            });

            // Point
            pm.querySelectorAll('Point').forEach(pt => {
                const coords = this._kmlParseCoords(pt.querySelector('coordinates')?.textContent);
                if (coords.length) {
                    features.push({
                        type: 'Feature',
                        geometry: { type: 'Point', coordinates: coords[0] },
                        properties: props
                    });
                }
            });
        });

        if (!features.length) {
            throw new Error('No geometry found in KML file.');
        }

        return {
            geojson: { type: 'FeatureCollection', features },
            source: 'kml',
            name: file.name
        };
    }

    _kmlOuterBoundary(poly) {
        const raw = poly.querySelector('outerBoundaryIs coordinates')?.textContent
                 || poly.querySelector('outerBoundaryIs LinearRing coordinates')?.textContent;
        return this._kmlParseCoords(raw);
    }

    _kmlInnerBoundaries(poly) {
        return Array.from(poly.querySelectorAll('innerBoundaryIs coordinates'))
            .map(el => this._kmlParseCoords(el.textContent))
            .filter(c => c.length > 0);
    }

    _kmlParseCoords(raw) {
        if (!raw) return [];
        return raw.trim().split(/\s+/).map(pair => {
            const parts = pair.split(',').map(Number);
            // KML: lon,lat[,alt]
            return isNaN(parts[0]) || isNaN(parts[1]) ? null : [parts[0], parts[1]];
        }).filter(Boolean);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // OSM / NOMINATIM SEARCH
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * Search OSM via server proxy (Nominatim).
     * @param {string} query
     * @param {number} [limit=7]
     * @returns {Promise<OsmSearchResult[]>}
     */
    async searchOSM(query, limit = 7) {
        const cacheKey = `${query}|${limit}`;
        if (this._osmSearchCache[cacheKey]) return this._osmSearchCache[cacheKey];

        const res = await axios.get(`${this.api}/api/osm/search`, {
            params: { q: query, limit },
            timeout: 10000
        });

        const results = (res.data?.results ?? []).map(r => ({
            osmId:       String(r.osm_id),
            osmType:     r.osm_type,           // 'node'|'way'|'relation'
            displayName: r.display_name,
            shortName:   r.name || r.display_name.split(',')[0],
            type:        r.type,               // 'city'|'town'|'administrative'…
            country:     r.address?.country || '',
            geojson:     r.geojson || null     // polygon if available from Nominatim
        }));

        this._osmSearchCache[cacheKey] = results;
        return results;
    }

    // ── OSM area management ───────────────────────────────────────────────────

    /**
     * Add an OSM result as a selected area.
     * @param {OsmSearchResult} item
     */
    addOSMArea(item) {
        // Avoid duplicates
        if (this.osmAreas.find(a => a.osmId === item.osmId)) return;
        this.osmAreas.push(item);
        this._osmAreaMode = true;
        this._fileArea    = null;
    }

    /**
     * @param {number} idx
     */
    removeOSMArea(idx) {
        this.osmAreas.splice(idx, 1);
        if (!this.osmAreas.length) this._osmAreaMode = false;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // SUBDIVISIONS (districts / arrondissements)
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * Fetch administrative subdivisions of an OSM area via Overpass.
     * @param {string} osmId
     * @param {string} osmType  - 'node'|'way'|'relation'
     * @returns {Promise<SubdivisionItem[]>}
     */
    async getSubdivisions(osmId, osmType) {
        const res = await axios.get(`${this.api}/api/osm/subdivisions`, {
            params: { osmId, osmType },
            timeout: 20000
        });
        return res.data?.subdivisions ?? [];
    }

    /**
     * @param {SubdivisionItem} sub
     */
    addSubdivision(sub) {
        if (!this.subdivisions.find(s => s.osmId === sub.osmId)) {
            this.subdivisions.push(sub);
        }
    }

    /**
     * @param {string} osmId
     */
    removeSubdivision(osmId) {
        this.subdivisions = this.subdivisions.filter(s => s.osmId !== osmId);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // AREA MERGE
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * Build a merged GeoJSON FeatureCollection from all selected OSM areas
     * and any chosen subdivisions.
     * @returns {object} GeoJSON FeatureCollection
     * @private
     */
    _mergeOSMAreas() {
        const features = [];

        this.osmAreas.forEach(area => {
            if (area.geojson) {
                const normalized = this._normalizeGeoJSON(area.geojson);
                normalized.features.forEach(f => {
                    features.push({
                        ...f,
                        properties: {
                            ...(f.properties || {}),
                            aegis_source: 'osm',
                            aegis_name:   area.shortName,
                            aegis_osmid:  area.osmId
                        }
                    });
                });
            }
        });

        this.subdivisions.forEach(sub => {
            if (sub.geojson) {
                const normalized = this._normalizeGeoJSON(sub.geojson);
                normalized.features.forEach(f => {
                    features.push({
                        ...f,
                        properties: {
                            ...(f.properties || {}),
                            aegis_source:   'osm_subdivision',
                            aegis_name:     sub.name,
                            aegis_osmid:    sub.osmId
                        }
                    });
                });
            }
        });

        // Fallback: if no GeoJSON was embedded in OSM results,
        // return a minimal structure — server will hydrate from Overpass
        if (!features.length) {
            return {
                type: 'FeatureCollection',
                features: [],
                _osmPending: {
                    areas:        this.osmAreas.map(a => ({ osmId: a.osmId, osmType: a.osmType })),
                    subdivisions: this.subdivisions.map(s => ({ osmId: s.osmId }))
                }
            };
        }

        return { type: 'FeatureCollection', features };
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PRIVATE HELPERS
    // ══════════════════════════════════════════════════════════════════════════

    _readText(file) {
        return new Promise((res, rej) => {
            const r = new FileReader();
            r.onload  = e => res(e.target.result);
            r.onerror = () => rej(new Error('Failed to read file.'));
            r.readAsText(file);
        });
    }

    _readBuffer(file) {
        return new Promise((res, rej) => {
            const r = new FileReader();
            r.onload  = e => res(e.target.result);
            r.onerror = () => rej(new Error('Failed to read file.'));
            r.readAsArrayBuffer(file);
        });
    }

    _countFeatures(geojson) {
        if (!geojson) return 0;
        if (geojson.type === 'FeatureCollection') return geojson.features?.length ?? 0;
        if (geojson.type === 'Feature') return 1;
        return 0;
    }

    _normalizeGeoJSON(g) {
        if (g.type === 'FeatureCollection') return g;
        if (g.type === 'Feature') return { type: 'FeatureCollection', features: [g] };
        return { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: g, properties: {} }] };
    }
}

/* ─── Type hints ─────────────────────────────────────────────────────────────
 * @typedef {{
 *   osmId:       string,
 *   osmType:     string,
 *   displayName: string,
 *   shortName:   string,
 *   type:        string,
 *   country:     string,
 *   geojson:     object|null
 * }} OsmSearchResult
 *
 * @typedef {OsmSearchResult} OsmAreaItem
 *
 * @typedef {{
 *   osmId:   string,
 *   osmType: string,
 *   name:    string,
 *   geojson: object|null
 * }} SubdivisionItem
 * ─────────────────────────────────────────────────────────────────────────── */
