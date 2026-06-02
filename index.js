import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pkg from 'pg';
import cors from 'cors';
import fs from 'node:fs';
import sanitizeHtml from 'sanitize-html';

const { Pool } = pkg;
const JWT_SECRET = process.env.JWT_SECRET || 'brutalist_secret_key_123';
const DO_LOGGING = true;

function log(...args) {
  if (DO_LOGGING) console.log(`[SERVER]`, ...args);
}

function sanitize(str, options = {}) {
  if (typeof str !== 'string') return str;
  return sanitizeHtml(str.trim(), {
    allowedTags: options.allowTags
      ? ['b', 'i', 'em', 'strong', 'a', 'p', 'br']
      : [],
    allowedAttributes: options.allowTags ? { a: ['href'] } : {},
    ...options,
  });
}

function sanitizeUsername(username) {
  if (typeof username !== 'string') return username;
  return username.replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 32);
}

let connectionString =
  process.env.DATABASE_URL ||
  'postgresql://postgres:postgres@localhost:5432/unreader';

if (
  connectionString &&
  !connectionString.startsWith('postgresql://') &&
  !connectionString.startsWith('postgres://')
) {
  log('Formatting DATABASE_URL: adding postgresql:// prefix');
  connectionString = `postgresql://postgres:postgres@${connectionString}/unreader`;
}

const db = new Pool({ connectionString });

