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
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      timeout_until BIGINT DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      timestamp BIGINT NOT NULL,
      content TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dms (
      id SERIAL PRIMARY KEY,
      sender TEXT NOT NULL,
      receiver TEXT NOT NULL,
      timestamp BIGINT NOT NULL,
      content TEXT NOT NULL
    );
  `);
  console.log("PostgreSQL Connected (via Pool) and Tables Ready");
}
initDatabase().catch(err => console.error("Database boot failure", err));

const app = express()
app.use(express.json())
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*")
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization")
  next()
})

// REFACTORED: Unified middleware verifying requests across endpoints
function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

const activeClients = new Map()

function isMasterAdmin(name) {
  return name === 'augustinejames' || name === 'tockdev';
}

function broadcastOnlineRoster() {
  const onlineUsernames = Array.from(activeClients.keys());
  const payload = JSON.stringify({ type: 'roster_update', users: onlineUsernames });
  activeClients.forEach(function(clientSocket) {
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.send(payload);
    }
  });
}

// REST API ENDPOINTS

app.get('/dm-contacts', authenticateToken, async (req, res) => {
  try {
    const me = req.user.username;
    const result = await db.query(`
      SELECT DISTINCT username FROM (
        SELECT receiver AS username FROM dms WHERE sender = $1
        UNION
        SELECT sender AS username FROM dms WHERE receiver = $1
      ) AS contacts WHERE username != $1;
    `, [me]);
    res.json(result.rows.map(row => row.username));
  } catch (err) {
    res.status(500).json({ error: 'Database read failure' });
  }
});

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' })
  try {
    const hash = await bcrypt.hash(password, 10)
    await db.query('INSERT INTO users (username, password_hash) VALUES ($1, $2);', [username, hash])
    const token = jwt.sign({ username }, JWT_SECRET)
    res.json({ token, username })
  } catch (err) {
    res.status(400).json({ error: 'Username already taken' })
  }
})

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body
  try {
    const result = await db.query('SELECT * FROM users WHERE username = $1;', [username])
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials' })
    }
    const token = jwt.sign({ username }, JWT_SECRET)
    res.json({ token, username })
  } catch (err) {
    res.status(500).json({ error: 'Server authentication failure' })
  }
})

app.post('/api/change-password', authenticateToken, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password cannot be blank' });
  
  try {
    const username = req.user.username;
    const newHash = await bcrypt.hash(password, 10);
    await db.query('UPDATE users SET password_hash = $1 WHERE username = $2;', [newHash, username]);
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Database update fault' });
  }
});

// FIXED: Secured with token middleware to stop random data scraping leaks
app.get('/history', authenticateToken, async (req, res) => {
  const pageIndex = parseInt(req.query.index ?? '0', 10);
  const offset = pageIndex * 10;
  try {
    const result = await db.query('SELECT * FROM messages ORDER BY timestamp DESC LIMIT 10 OFFSET $1;', [offset]);
    res.json(result.rows.reverse()); 
  } catch (err) {
    res.status(500).json({ error: 'Database history error.' });
  }
});

app.get('/dm-history', authenticateToken, async (req, res) => {
  const target = req.query.target;
  const pageIndex = parseInt(req.query.index ?? '0', 10);
  const offset = pageIndex * 10;

  if (!target) return res.status(400).json({ error: 'Target query required' });
  try {
    const me = req.user.username;
    const result = await db.query(`
      SELECT id, sender AS username, receiver, timestamp, content FROM dms 
      WHERE (sender = $1 AND receiver = $2) OR (sender = $2 AND receiver = $1)
      ORDER BY timestamp DESC LIMIT 10 OFFSET $3;
    `, [me, target, offset]);

    res.json(result.rows.reverse());
  } catch (err) {
    res.status(500).json({ error: 'Database history error.' });
  }
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`HTTP Server running on port ${PORT}`));

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let authenticatedUser = null;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'auth') {
        const decoded = jwt.verify(data.token, JWT_SECRET);
        authenticatedUser = decoded.username;
        activeClients.set(authenticatedUser, ws);
        broadcastOnlineRoster();
        return;
      }

      if (!authenticatedUser) {
        ws.send(JSON.stringify({ type: 'error', message: 'Unauthenticated' }));
        return;
      }

      if (data.type === 'mod_kick' && isMasterAdmin(authenticatedUser)) {
        if (isMasterAdmin(data.target)) return;
        const targetSocket = activeClients.get(data.target);
        if (targetSocket) {
          targetSocket.send(JSON.stringify({ type: 'terminated' }));
          targetSocket.close();
          activeClients.delete(data.target);
        }
        broadcastOnlineRoster();
        return;
      }

      if (data.type === 'mod_delete' && isMasterAdmin(authenticatedUser)) {
        if (data.channel === 'public') {
          await db.query('DELETE FROM messages WHERE id = $1;', [data.id]);
        } else {
          await db.query('DELETE FROM dms WHERE id = $1;', [data.id]);
        }
        const deletePayload = JSON.stringify({ type: 'msg_deleted', id: data.id });
        activeClients.forEach(function(c) {
          if (c.readyState === WebSocket.OPEN) c.send(deletePayload);
        });
        return;
      }

      if (data.type === 'typing') {
        const targetSocket = activeClients.get(data.target);
        if (targetSocket && targetSocket.readyState === WebSocket.OPEN) {
          targetSocket.send(JSON.stringify({ type: 'typing', sender: authenticatedUser }));
        }
        return;
      }

      if (data.type === 'message') {
        const timestamp = Date.now();
        const dbRes = await db.query('INSERT INTO messages (username, timestamp, content) VALUES ($1, $2, $3) RETURNING id;', [authenticatedUser, timestamp, data.content]);
        const insertedId = dbRes.rows[0].id;
        
        const broadcastPayload = JSON.stringify({
          type: 'message',
          id: insertedId,
          username: authenticatedUser,
          timestamp,
          content: data.content
        });

        activeClients.forEach((clientSocket) => {
          if (clientSocket.readyState === WebSocket.OPEN) {
            clientSocket.send(broadcastPayload);
          }
        });
      }

      if (data.type === 'dm') {
        const timestamp = Date.now();
        const dbRes = await db.query('INSERT INTO dms (sender, receiver, timestamp, content) VALUES ($1, $2, $3, $4) RETURNING id;', [authenticatedUser, data.target, timestamp, data.content]);
        const insertedId = dbRes.rows[0].id;
        
        // FIXED: Maps structural .username accurately to support client UI state mapping cleanly
        const dmPayload = JSON.stringify({
          type: 'dm',
          id: insertedId,
          username: authenticatedUser, 
          sender: authenticatedUser,
          receiver: data.target,
          timestamp,
          content: data.content
        });

        const recipientSocket = activeClients.get(data.target);
        if (recipientSocket && recipientSocket.readyState === WebSocket.OPEN) {
          recipientSocket.send(dmPayload);
        }
        ws.send(dmPayload);
      }

    } catch (err) {
      console.error("Payload execution fault", err);
    }
  });

  ws.on('close', () => {
    if (authenticatedUser) {
      activeClients.delete(authenticatedUser);
      broadcastOnlineRoster();
    }
  });
});
