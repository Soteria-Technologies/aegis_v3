/**
 * AEGIS V3 — Authentication Module
 * JWT (httpOnly cookies) · bcryptjs · invite-only · rate limiting
 * OWASP Top-10 compliant
 */
'use strict';

const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();
const crypto  = require('crypto');
const path    = require('path');
const fs      = require('fs');
const fsp     = require('fs').promises;

const DATA_DIR      = path.join(__dirname, 'data');
const USERS_DB_PATH = path.join(DATA_DIR, 'users.db');
const INVITES_PATH  = path.join(DATA_DIR, 'invites.json');

const BCRYPT_ROUNDS  = 12;        // ~250ms on modern hardware
const JWT_EXPIRY     = '7d';
const COOKIE_NAME    = 'aegis_token';
const MAX_ATTEMPTS   = 10;
const RATE_WINDOW_MS = 15 * 60 * 1000; // 15 min

// In-memory rate limiter (ip → {count, resetAt})
const _loginAttempts = new Map();

let _db = null;

// ── JWT Secret validation ─────────────────────────────────────
function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      'JWT_SECRET is missing or too short (min 32 chars).\n' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"\n' +
      'Then add it to your .env file as JWT_SECRET=<value>'
    );
  }
  return secret;
}

// ── Database ──────────────────────────────────────────────────
async function initUsersDb() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  return new Promise((resolve, reject) => {
    _db = new sqlite3.Database(USERS_DB_PATH, (err) => {
      if (err) { reject(err); return; }
      _db.serialize(() => {
        _db.run('PRAGMA journal_mode=WAL');
        _db.run(`CREATE TABLE IF NOT EXISTS users (
          id           TEXT PRIMARY KEY,
          username     TEXT UNIQUE NOT NULL,
          email        TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          role         TEXT NOT NULL DEFAULT 'user',
          is_active    INTEGER NOT NULL DEFAULT 1,
          created_at   TEXT NOT NULL DEFAULT (datetime('now')),
          last_login   TEXT
        )`);
        _db.run(`CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`);
        _db.run(`CREATE INDEX IF NOT EXISTS idx_users_email    ON users(email)`, resolve);
      });
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((res, rej) =>
    _db.get(sql, params, (err, row) => err ? rej(err) : res(row)));
}
function dbRun(sql, params = []) {
  return new Promise((res, rej) =>
    _db.run(sql, params, function (err) { err ? rej(err) : res(this); }));
}
function dbAll(sql, params = []) {
  return new Promise((res, rej) =>
    _db.all(sql, params, (err, rows) => err ? rej(err) : res(rows)));
}

// ── Invite helpers ─────────────────────────────────────────────
function readInvites() {
  try { return JSON.parse(fs.readFileSync(INVITES_PATH, 'utf8')); } catch { return []; }
}
function writeInvites(invites) {
  fs.writeFileSync(INVITES_PATH, JSON.stringify(invites, null, 2));
}

// ── Rate limiter ──────────────────────────────────────────────
function checkRateLimit(ip) {
  const now = Date.now();
  let entry = _loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
    _loginAttempts.set(ip, entry);
  }
  entry.count++;
  return entry.count <= MAX_ATTEMPTS;
}
function clearRateLimit(ip) { _loginAttempts.delete(ip); }

// ── Cookie helpers ────────────────────────────────────────────
function setCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly:  true,
    secure:    process.env.NODE_ENV === 'production', // HTTPS in prod
    sameSite:  'strict',   // CSRF protection
    maxAge:    7 * 24 * 3600 * 1000,
    path:      '/',
  });
}

