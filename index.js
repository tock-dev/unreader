import express from 'express'
import { WebSocketServer, WebSocket } from 'ws'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import pkg from 'pg'

const { Client } = pkg
const JWT_SECRET = process.env.JWT_SECRET || 'brutalist_secret_key_123'
const db = new Client({ connectionString: process.env.DATABASE_URL })

async function initDatabase() {
  await db.connect();
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
  console.log("PostgreSQL Connected and Tables Ready");
}
initDatabase().catch(err => console.error("Database boot failure", err));

const app = express()
app.use(express.json())
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*")
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization")
  next()
})

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

// REST API Endpoints

app.get('/dm-contacts', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const me = decoded.username;
    const result = await db.query(`
      SELECT DISTINCT username FROM (
        SELECT receiver AS username FROM dms WHERE sender = $1
        UNION
        SELECT sender AS username FROM dms WHERE receiver = $1
      ) AS contacts WHERE username != $1;
    `, [me]);
    res.json(result.rows.map(function(row) { return row.username; }));
  } catch (err) {
    res.status(401).json({ error: 'Session expired' });
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

app.post('/api/change-password', async (req, res) => {
  const authHeader = req.headers.authorization;
  const { password } = req.body;
  if (!authHeader || !password) return res.status(401).json({ error: 'Unauthorized payload' });
  
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const username = decoded.username;
    
    const newHash = await bcrypt.hash(password, 10);
    await db.query('UPDATE users SET password_hash = $1 WHERE username = $2;', [newHash, username]);
    
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    res.status(401).json({ error: 'Authentication failed' });
  }
});

// FIXED: Infinite Scroll Public Feed History Pagination
app.get('/history', async (req, res) => {
  const pageIndex = parseInt(req.query.index ?? '0', 10);
  const offset = pageIndex * 10;
  try {
    const result = await db.query('SELECT * FROM messages ORDER BY timestamp DESC LIMIT 10 OFFSET $1;', [offset]);
    res.json(result.rows.reverse()); 
  } catch (err) {
    res.status(500).json({ error: 'Database history error.' });
  }
});

// FIXED: Infinite Scroll Secure DM Feed History Pagination
app.get('/dm-history', async (req, res) => {
  const authHeader = req.headers.authorization;
  const target = req.query.target;
  const pageIndex = parseInt(req.query.index ?? '0', 10);
  const offset = pageIndex * 10;

  if (!authHeader || !target) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const me = decoded.username;

    const result = await db.query(`
      SELECT * FROM dms 
      WHERE (sender = $1 AND receiver = $2) OR (sender = $2 AND receiver = $1)
      ORDER BY timestamp DESC LIMIT 10 OFFSET $3;
    `, [me, target, offset]);

    res.json(result.rows.reverse());
  } catch (err) {
    res.status(401).json({ error: 'Session expired' });
  }
});

// START HTTP SERVER
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`HTTP Server running on port ${PORT}`));

// WEBSOCKET SERVER IMPLEMENTATION
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let authenticatedUser = null;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      // Handle Authentication via WS Connection
      if (data.type === 'auth') {
        const decoded = jwt.verify(data.token, JWT_SECRET);
        authenticatedUser = decoded.username;
        activeClients.set(authenticatedUser, ws);
        broadcastOnlineRoster();
        return;
      }

      // Safeguard unauthorized sockets
      if (!authenticatedUser) {
        ws.send(JSON.stringify({ type: 'error', message: 'Unauthenticated' }));
        return;
      }

      // FIXED: Process terminal-style system operator override terminations
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

      // FIXED: Process instantaneous database item purges from 'X' elements
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

      // FIXED: Route typing status tracking indicators securely to the right targets
      if (data.type === 'typing') {
        const targetSocket = activeClients.get(data.target);
        if (targetSocket && targetSocket.readyState === WebSocket.OPEN) {
          targetSocket.send(JSON.stringify({ type: 'typing', sender: authenticatedUser }));
        }
        return;
      }

      // Broadcast public global channel messages
      if (data.type === 'public') {
        const timestamp = Date.now();
        // FIXED: Added RETURNING id statement to feed index structures safely
        const dbRes = await db.query('INSERT INTO messages (username, timestamp, content) VALUES ($1, $2, $3) RETURNING id;', [authenticatedUser, timestamp, data.content]);
        const insertedId = dbRes.rows[0].id;
        
        const broadcastPayload = JSON.stringify({
          type: 'public',
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

      // Direct Message Routing Engine
      if (data.type === 'dm') {
        const timestamp = Date.now();
        // FIXED: Added RETURNING id statement to feed index structures safely
        const dbRes = await db.query('INSERT INTO dms (sender, receiver, timestamp, content) VALUES ($1, $2, $3, $4) RETURNING id;', [authenticatedUser, data.target, timestamp, data.content]);
        const insertedId = dbRes.rows[0].id;
        
        const dmPayload = JSON.stringify({
          type: 'dm',
          id: insertedId,
          sender: authenticatedUser,
          receiver: data.target,
          timestamp,
          content: data.content
        });

        // Send to receiver if online
        const recipientSocket = activeClients.get(data.target);
        if (recipientSocket && recipientSocket.readyState === WebSocket.OPEN) {
          recipientSocket.send(dmPayload);
        }
        // Send reflection back to sender device
        ws.send(dmPayload);
      }

    } catch (err) {
      console.error(err);
      ws.send(JSON.stringify({ type: 'error', message: 'Malformed message or invalid session token' }));
    }
  });

  ws.on('close', () => {
    if (authenticatedUser) {
      activeClients.delete(authenticatedUser);
      broadcastOnlineRoster();
    }
  });
});
