#!/usr/bin/env node
/**
 * AEGIS V3 — Admin CLI
 * Manages users and invite tokens from the command line.
 *
 * Usage:
 *   node admin-cli.js create-invite  --email <email> [--expires <days>]
 *   node admin-cli.js create-admin   --email <email> --username <u> --password <p>
 *   node admin-cli.js list-users
 *   node admin-cli.js list-invites
 *   node admin-cli.js disable-user   --username <name>
 *   node admin-cli.js enable-user    --username <name>
 *   node admin-cli.js reset-password --username <name> --password <p>
 *   node admin-cli.js generate-secret
 */
'use strict';

require('dotenv').config();
const bcrypt  = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();
const crypto  = require('crypto');
const path    = require('path');
const fs      = require('fs');

const DATA_DIR      = path.join(__dirname, 'data');
const USERS_DB_PATH = path.join(DATA_DIR, 'users.db');
const INVITES_PATH  = path.join(DATA_DIR, 'invites.json');

const args    = process.argv.slice(2);
const command = args[0];

function arg(name) {
  const idx = args.indexOf('--' + name);
  return idx >= 0 ? args[idx + 1] : null;
}

function readInvites() {
  try { return JSON.parse(fs.readFileSync(INVITES_PATH, 'utf8')); } catch { return []; }
}
function writeInvites(i) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(INVITES_PATH, JSON.stringify(i, null, 2));
}

function openDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(USERS_DB_PATH, (err) => {
      if (err) reject(err); else resolve(db);
    });
  });
}
function run(db, sql, params = []) {
  return new Promise((res, rej) => db.run(sql, params, function (err) { err ? rej(err) : res(this); }));
}
function get(db, sql, params = []) {
  return new Promise((res, rej) => db.get(sql, params, (err, row) => err ? rej(err) : res(row)));
}
function all(db, sql, params = []) {
  return new Promise((res, rej) => db.all(sql, params, (err, rows) => err ? rej(err) : res(rows)));
}

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', white: '\x1b[37m',
};

function ok(msg)   { console.log(`${C.green}✓${C.reset} ${msg}`); }
function err(msg)  { console.error(`${C.red}✗${C.reset} ${msg}`); }
function info(msg) { console.log(`${C.cyan}ℹ${C.reset} ${msg}`); }

async function ensureSchema(db) {
  await run(db, `CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    username     TEXT UNIQUE NOT NULL,
    email        TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role         TEXT NOT NULL DEFAULT 'user',
    is_active    INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    last_login   TEXT
  )`);
}

