import express from 'express'
import { WebSocketServer, WebSocket } from 'ws'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import pkg from 'pg'

const { Pool } = pkg 
const JWT_SECRET = process.env.JWT_SECRET || 'brutalist_secret_key_123'
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
  console.log("Database online. Timestamps configured as absolute String layout models.");
}
initDatabase().catch(err => console.error(err));

const app = express()
app.use(express.json())
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*"); res.header("Access-Control-Allow-Headers", "*"); next();
})

function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(authHeader.split(' ')[1], JWT_SECRET); next();
  } catch (err) { return res.status(403).json({ error: 'Invalid token' }); }
}

const activeClients = new Map()
function isMasterAdmin(name) { return name === 'augustinejames' || name === 'tockdev'; }

async function broadcastTopics() {
  const result = await db.query('SELECT * FROM topics ORDER BY id DESC;');
  const payload = JSON.stringify({ type: 'topics_update', topics: result.rows });
  activeClients.forEach(c => { if(c.readyState === WebSocket.OPEN) c.send(payload); });
}

app.get('/dm-contacts', authenticateToken, async (req, res) => {
  const result = await db.query(`SELECT DISTINCT username FROM (SELECT receiver AS username FROM dms WHERE sender = $1 UNION SELECT sender AS username FROM dms WHERE receiver = $1) AS c WHERE username != $1;`, [req.user.username]);
  res.json(result.rows.map(r => r.username));
});

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  try {
    const hash = await bcrypt.hash(password, 10);
    await db.query('INSERT INTO users (username, password_hash) VALUES ($1, $2);', [username, hash]);
    await db.query('INSERT INTO profiles (username) VALUES ($1);', [username]);
    res.json({ token: jwt.sign({ username }, JWT_SECRET), username });
  } catch (err) { res.status(400).json({ error: 'Taken' }); }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const result = await db.query('SELECT * FROM users WHERE username = $1;', [username]);
  const user = result.rows[0];
  if (!user || user.is_banned || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'Rejected' });
  res.json({ token: jwt.sign({ username }, JWT_SECRET), username });
});

app.get('/api/profile/:username', authenticateToken, async (req, res) => {
  const r = await db.query('SELECT * FROM profiles WHERE username = $1;', [req.params.username]);
  if (!r.rows[0]) {
    await db.query('INSERT INTO profiles (username) VALUES ($1) ON CONFLICT DO NOTHING;', [req.params.username]);
    return res.json({ username: req.params.username, bio: 'Hello world.', location: 'Cyberspace', avatar_emoji: '👤' });
  }
  res.json(r.rows[0]);
});

