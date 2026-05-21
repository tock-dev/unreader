import express from 'express'
import { WebSocketServer, WebSocket } from 'ws'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import pkg from 'pg'
const { Client } = pkg

const JWT_SECRET = process.env.JWT_SECRET || 'brutalist_secret_key_123'

// Instantiating continuous database connection profiles
const db = new Client({
    connectionString: process.env.DATABASE_URL
})

async function initDatabase() {
    await db.connect();
    await db.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL
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

// Fetch all unique users this account has interactive DM logs mapped alongside
app.get('/dm-contacts', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Unauthorized payload access block' });

    try {
        const token = authHeader.split(' ')[1] || authHeader.split(' ')[0];
        const decoded = jwt.verify(token, JWT_SECRET);
        const me = decoded.username;

        const result = await db.query(`
            SELECT DISTINCT username FROM (
                SELECT receiver AS username FROM dms WHERE sender = $1
                UNION
                SELECT sender AS username FROM dms WHERE receiver = $1
            ) AS contacts WHERE username != $1;
        `, [me]);

        res.json(result.rows.map(row => row.username));
    } catch (err) {
        res.status(401).json({ error: 'Session signature failure matching profile' });
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
        const user = result.rows[0]
        if (!user || !(await bcrypt.compare(password, user.password_hash))) {
            return res.status(401).json({ error: 'Invalid credentials' })
        }
        const token = jwt.sign({ username }, JWT_SECRET)
        res.json({ token, username })
    } catch (err) {
        res.status(500).json({ error: 'Server authentication failure' })
    }
})

app.get('/history', async (req, res) => {
    const offset = parseInt(req.query.index ?? '0', 10) * 10
    try {
        const result = await db.query('SELECT * FROM messages ORDER BY timestamp DESC LIMIT 10 OFFSET $1;', [offset])
        res.json(result.rows.reverse()) 
    } catch (err) {
        res.status(500).json({ error: 'Database history error.' })
    }
})

app.get('/dm-history', async (req, res) => {
    const authHeader = req.headers.authorization
    const target = req.query.target
    if (!authHeader || !target) return res.status(401).json({ error: 'Unauthorized' })
    try {
        const token = authHeader.split(' ')[1] || authHeader.split(' ')[0];
        const decoded = jwt.verify(token, JWT_SECRET)
        const me = decoded.username
        const result = await db.query(`
            SELECT * FROM dms WHERE (sender = $1 AND receiver = $2) OR (sender = $2 AND receiver = $1)
            ORDER BY timestamp DESC LIMIT 30;
        `, [me, target])
        res.json(result.rows.reverse())
    } catch (err) {
        res.status(401).json({ error: 'Session expired' })
    }
})

const PORT = process.env.PORT || 3000
const server = app.listen(PORT, () => console.log(`HTTP operational on port ${PORT}`))
const wss = new WebSocketServer({ server })

wss.on('connection', (ws) => {
    let authenticatedUser = null

    ws.on('message', async (msg) => {
        try {
            const data = JSON.parse(msg)

            if (data.type === 'auth') {
                const decoded = jwt.verify(data.token, JWT_SECRET)
                authenticatedUser = decoded.username
                activeClients.set(authenticatedUser, ws)
                return
            }

            if (!authenticatedUser) return;
            const timestamp = Date.now()

            if (data.type === 'typing') {
                const targetSocket = activeClients.get(data.target)
                if (targetSocket && targetSocket.readyState === WebSocket.OPEN) {
                    targetSocket.send(JSON.stringify({ type: 'typing', sender: authenticatedUser }))
                }
                return;
            }

            if (data.type === 'public') {
                await db.query('INSERT INTO messages (username, timestamp, content) VALUES ($1, $2, $3);', [authenticatedUser, timestamp, data.content])
                const payload = JSON.stringify({ type: 'public', username: authenticatedUser, timestamp, content: data.content })
                wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(payload) })
            }

            if (data.type === 'dm') {
                await db.query('INSERT INTO dms (sender, receiver, timestamp, content) VALUES ($1, $2, $3, $4);', [authenticatedUser, data.target, timestamp, data.content])
                const payload = JSON.stringify({ type: 'dm', sender: authenticatedUser, receiver: data.target, timestamp, content: data.content })
                ws.send(payload)
                const targetSocket = activeClients.get(data.target)
                if (targetSocket && targetSocket.readyState === WebSocket.OPEN) targetSocket.send(payload)
            }
        } catch (err) {
            console.error('Transmission fault:', err)
        }
    })

    ws.on('close', () => { if (authenticatedUser) activeClients.delete(authenticatedUser) })
})
