import express from 'express'
import { WebSocketServer, WebSocket } from 'ws'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import pkg from 'pg'

const { Pool } = pkg 
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("CRITICAL SERVER CONFIGURATION ERROR: process.env.JWT_SECRET is completely missing.");
}

const db = new Pool({ connectionString: process.env.DATABASE_URL })

async function initDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, timeout_until BIGINT DEFAULT 0, is_banned BOOLEAN DEFAULT false
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
  console.log("Database engine successfully connected.");
}
initDatabase().catch(err => console.error(err));

const app = express()

// CRITICAL CORS CORRECTION INTERCEPTOR: Executes before any subsequent parsing middleware
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "https://tock-dev.github.io");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Origin, Accept"); 
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE");
  res.setHeader("Access-Control-Allow-Credentials", "true");

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

app.use(express.json())

function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(authHeader.split(' ')[1], JWT_SECRET); next();
  } catch (err) { return res.status(403).json({ error: 'Invalid token' }); }
}

const activeClients = new Map()
function isMasterAdmin(name) { return name === 'augustinejames' || name === 'tockdev'; }

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
  if(!username || !password) return res.status(400).json({ error: 'Missing parameters' });
  
  const result = await db.query('SELECT * FROM users WHERE username = $1;', [username]);
  const user = result.rows[0];
  if (!user || user.is_banned || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Invalid connection credentials' });
  }
  res.json({ token: jwt.sign({ username }, JWT_SECRET), username });
});

app.get('/api/profile/:username', authenticateToken, async (req, res) => {
  const r = await db.query('SELECT * FROM profiles WHERE username = $1;', [req.params.username]);
  if (!r.rows[0]) {
    return res.json({ username: req.params.username, bio: 'Hello world.', location: 'Cyberspace', avatar_emoji: '👤' });
  }
  res.json(r.rows[0]);
});

app.post('/api/profile', authenticateToken, async (req, res) => {
  const { bio, location, avatar_emoji } = req.body;
  await db.query('INSERT INTO profiles (username, bio, location, avatar_emoji) VALUES ($4, $1, $2, $3) ON CONFLICT (username) DO UPDATE SET bio=$1, location=$2, avatar_emoji=$3;', [bio, location, avatar_emoji, req.user.username]);
  res.json({ success: true });
});

app.post('/api/change-password', authenticateToken, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "Missing required password verification params." });
  }
  try {
    const result = await db.query('SELECT password_hash FROM users WHERE username = $1;', [req.user.username]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: "Identity profile not tracked." });

    const isMatch = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isMatch) return res.status(401).json({ error: "Current structural credentials mismatch." });

    const newHash = await bcrypt.hash(newPassword, 10);
    await db.query('UPDATE users SET password_hash = $1 WHERE username = $2;', [newHash, req.user.username]);
    res.json({ success: true, message: "Security parameters successfully reset." });
  } catch (err) {
    res.status(500).json({ error: "Internal processing database error." });
  }
});

app.get('/history', authenticateToken, async (req, res) => {
  const pageIndex = req.query.index ? parseInt(req.query.index, 10) : 0;
  const off = (isNaN(pageIndex) ? 0 : pageIndex) * 10;
  const r = await db.query('SELECT id, username, timestamp, content, is_deleted FROM messages ORDER BY id DESC LIMIT 10 OFFSET $1;', [off]);
  res.json(r.rows.reverse());
});

app.get('/dm-history', authenticateToken, async (req, res) => {
  const pageIndex = req.query.index ? parseInt(req.query.index, 10) : 0;
  const off = (isNaN(pageIndex) ? 0 : pageIndex) * 10;
  const r = await db.query(`SELECT id, sender AS username, receiver, timestamp, content, is_deleted FROM dms WHERE (sender = $1 AND receiver = $2) OR (sender = $2 AND receiver = $1) ORDER BY id DESC LIMIT 10 OFFSET $3;`, [req.user.username, req.query.target, off]);
  res.json(r.rows.reverse());
});

app.get('/topic-history', authenticateToken, async (req, res) => {
  const pageIndex = req.query.index ? parseInt(req.query.index, 10) : 0;
  const off = (isNaN(pageIndex) ? 0 : pageIndex) * 10;
  const r = await db.query('SELECT id, topic_slug, username, timestamp, content, is_deleted FROM topic_messages WHERE topic_slug = $1 ORDER BY id DESC LIMIT 10 OFFSET $2;', [req.query.slug, off]);
  res.json(r.rows.reverse());
});

app.get('/neighborhood-history', authenticateToken, async (req, res) => {
  const pageIndex = req.query.index ? parseInt(req.query.index, 10) : 0;
  const off = (isNaN(pageIndex) ? 0 : pageIndex) * 10;
  try {
    const query = `
      SELECT p.*, COALESCE(json_agg(c.* ORDER BY c.id ASC) FILTER (WHERE c.id IS NOT NULL), '[]') as comments
      FROM neighborhood_posts p
      LEFT JOIN neighborhood_comments c ON p.id = c.post_id
      GROUP BY p.id
      ORDER BY p.id DESC LIMIT 10 OFFSET $1;
    `;
    const posts = await db.query(query, [off]);
    res.json(posts.rows.reverse());
  } catch(err) { res.status(500).json({ error: 'Failed to build feed logs.' }); }
});

