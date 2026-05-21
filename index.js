import express from 'express'
import { WebSocketServer, WebSocket } from 'ws'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import pkg from 'pg'
import cors from 'cors'

const { Pool } = pkg 
const JWT_SECRET = process.env.JWT_SECRET || 'brutalist_secret_key_123'

let connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/unreader';

if (connectionString && !connectionString.startsWith('postgresql://') && !connectionString.startsWith('postgres://')) {
  console.log("Formatting DATABASE_URL: adding postgresql:// prefix");
  connectionString = `postgresql://postgres:postgres@${connectionString}/unreader`;
}

const maskedURI = connectionString.replace(/:([^:@]+)@/, ':****@');
console.log(`Connecting to database at: ${maskedURI}`);

const db = new Pool({ connectionString })

async function initDatabase() {
  try {
    // Migration: Add role flags if they don't exist
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY, 
        username TEXT UNIQUE NOT NULL, 
        password_hash TEXT NOT NULL, 
        timeout_until BIGINT DEFAULT 0, 
        is_banned BOOLEAN DEFAULT false,
        is_admin BOOLEAN DEFAULT false,
        is_moderator BOOLEAN DEFAULT false
      );
      
      -- Ensure columns exist for older databases
      DO $$ 
      BEGIN 
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='is_admin') THEN
          ALTER TABLE users ADD COLUMN is_admin BOOLEAN DEFAULT false;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='is_moderator') THEN
          ALTER TABLE users ADD COLUMN is_moderator BOOLEAN DEFAULT false;
        END IF;
      END $$;

      CREATE TABLE IF NOT EXISTS mod_logs (
        id SERIAL PRIMARY KEY,
        mod_username TEXT NOT NULL,
        action_type TEXT NOT NULL,
        target_username TEXT,
        target_id INTEGER,
        reason TEXT,
        timestamp BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY, username TEXT NOT NULL, timestamp TEXT NOT NULL, content TEXT NOT NULL, is_deleted BOOLEAN DEFAULT false
      );
      CREATE TABLE IF NOT EXISTS dms (
        id SERIAL PRIMARY KEY, sender TEXT NOT NULL, receiver TEXT NOT NULL, timestamp TEXT NOT NULL, content TEXT NOT NULL, is_deleted BOOLEAN DEFAULT false
      );
      CREATE TABLE IF NOT EXISTS profiles (
        username TEXT PRIMARY KEY REFERENCES users(username) ON DELETE CASCADE, bio TEXT DEFAULT 'Hello world.', location TEXT DEFAULT 'Cyberspace', avatar_emoji TEXT DEFAULT '👤'
      );
      CREATE TABLE IF NOT EXISTS topics (
        id SERIAL PRIMARY KEY, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL, username TEXT NOT NULL, timestamp TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS topic_messages (
        id SERIAL PRIMARY KEY, topic_slug TEXT NOT NULL, username TEXT NOT NULL, timestamp TEXT NOT NULL, content TEXT NOT NULL, is_deleted BOOLEAN DEFAULT false
      );
      CREATE TABLE IF NOT EXISTS neighborhood_posts (
        id SERIAL PRIMARY KEY, username TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, timestamp TEXT NOT NULL, is_deleted BOOLEAN DEFAULT false
      );
      CREATE TABLE IF NOT EXISTS neighborhood_comments (
        id SERIAL PRIMARY KEY, post_id INTEGER NOT NULL, username TEXT NOT NULL, content TEXT NOT NULL, timestamp TEXT NOT NULL, is_deleted BOOLEAN DEFAULT false
      );
    `);
    
    // Seed initial admins if specified in env or if it's the first run
    await db.query(`
      UPDATE users SET is_admin = true WHERE username IN ('augustinejames', 'tockdev');
    `);

    console.log("Database online. Dynamic roles and mod logs initialized.");
  } catch (err) {
    console.error("CRITICAL DATABASE ERROR:", err);
    process.exit(1);
  }
}
initDatabase();

const app = express()

app.use(cors({
  origin: ["https://tock-dev.github.io", "https://tock-dev.github.io/", "null"],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type", "Origin", "Accept"],
  credentials: true,
  optionsSuccessStatus: 204
}));

app.use(express.json())

app.use((req, res, next) => {
  const origin = req.headers.origin;
  res.header("Access-Control-Allow-Origin", origin || "*"); 
  res.header("Access-Control-Allow-Headers", "Authorization, Content-Type, *"); 
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE");
  res.header("Access-Control-Allow-Credentials", "true");
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
})

async function getUserRoles(username) {
  const r = await db.query('SELECT is_admin, is_moderator FROM users WHERE username = $1;', [username]);
  return r.rows[0] || { is_admin: false, is_moderator: false };
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
    return res.status(403).json({ error: 'Invalid token' }); 
  }
}

const activeClients = new Map()

function broadcastSystemUpdate(payloadObj) {
  const msgStr = JSON.stringify(payloadObj);
  activeClients.forEach(c => { if(c.readyState === WebSocket.OPEN) c.send(msgStr); });
}

async function broadcastTopics() {
  const result = await db.query('SELECT * FROM topics ORDER BY id DESC;');
  broadcastSystemUpdate({ type: 'topics_update', topics: result.rows });
}

app.get('/dm-contacts', authenticateToken, async (req, res) => {
  const result = await db.query(`SELECT DISTINCT username FROM (SELECT receiver AS username FROM dms WHERE sender = $1 UNION SELECT sender AS username FROM dms WHERE receiver = $1) AS c WHERE username != $1;`, [req.user.username]);
  res.json(result.rows.map(r => r.username));
});

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if(!username || !password) return res.status(400).json({error: "Missing parameters"});
  try {
    const hash = await bcrypt.hash(password, 10);
    await db.query('INSERT INTO users (username, password_hash) VALUES ($1, $2);', [username, hash]);
    await db.query('INSERT INTO profiles (username) VALUES ($1) ON CONFLICT DO NOTHING;', [username]);
    res.json({ token: jwt.sign({ username }, JWT_SECRET), username });
  } catch (err) { res.status(400).json({ error: 'Username already taken' }); }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const result = await db.query('SELECT * FROM users WHERE username = $1;', [username]);
  const user = result.rows[0];
  if (!user || user.is_banned || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Rejected' });
  }
  res.json({ token: jwt.sign({ username }, JWT_SECRET), username });
});

app.get('/api/profile/:username', authenticateToken, async (req, res) => {
  const r = await db.query('SELECT * FROM profiles WHERE username = $1;', [req.params.username]);
  if (!r.rows[0]) return res.json({ username: req.params.username, bio: 'Hello world.', location: 'Cyberspace', avatar_emoji: '👤' });
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

app.post('/api/change-password', authenticateToken, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const result = await db.query('SELECT password_hash FROM users WHERE username = $1;', [req.user.username]);
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(currentPassword, user.password_hash))) return res.status(401).json({ error: "Invalid credentials" });
  const newHash = await bcrypt.hash(newPassword, 10);
  await db.query('UPDATE users SET password_hash = $1 WHERE username = $2;', [newHash, req.user.username]);
  res.json({ success: true });
});

app.get('/history', authenticateToken, async (req, res) => {
  const off = parseInt(req.query.index ?? '0', 10) * 10;
  const r = await db.query('SELECT id, username, timestamp, content, is_deleted FROM messages ORDER BY id DESC LIMIT 10 OFFSET $1;', [off]);
  res.json(r.rows.reverse());
});

app.get('/dm-history', authenticateToken, async (req, res) => {
  const off = parseInt(req.query.index ?? '0', 10) * 10;
  const r = await db.query(`SELECT id, sender AS username, receiver, timestamp, content, is_deleted FROM dms WHERE (sender = $1 AND receiver = $2) OR (sender = $2 AND receiver = $1) ORDER BY id DESC LIMIT 10 OFFSET $3;`, [req.user.username, req.query.target, off]);
  res.json(r.rows.reverse());
});

app.get('/topic-history', authenticateToken, async (req, res) => {
  const off = parseInt(req.query.index ?? '0', 10) * 10;
  const r = await db.query('SELECT id, topic_slug, username, timestamp, content, is_deleted FROM topic_messages WHERE topic_slug = $1 ORDER BY id DESC LIMIT 10 OFFSET $2;', [req.query.slug, off]);
  res.json(r.rows.reverse());
});

app.get('/neighborhood-history', authenticateToken, async (req, res) => {
  const off = parseInt(req.query.index ?? '0', 10) * 10;
  const query = `SELECT p.*, COALESCE(json_agg(c.* ORDER BY c.id ASC) FILTER (WHERE c.id IS NOT NULL), '[]') as comments FROM neighborhood_posts p LEFT JOIN neighborhood_comments c ON p.id = c.post_id GROUP BY p.id ORDER BY p.id DESC LIMIT 10 OFFSET $1;`;
  const posts = await db.query(query, [off]);
  res.json(posts.rows.reverse());
});

const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, '0.0.0.0', () => console.log(`Server on port ${PORT}`));
const wss = new WebSocketServer({ server });

const ALLOWED_CHANNELS = { 'public': 'messages', 'topic': 'topic_messages', 'neighborhood': 'neighborhood_posts', 'dm': 'dms' };

wss.on('connection', (ws) => {
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
          const check = await db.query('SELECT is_banned, timeout_until FROM users WHERE username = $1;', [authUser]);
          if (check.rows[0] && (check.rows[0].is_banned || BigInt(check.rows[0].timeout_until) > BigInt(Date.now()))) {
            ws.send(JSON.stringify({ type: 'terminated' })); ws.close(); return;
          }
          activeClients.set(authUser, ws);
          broadcastSystemUpdate({ type: 'roster_update', users: Array.from(activeClients.keys()) });
          const topicsRes = await db.query('SELECT * FROM topics ORDER BY id DESC;');
          ws.send(JSON.stringify({ type: 'topics_update', topics: topicsRes.rows, user_roles: userRoles }));
        } catch (e) { ws.send(JSON.stringify({ type: 'terminated' })); }
        return;
      }

      if (!authUser) return;

      if (data.type === 'create_topic') {
        const slug = data.title.toLowerCase().replace(/[^a-z0-9]/g, '-');
        await db.query('INSERT INTO topics (slug, title, username, timestamp) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING;', [slug, data.title, authUser, String(Date.now())]);
        broadcastTopics();
      }

      if (['message', 'topic_message', 'dm', 'neighborhood_post', 'neighborhood_comment'].includes(data.type)) {
        const tStr = String(Date.now());
        if (data.type === 'message') await db.query('INSERT INTO messages (username, timestamp, content) VALUES ($1, $2, $3);', [authUser, tStr, data.content]);
        if (data.type === 'topic_message') await db.query('INSERT INTO topic_messages (topic_slug, username, timestamp, content) VALUES ($1, $2, $3, $4);', [data.target, authUser, tStr, data.content]);
        if (data.type === 'dm') await db.query('INSERT INTO dms (sender, receiver, timestamp, content) VALUES ($1, $2, $3, $4);', [authUser, data.target, tStr, data.content]);
        if (data.type === 'neighborhood_post') await db.query('INSERT INTO neighborhood_posts (username, title, content, timestamp) VALUES ($1, $2, $3, $4);', [authUser, data.title, data.content, tStr]);
        if (data.type === 'neighborhood_comment') await db.query('INSERT INTO neighborhood_comments (post_id, username, content, timestamp) VALUES ($1, $2, $3, $4);', [data.post_id, authUser, data.content, tStr]);
        broadcastSystemUpdate({ type: 'refresh_feed' });
      }

      if (data.type === 'mod_delete' || data.type === 'mod_restore') {
        const targetTable = ALLOWED_CHANNELS[data.channel];
        if (!targetTable) return;
        const res = await db.query(`SELECT username, sender FROM ${targetTable} WHERE id = $1;`, [data.id]);
        const owner = res.rows[0]?.username || res.rows[0]?.sender;
        
        const isOwner = (owner === authUser);
        const canMod = userRoles.is_admin || userRoles.is_moderator;
        
        if (isOwner || userRoles.is_admin || (userRoles.is_moderator && data.type === 'mod_delete')) {
          await db.query(`UPDATE ${targetTable} SET is_deleted = $1 WHERE id = $2;`, [data.type === 'mod_delete', data.id]);
          if (!isOwner && userRoles.is_moderator && !userRoles.is_admin) {
            await db.query('INSERT INTO mod_logs (mod_username, action_type, target_username, target_id, reason, timestamp) VALUES ($1, $2, $3, $4, $5, $6);', 
              [authUser, data.type, owner, data.id, data.reason || 'No reason provided', Date.now()]);
          }
          broadcastSystemUpdate({ type: 'refresh_feed' });
        }
      }

      if (userRoles.is_admin || userRoles.is_moderator) {
        if (data.type === 'mod_timeout') {
          const targetRoles = await getUserRoles(data.target);
          if (targetRoles.is_admin) return ws.send(JSON.stringify({ type: 'error_alert', message: 'Cannot timeout an admin.' }));
          await db.query('UPDATE users SET timeout_until = $1 WHERE username = $2;', [Date.now() + (parseInt(data.duration, 10)*60*1000), data.target]);
          if (!userRoles.is_admin) {
            await db.query('INSERT INTO mod_logs (mod_username, action_type, target_username, reason, timestamp) VALUES ($1, $2, $3, $4, $5);', 
              [authUser, 'timeout', data.target, data.reason || 'No reason provided', Date.now()]);
          }
          if(activeClients.has(data.target)) { activeClients.get(data.target).send(JSON.stringify({ type: 'terminated' })); activeClients.get(data.target).close(); }
        }
        if (userRoles.is_admin) {
          if (data.type === 'mod_ban') {
            await db.query('UPDATE users SET is_banned = true WHERE username = $1;', [data.target]);
            if(activeClients.has(data.target)) activeClients.get(data.target).close();
          }
          if (data.type === 'mod_pardon') await db.query('UPDATE users SET is_banned = false, timeout_until = 0 WHERE username = $1;', [data.target]);
        }
      }
    } catch (err) { console.error(err); }
  });

  ws.on('close', () => {
    if (authUser) {
      activeClients.delete(authUser);
      broadcastSystemUpdate({ type: 'roster_update', users: Array.from(activeClients.keys()) });
    }
  });
});
