// server/server.js
// -----------------
// Requires packages (install in /server):
// npm i express cors sqlite3 bcryptjs jsonwebtoken node-cron nodemailer dotenv
//
// Tip: add "type": "module" in server/package.json
// Scripts: "dev": "nodemon server.js", "start": "node server.js"

import express from 'express';
import cors from 'cors';
import sqlite3 from 'sqlite3';
import fs from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cron from 'node-cron';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

// ---------- Load .env FIRST so env vars are available everywhere ----------
dotenv.config();

// ---------- Boilerplate for __dirname in ES modules ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------- Config ----------
const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me'; // set in prod
const JWT_EXPIRES = '7d';

// ---------- Robust CORS allowlist (prevents crashes & logs clearly) ----------
const ORIGINS = [
    "http://localhost:5173",
    "https://portfolio-sable-nine-56.vercel.app", // your stable Vercel URL
    process.env.FRONTEND_URL || null,
].filter(Boolean);

console.log("🌐 Allowed Origins:", ORIGINS);

app.use(
    cors({
        origin(origin, callback) {
            // Allow REST clients without Origin header (mobile apps / curl / Postman)
            if (!origin) return callback(null, true);

            if (ORIGINS.includes(origin)) {
                callback(null, true);
            } else {
                callback(new Error("CORS blocked for: " + origin));
            }
        },
        credentials: true,
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
        allowedHeaders: ["Content-Type", "Authorization"],
    })
);


// Convert CORS errors into JSON (instead of crashing)
app.use((err, _req, res, next) => {
    if (err && String(err.message || '').startsWith('Not allowed by CORS')) {
        return res.status(403).json({ error: err.message });
    }
    next(err);
});

app.use(express.json()); // parse JSON bodies

// ---------- Data directory & DB file ----------
const dataDir = join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const dbPath = join(dataDir, 'todos.db');

// ---------- SQLite init ----------
const db = new sqlite3.Database(dbPath);
db.run('PRAGMA foreign_keys = ON'); // enable FK cascades

// Promisified helpers
const all = (sql, params = []) =>
    new Promise((res, rej) => db.all(sql, params, (err, rows) => (err ? rej(err) : res(rows))));
const get = (sql, params = []) =>
    new Promise((res, rej) => db.get(sql, params, (err, row) => (err ? rej(err) : res(row))));
const run = (sql, params = []) =>
    new Promise((res, rej) =>
        db.run(sql, params, function (err) {
            if (err) rej(err);
            else res(this);
        })
    );

// ---------- Tables ----------
db.serialize(() => {
    // Users
    db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

    // Todos (per-user)
    db.run(`
    CREATE TABLE IF NOT EXISTS todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      text TEXT NOT NULL,
      completed INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      due_date TEXT,
      priority TEXT DEFAULT 'low',
      category TEXT DEFAULT 'General',
      description TEXT,
      reminder_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

    // Subtasks
    db.run(`
    CREATE TABLE IF NOT EXISTS subtasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      todo_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      completed INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (todo_id) REFERENCES todos(id) ON DELETE CASCADE
    )
  `);
});

// ---------- Auto-migrate: add columns if missing (safe, idempotent) ----------
db.serialize(() => {
    const ensureColumn = (table, name, ddl) => {
        db.get(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`, [name], (e, row) => {
            if (e) return console.error(`PRAGMA lookup error for ${table}.${name}:`, e.message);
            if (!row) {
                db.run(`ALTER TABLE ${table} ADD COLUMN ${ddl}`, (ae) => {
                    if (ae) console.error(`ALTER TABLE add ${table}.${name} failed:`, ae.message);
                    else console.log(`✅ Added column: ${table}.${name}`);
                });
            }
        });
    };
    // In case older DBs lack these:
    ensureColumn('todos', 'category', "category TEXT DEFAULT 'General'");
    ensureColumn('todos', 'description', "description TEXT");
    ensureColumn('todos', 'reminder_at', "reminder_at TEXT");
    ensureColumn('todos', 'user_id', "user_id INTEGER REFERENCES users(id) ON DELETE CASCADE");
});

// (Optional) show DB’s idea of time at boot
db.get("SELECT datetime('now') AS utc, datetime('now','localtime') AS localtime", (err, row) => {
    if (!err && row) console.log('⏱️  DB time →', row);
});