app.post('/api/profile', authenticateToken, async (req, res) => {
  const { bio, location, avatar_emoji } = req.body;
  await db.query('UPDATE profiles SET bio = $1, location = $2, avatar_emoji = $3 WHERE username = $4;', [bio, location, avatar_emoji, req.user.username]);
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
  try {
    const posts = await db.query('SELECT id, username, title, content, timestamp, is_deleted FROM neighborhood_posts ORDER BY id DESC LIMIT 10 OFFSET $1;', [off]);
    for(let i=0; i<posts.rows.length; i++) {
      const comments = await db.query('SELECT id, post_id, username, content, timestamp, is_deleted FROM neighborhood_comments WHERE post_id = $1 ORDER BY id ASC;', [posts.rows[i].id]);
      posts.rows[i].comments = comments.rows;
    }
    res.json(posts.rows.reverse());
  } catch(err) { res.status(500).json({ error: 'Feed load failure' }); }
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let authUser = null;

  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg);

      if (data.type === 'auth') {
        const decoded = jwt.verify(data.token, JWT_SECRET); authUser = decoded.username;
        const check = await db.query('SELECT is_banned, timeout_until FROM users WHERE username = $1;', [authUser]);
        if (check.rows[0] && (check.rows[0].is_banned || BigInt(check.rows[0].timeout_until) > BigInt(Date.now()))) {
          ws.send(JSON.stringify({ type: 'terminated' })); ws.close(); return;
        }
        activeClients.set(authUser, ws);
        const payload = JSON.stringify({ type: 'roster_update', users: Array.from(activeClients.keys()) });
        activeClients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(payload); });
        
        const topicsRes = await db.query('SELECT * FROM topics ORDER BY id DESC;');
        ws.send(JSON.stringify({ type: 'topics_update', topics: topicsRes.rows }));
        return;
      }

      if (!authUser) return;

      const compliance = await db.query('SELECT is_banned, timeout_until FROM users WHERE username = $1;', [authUser]);
      if (compliance.rows[0] && (compliance.rows[0].is_banned || BigInt(compliance.rows[0].timeout_until) > BigInt(Date.now()))) {
        ws.send(JSON.stringify({ type: 'terminated' })); ws.close(); activeClients.delete(authUser); return;
      }

      if (data.type === 'create_topic') {
        if (!isMasterAdmin(authUser)) {
          const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
          const historicalCheck = await db.query('SELECT timestamp FROM topics WHERE username = $1 AND CAST(timestamp AS BIGINT) > $2 LIMIT 1;', [authUser, sevenDaysAgo]);
          if (historicalCheck.rows[0]) {
            ws.send(JSON.stringify({ type: 'error_alert', message: '⚠️ LIMIT EXCEEDED: One topic board entry allowed per rolling week.' }));
            return;
          }
        }
        const slug = data.title.toLowerCase().replace(/[^a-z0-9]/g, '-');
        await db.query('INSERT INTO topics (slug, title, username, timestamp) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING;', [slug, data.title, authUser, String(Date.now())]);
        broadcastTopics();
        return;
      }

      if (data.type === 'message') {
        const tStr = String(Date.now());
        const dbRes = await db.query('INSERT INTO messages (username, timestamp, content) VALUES ($1, $2, $3) RETURNING id;', [authUser, tStr, data.content]);
        activeClients.forEach(c => { if(c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'neighborhood_refresh' })); });
      }

      if (data.type === 'topic_message') {
        const tStr = String(Date.now());
        const dbRes = await db.query('INSERT INTO topic_messages (topic_slug, username, timestamp, content) VALUES ($1, $2, $3, $4) RETURNING id;', [data.target, authUser, tStr, data.content]);
        activeClients.forEach(c => { if(c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'neighborhood_refresh' })); });
      }

      if (data.type === 'dm') {
        const tStr = String(Date.now());
        await db.query('INSERT INTO dms (sender, receiver, timestamp, content) VALUES ($1, $2, $3, $4) RETURNING id;', [authUser, data.target, tStr, data.content]);
        activeClients.forEach(c => { if(c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'neighborhood_refresh' })); });
      }

      if (data.type === 'neighborhood_post') {
        if (!isMasterAdmin(authUser)) {
          const lastPost = await db.query('SELECT username FROM neighborhood_posts ORDER BY id DESC LIMIT 1;');
          if (lastPost.rows[0] && lastPost.rows[0].username === authUser) {
            ws.send(JSON.stringify({ type: 'error_alert', message: '⚠️ PACKET REJECTED: Double posting is barred on main Neighborhood entries.' }));
            return;
          }
        }
        const tStr = String(Date.now());
        await db.query('INSERT INTO neighborhood_posts (username, title, content, timestamp) VALUES ($1, $2, $3, $4) RETURNING id;', [authUser, data.title, data.content, tStr]);
        activeClients.forEach(c => { if(c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'neighborhood_refresh' })); });
      }

      if (data.type === 'neighborhood_comment') {
        const tStr = String(Date.now());
        await db.query('INSERT INTO neighborhood_comments (post_id, username, content, timestamp) VALUES ($1, $2, $3, $4);', [data.post_id, authUser, data.content, tStr]);
        activeClients.forEach(c => { if(c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'neighborhood_refresh' })); });
      }

      if (data.type === 'mod_delete') {
        let t = 'messages';
        if (data.channel === 'topic') t = 'topic_messages';
        else if (data.channel === 'neighborhood') t = 'neighborhood_posts';
        else if (data.channel === 'dm') t = 'dms';

        const ownership = await db.query(`SELECT * FROM ${t} WHERE id = $1;`, [data.id]);
        if (!ownership.rows[0]) return;
        const owner = ownership.rows[0].username || ownership.rows[0].sender;

        if (owner === authUser || isMasterAdmin(authUser)) {
          await db.query(`UPDATE ${t} SET is_deleted = true WHERE id = $1;`, [data.id]);
          activeClients.forEach(c => { if(c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'neighborhood_refresh' })); });
        }
      }

      if (data.type === 'mod_delete_comment') {
        const ownership = await db.query('SELECT username FROM neighborhood_comments WHERE id = $1;', [data.id]);
        if (!ownership.rows[0]) return;
        if (ownership.rows[0].username === authUser || isMasterAdmin(authUser)) {
          await db.query('UPDATE neighborhood_comments SET is_deleted = true WHERE id = $1;', [data.id]);
          activeClients.forEach(c => { if(c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'neighborhood_refresh' })); });
        }
      }

      if (isMasterAdmin(authUser)) {
        let t = data.channel === 'topic' ? 'topic_messages' : (data.channel === 'neighborhood' ? 'neighborhood_posts' : 'messages');
        if (data.type === 'mod_restore') {
          await db.query(`UPDATE ${t} SET is_deleted = false WHERE id = $1;`, [data.id]);
          activeClients.forEach(c => { if(c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'neighborhood_refresh' })); });
        }
        if (data.type === 'mod_timeout') {
          await db.query('UPDATE users SET timeout_until = $1 WHERE username = $2;', [Date.now() + (parseInt(data.duration, 10)*60*1000), data.target]);
          if(activeClients.has(data.target)) { activeClients.get(data.target).send(JSON.stringify({ type: 'terminated' })); activeClients.get(data.target).close(); }
        }
        if (data.type === 'mod_ban') {
          await db.query('UPDATE users SET is_banned = true WHERE username = $1;', [data.target]);
          if(activeClients.has(data.target)) { activeClients.get(data.target).send(JSON.stringify({ type: 'terminated', reason: 'Permanently banned.' })); activeClients.get(data.target).close(); }
        }
        if (data.type === 'mod_pardon') {
          await db.query('UPDATE users SET is_banned = false, timeout_until = 0 WHERE username = $1;', [data.target]);
        }
      }

    } catch (err) { console.error(err); }
  });

  ws.on('close', () => {
    if (authUser) {
      activeClients.delete(authUser);
      const payload = JSON.stringify({ type: 'roster_update', users: Array.from(activeClients.keys()) });
      activeClients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(payload); });
    }
  });
});
