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
/* app.use(async (req, res, next) => {
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
}) */
app.use(cors());
app.use(express.json());

// const getUserRolesCache = {};
async function getUserRoles(username) {
  // if (getUserRolesCache[username]) return getUserRolesCache[username];
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

  // getUserRolesCache[username] = res;
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

const activeClients = new Map(); // { username: { ws, mode, target } }

function broadcastSystemUpdate(payloadObj, filterFn = null) {
  const msgStr = JSON.stringify(payloadObj);
  activeClients.forEach((client, username) => {
    if (client.ws.readyState === WebSocket.OPEN) {
      if (!filterFn || filterFn(client)) {
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
    await db.query(
      'INSERT INTO users (username, password_hash, last_ip) VALUES ($1, $2, $3);',
      [username, hash, ip],
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
    'SELECT p.*, u.is_admin, u.is_moderator FROM profiles p JOIN users u ON p.username = u.username WHERE p.username = $1;',
    [targetUsername],
  );
  if (!r.rows[0])
    return res.json({
      username: targetUsername,
      bio: 'Hello world.',
      location: 'Cyberspace',
      avatar_emoji: '👤',
      is_admin: false,
      is_moderator: false,
    });
  res.json(r.rows[0]);
});

app.post('/api/profile', authenticateToken, async (req, res) => {
  let { bio, location, avatar_emoji } = req.body;
  bio = sanitize(bio);
  location = sanitize(location);
  avatar_emoji = sanitize(avatar_emoji);

  await db.query(
    'INSERT INTO profiles (username, bio, location, avatar_emoji) VALUES ($4, $1, $2, $3) ON CONFLICT (username) DO UPDATE SET bio=$1, location=$2, avatar_emoji=$3;',
    [bio, location, avatar_emoji, req.user.username],
  );
  res.json({ success: true });
});

app.get('/api/mod-logs', authenticateToken, async (req, res) => {
  if (!['admin', 'moderator'].includes(req.user.role.role))
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

app.get(
  '/api/admin/find-user/:username',
  authenticateToken,
  async (req, res) => {
    if (!['admin', 'moderator'].includes(req.user.role.role))
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
    if (req.user.role.role !== 'admin') {
      userInfo.last_ip = '[redacted]';
    }
    res.json({ ...userInfo, alts });
  },
);

app.post('/api/admin/set-role', authenticateToken, async (req, res) => {
  if (req.user.role.role !== 'admin')
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
  res.json({ success: true });
});

app.get('/history', authenticateToken, async (req, res) => {
  const off = Math.max(0, parseInt(req.query.index ?? '0', 10) * 10);
  const r = await db.query(
    'SELECT m.* FROM messages m LEFT JOIN users u ON m.username = u.username ORDER BY m.id DESC LIMIT 10 OFFSET $1;',
    [off],
  );
  let result = [];
  for (let row of r.rows) {
    row.role = (await getUserRoles(row.username)).role;
    result.push(row);
  }
  res.json(result.reverse());
});

app.get('/dm-history', authenticateToken, async (req, res) => {
  const off = Math.max(0, parseInt(req.query.index ?? '0', 10) * 10);
  const target = sanitizeUsername(req.query.target);
  // FIX: Force ALIAS and explicit join for name consistency
  const r = await db.query(
    `
    SELECT d.id, d.sender AS username, d.receiver, d.timestamp, d.content, d.is_deleted, d.deleted_by 
    FROM dms d 
    LEFT JOIN users u ON d.sender = u.username 
    WHERE (d.sender = $1 AND d.receiver = $2) OR (d.sender = $2 AND d.receiver = $1) 
    ORDER BY d.id DESC LIMIT 10 OFFSET $3;
  `,
    [req.user.username, target, off],
  );
  let result = [];
  for (let row of r.rows) {
    row.role = (await getUserRoles(row.username)).role;
    result.push(row);
  }
  res.json(result.reverse());
});

app.get('/topic-history', authenticateToken, async (req, res) => {
  const off = Math.max(0, parseInt(req.query.index ?? '0', 10) * 10);
  const slug = sanitize(req.query.slug);
  const r = await db.query(
    'SELECT tm.* FROM topic_messages tm LEFT JOIN users u ON tm.username = u.username WHERE tm.topic_slug = $1 ORDER BY tm.id DESC LIMIT 10 OFFSET $2;',
    [slug, off],
  );
  let result = [];
  for (let row of r.rows) {
    row.role = (await getUserRoles(row.username)).role;
    result.push(row);
  }
  res.json(result.reverse());
});

app.get('/neighborhood-history', authenticateToken, async (req, res) => {
  const off = Math.max(0, parseInt(req.query.index ?? '0', 10) * 10);
  const query = `
    SELECT p.*, 
    COALESCE(json_agg(json_build_object('id', c.id, 'username', c.username, 'content', c.content, 'timestamp', c.timestamp, 'is_deleted', c.is_deleted, 'deleted_by', c.deleted_by, 'is_admin', cu.is_admin, 'is_moderator', cu.is_moderator) ORDER BY c.id ASC) FILTER (WHERE c.id IS NOT NULL), '[]') as comments 
    FROM neighborhood_posts p 
    LEFT JOIN users u ON p.username = u.username
    LEFT JOIN neighborhood_comments c ON p.id = c.post_id 
    LEFT JOIN users cu ON c.username = cu.username
    GROUP BY p.id, u.id ORDER BY p.id DESC LIMIT 10 OFFSET $1;`;
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

const server = app.listen(process.env.PORT || 10000, '0.0.0.0', () =>
  log(`Node strictly bound to port: ${process.env.PORT || 10000}`),
);
const wss = new WebSocketServer({ server });

const ALLOWED_CHANNELS = {
  public: 'messages',
  topic: 'topic_messages',
  neighborhood: 'neighborhood_posts',
  dm: 'dms',
  comment: 'neighborhood_comments',
  neighborhood_comment: 'neighborhood_comments',
};

wss.on('connection', (ws, req) => {
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
            `WS Auth Session Established: ${authUser} (Admin: ${userRoles.role === 'admin'}, Mod: ${userRoles.role === 'moderator'})`,
          );
          if (userRoles.is_banned) {
            log(`WS Termination Triggered: Banned or Timed out user session`);
            ws.send(
              JSON.stringify({ type: 'terminated', reason: 'You are banned' }),
            );
            ws.close();
            return;
          }
          if (BigInt(userRoles.timeout_until) > BigInt(Date.now())) {
            log(`WS Termination Triggered: Banned or Timed out user session`);
            ws.send(
              JSON.stringify({
                type: 'terminated',
                reason: `You are timed out until ${new Date(BigInt(userRoles.timeout_until)).toLocaleString()}`,
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

        broadcastSystemUpdate(
          { type: 'refresh_feed' },
          (c) => c.mode === mode && c.target === target,
        );
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
          userRoles.role.role === 'admin' ||
          (userRoles.role.role === 'moderator' &&
            targetObj.deleted_by === authUser);
        const canDelete =
          isOwner ||
          userRoles.role.role === 'admin' ||
          userRoles.role.role === 'moderator';

        // Deletes
        if (data.type === 'mod_delete' && canDelete) {
          const reason =
            data.reason ||
            (userRoles.role.role === 'admin'
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
            userRoles.role.role === 'moderator' ||
            userRoles.role.role === 'admin'
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
        userRoles.role.role === 'admin' ||
        userRoles.role.role === 'moderator'
      ) {
        // Timeouts
        if (data.type === 'mod_timeout') {
          const target = sanitizeUsername(data.target);
          const targetRoles = await getUserRoles(target);
          if (targetRoles.role.role === 'admin')
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
            data.reason ||
            (userRoles.role.role === 'admin'
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
            userRoles.role.role === 'admin' ||
            (userRoles.role.role === 'moderator' &&
              targetRoles.role.role !== 'admin' &&
              data.target !== authUser)
          ) {
            const client = activeClients.get(data.target);
            const reason =
              data.reason ||
              (userRoles.role.role === 'admin'
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
        if (userRoles.role.role === 'admin') {
          // Bans
          if (data.type === 'mod_ban') {
            const target = sanitizeUsername(data.target);
            const reason = "Admin doesn't need any reasons";
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
