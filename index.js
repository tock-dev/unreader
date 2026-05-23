import express from 'express'
import { WebSocketServer, WebSocket } from 'ws'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import pkg from 'pg'
import cors from 'cors'
import fs from 'node:fs'

const { Pool } = pkg
const JWT_SECRET = process.env.JWT_SECRET || 'brutalist_secret_key_123'
const DO_LOGGING = true;

function log(...args) {
  if (DO_LOGGING) console.log(`[SERVER]`, ...args);
}

// CORRECT RELEASE URL
let connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/unreader';

if (connectionString && !connectionString.startsWith('postgresql://') && !connectionString.startsWith('postgres://')) {
  log("Formatting DATABASE_URL: adding postgresql:// prefix");
  connectionString = `postgresql://postgres:postgres@${connectionString}/unreader`;
}

const db = new Pool({ connectionString })

async function initDatabase() {
  try {
    log("Verifying structural integrity...");
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, 
        timeout_until BIGINT DEFAULT 0, is_banned BOOLEAN DEFAULT false,
        is_admin BOOLEAN DEFAULT false, is_moderator BOOLEAN DEFAULT false, last_ip TEXT
      );
      
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_moderator BOOLEAN DEFAULT false;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS last_ip TEXT;

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
    `);
    log("Structural migration successful.");
  } catch (err) { log("DB MIGRATION FAILURE:", err); process.exit(1); }
}
initDatabase();

const app = express()
app.set('trust proxy', true);
app.use(async (req, res, next) => {
  console.log('Received raw request')
  if (req.url.startsWith('/api')
    || !req.url.endsWith('.html')
    || '..' in req.url) next()
  else {
    if (!fs.existsSync('.' + req.url)) {
      console.log('Requested inexistant file')
      res.status(404).send('<h1>File not found</h1>')
      return
    }
    console.log('Requested ' + req.url)
    res.status(200).sendFile('.' + req.url)
  }
})
app.use(cors());
app.use(express.json())

async function getUserRoles(username) {
  const r = await db.query('SELECT is_admin, is_moderator, timeout_until, is_banned, last_ip FROM users WHERE username = $1;', [username]);
  return r.rows[0] || { is_admin: false, is_moderator: false, is_banned: false, timeout_until: 0, last_ip: null };
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
    log("Auth Token verification failed:", err.message);
    return res.status(403).json({ error: 'Invalid token' });
  }
}

const activeClients = new Map()
function broadcastSystemUpdate(payloadObj) {
  const msgStr = JSON.stringify(payloadObj);
  activeClients.forEach((c, username) => {
    if (c.readyState === WebSocket.OPEN) {
      c.send(msgStr);
    } else {
      log(`Pruning inactive connection: ${username}`);
      activeClients.delete(username);
    }
  });
}

app.get('/dm-contacts', authenticateToken, async (req, res) => {
  const result = await db.query(`SELECT DISTINCT username FROM (SELECT receiver AS username FROM dms WHERE sender = $1 UNION SELECT sender AS username FROM dms WHERE receiver = $1) AS c WHERE username != $1;`, [req.user.username]);
  res.json(result.rows.map(r => r.username));
});

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  log(`Registration request: ${username} from ${ip}`);
  try {
    const hash = await bcrypt.hash(password, 10);
    await db.query('INSERT INTO users (username, password_hash, last_ip) VALUES ($1, $2, $3);', [username, hash, ip]);
    await db.query('INSERT INTO profiles (username) VALUES ($1) ON CONFLICT DO NOTHING;', [username]);
    res.json({ token: jwt.sign({ username }, JWT_SECRET), username });
  } catch (err) {
    log("Registration collision/error:", err.message);
    res.status(400).json({ error: 'Username already taken' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  log(`Login request: ${username} from ${ip}`);
  try {
    const result = await db.query('SELECT * FROM users WHERE username = $1;', [username]);
    const user = result.rows[0];
    if (!user || user.is_banned || !(await bcrypt.compare(password, user.password_hash))) {
      log(`Login REJECTED for ${username}`);
      return res.status(401).json({ error: 'Rejected' });
    }
    await db.query('UPDATE users SET last_ip = $1 WHERE username = $2;', [ip, username]);
    log(`Login SUCCESS: ${username}`);
    res.json({ token: jwt.sign({ username }, JWT_SECRET), username });
  } catch (err) {
    log("Login logic breakdown:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.get('/api/profile/:username', authenticateToken, async (req, res) => {
  const r = await db.query('SELECT p.*, u.is_admin, u.is_moderator FROM profiles p JOIN users u ON p.username = u.username WHERE p.username = $1;', [req.params.username]);
  if (!r.rows[0]) return res.json({ username: req.params.username, bio: 'Hello world.', location: 'Cyberspace', avatar_emoji: '👤', is_admin: false, is_moderator: false });
  res.json(r.rows[0]);
});

app.post('/api/profile', authenticateToken, async (req, res) => {
  const { bio, location, avatar_emoji } = req.body;
  await db.query('INSERT INTO profiles (username, bio, location, avatar_emoji) VALUES ($4, $1, $2, $3) ON CONFLICT (username) DO UPDATE SET bio=$1, location=$2, avatar_emoji=$3;', [bio, location, avatar_emoji, req.user.username]);
  res.json({ success: true });
});

app.get('/api/mod-logs', authenticateToken, async (req, res) => {
  if (!req.user.is_admin && !req.user.is_moderator) return res.status(403).json({ error: 'Unauthorized' });
  const r = await db.query('SELECT * FROM mod_logs ORDER BY id DESC LIMIT 50;');
  res.json(r.rows);
});

app.get('/api/admin/find-user/:username', authenticateToken, async (req, res) => {
  if (!req.user.is_admin && !req.user.is_moderator) return res.status(403).json({ error: 'Unauthorized' });
  log(`Admin User-Search: target=${req.params.username} by=${req.user.username} who is admin (${req.user.is_admin}) and moderator (${req.user.is_moderator})`);
  const r = await db.query('SELECT username, last_ip, timeout_until, is_banned, is_admin, is_moderator FROM users WHERE username = $1;', [req.params.username]);
  if (!r.rows[0]) return res.status(404).json({ error: 'User not found' });
  const userInfo = r.rows[0];
  // Redact IP for moderators (non-admins)
  if (!req.user.is_admin) {
    userInfo.last_ip = "[redacted]";
  }
  // Find alts (other users with same IP)
  let alts = [];
  if (userInfo.last_ip && userInfo.last_ip !== "[redacted]") {
    const altsRes = await db.query('SELECT username FROM users WHERE last_ip = $1 AND username <> $2;', [userInfo.last_ip, userInfo.username]);
    alts = altsRes.rows.map(r => r.username);
  }
  res.json({ ...userInfo, alts });
});

app.post('/api/admin/set-role', authenticateToken, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Unauthorized' });
  const { target, is_moderator } = req.body;
  log(`Role Assignment: ${target} -> mod=${is_moderator} by=${req.user.username}`);
  await db.query('UPDATE users SET is_moderator = $1 WHERE username = $2;', [is_moderator, target]);
  res.json({ success: true });
});

app.get('/history', authenticateToken, async (req, res) => {
  const off = parseInt(req.query.index ?? '0', 10) * 10;
  const r = await db.query('SELECT m.*, u.is_admin, u.is_moderator FROM messages m LEFT JOIN users u ON m.username = u.username ORDER BY m.id DESC LIMIT 10 OFFSET $1;', [off]);
  res.json(r.rows.reverse());
});

app.get('/dm-history', authenticateToken, async (req, res) => {
  const off = parseInt(req.query.index ?? '0', 10) * 10;
  // FIX: Force ALIAS and explicit join for name consistency
  const r = await db.query(`
    SELECT d.id, d.sender AS username, d.receiver, d.timestamp, d.content, d.is_deleted, d.deleted_by, u.is_admin, u.is_moderator 
    FROM dms d 
    LEFT JOIN users u ON d.sender = u.username 
    WHERE (d.sender = $1 AND d.receiver = $2) OR (d.sender = $2 AND d.receiver = $1) 
    ORDER BY d.id DESC LIMIT 10 OFFSET $3;
  `, [req.user.username, req.query.target, off]);
  res.json(r.rows.reverse());
});

app.get('/topic-history', authenticateToken, async (req, res) => {
  const off = parseInt(req.query.index ?? '0', 10) * 10;
  const r = await db.query('SELECT tm.*, u.is_admin, u.is_moderator FROM topic_messages tm LEFT JOIN users u ON tm.username = u.username WHERE tm.topic_slug = $1 ORDER BY tm.id DESC LIMIT 10 OFFSET $2;', [req.query.slug, off]);
  res.json(r.rows.reverse());
});

app.get('/neighborhood-history', authenticateToken, async (req, res) => {
  const off = parseInt(req.query.index ?? '0', 10) * 10;
  const query = `
    SELECT p.*, u.is_admin, u.is_moderator, 
    COALESCE(json_agg(json_build_object('id', c.id, 'username', c.username, 'content', c.content, 'timestamp', c.timestamp, 'is_deleted', c.is_deleted, 'deleted_by', c.deleted_by, 'is_admin', cu.is_admin, 'is_moderator', cu.is_moderator) ORDER BY c.id ASC) FILTER (WHERE c.id IS NOT NULL), '[]') as comments 
    FROM neighborhood_posts p 
    LEFT JOIN users u ON p.username = u.username
    LEFT JOIN neighborhood_comments c ON p.id = c.post_id 
    LEFT JOIN users cu ON c.username = cu.username
    GROUP BY p.id, u.id ORDER BY p.id DESC LIMIT 10 OFFSET $1;`;
  const posts = await db.query(query, [off]);
  res.json(posts.rows.reverse());
});

const server = app.listen(process.env.PORT || 10000, '0.0.0.0', () => log(`Node strictly bound to port: ${process.env.PORT || 10000}`));
const wss = new WebSocketServer({ server });

const ALLOWED_CHANNELS = { 'public': 'messages', 'topic': 'topic_messages', 'neighborhood': 'neighborhood_posts', 'dm': 'dms', 'comment': 'neighborhood_comments', 'neighborhood_comment': 'neighborhood_comments' };

wss.on('connection', (ws, req) => {
  let authUser = null;
  let userRoles = { is_admin: false, is_moderator: false };

  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'auth') {
        try {
          const decoded = jwt.verify(data.token, JWT_SECRET);
          authUser = decoded.username;
          userRoles = await getUserRoles(authUser);
          log(`WS Auth Session Established: ${authUser} (Admin: ${userRoles.is_admin}, Mod: ${userRoles.is_moderator})`);
          if (userRoles.is_banned || BigInt(userRoles.timeout_until) > BigInt(Date.now())) {
            log(`WS Termination Triggered: Banned or Timed out user session`);
            ws.send(JSON.stringify({ type: 'terminated' })); ws.close(); return;
          }
          activeClients.set(authUser, ws);
          broadcastSystemUpdate({ type: 'roster_update', users: Array.from(activeClients.keys()) });
          const topicsRes = await db.query('SELECT * FROM topics ORDER BY id DESC;');
          ws.send(JSON.stringify({ type: 'topics_update', topics: topicsRes.rows, user_roles: userRoles }));
        } catch (e) { log("WS Authentication Invalid:", e.message); ws.send(JSON.stringify({ type: 'terminated' })); }
        return;
      }
      if (!authUser) return;

      if (['message', 'topic_message', 'dm', 'neighborhood_post', 'neighborhood_comment'].includes(data.type)) {
        const tStr = String(Date.now());
        if (data.type === 'message') await db.query('INSERT INTO messages (username, timestamp, content, sender) VALUES ($1, $2, $3, $4);', [authUser, tStr, data.content, authUser]);
        if (data.type === 'topic_message') await db.query('INSERT INTO topic_messages (topic_slug, username, timestamp, content, sender) VALUES ($1, $2, $3, $4, $5);', [data.target, authUser, tStr, data.content, authUser]);
        if (data.type === 'dm') await db.query('INSERT INTO dms (sender, receiver, timestamp, content, username) VALUES ($1, $2, $3, $4, $5);', [authUser, data.target, tStr, data.content, authUser]);
        if (data.type === 'neighborhood_post') await db.query('INSERT INTO neighborhood_posts (username, title, content, timestamp, sender) VALUES ($1, $2, $3, $4, $5);', [authUser, data.title, data.content, tStr, authUser]);
        if (data.type === 'neighborhood_comment') await db.query('INSERT INTO neighborhood_comments (post_id, username, content, timestamp, sender) VALUES ($1, $2, $3, $4, $5);', [data.post_id, authUser, data.content, tStr, authUser]);
        broadcastSystemUpdate({ type: 'refresh_feed' });
      }

      if (data.type === 'mod_delete' || data.type === 'mod_restore') {
        const targetTable = ALLOWED_CHANNELS[data.channel];
        log(`MOD PACKET: action=${data.type}, targetSpace=${data.channel}, table=${targetTable}, id=${data.id}`);

        if (!targetTable) {
          log(`CRITICAL: Infrastructure target space undefined for channel ${data.channel}`);
          return;
        }

        const res = await db.query(`SELECT username, sender, deleted_by FROM ${targetTable} WHERE id = $1;`, [data.id]);
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

        const isOwner = (owner === authUser);
        const canUndo = userRoles.is_admin || (userRoles.is_moderator && targetObj.deleted_by === authUser);
        const canDelete = isOwner || userRoles.is_admin || userRoles.is_moderator;

        if (data.type === 'mod_delete' && canDelete) {
          log(`EXECUTING DATA PURGE: targetId=${data.id} in ${targetTable} by=${authUser}`);
          await db.query(`UPDATE ${targetTable} SET is_deleted = true, deleted_by = $1 WHERE id = $2;`, [authUser, data.id]);
          if (!isOwner && userRoles.is_moderator && !userRoles.is_admin) {
            await db.query('INSERT INTO mod_logs (mod_username, action_type, target_username, target_id, reason, timestamp) VALUES ($1, $2, $3, $4, $5, $6);', [authUser, 'delete', owner, data.id, data.reason || 'No reason provided', Date.now()]);
          }
          broadcastSystemUpdate({ type: 'refresh_feed' });
        } else if (data.type === 'mod_restore' && canUndo) {
          log(`EXECUTING DATA RESTORE: targetId=${data.id} in ${targetTable} by=${authUser}`);
          await db.query(`UPDATE ${targetTable} SET is_deleted = false, deleted_by = NULL WHERE id = $1;`, [data.id]);
          broadcastSystemUpdate({ type: 'refresh_feed' });
        } else {
          log(`MOD ACTION REJECTED: Access level mismatch or ownership collision`);
        }
      }

      if (userRoles.is_admin || userRoles.is_moderator) {
        if (data.type === 'mod_timeout') {
          const targetRoles = await getUserRoles(data.target);
          if (targetRoles.is_admin) return ws.send(JSON.stringify({ type: 'error_alert', message: 'System operator immunity detected.' }));
          log(`USER TIMEOUT: target=${data.target}, duration=${data.duration}m, by=${authUser}`);
          await db.query('UPDATE users SET timeout_until = $1 WHERE username = $2;', [Date.now() + (parseInt(data.duration, 10) * 60 * 1000), data.target]);
          if (!userRoles.is_admin) await db.query('INSERT INTO mod_logs (mod_username, action_type, target_username, reason, timestamp) VALUES ($1, $2, $3, $4, $5);', [authUser, 'timeout', data.target, data.reason || 'No reason provided', Date.now()]);
          if (activeClients.has(data.target)) { activeClients.get(data.target).send(JSON.stringify({ type: 'terminated' })); activeClients.get(data.target).close(); }
        }
        if (userRoles.is_admin) {
          if (data.type === 'mod_ban') {
            log(`ADMIN BAN: target=${data.target}, by=${authUser}`);
            await db.query('UPDATE users SET is_banned = true WHERE username = $1;', [data.target]);
            if (activeClients.has(data.target)) activeClients.get(data.target).close();
          }
          if (data.type === 'mod_pardon') {
            log(`ADMIN PARDON: target=${data.target}, by=${authUser}`);
            await db.query('UPDATE users SET is_banned = false, timeout_until = 0 WHERE username = $1;', [data.target]);
          }
        }
      }
    } catch (err) { log("WS Infrastructure Logic Failure:", err.message); }
  });
  ws.on('close', () => { if (authUser) { log(`WS Terminal closed: ${authUser}`); activeClients.delete(authUser); broadcastSystemUpdate({ type: 'roster_update', users: Array.from(activeClients.keys()) }); } });
});