async function main() {
  switch (command) {

    case 'generate-secret': {
      const secret = crypto.randomBytes(64).toString('hex');
      console.log(`\n${C.bold}Generated JWT_SECRET:${C.reset}`);
      console.log(`${C.yellow}${secret}${C.reset}`);
      console.log(`\nAdd to your .env file:\n  JWT_SECRET=${secret}\n`);
      break;
    }

    case 'create-invite': {
      const email   = arg('email');
      const days    = parseInt(arg('expires') || '7');
      if (!email) { err('--email required'); process.exit(1); }

      const token     = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
      const invites   = readInvites();

      invites.push({
        token, email,
        created_at:  new Date().toISOString(),
        expires_at:  expiresAt,
        used:        false,
      });
      writeInvites(invites);

      const host = process.env.HOST || 'http://localhost:3001';
      ok(`Invite created for ${C.bold}${email}${C.reset}`);
      console.log(`  ${C.dim}Token:${C.reset}   ${token}`);
      console.log(`  ${C.dim}Expires:${C.reset} ${expiresAt}`);
      console.log(`  ${C.dim}URL:${C.reset}     ${C.cyan}${host}/login.html?invite=${token}${C.reset}\n`);
      break;
    }

    case 'create-admin': {
      const email    = arg('email');
      const username = arg('username');
      const password = arg('password');
      if (!email || !username || !password) {
        err('--email, --username and --password required'); process.exit(1);
      }
      if (password.length < 10) { err('Password must be >= 10 characters'); process.exit(1); }

      const db   = await openDb();
      await ensureSchema(db);
      const hash = await bcrypt.hash(password, 12);
      const id   = crypto.randomUUID();

      try {
        await run(db, `INSERT INTO users (id, username, email, password_hash, role)
          VALUES (?, ?, ?, ?, 'admin')`, [id, username, email, hash]);
        ok(`Admin created: ${C.bold}${username}${C.reset} (${email})`);
      } catch (e) {
        if (e.message.includes('UNIQUE')) err('Username or email already exists');
        else err(e.message);
      }
      db.close();
      break;
    }

    case 'list-users': {
      const db   = await openDb();
      await ensureSchema(db);
      const rows = await all(db, `SELECT username, email, role, is_active, created_at, last_login
        FROM users ORDER BY created_at DESC`);

      console.log(`\n${C.bold}── AEGIS Users ──────────────────────────────────────────────${C.reset}`);
      rows.forEach(r => {
        const status = r.is_active ? `${C.green}ACTIVE${C.reset}` : `${C.red}DISABLED${C.reset}`;
        const role   = r.role === 'admin' ? `${C.yellow}admin${C.reset}` : 'user ';
        const last   = r.last_login ? r.last_login.slice(0,16) : 'never';
        console.log(`  ${status}  ${role}  ${r.username.padEnd(20)} ${r.email.padEnd(30)} last: ${last}`);
      });
      console.log(`\n  Total: ${rows.length} users\n`);
      db.close();
      break;
    }

    case 'list-invites': {
      const invites = readInvites();
      console.log(`\n${C.bold}── AEGIS Invites ───────────────────────────────────────────${C.reset}`);
      invites.forEach(i => {
        const expired = new Date(i.expires_at) < new Date();
        const status  = i.used    ? `${C.dim}used by ${i.used_by}${C.reset}`
                      : expired   ? `${C.red}EXPIRED${C.reset}`
                      : `${C.green}PENDING${C.reset}`;
        console.log(`  ${status.padEnd(30)} ${i.email}`);
        console.log(`    ${C.dim}${i.token}${C.reset}`);
      });
      console.log(`\n  Total: ${invites.length} invites\n`);
      break;
    }

    case 'disable-user': {
      const username = arg('username');
      if (!username) { err('--username required'); process.exit(1); }
      const db = await openDb();
      const r  = await run(db, `UPDATE users SET is_active = 0 WHERE username = ?`, [username]);
      r.changes > 0 ? ok(`User ${username} disabled`) : err(`User ${username} not found`);
      db.close();
      break;
    }

    case 'enable-user': {
      const username = arg('username');
      if (!username) { err('--username required'); process.exit(1); }
      const db = await openDb();
      const r  = await run(db, `UPDATE users SET is_active = 1 WHERE username = ?`, [username]);
      r.changes > 0 ? ok(`User ${username} enabled`) : err(`User ${username} not found`);
      db.close();
      break;
    }

    case 'reset-password': {
      const username = arg('username');
      const password = arg('password');
      if (!username || !password) { err('--username and --password required'); process.exit(1); }
      if (password.length < 10) { err('Password must be >= 10 characters'); process.exit(1); }
      const db   = await openDb();
      const hash = await bcrypt.hash(password, 12);
      const r    = await run(db, `UPDATE users SET password_hash = ? WHERE username = ?`, [hash, username]);
      r.changes > 0 ? ok(`Password reset for ${username}`) : err(`User ${username} not found`);
      db.close();
      break;
    }

    default:
      console.log(`
${C.bold}AEGIS V3 — Admin CLI${C.reset}
${C.dim}────────────────────────────────────────────${C.reset}
Commands:
  ${C.cyan}generate-secret${C.reset}                          Generate a JWT_SECRET
  ${C.cyan}create-invite${C.reset}   --email <e> [--expires N]  Create invite link (default 7 days)
  ${C.cyan}create-admin${C.reset}    --email <e> --username <u> --password <p>
  ${C.cyan}list-users${C.reset}                               List all users
  ${C.cyan}list-invites${C.reset}                             List all invites
  ${C.cyan}disable-user${C.reset}    --username <name>
  ${C.cyan}enable-user${C.reset}     --username <name>
  ${C.cyan}reset-password${C.reset}  --username <name> --password <p>

${C.dim}First time setup:
  1. node admin-cli.js generate-secret   → add JWT_SECRET to .env
  2. node admin-cli.js create-admin ...  → create your admin account
  3. node admin-cli.js create-invite ... → send invite URL to users${C.reset}
`);
  }
}

main().catch(e => { err(e.message); process.exit(1); });