async function initDatabase() {
  try {
    log('Verifying structural integrity...');
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, 
        timeout_until BIGINT DEFAULT 0, is_banned BOOLEAN DEFAULT false,
        roles TEXT NOT NULL DEFAULT '[]'
      );
      
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_moderator BOOLEAN DEFAULT false;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS last_ip TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_bot BOOLEAN DEFAULT false;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS roles TEXT NOT NULL DEFAULT '[]';

      CREATE TABLE IF NOT EXISTS mod_logs (
        id SERIAL PRIMARY KEY, mod_username TEXT NOT NULL, action_type TEXT NOT NULL,
        target_username TEXT, target_id INTEGER, reason TEXT, timestamp BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY, username TEXT NOT NULL, timestamp TEXT NOT NULL, content TEXT NOT NULL, 
        is_deleted BOOLEAN DEFAULT false, deleted_by TEXT, sender TEXT
      );
      CREATE TABLE IF NOT EXISTS dms (
        id SERIAL PRIMARY KEY, username TEXT, sender TEXT NOT NULL, receiver TEXT NOT NULL, timestamp TEXT NOT NULL, content TEXT NOT NULL, 
        is_deleted BOOLEAN DEFAULT false, deleted_by TEXT
      );
      CREATE TABLE IF NOT EXISTS profiles (
        username TEXT PRIMARY KEY REFERENCES users(username) ON DELETE CASCADE, bio TEXT DEFAULT 'Hello world.', location TEXT DEFAULT 'Cyberspace', avatar_emoji TEXT DEFAULT '👤'
      );
      CREATE TABLE IF NOT EXISTS topics (
        id SERIAL PRIMARY KEY, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL, username TEXT NOT NULL, timestamp TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS topic_messages (
        id SERIAL PRIMARY KEY, topic_slug TEXT NOT NULL, username TEXT NOT NULL, timestamp TEXT NOT NULL, content TEXT NOT NULL, 
        is_deleted BOOLEAN DEFAULT false, deleted_by TEXT, sender TEXT
      );
      CREATE TABLE IF NOT EXISTS neighborhood_posts (
        id SERIAL PRIMARY KEY, username TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, timestamp TEXT NOT NULL, 
        is_deleted BOOLEAN DEFAULT false, deleted_by TEXT, sender TEXT
      );
      CREATE TABLE IF NOT EXISTS neighborhood_comments (
        id SERIAL PRIMARY KEY, post_id INTEGER NOT NULL, username TEXT NOT NULL, content TEXT NOT NULL, timestamp TEXT NOT NULL, 
        is_deleted BOOLEAN DEFAULT false, deleted_by TEXT, sender TEXT
      );

      ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_by TEXT;
      ALTER TABLE dms ADD COLUMN IF NOT EXISTS deleted_by TEXT;
      ALTER TABLE topic_messages ADD COLUMN IF NOT EXISTS deleted_by TEXT;
      ALTER TABLE neighborhood_posts ADD COLUMN IF NOT EXISTS deleted_by TEXT;
      ALTER TABLE neighborhood_comments ADD COLUMN IF NOT EXISTS deleted_by TEXT;

      ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender TEXT;
      ALTER TABLE topic_messages ADD COLUMN IF NOT EXISTS sender TEXT;
      ALTER TABLE neighborhood_posts ADD COLUMN IF NOT EXISTS sender TEXT;
      ALTER TABLE neighborhood_comments ADD COLUMN IF NOT EXISTS sender TEXT;

      ALTER TABLE dms ADD COLUMN IF NOT EXISTS username TEXT;

      UPDATE messages SET sender = username WHERE sender IS NULL;
      UPDATE topic_messages SET sender = username WHERE sender IS NULL;
      UPDATE neighborhood_posts SET sender = username WHERE sender IS NULL;
      UPDATE neighborhood_comments SET sender = username WHERE sender IS NULL;

      UPDATE dms SET username = sender WHERE username IS NULL;

      CREATE TABLE IF NOT EXISTS roles (
        role TEXT PRIMARY KEY,
        prefix TEXT NOT NULL,
        style TEXT NOT NULL,
        class TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0
      );
      ALTER TABLE roles ADD COLUMN IF NOT EXISTS class TEXT;

      CREATE TABLE IF NOT EXISTS banned_ips (
        ip TEXT PRIMARY KEY,
        banned_by TEXT NOT NULL,
        reason TEXT,
        timestamp BIGINT NOT NULL
      );
    `);
    log('Structural migration successful.');
  } catch (err) {
    log('DB MIGRATION FAILURE:', err);
    process.exit(1);
  }
}
initDatabase();

const app = express();
app.set('trust proxy', true);

app.use(cors());
app.use(express.json());

async function blockBannedIPs(req, res, next) {
  try {
    const clientIp = req.ip;
    const check = await db.query('SELECT 1 FROM banned_ips WHERE ip = $1;', [clientIp]);
    if (check.rowCount > 0) {
      return res.status(403).json({ error: 'Your IP address has been banned.' });
    }
    next();
  } catch (err) {
    log('IP validation middleware error:', err);
    next();
  }
}
app.use(blockBannedIPs);

async function getUserRoles(username) {
  const r = await db.query(
    'SELECT roles, timeout_until, is_banned, last_ip FROM users WHERE username = $1;',
    [username],
  );
  const res = r.rows[0] || {
    roles: '[]',
    timeout_until: 0,
    is_banned: false,
    last_ip: null,
  };
  res.roles = JSON.parse(res.roles);
  const tempRoles = res.roles;
  res.role = { role: '', prefix: '', style: '' };
  let priority = -1;
  for (var role of tempRoles) {
    const s = await db.query(
      'SELECT role, prefix, style, class, priority FROM roles WHERE role = $1;',
      [role],
    );
    if (!s.rows[0] || s.rows[0].priority <= priority) continue;
    priority = s.rows[0].priority;
    res.role = s.rows[0];
    delete res.role.priority;
  }
  delete res.roles;
  return res;
}

async function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const roles = await getUserRoles(decoded.username);
    req.user = { ...decoded, ...roles };
    next();
  } catch (err) {
    log('Auth Token verification failed:', err.message);
    return res.status(403).json({ error: 'Invalid token' });
  }
}

// ADMIN ENDPOINTS
app.post('/api/admin/ban-ip', authenticateToken, async (req, res) => {
  try {
    if (!req.user || !req.user.role || req.user.role.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden: Requires administrator privileges.' });
    }

    const { ip, reason } = req.body;
    if (!ip) {
      return res.status(400).json({ error: 'Missing target IP address.' });
    }

    await db.query(
      `INSERT INTO banned_ips (ip, banned_by, reason, timestamp) 
       VALUES ($1, $2, $3, $4) ON CONFLICT (ip) DO NOTHING;`,
      [ip, req.user.username, reason || 'No reason provided', Date.now()]
    );

    await db.query(
      `INSERT INTO mod_logs (mod_username, action_type, target_username, reason, timestamp) 
       VALUES ($1, $2, $3, $4, $5);`,
      [req.user.username, 'IP_BAN', ip, reason || 'No reason provided', Date.now()]
    );

    await db.query('UPDATE users SET is_banned = true WHERE last_ip = $1;', [ip]);

    for (const [username, client] of activeClients.entries()) {
      if (client.lastIp === ip && client.ws) {
        client.ws.send(JSON.stringify({ type: 'SYSTEM_ALERT', message: 'Your network has been banned.' }));
        client.ws.close(4003, 'IP Banned');
        activeClients.delete(username);
      }
    }

    log(`Administrator "${req.user.username}" blacklisted IP: ${ip}`);
    return res.status(200).json({ success: true, message: `IP ${ip} banned and corresponding sessions dropped.` });

  } catch (err) {
    log('Admin endpoint /ban-ip failure execution:', err);
    return res.status(500).json({ error: 'Internal system server error.' });
  }
});

const activeClients = new Map();

function broadcastSystemUpdate(payloadObj, filterFn = null) {
  const payload = JSON.stringify(payloadObj);
  for (const [username, client] of activeClients.entries()) {
    if (client.ws && client.ws.readyState === WebSocket.OPEN) {
      if (!filterFn || filterFn(username, client)) {
        client.ws.send(payload);
      }
    }
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log(`Server parsing engine listening on port ${PORT}`));