// ---------- Auth helpers ----------
function generateToken(user) {
    return jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = (authHeader && authHeader.split(' ')[1]) || null;
    if (!token) return res.status(401).json({ error: 'Missing token' });
    jwt.verify(token, JWT_SECRET, (err, payload) => {
        if (err) return res.status(401).json({ error: 'Invalid token' });
        req.user = { id: payload.id, email: payload.email };
        next();
    });
}

// ---------- DEV seed user (optional, never in prod) ----------
async function ensureDevUser() {
    if (process.env.NODE_ENV === 'production') return;
    const email = process.env.DEV_USER_EMAIL || 'demo@local';
    const pass = process.env.DEV_USER_PASS || 'demo1234';
    const existing = await get('SELECT id FROM users WHERE email = ?', [email]);
    if (!existing) {
        const hash = await bcrypt.hash(pass, 10);
        await run('INSERT INTO users (email, password_hash) VALUES (?, ?)', [email, hash]);
        console.log(`👤 Seeded dev user: ${email} / ${pass}`);
    }
}
ensureDevUser().catch(console.error);

// ---------- EMAIL transport: prefer Resend SMTP, else Gmail App Password ----------
const transporter = (() => {
    if (process.env.RESEND_API_KEY) {
        console.log('📨 Mail: using Resend SMTP');
        return nodemailer.createTransport({
            host: 'smtp.resend.com',
            port: 587,
            auth: { user: 'resend', pass: process.env.RESEND_API_KEY },
        });
    }
    if (process.env.MAIL_USER && process.env.MAIL_PASS) {
        console.log('📨 Mail: using Gmail SMTP (App Password)');
        return nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
        });
    }
    console.warn('⚠️  Mail transport not configured. Set RESEND_API_KEY or MAIL_USER/MAIL_PASS.');
    return null;
})();

async function sendReminderMail(to, subject, text) {
    if (!transporter) return console.warn('✉️  Skipping email: transporter not configured');
    try {
        await transporter.sendMail({
            from: process.env.MAIL_FROM || process.env.MAIL_USER || 'reminder@resend.dev',
            to,
            subject,
            text,
        });
        console.log(`📧 Email sent to ${to}: ${subject}`);
    } catch (e) {
        console.error('❌ Failed to send email:', e.message);
    }
}

// ---------- ROUTES ----------

// Health check (public)
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ---- Auth ----
app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password } = req.body || {};
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
        const dup = await get('SELECT id FROM users WHERE email = ?', [email]);
        if (dup) return res.status(409).json({ error: 'Email already registered' });
        const hash = await bcrypt.hash(password, 10);
        const r = await run('INSERT INTO users (email, password_hash) VALUES (?, ?)', [email, hash]);
        const user = await get('SELECT id, email, created_at FROM users WHERE id = ?', [r.lastID]);
        const token = generateToken(user);
        res.status(201).json({ token, user });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body || {};
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
        const row = await get('SELECT * FROM users WHERE email = ?', [email]);
        if (!row) return res.status(401).json({ error: 'Invalid credentials' });
        const ok = await bcrypt.compare(password, row.password_hash);
        if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
        const user = { id: row.id, email: row.email, created_at: row.created_at };
        const token = generateToken(user);
        res.json({ token, user });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/me', authenticateToken, async (req, res) => {
    const u = await get('SELECT id, email, created_at FROM users WHERE id = ?', [req.user.id]);
    res.json({ user: u });
});

