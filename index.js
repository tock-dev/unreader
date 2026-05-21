import express from 'express'
import { WebSocketServer, WebSocket } from 'ws'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import pkg from 'pg'
import cors from 'cors'

console.log('App just started')

const { Pool } = pkg 
const JWT_SECRET = process.env.JWT_SECRET || 'brutalist_secret_key_123'

// Securely assign the fallback initialization credentials using environment variables
const ADMIN_SEED_PASSWORD = process.env.ADMIN_SEED_PASSWORD || 'ChangeMe_Strict_Random_2026!';

let connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/unreader';

if (connectionString && !connectionString.startsWith('postgresql://') && !connectionString.startsWith('postgres://')) {
  console.log("Formatting DATABASE_URL: adding postgresql:// prefix");
  connectionString = `postgresql://postgres:postgres@${connectionString}/unreader`;
}

const db = new Pool({ connectionString })

console.log('Connected to the database')

async function initDatabase() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, 
        timeout_until BIGINT DEFAULT 0, is_banned BOOLEAN DEFAULT false,
        is_admin BOOLEAN DEFAULT false, is_moderator BOOLEAN DEFAULT false, last_ip TEXT
      );
      
      -- Ensure columns exist for older databases
      DO $$ BEGIN 
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='is_admin') THEN ALTER TABLE users ADD COLUMN is_admin BOOLEAN DEFAULT false; END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='is_moderator') THEN ALTER TABLE users ADD COLUMN is_moderator BOOLEAN DEFAULT false; END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='last_ip') THEN ALTER TABLE users ADD COLUMN last_ip TEXT; END IF;
      END $$;
    `);

    // 3. Create Supporting Tables & Performance Indexes
    await db.query(`
      CREATE TABLE IF NOT EXISTS mod_logs (
        id SERIAL PRIMARY KEY, mod_username TEXT NOT NULL, action_type TEXT NOT NULL,
        target_username TEXT, target_id INTEGER, reason TEXT, timestamp BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY, username TEXT NOT NULL, timestamp TEXT NOT NULL, content TEXT NOT NULL, 
        is_deleted BOOLEAN DEFAULT false, deleted_by TEXT
      );
      CREATE TABLE IF NOT EXISTS dms (
        id SERIAL PRIMARY KEY, sender TEXT NOT NULL, receiver TEXT NOT NULL, timestamp TEXT NOT NULL, content TEXT NOT NULL, 
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
        is_deleted BOOLEAN DEFAULT false, deleted_by TEXT
      );
      CREATE TABLE IF NOT EXISTS neighborhood_posts (
        id SERIAL PRIMARY KEY, username TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, timestamp TEXT NOT NULL, 
        is_deleted BOOLEAN DEFAULT false, deleted_by TEXT
      );
      CREATE TABLE IF NOT EXISTS neighborhood_comments (
        id SERIAL PRIMARY KEY, post_id INTEGER NOT NULL, username TEXT NOT NULL, content TEXT NOT NULL, timestamp TEXT NOT NULL, 
        is_deleted BOOLEAN DEFAULT false, deleted_by TEXT
      );

      -- Add deleted_by columns if missing
      DO $$ BEGIN 
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='messages' AND column_name='deleted_by') THEN ALTER TABLE messages ADD COLUMN deleted_by TEXT; END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='dms' AND column_name='deleted_by') THEN ALTER TABLE dms ADD COLUMN deleted_by TEXT; END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='topic_messages' AND column_name='deleted_by') THEN ALTER TABLE topic_messages ADD COLUMN deleted_by TEXT; END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='neighborhood_posts' AND column_name='deleted_by') THEN ALTER TABLE neighborhood_posts ADD COLUMN deleted_by TEXT; END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='neighborhood_comments' AND column_name='deleted_by') THEN ALTER TABLE neighborhood_comments ADD COLUMN deleted_by TEXT; END IF;
      END $$;

      CREATE INDEX IF NOT EXISTS idx_messages_id ON messages(id DESC);
      CREATE INDEX IF NOT EXISTS idx_topic_messages_slug ON topic_messages(topic_slug);
      CREATE INDEX IF NOT EXISTS idx_dms_participants ON dms(sender, receiver);
    `);
    
    // 4. Seed Admins securely using ADMIN_SEED_PASSWORD variable
    const placeholderHash = await bcrypt.hash(ADMIN_SEED_PASSWORD, 10);
    
    await db.query(`
      INSERT INTO users (username, password_hash) 
      VALUES ('augustinejames', $1), ('tockdev', $1)
      ON CONFLICT (username) DO NOTHING;
    `, [placeholderHash]);

    await db.query(`
      UPDATE users SET is_admin = true WHERE username IN ('augustinejames', 'tockdev');
    `);

    await db.query(`
      INSERT INTO profiles (username) 
      VALUES ('augustinejames'), ('tockdev') 
      ON CONFLICT DO NOTHING;
    `);

    console.log("Database online. Dynamic roles, seeds, and mod logs initialized.");
  } catch (err) {
    console.error("CRITICAL DATABASE ERROR:", err);
    process.exit(1);
  }
}
initDatabase();

const app = express()
app.set('trust proxy', true);

app.use(cors({
  origin: ["https://tock-dev.github.io", "null"],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type", "Origin", "Accept"],
  credentials: true,
  optionsSuccessStatus: 204
}));

app.use(express.json())

async function getUserRoles(username) {
  const r = await db.query('SELECT is_admin, is_moderator, timeout_until, is_banned, last_ip FROM users WHERE username = $1;', [username]);
  return r.rows[0] || { is_admin: false, is_moderator: false };
}

async function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = { ...decoded, ...(await getUserRoles(decoded.username)) };
    next();
  } catch (err) { return res.status(403).json({ error: 'Invalid token' }); }
}

const activeClients = new Map()
function broadcastSystemUpdate(payloadObj) {
  const msgStr = JSON.stringify(payloadObj);
  activeClients.forEach(c => { if(c.readyState === WebSocket.OPEN) c.send(msgStr); });
}

app.get('/dm-contacts', authenticateToken, async (req, res) => {
  const result = await db.query(`SELECT DISTINCT username FROM (SELECT receiver AS username FROM dms WHERE sender = $1 UNION SELECT sender AS username FROM dms WHERE receiver = $1) AS c WHERE username != $1;`, [req.user.username]);
  res.json(result.rows.map(r => r.username));
});

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  try {
    const hash = await bcrypt.hash(password, 10);
    await db.query('INSERT INTO users (username, password_hash, last_ip) VALUES ($1, $2, $3);', [username, hash, ip]);
    await db.query('INSERT INTO profiles (username) VALUES ($1) ON CONFLICT DO NOTHING;', [username]);
    res.json({ token: jwt.sign({ username }, JWT_SECRET, { expiresIn: '7d' }), username });
  } catch (err) { res.status(400).json({ error: 'Username already taken' }); }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const result = await db.query('SELECT * FROM users WHERE username = $1;', [username]);
  const user = result.rows[0];
  if (!user || user.is_banned || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'Rejected' });
  await db.query('UPDATE users SET last_ip = $1 WHERE username = $2;', [ip, username]);
  res.json({ token: jwt.sign({ username }, JWT_SECRET), username });
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
  const r = await db.query('SELECT username, last_ip, timeout_until, is_banned, is_admin, is_moderator FROM users WHERE username = $1;', [req.params.username]);
  if (!r.rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json(r.rows[0]);
});

app.post('/api/admin/set-role', authenticateToken, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Unauthorized' });
  const { target, is_moderator } = req.body;
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
  const r = await db.query(`SELECT d.*, u.is_admin, u.is_moderator FROM dms d LEFT JOIN users u ON d.sender = u.username WHERE (sender = $1 AND receiver = $2) OR (sender = $2 AND receiver = $1) ORDER BY d.id DESC LIMIT 10 OFFSET $3;`, [req.user.username, req.query.target, off]);
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

const server = app.listen(process.env.PORT || 10000, '0.0.0.0');
const wss = new WebSocketServer({ server });

const ALLOWED_CHANNELS = { 'public': 'messages', 'topic': 'topic_messages', 'neighborhood': 'neighborhood_posts', 'dm': 'dms', 'comment': 'neighborhood_comments' };

wss.on('connection', (ws, req) => {
  let authUser = null;
  let userRoles = { is_admin: false, is_moderator: false };
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'auth') {
        try {
          const decoded = jwt.verify(data.token, JWT_SECRET);
          authUser = decoded.username;
          userRoles = await getUserRoles(authUser);
          if (userRoles.is_banned || BigInt(userRoles.timeout_until) > BigInt(Date.now())) {
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

      const liveCheck = await db.query('SELECT is_banned, timeout_until FROM users WHERE username = $1;', [authUser]);
      if (liveCheck.rows[0] && (liveCheck.rows[0].is_banned || BigInt(liveCheck.rows[0].timeout_until) > BigInt(Date.now()))) {
        ws.send(JSON.stringify({ type: 'terminated' })); 
        ws.close(); 
        return;
      }

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
<<<<<<< HEAD
        const targetTable = ALLOWED_CHANNELS[data.channel] || (data.channel === 'neighborhood_comment' ? 'neighborhood_comments' : null);
        if (!targetTable) {
          ws.send(JSON.stringify({ type: 'error_alert', message: 'Invalid channel structure.' }));
		  return;
		}
        const res = await db.query(`SELECT username, sender, deleted_by FROM ${targetTable} WHERE id = $1;`, [data.id]);
        if (res.rows.length === 0) return;
        const target = res.rows[0];
        if (!target) return;
        const owner = target.username || target.sender;
        
        const isOwner = (owner === authUser);
        const canUndo = userRoles.is_admin || (userRoles.is_moderator && target.deleted_by === authUser);
        const canDelete = isOwner || userRoles.is_admin || userRoles.is_moderator;

        if (data.type === 'mod_delete' && canDelete) {
          await db.query(`UPDATE ${targetTable} SET is_deleted = true, deleted_by = $1 WHERE id = $2;`, [authUser, data.id]);
          if (!isOwner && userRoles.is_moderator && !userRoles.is_admin) {
            await db.query('INSERT INTO mod_logs (mod_username, action_type, target_username, target_id, reason, timestamp) VALUES ($1, $2, $3, $4, $5, $6);', [authUser, 'delete', owner, data.id, data.reason || 'No reason', Date.now()]);
          }
          broadcastSystemUpdate({ type: 'refresh_feed' });
        } else if (data.type === 'mod_restore' && canUndo) {
          await db.query(`UPDATE ${targetTable} SET is_deleted = false, deleted_by = NULL WHERE id = $2;`, [data.id]);
          broadcastSystemUpdate({ type: 'refresh_feed' });
        }
      }

      if (userRoles.is_admin || userRoles.is_moderator) {
        if (data.type === 'mod_timeout') {
          const targetRoles = await getUserRoles(data.target);
<<<<<<< HEAD
          if (targetRoles.is_admin) return ws.send(JSON.stringify({ type: 'error_alert', message: 'Cannot timeout an admin.' }));
          await db.query('UPDATE users SET timeout_until = $1 WHERE username = $2;', [Date.now() + (parseInt(data.duration, 10)*60*1000), data.target]);
          if (!userRoles.is_admin) await db.query('INSERT INTO mod_logs (mod_username, action_type, target_username, reason, timestamp) VALUES ($1, $2, $3, $4, $5);', [authUser, 'timeout', data.target, data.reason || 'No reason', Date.now()]);
          if(activeClients.has(data.target)) { 
            activeClients.get(data.target).send(JSON.stringify({ type: 'terminated', reason: 'You have been temporarily timed out by staff.' })); 
            activeClients.get(data.target).close(); 
          }
        }
        if (userRoles.is_admin) {
          if (data.type === 'mod_ban') {
			await db.query('UPDATE users SET is_banned = true WHERE username = $1;', [data.target]); 
            if(activeClients.has(data.target)) {
              activeClients.get(data.target).send(JSON.stringify({ type: 'terminated', reason: 'Your account has been permanently banned.' }));
              activeClients.get(data.target).close();
            }
		  }
		  if (data.type === 'mod_pardon') await db.query('UPDATE users SET is_banned = false, timeout_until = 0 WHERE username = $1;', [data.target]);
        }
      }
    } catch (err) { console.error("Socket Error:", err); }
  });
  ws.on('close', () => { if (authUser) { activeClients.delete(authUser); broadcastSystemUpdate({ type: 'roster_update', users: Array.from(activeClients.keys()) }); } });
});