const PORT = process.env.PORT || 3000;

// FIXED BINDING: Explicitly pass '0.0.0.0' to receive web socket and HTTP traffic outside the host localhost loop
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server system online and routing via port: ${PORT}`);
});

const wss = new WebSocketServer({ server });

const ALLOWED_CHANNELS = {
  'public': 'messages',
  'topic': 'topic_messages',
  'neighborhood': 'neighborhood_posts',
  'dm': 'dms'
};

wss.on('connection', (ws) => {
  let authUser = null;

  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg);

      if (data.type === 'auth') {
        try {
          let cleanToken = data.token;
          if (cleanToken && cleanToken.startsWith('Bearer ')) {
            cleanToken = cleanToken.slice(7);
          }

          const decoded = jwt.verify(cleanToken, JWT_SECRET); 
          authUser = decoded.username;
          
          const check = await db.query('SELECT is_banned, timeout_until FROM users WHERE username = $1;', [authUser]);
          if (check.rows[0] && (check.rows[0].is_banned || BigInt(check.rows[0].timeout_until) > BigInt(Date.now()))) {
            ws.send(JSON.stringify({ type: 'terminated', reason: 'Account status restriction applied.' })); 
            ws.close(); 
            return;
          }
          
          activeClients.set(authUser, ws);
          broadcastSystemUpdate({ type: 'roster_update', users: Array.from(activeClients.keys()) });
          
          const topicsRes = await db.query('SELECT * FROM topics ORDER BY id DESC;');
          ws.send(JSON.stringify({ type: 'topics_update', topics: topicsRes.rows }));
          
          console.log(`WebSocket successfully authenticated user: ${authUser}`);
        } catch (err) {
          console.error("WebSocket Auth Failed:", err.message);
          ws.send(JSON.stringify({ type: 'error_alert', message: 'WebSocket authentication failed. Please re-login.' }));
        }
        return;
      }

      if (!authUser) return;

      if (data.type === 'create_topic') {
        const slug = data.title.toLowerCase().replace(/[^a-z0-9]/g, '-');
        await db.query('INSERT INTO topics (slug, title, username, timestamp) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING;', [slug, data.title, authUser, String(Date.now())]);
        broadcastTopics();
        return;
      }

      if (data.type === 'message') {
        await db.query('INSERT INTO messages (username, timestamp, content) VALUES ($1, $2, $3);', [authUser, String(Date.now()), data.content]);
        broadcastSystemUpdate({ type: 'refresh_feed' });
      }

      if (data.type === 'topic_message') {
        if(!data.target) return;
        await db.query('INSERT INTO topic_messages (topic_slug, username, timestamp, content) VALUES ($1, $2, $3, $4);', [data.target, authUser, String(Date.now()), data.content]);
        broadcastSystemUpdate({ type: 'refresh_feed' });
      }

      if (data.type === 'dm') {
        if(!data.target) return;
        await db.query('INSERT INTO dms (sender, receiver, timestamp, content) VALUES ($1, $2, $3, $4);', [authUser, data.target, String(Date.now()), data.content]);
        broadcastSystemUpdate({ type: 'refresh_feed' });
      }

      if (data.type === 'neighborhood_post') {
        await db.query('INSERT INTO neighborhood_posts (username, title, content, timestamp) VALUES ($1, $2, $3, $4);', [authUser, data.title, data.content, String(Date.now())]);
        broadcastSystemUpdate({ type: 'refresh_feed' });
      }

      if (data.type === 'neighborhood_comment') {
        await db.query('INSERT INTO neighborhood_comments (post_id, username, content, timestamp) VALUES ($1, $2, $3, $4);', [data.post_id, authUser, data.content, String(Date.now())]);
        broadcastSystemUpdate({ type: 'refresh_feed' });
      }

      if (data.type === 'mod_delete' || data.type === 'mod_restore') {
        if(!isMasterAdmin(authUser)) {
          ws.send(JSON.stringify({ type: 'error_alert', message: 'Access denied.' }));
          return;
        }
        
        const targetTable = ALLOWED_CHANNELS[data.channel];
        if(!targetTable) {
          ws.send(JSON.stringify({ type: 'error_alert', message: 'Invalid infrastructure target space.' }));
          return;
        }

        const stateValue = (data.type === 'mod_delete');
        await db.query(`UPDATE ${targetTable} SET is_deleted = $1 WHERE id = $2;`, [stateValue, data.id]);
        broadcastSystemUpdate({ type: 'refresh_feed' });
      }

    } catch (err) { console.error("WS routing mismatch:", err); }
  });

  ws.on('close', () => {
    if (authUser) {
      activeClients.delete(authUser);
      broadcastSystemUpdate({ type: 'roster_update', users: Array.from(activeClients.keys()) });
    }
  });
});