// ---- Todos (per-user) ----
// Query params: filter=all|active|completed, sort=due|created|priority, order=asc|desc (for 'created')
app.get('/api/todos', authenticateToken, async (req, res) => {
    try {
        const filter = req.query.filter;
        const sort = (req.query.sort || 'due').toLowerCase();
        const order = req.query.order === 'asc' ? 'ASC' : 'DESC';
        const completedLast = req.query.completedLast !== '0';

        let where = 'WHERE user_id = ?';
        if (filter === 'active') where += ' AND completed = 0';
        else if (filter === 'completed') where += ' AND completed = 1';

        const parts = [];
        if (completedLast) parts.push('completed ASC');

        if (sort === 'priority') {
            parts.push(`
        CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END ASC
      `);
            parts.push('CASE WHEN due_date IS NULL THEN 1 ELSE 0 END ASC');
            parts.push('datetime(due_date) ASC');
            parts.push('id DESC');
        } else if (sort === 'created') {
            parts.push(`datetime(created_at) ${order}`);
            parts.push('id DESC');
        } else {
            parts.push('CASE WHEN due_date IS NULL THEN 1 ELSE 0 END ASC');
            parts.push('datetime(due_date) ASC');
            parts.push('id DESC');
        }

        const rows = await all(
            `SELECT * FROM todos ${where} ORDER BY ${parts.join(', ')}`,
            [req.user.id]
        );
        res.json(rows.map(r => ({ ...r, completed: !!r.completed })));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Create todo
app.post('/api/todos', authenticateToken, async (req, res) => {
    try {
        const {
            text,
            due_date,
            priority = 'low',
            category = 'General',
            description = '',
            reminder_at = null,
        } = req.body;

        if (!text || !text.trim()) return res.status(400).json({ error: 'Text is required' });
        if (!['low', 'medium', 'high'].includes(priority)) {
            return res.status(400).json({ error: 'Invalid priority' });
        }

        const r = await run(
            `INSERT INTO todos (user_id, text, completed, due_date, priority, category, description, reminder_at)
       VALUES (?, ?, 0, ?, ?, ?, ?, ?)`,
            [req.user.id, text.trim(), due_date || null, priority, category, description, reminder_at || null]
        );
        const row = await get('SELECT * FROM todos WHERE id = ?', [r.lastID]);
        res.status(201).json({ ...row, completed: !!row.completed });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Toggle completion
app.patch('/api/todos/:id/toggle', authenticateToken, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const existing = await get('SELECT * FROM todos WHERE id = ? AND user_id = ?', [id, req.user.id]);
        if (!existing) return res.status(404).json({ error: 'Not found' });

        const newCompleted = existing.completed ? 0 : 1;
        await run('UPDATE todos SET completed = ? WHERE id = ?', [newCompleted, id]);
        const updated = await get('SELECT * FROM todos WHERE id = ?', [id]);
        res.json({ ...updated, completed: !!updated.completed });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Update (partial)
app.put('/api/todos/:id', authenticateToken, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const existing = await get('SELECT * FROM todos WHERE id = ? AND user_id = ?', [id, req.user.id]);
        if (!existing) return res.status(404).json({ error: 'Not found' });

        const {
            text,
            completed,
            due_date,
            priority,
            category,
            description,
            reminder_at,
        } = req.body;

        const newText = text?.trim() ?? existing.text;
        const newCompleted = completed ?? existing.completed;
        const newDue = due_date ?? existing.due_date;
        const newPriority = priority ?? existing.priority;
        const newCategory = category ?? existing.category ?? 'General';
        const newDescription = description ?? existing.description ?? '';
        const newReminder = reminder_at ?? existing.reminder_at;

        if (priority && !['low', 'medium', 'high'].includes(newPriority)) {
            return res.status(400).json({ error: 'Invalid priority' });
        }

        await run(
            `UPDATE todos
       SET text = ?, completed = ?, due_date = ?, priority = ?, category = ?, description = ?, reminder_at = ?
       WHERE id = ?`,
            [newText, newCompleted ? 1 : 0, newDue, newPriority, newCategory, newDescription, newReminder, id]
        );

        const updated = await get('SELECT * FROM todos WHERE id = ?', [id]);
        res.json({ ...updated, completed: !!updated.completed });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Delete one todo (subtasks cascade)
app.delete('/api/todos/:id', authenticateToken, async (req, res) => {
    try {
        const id = Number(req.params.id);
        await run('DELETE FROM subtasks WHERE todo_id = ?', [id]);
        await run('DELETE FROM todos WHERE id = ? AND user_id = ?', [id, req.user.id]);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Delete ALL todos for current user
app.delete('/api/todos', authenticateToken, async (req, res) => {
    try {
        await run('DELETE FROM subtasks WHERE todo_id IN (SELECT id FROM todos WHERE user_id = ?)', [req.user.id]);
        await run('DELETE FROM todos WHERE user_id = ?', [req.user.id]);
        res.json({ ok: true, message: 'All todos deleted' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ---- Subtasks ----
app.get('/api/todos/:todoId/subtasks', authenticateToken, async (req, res) => {
    try {
        const todoId = Number(req.params.todoId);
        const owner = await get('SELECT id FROM todos WHERE id = ? AND user_id = ?', [todoId, req.user.id]);
        if (!owner) return res.status(404).json({ error: 'Parent not found' });

        const rows = await all(`SELECT * FROM subtasks WHERE todo_id = ? ORDER BY completed ASC, id ASC`, [todoId]);
        res.json(rows.map(r => ({ ...r, completed: !!r.completed })));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/todos/:todoId/subtasks', authenticateToken, async (req, res) => {
    try {
        const todoId = Number(req.params.todoId);
        const parent = await get('SELECT id FROM todos WHERE id = ? AND user_id = ?', [todoId, req.user.id]);
        if (!parent) return res.status(404).json({ error: 'Parent todo not found' });

        const title = (req.body.title || '').trim();
        if (!title) return res.status(400).json({ error: 'Title is required' });

        const r = await run(`INSERT INTO subtasks (todo_id, title) VALUES (?, ?)`, [todoId, title]);
        const row = await get(`SELECT * FROM subtasks WHERE id = ?`, [r.lastID]);
        res.status(201).json({ ...row, completed: !!row.completed });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.patch('/api/subtasks/:id', authenticateToken, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const existing = await get(`SELECT s.*, t.user_id FROM subtasks s JOIN todos t ON s.todo_id = t.id WHERE s.id = ?`, [id]);
        if (!existing || existing.user_id !== req.user.id) return res.status(404).json({ error: 'Not found' });

        const newCompleted = (req.body.completed ?? existing.completed) ? 1 : 0;
        const newTitle = (req.body.title ?? existing.title).trim();
        await run(`UPDATE subtasks SET title = ?, completed = ? WHERE id = ?`, [newTitle, newCompleted, id]);
        const updated = await get(`SELECT * FROM subtasks WHERE id = ?`, [id]);
        res.json({ ...updated, completed: !!updated.completed });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/subtasks/:id', authenticateToken, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const existing = await get(`SELECT s.*, t.user_id FROM subtasks s JOIN todos t ON s.todo_id = t.id WHERE s.id = ?`, [id]);
        if (!existing || existing.user_id !== req.user.id) return res.status(404).json({ error: 'Not found' });

        await run(`DELETE FROM subtasks WHERE id = ?`, [id]);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ---- BACKUP HELPERS & ROUTES ----
function asArray(x) { return Array.isArray(x) ? x : []; }
function validateTodoInput(t) {
    if (!t || typeof t !== 'object') return 'Invalid todo object';
    if (!t.text || typeof t.text !== 'string' || !t.text.trim()) return 'Todo.text is required';
    if (t.priority && !['low', 'medium', 'high'].includes(t.priority)) return 'Invalid priority';
    return null;
}
function nowStamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// Export all todos+subtasks for current user
app.get('/api/backup/export', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const todos = await all(
            `SELECT id, text, completed, created_at, due_date, priority, category, description, reminder_at
       FROM todos WHERE user_id = ? ORDER BY id ASC`, [userId]
        );

        const ids = todos.map(t => t.id);
        let subtasks = [];
        if (ids.length) {
            const placeholders = ids.map(() => '?').join(',');
            subtasks = await all(
                `SELECT id, todo_id, title, completed, created_at
         FROM subtasks WHERE todo_id IN (${placeholders})
         ORDER BY todo_id ASC, id ASC`, ids
            );
        }

        const byTodo = new Map();
        for (const t of todos) byTodo.set(t.id, { ...t, completed: !!t.completed, subtasks: [] });
        for (const s of subtasks) {
            const bucket = byTodo.get(s.todo_id);
            if (bucket) bucket.subtasks.push({ ...s, completed: !!s.completed });
        }

        const payload = {
            schema: 'todo-backup.v1',
            exported_at: new Date().toISOString(),
            user: { id: userId, email: req.user.email },
            todos: todos.map(t => byTodo.get(t.id)),
        };

        if (req.query.download === '1') {
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="backup-${nowStamp()}.json"`);
        }
        res.json(payload);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Import (merge/replace)
app.post('/api/backup/import', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    try {
        const body = req.body || {};
        const mode = (body.mode || 'merge').toLowerCase(); // 'merge' | 'replace'
        const incoming = asArray(body.todos);

        for (const t of incoming) {
            const err = validateTodoInput(t);
            if (err) return res.status(400).json({ error: err });
            if (t.subtasks && !Array.isArray(t.subtasks)) {
                return res.status(400).json({ error: 'todo.subtasks must be an array if provided' });
            }
        }

        await run('BEGIN');
        try {
            if (mode === 'replace') {
                await run('DELETE FROM subtasks WHERE todo_id IN (SELECT id FROM todos WHERE user_id = ?)', [userId]);
                await run('DELETE FROM todos WHERE user_id = ?', [userId]);
            }

            let importedTodos = 0;
            let importedSubs = 0;

            for (const t of incoming) {
                const {
                    text,
                    completed = 0,
                    created_at = null,
                    due_date = null,
                    priority = 'low',
                    category = 'General',
                    description = '',
                    reminder_at = null,
                } = t;

                const ins = await run(
                    `INSERT INTO todos (user_id, text, completed, created_at, due_date, priority, category, description, reminder_at)
           VALUES (?, ?, ?, COALESCE(?, datetime('now','localtime')), ?, ?, ?, ?, ?)`,
                    [userId, text.trim(), completed ? 1 : 0, created_at, due_date || null, priority, category, description, reminder_at || null]
                );
                const newTodoId = ins.lastID;
                importedTodos++;

                for (const s of asArray(t.subtasks)) {
                    const title = (s.title || '').trim();
                    if (!title) continue;
                    await run(
                        `INSERT INTO subtasks (todo_id, title, completed, created_at)
             VALUES (?, ?, ?, COALESCE(?, datetime('now','localtime')))`,
                        [newTodoId, title, s.completed ? 1 : 0, s.created_at || null]
                    );
                    importedSubs++;
                }
            }

            await run('COMMIT');
            res.json({ ok: true, mode, summary: { importedTodos, importedSubs } });
        } catch (err) {
            await run('ROLLBACK');
            throw err;
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ---------- REMINDER SCHEDULER ----------
// Checks every minute for reminders that are due now; emails user, then clears reminder_at
// ---------- REMINDER SCHEDULER (shared logic) ----------
async function processDueReminders() {
    try {
        const dueReminders = await all(
            `SELECT t.id, t.text, t.reminder_at, t.user_id, u.email
             FROM todos t
             JOIN users u ON t.user_id = u.id
             WHERE t.reminder_at IS NOT NULL
               AND t.completed = 0
               AND datetime(t.reminder_at) <= datetime('now','localtime')`
        );

        if (!dueReminders.length) return;

        console.log(`🔔 [${new Date().toLocaleTimeString()}] ${dueReminders.length} reminder(s) triggered:`);

        for (const r of dueReminders) {
            const pretty = new Date((r.reminder_at || '').replace(' ', 'T')).toLocaleString();
            const msg = `🔔 Reminder: "${r.text}" is due at ${pretty}`;
            console.log(`📬 Sending to ${r.email} → ${msg}`);
            await sendReminderMail(r.email, '⏰ Task Reminder', `${msg}\n\n— Your To-Do App`);
            await run(`UPDATE todos SET reminder_at = NULL WHERE id = ?`, [r.id]);
        }
    } catch (err) {
        console.error('❌ Reminder processing failed:', err.message);
    }
}

// Local/dev cron: runs every minute while the container is alive
//cron.schedule('* * * * *', () => {
//    processDueReminders().catch(err =>
//        console.error('❌ Reminder cron failed:', err.message)
//    );
//});

// Manual trigger for reminders (used by Railway Cron)
app.get('/api/reminders/check', async (req, res) => {
    try {
        const dueReminders = await all(
            `SELECT t.id, t.text, t.reminder_at, t.user_id, u.email
             FROM todos t
             JOIN users u ON t.user_id = u.id
             WHERE t.reminder_at IS NOT NULL
               AND t.completed = 0
               AND datetime(t.reminder_at) <= datetime('now','localtime')`
        );

        if (dueReminders.length === 0) {
            return res.json({ ok: true, message: "No reminders due" });
        }

        for (const r of dueReminders) {
            const pretty = new Date((r.reminder_at || '').replace(' ', 'T')).toLocaleString();
            const msg = `🔔 Reminder: "${r.text}" is due at ${pretty}`;
            await sendReminderMail(r.email, '⏰ Task Reminder', `${msg}\n\n— Your To-Do App`);
            await run(`UPDATE todos SET reminder_at = NULL WHERE id = ?`, [r.id]);
        }

        return res.json({ ok: true, sent: dueReminders.length });
    } catch (err) {
        console.error("Reminder check failed:", err.message);
        return res.status(500).json({ error: err.message });
    }
});



// ---------- Start server ----------
app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
});
