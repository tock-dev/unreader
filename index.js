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

// CORRECT RELEASE URL
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

const db = new Pool({
  connectionString,
  max: Number(process.env.DB_POOL_MAX || 20),
  min: Number(process.env.DB_POOL_MIN || 0),
  idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 30000),
  connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 5000),
  maxUses: Number(process.env.DB_MAX_USES || 0) || undefined,
});

db.on('error', (err) => log('PostgreSQL pool error:', err.message));

const USER_ROLE_CACHE_TTL = Number(process.env.USER_ROLE_CACHE_TTL_MS || 30000);
const userRoleCache = new Map();
const bannedIpCache = new Map();
const BANNED_IP_CACHE_TTL = Number(process.env.BANNED_IP_CACHE_TTL_MS || 30000);

function invalidateUserRoleCache(username = null) {
  if (!username) return userRoleCache.clear();
  userRoleCache.delete(String(username).toLowerCase());
}

function invalidateBannedIpCache(ip = null) {
  if (!ip) return bannedIpCache.clear();
  bannedIpCache.delete(ip);
}

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
      UPDATE users SET is_admin = true WHERE LOWER(username) IN ('admin', 'lmao');

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
      CREATE TABLE IF NOT EXISTS profile_images (
        username TEXT PRIMARY KEY REFERENCES users(username) ON DELETE CASCADE,
        image_data TEXT NOT NULL,
        "user" TEXT NOT NULL DEFAULT 'user'
      );
      ALTER TABLE profile_images ADD COLUMN IF NOT EXISTS "user" TEXT NOT NULL DEFAULT 'user';
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

      CREATE INDEX IF NOT EXISTS idx_messages_id_desc ON messages (id DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_username ON messages (username);
      CREATE INDEX IF NOT EXISTS idx_topic_messages_slug_id ON topic_messages (topic_slug, id DESC);
      CREATE INDEX IF NOT EXISTS idx_topic_messages_username ON topic_messages (username);
      CREATE INDEX IF NOT EXISTS idx_dms_participants_id ON dms (sender, receiver, id DESC);
      CREATE INDEX IF NOT EXISTS idx_neighborhood_posts_id_desc ON neighborhood_posts (id DESC);
      CREATE INDEX IF NOT EXISTS idx_neighborhood_comments_post_id ON neighborhood_comments (post_id, id ASC);
      CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);

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

      CREATE TABLE IF NOT EXISTS "portal-2d" (
        "level-id" SERIAL PRIMARY KEY,
        "level-name" VARCHAR(255) NOT NULL,
        "username" VARCHAR(100) NOT NULL,
        "level-data" TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS suggestions (
        id SERIAL PRIMARY KEY,
        date DATE NOT NULL,
        suggestions TEXT NOT NULL,
        username TEXT NOT NULL,
        admin_filter TEXT,
        completion BOOLEAN
      );
    `);
    /* INSERT INTO roles (role, prefix, style, priority) VALUES
      ('admin', 'ADMIN', 'background: black !important;color: white !important;border: 3px solid black !important;box-shadow: 4px 4px 0px #0000004a !important;', 1000),
      ('moderator', 'MOD', 'border: 3px solid #0000ff !important;box-shadow: 4px 4px 0px #0000ff50 !important;', 50),
      ('bot', 'BOT', 'border: 3px solid #808080 !important;box-shadow: 4px 4px 0px #80808050 !important;', 10) ON CONFLICT (role) DO NOTHING; */
    log('Structural migration successful.');
  } catch (err) {
    log('DB MIGRATION FAILURE:', err);
    process.exit(1);
  }
}
initDatabase();

const app = express();
app.set('trust proxy', true);
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '1mb' }));
async function blockBannedIPs(req, res, next) {
  try {
    const clientIp = req.ip;
    const now = Date.now();
    const cached = bannedIpCache.get(clientIp);
    let banned = cached && cached.expiresAt > now ? cached.banned : null;
    if (banned === null || banned === undefined) {
      const check = await db.query('SELECT 1 FROM banned_ips WHERE ip = $1;', [clientIp]);
      banned = check.rowCount > 0;
      bannedIpCache.set(clientIp, { banned, expiresAt: now + BANNED_IP_CACHE_TTL });
    }
    if (banned) return res.status(403).json({ error: 'Your IP address has been banned.' });
    next();
  } catch (err) {
    log('IP validation middleware error:', err);
    next();
  }
}
app.use(blockBannedIPs);

const ADMIN_ENTITY_USERNAMES = new Set(['admin', 'lmao']);

// SQL expression for rows read straight from `users` (roles is a JSON array TEXT column).
const adminUserSql = (alias) =>
  `(${alias}.is_admin OR LOWER(${alias}.username) IN ('admin', 'lmao') OR ${alias}.roles::jsonb @> '["admin"]')`;

// SQL expression for rows read straight from `users` (roles is a JSON array TEXT column).
const moderatorUserSql = (alias) =>
  `(${alias}.is_moderator OR ${alias}.roles::jsonb @> '["moderator"]')`;

const hasAdminPrivileges = (user) => !!(user && user.is_admin);
const hasModeratorPrivileges = (user) => !!(user && user.is_moderator);

// const getUserRolesCache = {};
async function getUserRoles(username) {
  const cacheKey = String(username || '').toLowerCase();
  const cached = userRoleCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;

  const r = await db.query(
    `SELECT u.roles, u.timeout_until, u.is_banned, u.last_ip, u.is_admin, u.is_moderator,
            COALESCE(best.role, '') AS role_name,
            COALESCE(best.prefix, '') AS role_prefix,
            COALESCE(best.style, '') AS role_style,
            COALESCE(best.class, '') AS role_class
       FROM users u
       LEFT JOIN LATERAL (
         SELECT r.role, r.prefix, r.style, r.class
         FROM roles r
         WHERE r.role = ANY (SELECT jsonb_array_elements_text(u.roles::jsonb))
         ORDER BY CASE WHEN r.role IN ('admin', 'moderator') THEN 1 ELSE 0 END,
                  r.priority DESC
         LIMIT 1
       ) best ON true
      WHERE u.username = $1;`,
    [username],
  );

  const res = r.rows[0] || {
    roles: '[]', timeout_until: 0, is_banned: false, last_ip: null,
    is_admin: false, is_moderator: false, role_name: '', role_prefix: '', role_style: '', role_class: '',
  };
  const adminEntity = ADMIN_ENTITY_USERNAMES.has(cacheKey);
  try { res.roles = JSON.parse(res.roles || '[]'); } catch { res.roles = []; }
  // An "admin"/"moderator" entry in the user's roles array (or the legacy boolean
  // columns) grants the benefit instantly, even when the roles-table seed row is
  // missing. style/class still come from the best-priority roles-table match, so
  // promoted users keep their custom borders.
  const roleList = Array.isArray(res.roles) ? res.roles : [];
  res.is_admin = !!res.is_admin || adminEntity || roleList.includes('admin');
  res.is_moderator = !!res.is_moderator || roleList.includes('moderator');
  res.role = {
    role: res.role_name || (res.is_admin ? 'admin' : res.is_moderator ? 'moderator' : ''),
    prefix: res.role_name ? res.role_prefix : res.is_admin ? 'ADMIN' : res.is_moderator ? 'MOD' : '',
    style: res.role_style || '',
    class: res.role_class || '',
  };
  delete res.role_name;
  delete res.role_prefix;
  delete res.role_style;
  delete res.role_class;
  delete res.roles;

  userRoleCache.set(cacheKey, { value: res, expiresAt: now + USER_ROLE_CACHE_TTL });
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

// The editor shell is directly navigable from the dashboard; its API/session check
// gates the actual developer UI and every mutating editor operation remains admin-only.
app.get('/portal-2d-editor.html', (req, res) => {
  res.sendFile('portal-2d-editor.html', { root: './static' });
});

app.use(express.static('./static/'));

// { username: { ws, mode, target, lastIp } }
const activeClients = new Map();

function broadcastSystemUpdate(payloadObj, filterFn = null) {
  const msgStr = JSON.stringify(payloadObj);
  activeClients.forEach((client, username) => {
    if (client.ws.readyState === WebSocket.OPEN) {
      if (!filterFn || filterFn(client, username)) {
        if (client.ws.bufferedAmount > 1024 * 1024) {
          log(`Backpressure: skipping oversized WebSocket queue for ${username}`);
          return;
        }
        client.ws.send(msgStr);
      }
    } else {
      log(`Pruning inactive connection: ${username}`);
      activeClients.delete(username);
    }
  });
}

function getRosterPayload() {
  const users = [];
  activeClients.forEach((c, username) => {
    users.push({
      username: username,
      mode: c.mode || 'public',
      target: c.target || '',
      userRoles: c.userRoles,
    });
  });
  return { type: 'roster_update', users };
}

app.get('/dm-contacts', authenticateToken, async (req, res) => {
  const result = await db.query(
    `SELECT DISTINCT username FROM (SELECT receiver AS username FROM dms WHERE sender = $1 UNION SELECT sender AS username FROM dms WHERE receiver = $1) AS c WHERE username != $1;`,
    [req.user.username],
  );
  res.json(result.rows.map((r) => r.username));
});

app.post('/api/register', async (req, res) => {
  let { username, password } = req.body;
  username = sanitizeUsername(username);
  if (!username || username.length < 3)
    return res.status(400).json({ error: 'Username invalid or too short' });

  const ip =
    req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  log(`Registration request: ${username} from ${ip}`);
  try {
    const hash = await bcrypt.hash(password, 10);
    const isAdminEntity = ADMIN_ENTITY_USERNAMES.has(username.toLowerCase());
    await db.query(
      'INSERT INTO users (username, password_hash, last_ip, is_admin) VALUES ($1, $2, $3, $4);',
      [username, hash, ip, isAdminEntity],
    );
    await db.query(
      'INSERT INTO profiles (username) VALUES ($1) ON CONFLICT DO NOTHING;',
      [username],
    );
    res.json({ token: jwt.sign({ username }, JWT_SECRET), username });
  } catch (err) {
    log('Registration collision/error:', err.message);
    res.status(400).json({ error: 'Username already taken' });
  }
});

app.post('/api/login', async (req, res) => {
  let { username, password } = req.body;
  username = sanitizeUsername(username);
  const ip =
    req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  log(`Login request: ${username} from ${ip}`);
  try {
    const result = await db.query('SELECT * FROM users WHERE username = $1;', [
      username,
    ]);
    const user = result.rows[0];
    if (
      !user ||
      user.is_banned ||
      !(await bcrypt.compare(password, user.password_hash))
    ) {
      log(`Login REJECTED for ${username}`);
      return res.status(401).json({ error: 'Rejected' });
    }
    await db.query('UPDATE users SET last_ip = $1 WHERE username = $2;', [
      ip,
      username,
    ]);
    log(`Login SUCCESS: ${username}`);
    res.json({ token: jwt.sign({ username }, JWT_SECRET), username });
  } catch (err) {
    log('Login logic breakdown:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/change-password', authenticateToken, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  try {
    const user = req.user;
    const result = await db.query('SELECT * FROM users WHERE username = $1;', [
      user.username,
    ]);
    const dbUser = result.rows[0];
    if (
      !dbUser ||
      !(await bcrypt.compare(currentPassword, dbUser.password_hash))
    ) {
      log(`Password change REJECTED for ${user.username}`);
      return res.status(401).json({
        error: 'Rejected. Incorrect current password or user does not exist.',
      });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await db.query('UPDATE users SET password_hash = $1 WHERE username = $2;', [
      hash,
      user.username,
    ]);
    log(`Password change SUCCESS: ${user.username}`);
    res.json({ success: true });
  } catch (err) {
    log('Password change logic breakdown:', err.message);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

app.get('/api/profile/:username', authenticateToken, async (req, res) => {
  const targetUsername = sanitizeUsername(req.params.username);
  const r = await db.query(
    `SELECT u.username, COALESCE(p.bio, 'Hello world.') AS bio, COALESCE(p.location, 'Cyberspace') AS location, COALESCE(p.avatar_emoji, '👤') AS avatar_emoji, i.image_data, ${adminUserSql('u')} AS is_admin, ${moderatorUserSql('u')} AS is_moderator FROM users u LEFT JOIN profiles p ON p.username = u.username LEFT JOIN LATERAL (SELECT image_data FROM profile_images WHERE LOWER(TRIM(LEADING '@' FROM username)) = LOWER(u.username) ORDER BY (username = u.username) DESC LIMIT 1) i ON true WHERE u.username = $1;`,
    [targetUsername],
  );
  if (!r.rows[0]) {
    const image = await db.query(
      `SELECT image_data FROM profile_images WHERE LOWER(TRIM(LEADING '@' FROM username)) = LOWER($1) ORDER BY (username = $1) DESC LIMIT 1;`,
      [targetUsername],
    );
    return res.json({
      username: targetUsername,
      bio: 'Hello world.',
      location: 'Cyberspace',
      avatar_emoji: '👤',
      image_data: image.rows[0]?.image_data || null,
      is_admin: false,
      is_moderator: false,
    });
  }
  res.json(r.rows[0]);
});

app.post('/api/profile', authenticateToken, async (req, res) => {
  let { bio, location, avatar_emoji, image_data } = req.body;
  bio = sanitize(bio);
  location = sanitize(location);
  avatar_emoji = sanitize(avatar_emoji);

  if (image_data !== undefined && image_data !== null && image_data !== '') {
    if (!validProfileImage(image_data)) return res.status(400).json({ error: 'Profile picture must be a valid base64 PNG under 512 KB.' });
  }

  await db.query(
    'INSERT INTO profiles (username, bio, location, avatar_emoji) VALUES ($4, $1, $2, $3) ON CONFLICT (username) DO UPDATE SET bio=$1, location=$2, avatar_emoji=$3;',
    [bio, location, avatar_emoji, req.user.username],
  );
  if (image_data === '') {
    await db.query('DELETE FROM profile_images WHERE username = $1;', [req.user.username]);
  } else if (image_data !== undefined && image_data !== null) {
    await db.query(
      'INSERT INTO profile_images (username, image_data, "user") VALUES ($1, $2, \'user\') ON CONFLICT (username) DO UPDATE SET image_data = EXCLUDED.image_data;',
      [req.user.username, image_data],
    );
  }
  res.json({ success: true });
});

app.get('/api/mod-logs', authenticateToken, async (req, res) => {
  if (!hasAdminPrivileges(req.user) && !hasModeratorPrivileges(req.user))
    return res.status(403).json({ error: 'Unauthorized' });
  const r = await db.query('SELECT * FROM mod_logs ORDER BY id DESC LIMIT 50;');
  const tr = r.rows;
  const rows = [];
  for (const row of tr) {
    row.reason = sanitize(row.reason);
    row.mod_username = sanitize(row.mod_username);
    row.target_username = sanitize(row.target_username);
    if (row.action_type === 'delete') {
      const dbResult = await db.query(
        'SELECT content FROM messages WHERE id = $1;',
        [row.target_id],
      );
      row.content = dbResult.rows.length
        ? dbResult.rows[0].content
        : 'Content not found or already deleted.';
    }
    rows.push(row);
  }
  res.json(rows);
});

function canManageProfilePictures(user) {
  return user.role.role === 'admin' || user.role.role === 'moderator';
}

function validProfileImage(imageData) {
  if (typeof imageData !== 'string' || imageData.length > 700000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(imageData)) return false;
  const bytes = Buffer.from(imageData, 'base64');
  return bytes.length > 0 && bytes.length <= 512000 && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
}

app.get('/api/mod/profile-images', authenticateToken, async (req, res) => {
  if (!canManageProfilePictures(req.user)) return res.status(403).json({ error: 'Unauthorized' });
  const page = Math.max(0, parseInt(req.query.index, 10) || 0);
  const search = String(req.query.search || '').trim().replace(/^@+/, '').slice(0, 32);
  const result = await db.query(
    `WITH pictures AS (
       SELECT u.username, pi.image_data
       FROM users u
       LEFT JOIN LATERAL (
         SELECT image_data FROM profile_images
         WHERE LOWER(TRIM(LEADING '@' FROM username)) = LOWER(u.username)
         ORDER BY (username = u.username) DESC LIMIT 1
       ) pi ON true
       UNION ALL
       SELECT pi.username, pi.image_data FROM profile_images pi
       WHERE NOT EXISTS (
         SELECT 1 FROM users u
         WHERE LOWER(TRIM(LEADING '@' FROM pi.username)) = LOWER(u.username)
       )
     )
     SELECT username, image_data FROM pictures
     WHERE $1 = '' OR username ILIKE '%' || $1 || '%'
     ORDER BY LOWER(username), username
     LIMIT 21 OFFSET $2;`,
    [search, page * 20],
  );
  res.json({ images: result.rows.slice(0, 20), hasMore: result.rows.length > 20 });
});

app.put('/api/mod/profile-images/:username', authenticateToken, async (req, res) => {
  if (!canManageProfilePictures(req.user)) return res.status(403).json({ error: 'Unauthorized' });
  const target = sanitizeUsername(req.params.username);
  const imageData = req.body.image_data;
  if (!validProfileImage(imageData)) return res.status(400).json({ error: 'A valid PNG profile picture under 512 KB is required.' });
  const existing = await db.query(
    `SELECT username FROM profile_images WHERE LOWER(TRIM(LEADING '@' FROM username)) = LOWER($1) ORDER BY (username = $1) DESC LIMIT 1;`,
    [target],
  );
  const row = existing.rows[0];
  if (row) {
    await db.query('UPDATE profile_images SET image_data = $1 WHERE username = $2;', [imageData, row.username]);
  } else {
    const user = await db.query('SELECT username FROM users WHERE LOWER(username) = LOWER($1);', [target]);
    if (!user.rows[0]) return res.status(404).json({ error: 'User not found.' });
    await db.query(
      'INSERT INTO profile_images (username, image_data, "user") VALUES ($1, $2, \'user\');',
      [user.rows[0].username, imageData],
    );
  }
  await db.query(
    'INSERT INTO mod_logs (mod_username, action_type, target_username, reason, timestamp) VALUES ($1, $2, $3, $4, $5);',
    [req.user.username, 'profile_picture_change', target, 'Moderator updated profile picture', Date.now()],
  );
  res.json({ success: true });
});

app.delete('/api/mod/profile-images/:username', authenticateToken, async (req, res) => {
  if (!canManageProfilePictures(req.user)) return res.status(403).json({ error: 'Unauthorized' });
  const target = sanitizeUsername(req.params.username);
  const existing = await db.query(
    `SELECT username FROM profile_images WHERE LOWER(TRIM(LEADING '@' FROM username)) = LOWER($1) ORDER BY (username = $1) DESC LIMIT 1;`,
    [target],
  );
  if (!existing.rows[0]) return res.status(404).json({ error: 'Profile picture not found.' });
  await db.query('DELETE FROM profile_images WHERE username = $1;', [existing.rows[0].username]);
  await db.query(
    'INSERT INTO mod_logs (mod_username, action_type, target_username, reason, timestamp) VALUES ($1, $2, $3, $4, $5);',
    [req.user.username, 'profile_picture_delete', target, 'Moderator deleted profile picture', Date.now()],
  );
  res.json({ success: true });
});

app.get(
  '/api/admin/find-user/:username',
  authenticateToken,
  async (req, res) => {
    if (!hasAdminPrivileges(req.user) && !hasModeratorPrivileges(req.user))
      return res.status(403).json({ error: 'Unauthorized' });
    const targetUsername = sanitizeUsername(req.params.username);
    log(
      `Admin User-Search: target=${targetUsername} by=${req.user.username} who is (${req.user.role.role})`,
    );
    const r = await db.query(
      'SELECT username, last_ip, timeout_until, is_banned, roles FROM users WHERE username = $1;',
      [targetUsername],
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'User not found' });
    const userInfo = r.rows[0];
    userInfo.roles = JSON.parse(userInfo.roles);

    userInfo.roles.sort(async (a, b) => {
      const aRole = await db.query(
        'SELECT priority FROM roles WHERE role = $1;',
        [a],
      );
      const bRole = await db.query(
        'SELECT priority FROM roles WHERE role = $1;',
        [b],
      );
      const aPriority = aRole.rows[0]?.priority || 0;
      const bPriority = bRole.rows[0]?.priority || 0;
      return bPriority - aPriority;
    });

    // Find alts (other users with same IP)
    let alts = [];
    if (userInfo.last_ip) {
      const altsRes = await db.query(
        'SELECT username FROM users WHERE last_ip = $1 AND username <> $2;',
        [userInfo.last_ip, userInfo.username],
      );
      alts = altsRes.rows.map((r) => r.username);
    }

    // Redact IP for moderators (non-admins)
    if (!hasAdminPrivileges(req.user)) {
      userInfo.last_ip = '[redacted]';
    }
    res.json({ ...userInfo, alts });
  },
);

app.post('/api/admin/set-role', authenticateToken, async (req, res) => {
  if (!hasAdminPrivileges(req.user))
    return res.status(403).json({ error: 'Unauthorized' });
  let { target, is_moderator } = req.body;
  target = sanitizeUsername(target);
  log(
    `Role Assignment: ${target} -> mod=${is_moderator} by=${req.user.username}`,
  );
  let roles = await db.query('SELECT roles FROM users WHERE username = $1;', [
    target,
  ]);
  roles = JSON.parse(roles.rows[0].roles);
  if (is_moderator && !roles.includes('moderator')) {
    roles.push('moderator');
  } else if (!is_moderator && roles.includes('moderator')) {
    roles = roles.filter((role) => role !== 'moderator');
  }
  await db.query('UPDATE users SET roles = $1 WHERE username = $2;', [
    JSON.stringify(roles),
    target,
  ]);
  invalidateUserRoleCache(target);
  res.json({ success: true });
});

app.post('/api/admin/ban-ip', authenticateToken, async (req, res) => {
  try {
    if (!hasAdminPrivileges(req.user)) {
      return res
        .status(403)
        .json({ error: 'Forbidden: Requires administrator privileges.' });
    }

    const { username } = req.body;
    if (!username) {
      return res.status(400).json({ error: 'Missing target IP address.' });
    }

    const reason = "Admin doesn't need any reasons";

    const r = await db.query('SELECT last_ip FROM users WHERE username = $1;', [
      username,
    ]);
    const ip = r.rows[0]?.last_ip;
    if (!ip) {
      return res.status(400).json({ error: 'Missing target IP address.' });
    }

    const checkProtectedIp = await db.query(
      `SELECT username, roles, is_admin, is_bot FROM users WHERE last_ip = $1;`,
      [ip],
    );

    for (const row of checkProtectedIp.rows) {
      const roles = JSON.parse(row.roles || '[]');
      if (row.is_bot || row.is_admin || ADMIN_ENTITY_USERNAMES.has(String(row.username || '').toLowerCase()) || roles.includes('admin')) {
        return res.status(400).json({
          error: `Operation Denied: This IP address is currently used by a protected account (@${row.username}).`,
        });
      }
    }

    await db.query(
      `INSERT INTO banned_ips (ip, banned_by, reason, timestamp) 
       VALUES ($1, $2, $3, $4) ON CONFLICT (ip) DO NOTHING;`,
      [ip, req.user.username, reason, Date.now()],
    );

    await db.query(
      `INSERT INTO mod_logs (mod_username, action_type, target_username, reason, timestamp) 
       VALUES ($1, $2, $3, $4, $5);`,
      [req.user.username, 'ip ban', username, reason, Date.now()],
    );

    await db.query('UPDATE users SET is_banned = true WHERE last_ip = $1;', [
      ip,
    ]);

    for (const [username, client] of activeClients.entries()) {
      if (client.lastIp === ip) {
        client.ws.send(
          JSON.stringify({
            type: 'terminate',
            reason: 'Your IP address has been banned.',
          }),
        );
        client.ws.close();
        activeClients.delete(username);
      }
    }

    log(`Blacklisted IP: ${ip} (${username})`);
    return res.status(200).json({
      success: true,
      message: `IP ${ip} banned and corresponding sessions dropped.`,
    });
  } catch (err) {
    log('Admin endpoint /ban-ip failure execution:', err);
    return res.status(500).json({ error: 'Internal system server error.' });
  }
});

app.get('/history', authenticateToken, async (req, res) => {
  log(`history called by ${req.user.username} (${req.user.role.role})`);
  const off = Math.max(0, parseInt(req.query.index ?? '0', 10) * 10);
  const r = await db.query(
    `SELECT m.*, pi.image_data, json_build_object('role', COALESCE(rr.role, ''), 'prefix', COALESCE(rr.prefix, ''), 'style', COALESCE(rr.style, ''), 'class', COALESCE(rr.class, '')) AS role
       FROM messages m
       LEFT JOIN users u ON m.username = u.username
       LEFT JOIN LATERAL (SELECT image_data FROM profile_images WHERE LOWER(TRIM(LEADING '@' FROM username)) = LOWER(m.username) ORDER BY (username = m.username) DESC LIMIT 1) pi ON true
       LEFT JOIN LATERAL (
         SELECT role, prefix, style, class FROM roles
         WHERE role = ANY (SELECT jsonb_array_elements_text(COALESCE(u.roles, '[]')::jsonb))
         ORDER BY CASE WHEN role IN ('admin', 'moderator') THEN 1 ELSE 0 END,
                  priority DESC LIMIT 1
       ) rr ON true
       ORDER BY m.id DESC LIMIT 10 OFFSET $1;`, [off]);
  res.json(r.rows.reverse());
});

app.get('/dm-history', authenticateToken, async (req, res) => {
  const off = Math.max(0, parseInt(req.query.index ?? '0', 10) * 10);
  const target = sanitizeUsername(req.query.target);
  // FIX: Force ALIAS and explicit join for name consistency
  const r = await db.query(
    `
    SELECT d.id, d.sender AS username, d.receiver, d.timestamp, d.content, d.is_deleted, d.deleted_by, pi.image_data
    FROM dms d 
    LEFT JOIN users u ON d.sender = u.username 
    LEFT JOIN LATERAL (SELECT image_data FROM profile_images WHERE LOWER(TRIM(LEADING '@' FROM username)) = LOWER(d.sender) ORDER BY (username = d.sender) DESC LIMIT 1) pi ON true
    WHERE (d.sender = $1 AND d.receiver = $2) OR (d.sender = $2 AND d.receiver = $1) 
    ORDER BY d.id DESC LIMIT 10 OFFSET $3;
  `,
    [req.user.username, target, off],
  );
  for (const row of r.rows) row.role = (await getUserRoles(row.username)).role;
  res.json(r.rows.reverse());
});

app.get('/topic-history', authenticateToken, async (req, res) => {
  const off = Math.max(0, parseInt(req.query.index ?? '0', 10) * 10);
  const slug = sanitize(req.query.slug);
  const r = await db.query(
    'SELECT tm.*, pi.image_data FROM topic_messages tm LEFT JOIN users u ON tm.username = u.username LEFT JOIN LATERAL (SELECT image_data FROM profile_images WHERE LOWER(TRIM(LEADING \'@\' FROM username)) = LOWER(tm.username) ORDER BY (username = tm.username) DESC LIMIT 1) pi ON true WHERE tm.topic_slug = $1 ORDER BY tm.id DESC LIMIT 10 OFFSET $2;',
    [slug, off],
  );
  for (const row of r.rows) row.role = (await getUserRoles(row.username)).role;
  res.json(r.rows.reverse());
});

app.get('/neighborhood-history', authenticateToken, async (req, res) => {
  const off = Math.max(0, parseInt(req.query.index ?? '0', 10) * 10);
  const query = `
    SELECT p.*, pi.image_data,
    COALESCE(json_agg(json_build_object('id', c.id, 'username', c.username, 'content', c.content, 'timestamp', c.timestamp, 'is_deleted', c.is_deleted, 'deleted_by', c.deleted_by, 'image_data', ci.image_data, 'is_admin', ${adminUserSql('cu')}, 'is_moderator', ${moderatorUserSql('cu')}) ORDER BY c.id ASC) FILTER (WHERE c.id IS NOT NULL), '[]') as comments
    FROM neighborhood_posts p 
    LEFT JOIN users u ON p.username = u.username
    LEFT JOIN neighborhood_comments c ON p.id = c.post_id 
    LEFT JOIN users cu ON c.username = cu.username
    LEFT JOIN LATERAL (SELECT image_data FROM profile_images WHERE LOWER(TRIM(LEADING '@' FROM username)) = LOWER(p.username) ORDER BY (username = p.username) DESC LIMIT 1) pi ON true
    LEFT JOIN LATERAL (SELECT image_data FROM profile_images WHERE LOWER(TRIM(LEADING '@' FROM username)) = LOWER(c.username) ORDER BY (username = c.username) DESC LIMIT 1) ci ON true
    GROUP BY p.id, u.id, pi.image_data ORDER BY p.id DESC LIMIT 10 OFFSET $1;`;
  const posts = await db.query(query, [off]);
  let result = [];
  for (let row of posts.rows) {
    row.role = (await getUserRoles(row.username)).role;
    for (let comment of row.comments) {
      comment.role = await getUserRoles(comment.username).role;
    }
    result.push(row);
  }
  res.json(result.reverse());
});

// ---------------------------------------------------------------------------
// Suggestions  (table: suggestions — id, date DATE, suggestions, username, admin_filter, completion BOOLEAN)
// One row = one app idea. "date" is the posting day, stamped by the DB.
// "admin_filter" is a staff status tag; "completion" marks the idea as done.
const SUGG_MAX_TITLE = 120;
const SUGG_MAX_BODY = 4000;
const SUGG_MAX_FILTER = 200;

function suggClean(value, maxLen) {
  return sanitize(value).replace(/[\u0000-\u001f\u007f]/g, (c) => (c === '\n' ? c : '')).trim().slice(0, maxLen);
}

app.get('/suggestions-history', authenticateToken, async (req, res) => {
  try {
    const limit = Math.min(30, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const off = Math.max(0, (parseInt(req.query.index ?? '0', 10) || 0) * limit);
    const r = await db.query(
      'SELECT s.id, s.date::text AS date, s.suggestions, s.username, s.admin_filter, s.completion, pi.image_data FROM suggestions s LEFT JOIN LATERAL (SELECT image_data FROM profile_images WHERE LOWER(TRIM(LEADING \'@\' FROM username)) = LOWER(s.username) ORDER BY (username = s.username) DESC LIMIT 1) pi ON true ORDER BY s.id DESC LIMIT $2 OFFSET $1;',
      [off, limit],
    );
    res.json(r.rows.reverse());
  } catch (err) {
    log('Suggestions history failure:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

app.post('/api/suggestions', authenticateToken, async (req, res) => {
  try {
    const blocked = p2dBlockedUser(req.user);
    if (blocked) return res.status(403).json({ error: blocked });
    const title = suggClean(req.body?.title, SUGG_MAX_TITLE);
    const body = suggClean(req.body?.body, SUGG_MAX_BODY);
    if (!title || !body)
      return res.status(400).json({ error: 'Title and description are required.' });
    const r = await db.query(
      'INSERT INTO suggestions (date, suggestions, username) VALUES (CURRENT_DATE, $1, $2) RETURNING id;',
      [`${title}\n${body}`, req.user.username],
    );
    log(`Suggestion #${r.rows[0].id} posted by ${req.user.username}`);
    res.json({ success: true, id: r.rows[0].id });
  } catch (err) {
    log('Suggestion post failure:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// Staff annotation: admin_filter = status tag, completion = done flag.
app.put('/api/suggestions/:id', authenticateToken, async (req, res) => {
  try {
    if (!hasAdminPrivileges(req.user) && !hasModeratorPrivileges(req.user))
      return res.status(403).json({ error: 'Staff only.' });
    const id = p2dParseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid suggestion ID.' });
    const found = await db.query('SELECT admin_filter, completion FROM suggestions WHERE id = $1;', [id]);
    if (!found.rows[0]) return res.status(404).json({ error: 'No suggestion with that ID.' });
    const body = req.body || {};
    const touchesFilter = 'admin_filter' in body;
    const touchesCompletion = 'completion' in body;
    if (!touchesFilter && !touchesCompletion)
      return res.status(400).json({ error: 'Nothing to update.' });
    // Omitted fields keep their stored value; null or blank clears them.
    const admin_filter = touchesFilter ? suggClean(body.admin_filter ?? '', SUGG_MAX_FILTER) || null : found.rows[0].admin_filter;
    let completion = found.rows[0].completion;
    if (touchesCompletion) {
      const v = body.completion;
      completion = v === null || v === undefined || v === '' || v === false ? null : true;
    }
    await db.query(
      'UPDATE suggestions SET admin_filter = $1, completion = $2 WHERE id = $3;',
      [admin_filter, completion, id],
    );
    await db.query(
      'INSERT INTO mod_logs (mod_username, action_type, target_username, target_id, reason, timestamp) VALUES ($1, $2, $3, $4, $5, $6);',
      [req.user.username, 'suggestion update', null, id, `filter=${admin_filter || ''} completion=${completion === null ? 'unset' : completion}`, Date.now()],
    );
    log(`Suggestion #${id} annotated by ${req.user.username}`);
    res.json({ success: true, id });
  } catch (err) {
    log('Suggestion update failure:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// Owners can delete their own suggestions; staff can delete any.
app.delete('/api/suggestions/:id', authenticateToken, async (req, res) => {
  try {
    const id = p2dParseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid suggestion ID.' });
    const r = await db.query('SELECT username FROM suggestions WHERE id = $1;', [id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'No suggestion with that ID.' });
    const owner = r.rows[0].username;
    if (owner !== req.user.username && !p2dIsStaff(req.user))
      return res.status(403).json({ error: 'You can only delete your own suggestions.' });
    await db.query('DELETE FROM suggestions WHERE id = $1;', [id]);
    if (owner !== req.user.username) {
      await db.query(
        'INSERT INTO mod_logs (mod_username, action_type, target_username, target_id, reason, timestamp) VALUES ($1, $2, $3, $4, $5, $6);',
        [req.user.username, 'suggestion delete', owner, id, 'Removed suggestion', Date.now()],
      );
    }
    log(`Suggestion #${id} deleted by ${req.user.username}`);
    res.json({ success: true });
  } catch (err) {
    log('Suggestion delete failure:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ---------------------------------------------------------------------------
// Flash Portal 2D: online level packs  (table: "portal-2d")
// One row = one published pack. "level-data" holds the pack as JSON:
//   { name, levels: [ { name, start, exit, platforms, hazards, buttons, button,
//                       triggers, wires, lasers, doors, plates, grids, noPortal, exitClosed, cubeStart } ] }
// Every identifier is double-quoted because the columns contain hyphens.
//
// The OFFICIAL pack is one special row whose username is "[official]". That
// value cannot be registered (usernames are limited to [A-Za-z0-9_-]), so only
// the admin-only /api/portal2d/official routes can ever write it.
// ---------------------------------------------------------------------------
const P2D_CANVAS_W = 640;
const P2D_CANVAS_H = 400;
const P2D_MAX_LEVELS = 30;
const P2D_MAX_PLATFORMS = 150;
const P2D_MAX_HAZARDS = 60;
const P2D_MAX_EXTRAS = 40; // doors / plates / grids / triggers / lasers / no-portal zones per level
const P2D_MAX_WIRES = 120;
const P2D_MAX_DATA_CHARS = 90000;
const P2D_MAX_PACKS_PER_USER = 25;
const P2D_PAGE_SIZE = 10;
const P2D_OFFICIAL = '[official]';
const P2D_OFFICIAL_MAX_LEVELS = 80;
const P2D_OFFICIAL_MAX_CHARS = 400000;

const p2dIsAdmin = (user) => !!(user && (user.is_admin || ADMIN_ENTITY_USERNAMES.has(String(user.username || '').toLowerCase())));
const p2dIsStaff = (user) => p2dIsAdmin(user) || hasModeratorPrivileges(user);

function p2dName(value, fallback, maxLen) {
  const cleaned = String(value ?? '')
    .replace(/[<>\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maxLen);
  return cleaned || fallback;
}

function p2dInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error('Level contains a non-numeric value.');
  return Math.min(max, Math.max(min, Math.round(n)));
}

function p2dNum(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error('Level contains a non-numeric value.');
  return Math.round(Math.min(max, Math.max(min, n)) * 100) / 100;
}

function p2dPoint(o) {
  if (!o || typeof o !== 'object') throw new Error('Level is missing a position.');
  return { x: p2dInt(o.x, 0, P2D_CANVAS_W), y: p2dInt(o.y, 0, P2D_CANVAS_H) };
}

function p2dRect(o) {
  const pt = p2dPoint(o);
  return {
    ...pt,
    w: p2dInt(o.w, 1, P2D_CANVAS_W),
    h: p2dInt(o.h, 1, P2D_CANVAS_H),
  };
}

function p2dList(list, max, label, mapper = p2dRect) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error(`Level ${label} must be a list.`);
  if (list.length > max) throw new Error(`Too many ${label} in one level (max ${max}).`);
  return list.map(mapper);
}

function p2dLogic(value) {
  return String(value || 'all').toLowerCase() === 'any' ? 'any' : 'all';
}

function p2dLaser(o) {
  if (!o || typeof o !== 'object') throw new Error('Laser is invalid.');
  const pt = p2dPoint(o);
  return {
    ...pt,
    angle: p2dNum(o.angle, -6.283185, 6.283185),
    length: p2dInt(o.length, 1, 900),
    enabled: o.enabled !== false,
  };
}

function p2dWire(o) {
  if (!o || typeof o !== 'object') throw new Error('Wire is invalid.');
  const sourceType = String(o.sourceType || o.source_type || '').toLowerCase();
  const targetType = String(o.targetType || o.target_type || '').toLowerCase();
  if (sourceType !== 'button' && sourceType !== 'trigger') throw new Error('Wire source must be a button or trigger.');
  if (targetType !== 'door') throw new Error('Wire target must be a door.');
  return {
    sourceType,
    sourceId: p2dInt(o.sourceId !== undefined ? o.sourceId : o.source_id, 0, P2D_MAX_EXTRAS - 1),
    targetType,
    targetId: p2dInt(o.targetId !== undefined ? o.targetId : o.target_id, 0, P2D_MAX_EXTRAS - 1),
  };
}

// Whitelists every field so only well-formed game data ever reaches the DB.
function p2dNormalizePack(input, fallbackName, maxLevels = P2D_MAX_LEVELS) {
  let raw = input;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new Error('Pack data is not valid JSON.');
    }
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.levels))
    throw new Error('Pack data must contain a list of levels.');
  if (raw.levels.length < 1) throw new Error('A pack needs at least one level.');
  if (raw.levels.length > maxLevels)
    throw new Error(`Too many levels in one pack (max ${maxLevels}).`);

  const levels = raw.levels.map((lvl, i) => {
    if (!lvl || typeof lvl !== 'object') throw new Error(`Level ${i + 1} is invalid.`);
    const explicitWires = Array.isArray(lvl.wires);
    const out = {
      name: p2dName(lvl.name, `Level ${i + 1}`, 60),
      start: p2dPoint(lvl.start),
      exit: p2dRect(lvl.exit),
      platforms: p2dList(lvl.platforms, P2D_MAX_PLATFORMS, 'platforms', (p) => {
        const r = p2dRect(p);
        return p && p.metal ? { ...r, metal: true } : r;
      }),
      hazards: p2dList(lvl.hazards, P2D_MAX_HAZARDS, 'hazards'),
      buttons: p2dList(
        Array.isArray(lvl.buttons) ? lvl.buttons : (lvl.button ? [lvl.button] : []),
        P2D_MAX_EXTRAS,
        'buttons',
        (b) => ({ ...p2dRect(b), pressed: false }),
      ),
      button: lvl.button ? { ...p2dRect(lvl.button), pressed: false } : null,
      triggers: p2dList(lvl.triggers, P2D_MAX_EXTRAS, 'triggers', (t) => ({ ...p2dRect(t), active: false })),
      exitClosed: !!lvl.exitClosed,
      cubeStart: lvl.cubeStart ? p2dRect(lvl.cubeStart) : null,
      noPortal: p2dList(lvl.noPortal, P2D_MAX_EXTRAS, 'no-portal zones'),
      doors: p2dList(lvl.doors, P2D_MAX_EXTRAS, 'doors', (d) => ({ ...p2dRect(d), logic: p2dLogic(d.logic || d.wireMode) })),
      wires: p2dList(lvl.wires, P2D_MAX_WIRES, 'wires', p2dWire),
      lasers: p2dList(lvl.lasers, P2D_MAX_EXTRAS, 'lasers', p2dLaser),
      grids: p2dList(lvl.grids, P2D_MAX_EXTRAS, 'grids'),
      plates: p2dList(lvl.plates, P2D_MAX_EXTRAS, 'plates', (p) => ({
        ...p2dRect(p),
        vx: p2dNum(p.vx, -20, 20),
        vy: p2dNum(p.vy, -25, 0),
      })),
    };
    if (!explicitWires && lvl.button && out.doors.length) {
      out.wires = out.doors.map((_, doorId) => ({
        sourceType: 'button', sourceId: 0, targetType: 'door', targetId: doorId,
      }));
    }
    for (const wire of out.wires) {
      const sourceCount = wire.sourceType === 'button' ? out.buttons.length : out.triggers.length;
      if (wire.sourceId >= sourceCount) throw new Error(`Wire ${wire.sourceType} source ${wire.sourceId + 1} does not exist.`);
      if (wire.targetId >= out.doors.length) throw new Error(`Wire door target ${wire.targetId + 1} does not exist.`);
    }
    if (out.platforms.length < 1) throw new Error(`Level ${i + 1} needs at least one platform.`);
    return out;
  });
  return { name: p2dName(raw.name, fallbackName, 100), levels };
}

function p2dParseId(value) {
  if (!/^\d{1,10}$/.test(String(value))) return null;
  const id = parseInt(value, 10);
  return id > 0 && id < 2147483647 ? id : null;
}

function p2dBlockedUser(user) {
  if (user.is_banned) return 'Your account is banned.';
  if (Number(user.timeout_until) > Date.now())
    return 'You are timed out and cannot publish right now.';
  return null;
}

// Who am I? Lets the game show/hide admin tools. The server still re-checks every request.
app.get('/api/portal2d/me', authenticateToken, (req, res) => {
  res.json({
    username: req.user.username,
    isAdmin: p2dIsAdmin(req.user),
    isStaff: p2dIsStaff(req.user),
  });
});

app.get('/api/portal2d/levels', authenticateToken, async (req, res) => {
  try {
    const page = Math.max(0, parseInt(req.query.index ?? '0', 10) || 0);
    const mine = req.query.mine === '1';
    const params = [P2D_PAGE_SIZE + 1, page * P2D_PAGE_SIZE, P2D_OFFICIAL];
    let where = 'WHERE p."username" <> $3';
    if (mine) {
      params.push(req.user.username);
      where += ' AND p."username" = $4';
    }
    const r = await db.query(
      `SELECT p."level-id" AS id, p."level-name" AS name, p."username", pi.image_data
       FROM "portal-2d" p LEFT JOIN LATERAL (SELECT image_data FROM profile_images WHERE LOWER(TRIM(LEADING '@' FROM username)) = LOWER(p."username") ORDER BY (username = p."username") DESC LIMIT 1) pi ON true ${where}
       ORDER BY "level-id" DESC LIMIT $1 OFFSET $2;`,
      params,
    );
    const staff = p2dIsStaff(req.user);
    const levels = r.rows.slice(0, P2D_PAGE_SIZE).map((row) => ({
      ...row,
      // decided here, never by the client
      canDelete: staff || row.username === req.user.username,
      isOwner: row.username === req.user.username,
    }));
    res.json({
      levels,
      hasMore: r.rows.length > P2D_PAGE_SIZE,
      viewer: { username: req.user.username, isAdmin: p2dIsAdmin(req.user), isStaff: staff },
    });
  } catch (err) {
    log('Portal2D list failure:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

app.get('/api/portal2d/levels/:id', authenticateToken, async (req, res) => {
  try {
    const id = p2dParseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid pack ID.' });
    const r = await db.query(
      `SELECT p."level-id" AS id, p."level-name" AS name, p."username", p."level-data" AS data, pi.image_data
       FROM "portal-2d" p LEFT JOIN LATERAL (SELECT image_data FROM profile_images WHERE LOWER(TRIM(LEADING '@' FROM username)) = LOWER(p."username") ORDER BY (username = p."username") DESC LIMIT 1) pi ON true WHERE p."level-id" = $1;`,
      [id],
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'No pack with that ID.' });
    const row = r.rows[0];
    try {
      row.data = JSON.parse(row.data);
    } catch {
      return res.status(500).json({ error: 'Stored pack data is corrupted.' });
    }
    res.json(row);
  } catch (err) {
    log('Portal2D fetch failure:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

app.post('/api/portal2d/levels', authenticateToken, async (req, res) => {
  try {
    const blocked = p2dBlockedUser(req.user);
    if (blocked) return res.status(403).json({ error: blocked });

    const name = p2dName(req.body?.name, 'Untitled pack', 100);
    let pack;
    try {
      pack = p2dNormalizePack(req.body?.data, name);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    pack.name = name;
    const json = JSON.stringify(pack);
    if (json.length > P2D_MAX_DATA_CHARS)
      return res.status(413).json({ error: 'Pack is too large to publish. Remove some levels or platforms.' });

    const count = await db.query(
      'SELECT COUNT(*)::int AS n FROM "portal-2d" WHERE "username" = $1;',
      [req.user.username],
    );
    if (count.rows[0].n >= P2D_MAX_PACKS_PER_USER)
      return res.status(400).json({
        error: `You already have ${P2D_MAX_PACKS_PER_USER} published packs. Delete one first.`,
      });

    const r = await db.query(
      `INSERT INTO "portal-2d" ("level-name", "username", "level-data")
       VALUES ($1, $2, $3) RETURNING "level-id" AS id;`,
      [name, req.user.username, json],
    );
    log(`Portal2D publish: #${r.rows[0].id} "${name}" by ${req.user.username}`);
    res.json({ success: true, id: r.rows[0].id });
  } catch (err) {
    log('Portal2D publish failure:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// Owners can update a pack they published (e.g. after editing their copy).
app.put('/api/portal2d/levels/:id', authenticateToken, async (req, res) => {
  try {
    const blocked = p2dBlockedUser(req.user);
    if (blocked) return res.status(403).json({ error: blocked });
    const id = p2dParseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid pack ID.' });

    const found = await db.query('SELECT "username" FROM "portal-2d" WHERE "level-id" = $1;', [id]);
    if (!found.rows[0]) return res.status(404).json({ error: 'No pack with that ID.' });
    if (found.rows[0].username !== req.user.username)
      return res.status(403).json({ error: 'You can only update your own packs.' });

    const name = p2dName(req.body?.name, 'Untitled pack', 100);
    let pack;
    try {
      pack = p2dNormalizePack(req.body?.data, name);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    pack.name = name;
    const json = JSON.stringify(pack);
    if (json.length > P2D_MAX_DATA_CHARS)
      return res.status(413).json({ error: 'Pack is too large to publish. Remove some levels or platforms.' });

    await db.query(
      'UPDATE "portal-2d" SET "level-name" = $1, "level-data" = $2 WHERE "level-id" = $3;',
      [name, json, id],
    );
    log(`Portal2D update: #${id} "${name}" by ${req.user.username}`);
    res.json({ success: true, id });
  } catch (err) {
    log('Portal2D update failure:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

app.delete('/api/portal2d/levels/:id', authenticateToken, async (req, res) => {
  try {
    const id = p2dParseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid pack ID.' });
    const r = await db.query(
      'SELECT "username" FROM "portal-2d" WHERE "level-id" = $1;',
      [id],
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'No pack with that ID.' });

    const owner = r.rows[0].username;
    if (owner === P2D_OFFICIAL)
      return res.status(403).json({ error: 'The official pack is managed from the admin dev tools.' });
    if (owner !== req.user.username && !p2dIsStaff(req.user))
      return res.status(403).json({ error: 'You can only delete your own packs.' });

    await db.query('DELETE FROM "portal-2d" WHERE "level-id" = $1;', [id]);
    if (owner !== req.user.username) {
      await db.query(
        'INSERT INTO mod_logs (mod_username, action_type, target_username, target_id, reason, timestamp) VALUES ($1, $2, $3, $4, $5, $6);',
        [req.user.username, 'portal2d delete', owner, id, 'Removed published Portal 2D pack', Date.now()],
      );
    }
    log(`Portal2D delete: #${id} by ${req.user.username}`);
    res.json({ success: true });
  } catch (err) {
    log('Portal2D delete failure:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ----- Official pack (admin only to write, everyone to read) -----
async function p2dReadOfficial() {
  const r = await db.query(
    `SELECT "level-id" AS id, "level-name" AS name, "level-data" AS data
     FROM "portal-2d" WHERE "username" = $1 ORDER BY "level-id" ASC LIMIT 1;`,
    [P2D_OFFICIAL],
  );
  if (!r.rows[0]) return null;
  const row = r.rows[0];
  return { id: row.id, name: row.name, data: JSON.parse(row.data) };
}

async function p2dWriteOfficial(pack, actor, note) {
  const json = JSON.stringify(pack);
  if (json.length > P2D_OFFICIAL_MAX_CHARS) {
    const err = new Error('Official pack is too large.');
    err.status = 413;
    throw err;
  }
  const upd = await db.query(
    'UPDATE "portal-2d" SET "level-name" = $1, "level-data" = $2 WHERE "username" = $3;',
    [pack.name, json, P2D_OFFICIAL],
  );
  if (!upd.rowCount) {
    await db.query(
      'INSERT INTO "portal-2d" ("level-name", "username", "level-data") VALUES ($1, $2, $3);',
      [pack.name, P2D_OFFICIAL, json],
    );
  }
  await db.query(
    'INSERT INTO mod_logs (mod_username, action_type, target_username, target_id, reason, timestamp) VALUES ($1, $2, $3, $4, $5, $6);',
    [actor, 'portal2d official', P2D_OFFICIAL, 0, note, Date.now()],
  );
  log(`Portal2D official: ${note} by ${actor}`);
}

app.get('/api/portal2d/official', authenticateToken, async (req, res) => {
  try {
    const official = await p2dReadOfficial();
    if (!official) return res.status(404).json({ error: 'No official pack has been published yet.', code: 'NO_OFFICIAL' });
    res.json(official);
  } catch (err) {
    log('Portal2D official read failure:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// Replace the whole official pack (reordering, removing, bulk edits).
app.put('/api/portal2d/official', authenticateToken, async (req, res) => {
  res.status(410).json({ error: 'Official packs are updated by replacing the exported Portal: The Kindle Version HTML. Use Sledgehammer Editor export.' });
});

// Append one playtested level to the end of the official pack.
app.post('/api/portal2d/official/levels', authenticateToken, async (req, res) => {
  res.status(410).json({ error: 'Official packs are updated by replacing the exported Portal: The Kindle Version HTML. Use Sledgehammer Editor export.' });
});

// Remove the server copy so everyone falls back to the chambers built into the game.
app.delete('/api/portal2d/official', authenticateToken, async (req, res) => {
  res.status(410).json({ error: 'Official packs are updated by replacing the exported Portal: The Kindle Version HTML. Use Sledgehammer Editor export.' });
});


const server = app.listen(process.env.PORT || 10000, '0.0.0.0', () =>
  log(`Node strictly bound to port: ${process.env.PORT || 10000}`),
);
const wss = new WebSocketServer({ server });

const WS_HEARTBEAT_MS = Number(process.env.WS_HEARTBEAT_MS || 30000);
const heartbeatTimer = setInterval(() => {
  activeClients.forEach((client, username) => {
    if (client.ws.isAlive === false) {
      log(`WS heartbeat timeout: ${username}`);
      activeClients.delete(username);
      return client.ws.terminate();
    }
    client.ws.isAlive = false;
    try { client.ws.ping(); } catch { client.ws.terminate(); }
  });
}, WS_HEARTBEAT_MS);
heartbeatTimer.unref();

const ALLOWED_CHANNELS = {
  public: 'messages',
  topic: 'topic_messages',
  neighborhood: 'neighborhood_posts',
  dm: 'dms',
  comment: 'neighborhood_comments',
  neighborhood_comment: 'neighborhood_comments',
};

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  let authUser = null;
  let userRoles = {
    role: {
      role: '',
      prefix: '',
      style: '',
      class: '',
    },
    is_banned: false,
    timeout_until: 0,
    last_ip: null,
  };

  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'auth') {
        try {
          const decoded = jwt.verify(data.token, JWT_SECRET);
          authUser = sanitizeUsername(decoded.username);
          userRoles = await getUserRoles(authUser);
          log(
            `WS Auth Session Established: ${authUser} (Admin: ${userRoles.is_admin}, Mod: ${userRoles.is_moderator})`,
          );
          if (userRoles.is_banned) {
            log(`WS Termination Triggered: Banned or Timed out user session`);
            ws.send(
              JSON.stringify({ type: 'terminated', reason: 'You are banned' }),
            );
            ws.close();
            return;
          }
          if (userRoles.timeout_until > Date.now()) {
            log(`WS Termination Triggered: Banned or Timed out user session`);
            ws.send(
              JSON.stringify({
                type: 'terminated',
                reason: `You are timed out until ${new Date(userRoles.timeout_until).toLocaleString()}`,
              }),
            );
            ws.close();
            return;
          }
          activeClients.set(authUser, {
            ws,
            mode: 'public',
            target: '',
            userRoles: userRoles,
            lastIp: req.socket.remoteAddress,
          });
          const topicsRes = await db.query(
            'SELECT * FROM topics ORDER BY id DESC;',
          );
          ws.send(
            JSON.stringify({
              type: 'topics_update',
              topics: topicsRes.rows,
              user_roles: userRoles,
            }),
          );
          broadcastSystemUpdate(getRosterPayload());
          ws.send(
            JSON.stringify({ type: 'auth_success', userRoles: userRoles }),
          );
        } catch (e) {
          log('WS Authentication Invalid:', e.message);
          ws.send(JSON.stringify({ type: 'terminated' }));
        }
        return;
      }
      if (!authUser) return;

      if (data.type === 'switch_context') {
        const client = activeClients.get(authUser);
        if (client) {
          client.mode = data.mode;
          client.target = data.target;
          broadcastSystemUpdate(getRosterPayload());
        }
        return;
      }

      if (
        [
          'message',
          'topic_message',
          'dm',
          'neighborhood_post',
          'neighborhood_comment',
          'create_topic',
        ].includes(data.type)
      ) {
        log(
          `${data.type} called by ${authUser} (${activeClients.get(authUser).userRoles.role.role}): ${data.content}`,
        );
        const tStr = String(Date.now());
        const mode =
          data.type === 'topic_message'
            ? 'topic'
            : data.type === 'dm'
              ? 'dm'
              : data.type === 'neighborhood_post' ||
                data.type === 'neighborhood_comment'
                ? 'neighborhood'
                : 'public';
        const target = data.target || data.slug || '';

        if (data.type === 'message') {
          const content = sanitize(data.content);
          await db.query(
            'INSERT INTO messages (username, timestamp, content, sender) VALUES ($1, $2, $3, $4);',
            [authUser, tStr, content, authUser],
          );
        }
        if (data.type === 'topic_message') {
          const content = sanitize(data.content);
          const target = sanitize(data.target);
          await db.query(
            'INSERT INTO topic_messages (topic_slug, username, timestamp, content, sender) VALUES ($1, $2, $3, $4, $5);',
            [target, authUser, tStr, content, authUser],
          );
        }
        if (data.type === 'dm') {
          const content = sanitize(data.content);
          const target = sanitizeUsername(data.target);
          await db.query(
            'INSERT INTO dms (sender, receiver, timestamp, content, username) VALUES ($1, $2, $3, $4, $5);',
            [authUser, target, tStr, content, authUser],
          );
        }
        if (data.type === 'neighborhood_post') {
          const title = sanitize(data.title);
          const content = sanitize(data.content);
          await db.query(
            'INSERT INTO neighborhood_posts (username, title, content, timestamp, sender) VALUES ($1, $2, $3, $4, $5);',
            [authUser, title, content, tStr, authUser],
          );
        }
        if (data.type === 'neighborhood_comment') {
          const content = sanitize(data.content);
          const post_id = parseInt(data.post_id, 10);
          await db.query(
            'INSERT INTO neighborhood_comments (post_id, username, content, timestamp, sender) VALUES ($1, $2, $3, $4, $5);',
            [post_id, authUser, content, tStr, authUser],
          );
        }
        if (data.type === 'create_topic') {
          const title = sanitize(data.title);
          const slug = title
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '-')
            .slice(0, 50);
          await db.query(
            'INSERT INTO topics (slug, title, username, timestamp) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING;',
            [slug, title, authUser, tStr],
          );
        }

        let livePayload = null;
        if (data.type === 'message') {
          const role = (await getUserRoles(authUser)).role;
          const latest = await db.query('SELECT m.id, m.username, m.timestamp, m.content, m.is_deleted, m.deleted_by, m.sender, pi.image_data FROM messages m LEFT JOIN LATERAL (SELECT image_data FROM profile_images WHERE LOWER(TRIM(LEADING \'@\' FROM username)) = LOWER(m.username) ORDER BY (username = m.username) DESC LIMIT 1) pi ON true WHERE m.username = $1 AND m.timestamp = $2 ORDER BY m.id DESC LIMIT 1;', [authUser, tStr]);
          if (latest.rows[0]) livePayload = { type: 'live_message', channel: 'public', message: { ...latest.rows[0], role } };
        } else if (data.type === 'topic_message') {
          const role = (await getUserRoles(authUser)).role;
          const latest = await db.query('SELECT m.id, m.username, m.timestamp, m.content, m.is_deleted, m.deleted_by, m.sender, m.topic_slug, pi.image_data FROM topic_messages m LEFT JOIN LATERAL (SELECT image_data FROM profile_images WHERE LOWER(TRIM(LEADING \'@\' FROM username)) = LOWER(m.username) ORDER BY (username = m.username) DESC LIMIT 1) pi ON true WHERE m.username = $1 AND m.timestamp = $2 AND m.topic_slug = $3 ORDER BY m.id DESC LIMIT 1;', [authUser, tStr, target]);
          if (latest.rows[0]) livePayload = { type: 'live_message', channel: 'topic', target, message: { ...latest.rows[0], role } };
        } else if (data.type === 'dm') {
          const role = (await getUserRoles(authUser)).role;
          const latest = await db.query('SELECT d.id, d.sender AS username, d.receiver, d.timestamp, d.content, d.is_deleted, d.deleted_by, pi.image_data FROM dms d LEFT JOIN LATERAL (SELECT image_data FROM profile_images WHERE LOWER(TRIM(LEADING \'@\' FROM username)) = LOWER(d.sender) ORDER BY (username = d.sender) DESC LIMIT 1) pi ON true WHERE d.sender = $1 AND d.receiver = $2 AND d.timestamp = $3 ORDER BY d.id DESC LIMIT 1;', [authUser, target, tStr]);
          if (latest.rows[0]) livePayload = { type: 'live_message', channel: 'dm', target, receiver: target, sender: authUser, message: { ...latest.rows[0], role } };
        } else if (data.type === 'neighborhood_post') {
          const role = (await getUserRoles(authUser)).role;
          const latest = await db.query('SELECT p.id, p.username, p.title, p.content, p.timestamp, p.is_deleted, p.deleted_by, p.sender, pi.image_data FROM neighborhood_posts p LEFT JOIN LATERAL (SELECT image_data FROM profile_images WHERE LOWER(TRIM(LEADING \'@\' FROM username)) = LOWER(p.username) ORDER BY (username = p.username) DESC LIMIT 1) pi ON true WHERE p.username = $1 AND p.timestamp = $2 ORDER BY p.id DESC LIMIT 1;', [authUser, tStr]);
          if (latest.rows[0]) livePayload = { type: 'live_neighborhood_post', message: { ...latest.rows[0], role, comments: [] } };
        }

        if (livePayload) {
          broadcastSystemUpdate(livePayload, (c, username) => {
            if (mode === 'dm') {
              return c.mode === 'dm' && c.target === (username === authUser ? target : authUser) && (username === authUser || username === target);
            }
            return c.mode === mode && c.target === target;
          });
        } else if (data.type === 'neighborhood_comment') {
          broadcastSystemUpdate({ type: 'refresh_feed' }, (c) => c.mode === 'neighborhood');
        }
      }

      if (data.type === 'mod_delete' || data.type === 'mod_restore') {
        const targetTable = ALLOWED_CHANNELS[data.channel];
        log(
          `MOD PACKET: action=${data.type}, targetSpace=${data.channel}, table=${targetTable}, id=${data.id}`,
        );

        if (!targetTable) {
          log(
            `CRITICAL: Infrastructure target space undefined for channel ${data.channel}`,
          );
          return;
        }

        const res = await db.query(
          `SELECT username, sender, deleted_by FROM ${targetTable} WHERE id = $1;`,
          [data.id],
        );
        const targetObj = res.rows[0];
        if (!targetObj) {
          log(`CRITICAL: ID ${data.id} not tracked in ${targetTable}`);
          return;
        }
        const owner = targetObj.username || targetObj.sender;
        if (!owner) {
          log(`CRITICAL: Owner not found for ID ${data.id} in ${targetTable}`);
          return;
        }

        const isOwner = owner === authUser;
        const canUndo =
          hasAdminPrivileges(userRoles) ||
          (hasModeratorPrivileges(userRoles) &&
            targetObj.deleted_by === authUser);
        const canDelete =
          isOwner ||
          hasAdminPrivileges(userRoles) ||
          hasModeratorPrivileges(userRoles);

        // Deletes
        if (data.type === 'mod_delete' && canDelete) {
          const reason =
            data.reason ||
            (hasAdminPrivileges(userRoles)
              ? "Admin doesn't need any reasons"
              : sanitize('No reason provided'));
          log(
            `EXECUTING DATA PURGE: targetId=${data.id} in ${targetTable} by=${authUser}`,
          );
          await db.query(
            `UPDATE ${targetTable} SET is_deleted = true, deleted_by = $1 WHERE id = $2;`,
            [authUser, data.id],
          );
          if (
            hasModeratorPrivileges(userRoles) ||
            hasAdminPrivileges(userRoles)
          ) {
            await db.query(
              'INSERT INTO mod_logs (mod_username, action_type, target_username, target_id, reason, timestamp) VALUES ($1, $2, $3, $4, $5, $6);',
              [authUser, 'delete', owner, data.id, reason, Date.now()],
            );
          }
          broadcastSystemUpdate({ type: 'refresh_feed' });
          // Restores
        } else if (data.type === 'mod_restore' && canUndo) {
          log(
            `EXECUTING DATA RESTORE: targetId=${data.id} in ${targetTable} by=${authUser}`,
          );
          await db.query(
            `UPDATE ${targetTable} SET is_deleted = false, deleted_by = NULL WHERE id = $1;`,
            [data.id],
          );
          broadcastSystemUpdate({ type: 'refresh_feed' });
        } else {
          log(
            `MOD ACTION REJECTED: Access level mismatch or ownership collision`,
          );
        }
      }

      // Moderating users
      if (
        hasAdminPrivileges(userRoles) ||
        hasModeratorPrivileges(userRoles)
      ) {
        // Timeouts
        if (data.type === 'mod_timeout') {
          const target = sanitizeUsername(data.target);
          const targetRoles = await getUserRoles(target);
          if (hasAdminPrivileges(targetRoles))
            return ws.send(
              JSON.stringify({
                type: 'error_alert',
                message: 'System operator immunity detected.',
              }),
            );
          const duration = Math.min(
            Math.max(1, parseInt(data.duration, 10)),
            43200,
          ); // Max 30 days
          const reason =
            sanitize(data.reason || '') ||
            (hasAdminPrivileges(userRoles)
              ? "Admin doesn't need any reasons"
              : sanitize('No reason provided'));
          log(
            `USER TIMEOUT: target=${target}, duration=${duration}m, by=${authUser}`,
          );
          await db.query(
            'UPDATE users SET timeout_until = $1 WHERE username = $2;',
            [Date.now() + duration * 60 * 1000, target],
          );
          await db.query(
            'INSERT INTO mod_logs (mod_username, action_type, target_username, reason, timestamp) VALUES ($1, $2, $3, $4, $5);',
            [authUser, 'timeout', target, reason, Date.now()],
          );
          if (activeClients.has(target)) {
            activeClients.get(target).ws.send(
              JSON.stringify({
                type: 'terminated',
                reason: 'You were timed out by a moderator.',
              }),
            );
            activeClients.get(target).ws.close();
          }
        }
        // Kicks
        if (data.type === 'mod_kick') {
          if (!activeClients.has(data.target))
            return log(`KICK TARGET ${data.target} NOT CONNECTED`, data.target);
          const targetRoles = await getUserRoles(data.target);
          if (
            hasAdminPrivileges(userRoles) ||
            (hasModeratorPrivileges(userRoles) &&
              !hasAdminPrivileges(targetRoles) &&
              data.target !== authUser)
          ) {
            const client = activeClients.get(data.target);
            const reason =
              data.reason ||
              (hasAdminPrivileges(userRoles)
                ? "Admin doesn't need any reasons"
                : sanitize('No reason provided'));
            client.ws.send(
              JSON.stringify({
                type: 'terminated',
                reason: 'You were kicked by a moderator.',
              }),
            );
            client.ws.close();
            activeClients.delete(data.target);
            broadcastSystemUpdate(getRosterPayload());
            await db.query(
              'INSERT INTO mod_logs (mod_username, action_type, target_username, reason, timestamp) VALUES ($1, $2, $3, $4, $5);',
              [authUser, 'kick', data.target, reason, Date.now()],
            );
          }
        }
        if (hasAdminPrivileges(userRoles)) {
          // Bans
          if (data.type === 'mod_ban') {
            const target = sanitizeUsername(data.target);
            const reason =
              sanitize(data.reason || '') || "Admin doesn't need any reasons";
            log(`ADMIN BAN: target=${target}, by=${authUser}`);
            await db.query(
              'UPDATE users SET is_banned = true WHERE username = $1;',
              [target],
            );
            await db.query(
              'INSERT INTO mod_logs (mod_username, action_type, target_username, reason, timestamp) VALUES ($1, $2, $3, $4, $5);',
              [authUser, 'ban', target, reason, Date.now()],
            );
            if (activeClients.has(target)) {
              activeClients.get(target).ws.send(
                JSON.stringify({
                  type: 'terminated',
                  reason: 'You were banned by a moderator.',
                }),
              );
              activeClients.get(target).ws.close();
            }
          }
          // Pardons
          if (data.type === 'mod_pardon') {
            const target = sanitizeUsername(data.target);
            log(`ADMIN PARDON: target=${target}, by=${authUser}`);
            await db.query(
              'UPDATE users SET is_banned = false, timeout_until = 0 WHERE username = $1;',
              [target],
            );
          }
        }
      }
    } catch (err) {
      log('WS Infrastructure Logic Failure:', err.message);
    }
  });
  ws.on('close', () => {
    if (authUser) {
      log(`WS Terminal closed: ${authUser}`);
      activeClients.delete(authUser);
      broadcastSystemUpdate(getRosterPayload());
    }
  });
});