// ── Auth middleware ───────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated', redirect: '/login.html' });
  }
  try {
    req.user = jwt.verify(token, getJwtSecret());
    next();
  } catch {
    res.clearCookie(COOKIE_NAME);
    res.status(401).json({ error: 'Session expired', redirect: '/login.html' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// ── Auth routes ───────────────────────────────────────────────
function registerAuthRoutes(app) {
  // POST /api/auth/login
  app.post('/api/auth/login', async (req, res) => {
    const ip = (req.ip || req.socket.remoteAddress || '').replace('::ffff:', '');
    if (!checkRateLimit(ip)) {
      return res.status(429).json({ error: 'Too many login attempts. Wait 15 minutes.' });
    }

    const { username, password } = req.body || {};
    if (!username?.trim() || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    try {
      const user = await dbGet(
        `SELECT * FROM users WHERE (username = ? OR email = ?) AND is_active = 1`,
        [username.trim(), username.trim()]
      );

      // Always run bcrypt to prevent timing attacks / user enumeration
      const dummyHash = '$2a$12$WtHpAlBvXY.rUXXeFkBhQOVfHHsUMmFIZtWzFaT6xPJWvVRCuL1Oi';
      const hashToCheck = user?.password_hash || dummyHash;
      const valid = await bcrypt.compare(password, hashToCheck);

      if (!user || !valid) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      clearRateLimit(ip);
      await dbRun(`UPDATE users SET last_login = datetime('now') WHERE id = ?`, [user.id]);

      const token = jwt.sign(
        { userId: user.id, username: user.username, role: user.role, jti: crypto.randomUUID() },
        getJwtSecret(),
        { expiresIn: JWT_EXPIRY }
      );
      setCookie(res, token);
      res.json({ ok: true, user: { id: user.id, username: user.username, role: user.role } });
    } catch (err) {
      console.error('[AUTH] Login error:', err.message);
      res.status(500).json({ error: 'Authentication error' });
    }
  });

  // POST /api/auth/logout
  app.post('/api/auth/logout', (req, res) => {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
  });

  // GET /api/auth/me
  app.get('/api/auth/me', requireAuth, async (req, res) => {
    try {
      const user = await dbGet(
        `SELECT id, username, email, role, created_at, last_login FROM users WHERE id = ?`,
        [req.user.userId]
      );
      if (!user) return res.status(404).json({ error: 'User not found' });
      res.json(user);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/auth/invite/check/:token
  app.get('/api/auth/invite/check/:token', (req, res) => {
    const invites = readInvites();
    const invite  = invites.find(
      i => i.token === req.params.token && !i.used && new Date(i.expires_at) > new Date()
    );
    if (!invite) return res.status(404).json({ valid: false, error: 'Invalid or expired invite' });
    res.json({ valid: true, email: invite.email });
  });

  // POST /api/auth/invite/use
  app.post('/api/auth/invite/use', async (req, res) => {
    const { token, username, password } = req.body || {};
    if (!token || !username?.trim() || !password) {
      return res.status(400).json({ error: 'All fields required' });
    }
    if (password.length < 10) {
      return res.status(400).json({ error: 'Password must be at least 10 characters' });
    }
    if (!/^[a-zA-Z0-9_-]{3,30}$/.test(username)) {
      return res.status(400).json({ error: 'Username: 3-30 characters, letters/numbers/_/-' });
    }

    const invites = readInvites();
    const invite  = invites.find(
      i => i.token === token && !i.used && new Date(i.expires_at) > new Date()
    );
    if (!invite) return res.status(400).json({ error: 'Invalid or expired invite token' });

    try {
      const existing = await dbGet(`SELECT id FROM users WHERE username = ?`, [username.trim()]);
      if (existing) return res.status(409).json({ error: 'Username already taken' });

      const id   = crypto.randomUUID();
      const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

      await dbRun(
        `INSERT INTO users (id, username, email, password_hash) VALUES (?, ?, ?, ?)`,
        [id, username.trim(), invite.email, hash]
      );

      invite.used    = true;
      invite.used_at = new Date().toISOString();
      invite.used_by = username.trim();
      writeInvites(invites);

      const jwtToken = jwt.sign(
        { userId: id, username: username.trim(), role: 'user', jti: crypto.randomUUID() },
        getJwtSecret(),
        { expiresIn: JWT_EXPIRY }
      );
      setCookie(res, jwtToken);
      res.json({ ok: true });
    } catch (err) {
      if (err.message?.includes('UNIQUE')) {
        return res.status(409).json({ error: 'Username or email already exists' });
      }
      res.status(500).json({ error: err.message });
    }
  });
  // ── Admin-only routes ──────────────────────────────────────────

  // GET /api/admin/users
  app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
    try {
      const users = await dbAll(
        `SELECT id, username, email, role, is_active, created_at, last_login FROM users ORDER BY created_at DESC`
      );
      res.json(users);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // POST /api/admin/invite — create invite link
  app.post('/api/admin/invite', requireAuth, requireAdmin, async (req, res) => {
    const { email, expires_days = 7 } = req.body || {};
    if (!email?.trim()) return res.status(400).json({ error: 'Email required' });

    const existing = await dbGet(`SELECT id FROM users WHERE email = ?`, [email.trim()]);
    if (existing) return res.status(409).json({ error: 'A user with this email already exists' });

    const token     = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + expires_days * 86400000).toISOString();
    const invites   = readInvites();

    // Revoke any existing unused invites for this email
    invites.forEach(i => { if (i.email === email.trim() && !i.used) i.revoked = true; });

    const invite = { token, email: email.trim(), created_at: new Date().toISOString(),
      expires_at: expiresAt, used: false, created_by: req.user.username };
    invites.push(invite);
    writeInvites(invites);

    const host    = req.headers.origin || `${req.protocol}://${req.get('host')}`;
    const inviteUrl = `${host}/login.html?invite=${token}`;
    res.json({ ok: true, token, email: email.trim(), expires_at: expiresAt, invite_url: inviteUrl });
  });

  // GET /api/admin/invites — list all invites
  app.get('/api/admin/invites', requireAuth, requireAdmin, (req, res) => {
    const invites = readInvites()
      .filter(i => !i.revoked)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json(invites);
  });

  // DELETE /api/admin/invite/:token — revoke
  app.delete('/api/admin/invite/:token', requireAuth, requireAdmin, (req, res) => {
    const invites = readInvites();
    const invite  = invites.find(i => i.token === req.params.token);
    if (!invite) return res.status(404).json({ error: 'Invite not found' });
    invite.revoked = true;
    writeInvites(invites);
    res.json({ ok: true });
  });

  // PATCH /api/admin/users/:id — toggle active / change role
  app.patch('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
    const { is_active, role } = req.body || {};
    const allowed_roles = ['user', 'admin'];
    if (role !== undefined && !allowed_roles.includes(role))
      return res.status(400).json({ error: 'Invalid role' });

    // Prevent admin from disabling themselves
    if (req.params.id === req.user.userId && is_active === false)
      return res.status(400).json({ error: 'Cannot disable your own account' });

    const updates = [];
    const params  = [];
    if (is_active !== undefined) { updates.push('is_active = ?'); params.push(is_active ? 1 : 0); }
    if (role      !== undefined) { updates.push('role = ?');      params.push(role); }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

    params.push(req.params.id);
    await dbRun(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
    const user = await dbGet(`SELECT id, username, email, role, is_active FROM users WHERE id = ?`, [req.params.id]);
    res.json(user);
  });

  // POST /api/admin/users/:id/reset-password
  app.post('/api/admin/users/:id/reset-password', requireAuth, requireAdmin, async (req, res) => {
    const { password } = req.body || {};
    if (!password || password.length < 10)
      return res.status(400).json({ error: 'Password must be at least 10 characters' });
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await dbRun(`UPDATE users SET password_hash = ? WHERE id = ?`, [hash, req.params.id]);
    res.json({ ok: true });
  });
}

module.exports = {
  initUsersDb,
  requireAuth,
  requireAdmin,
  registerAuthRoutes,
  readInvites,
  writeInvites,
  dbGet,
  dbRun,
  dbAll,
};
