// App.jsx
import React, { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import './styles.css';

const API = axios.create({
    baseURL: import.meta?.env?.VITE_API_URL || 'http://localhost:4000/api',
});
// Attach token to every request
API.interceptors.request.use((config) => {
    const t = localStorage.getItem('token');
    if (t) config.headers.Authorization = `Bearer ${t}`;
    return config;
});
// Handle 401s globally -> logout
let setAuthStateExternal = null;
API.interceptors.response.use(
    (resp) => resp,
    (err) => {
        if (err?.response?.status === 401 && setAuthStateExternal) {
            setAuthStateExternal((s) => ({ ...s, token: null, user: null }));
            localStorage.removeItem('token');
        }
        return Promise.reject(err);
    }
);

/* ========== Snackbar (Undo / Reminders) ========== */
function Snackbar({ message, onUndo, onClose, showUndo = true }) {
    if (!message) return null;
    return (
        <div className="snackbar">
            <span className="label">{message}</span>
            {showUndo && <button className="action undo" onClick={onUndo}>Undo</button>}
            <button className="action dismiss" onClick={onClose}>Dismiss</button>
        </div>
    );
}

/* ========== Auth Panel (Register / Login / Logout) ========== */
function AuthPanel({ auth, setAuth }) {
    const [email, setEmail] = useState('');
    const [pw, setPw] = useState('');
    const [busy, setBusy] = useState(false);
    const hasToken = !!auth.token;

    const register = async () => {
        if (!email || !pw) return alert('Email and password required.');
        setBusy(true);
        try {
            const { data } = await API.post('/auth/register', { email, password: pw });
            localStorage.setItem('token', data.token);
            setAuth({ token: data.token, user: data.user });
            setEmail(''); setPw('');
        } catch (e) {
            alert(e?.response?.data?.error || e.message);
        } finally {
            setBusy(false);
        }
    };

    const login = async () => {
        if (!email || !pw) return alert('Email and password required.');
        setBusy(true);
        try {
            const { data } = await API.post('/auth/login', { email, password: pw });
            localStorage.setItem('token', data.token);
            setAuth({ token: data.token, user: data.user });
            setEmail(''); setPw('');
        } catch (e) {
            alert(e?.response?.data?.error || e.message);
        } finally {
            setBusy(false);
        }
    };

    const logout = () => {
        localStorage.removeItem('token');
        setAuth({ token: null, user: null });
    };

    return (
        <div className="card" style={{ marginBottom: 12 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <div style={{ fontWeight: 600 }}>Account</div>
                {hasToken && auth.user ? (
                    <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                        <span className="badge">Signed in: {auth.user.email}</span>
                        <button className="small danger" onClick={logout}>Logout</button>
                    </div>
                ) : (
                    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                        <input
                            type="email"
                            placeholder="you@example.com"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            style={{ minWidth: 220 }}
                        />
                        <input
                            type="password"
                            placeholder="Password"
                            value={pw}
                            onChange={(e) => setPw(e.target.value)}
                            style={{ minWidth: 160 }}
                        />
                        <button className="small" disabled={busy} onClick={login}>Login</button>
                        <button className="small secondary" disabled={busy} onClick={register}>Register</button>
                    </div>
                )}
            </div>
        </div>
    );
}

// Minimal, style-neutral subtasks block that inherits your existing styles
function SubtasksBlock({ todoId }) {
    const [subtasks, setSubtasks] = React.useState([]);
    const [newSub, setNewSub] = React.useState("");

    const load = async () => {
        const { data } = await API.get(`/todos/${todoId}/subtasks`);
        setSubtasks(data);
    };

    React.useEffect(() => { load(); }, [todoId]);

    const add = async () => {
        const title = newSub.trim();
        if (!title) return;
        const { data } = await API.post(`/todos/${todoId}/subtasks`, { title });
        setSubtasks(prev => [...prev, data]);
        setNewSub("");
    };

    const toggle = async (s) => {
        const { data } = await API.patch(`/subtasks/${s.id}`, { completed: !s.completed });
        setSubtasks(prev => prev.map(x => (x.id === s.id ? data : x)));
    };

    const remove = async (id) => {
        await API.delete(`/subtasks/${id}`);
        setSubtasks(prev => prev.filter(x => x.id !== id));
    };

    return (
        <details style={{ marginTop: 8 }}>
            <summary>Subtasks ({subtasks.length})</summary>
            {subtasks.length === 0 ? (
                <div style={{ opacity: 0.75, fontSize: 12, marginTop: 6 }}>No subtasks yet.</div>
            ) : (
                <ul style={{ paddingLeft: 16, marginTop: 6 }}>
                    {subtasks.map(s => (
                        <li key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, margin: "4px 0" }}>
                            <input type="checkbox" checked={s.completed} onChange={() => toggle(s)} />
                            <span style={s.completed ? { textDecoration: "line-through", opacity: 0.7 } : {}}>
                                {s.title}
                            </span>
                            <button onClick={() => remove(s.id)} style={{ marginLeft: "auto" }}>
                                Delete
                            </button>
                        </li>
                    ))}
                </ul>
            )}

            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <input
                    placeholder="Add a subtask…"
                    value={newSub}
                    onChange={(e) => setNewSub(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") add(); }}
                />
                <button onClick={add}>Add</button>
            </div>
        </details>
    );
}

/* ========== Single Todo Item ========== */
function TodoItem({ todo, onToggle, onDelete, onEdit }) {
    const [editing, setEditing] = useState(false);
    const [text, setText] = useState(todo.text);

    // Local states for autosave fields
    const [desc, setDesc] = useState(todo.description || '');
    const [cat, setCat] = useState(todo.category || 'General');

    const localCreated = useMemo(() => {
        try {
            const d = new Date(todo.created_at.replace(' ', 'T'));
            return isNaN(d.getTime()) ? todo.created_at : d.toLocaleString();
        } catch {
            return todo.created_at;
        }
    }, [todo.created_at]);

    const Due = () => {
        if (!todo.due_date) return null;
        const hasTime = todo.due_date.includes('T');
        const due = new Date(hasTime ? todo.due_date : `${todo.due_date}T00:00:00`);
        const now = new Date();
        const isOverdue = due < now && !todo.completed;
        return (
            <div className="muted" style={{ fontSize: 12, color: isOverdue ? 'red' : 'inherit' }}>
                Due: {hasTime ? due.toLocaleString() : due.toLocaleDateString()}
            </div>
        );
    };

    const Reminder = () => {
        if (!todo.reminder_at) return null;
        const hasTime = todo.reminder_at.includes('T');
        const when = new Date(hasTime ? todo.reminder_at : `${todo.reminder_at}T09:00:00`);
        return (
            <div className="muted" style={{ fontSize: 12 }}>
                Reminder: {hasTime ? when.toLocaleString() : when.toLocaleDateString()}
            </div>
        );
    };

    const PriorityBadge = () => {
        const p = todo.priority || 'low';
        return (
            <span className="badge" title={`Priority: ${p}`}>
                <span className={`dot ${p}`}></span>
                {p[0].toUpperCase() + p.slice(1)}
            </span>
        );
    };

    const saveText = async () => {
        const t = text.trim();
        if (!t) return;
        await onEdit(todo.id, t);
        setEditing(false);
    };

    const saveDescription = async () => {
        await onEdit(todo.id, undefined, { description: desc });
    };

    const saveCategory = async (newCat) => {
        setCat(newCat);
        await onEdit(todo.id, undefined, { category: newCat });
    };

    return (
        <div className="todo">
            <div className="left" style={{ display: 'flex' }}>
                <input
                    type="checkbox"
                    className="checkbox"
                    checked={todo.completed}
                    onChange={() => onToggle(todo)}
                />

                {editing ? (
                    <input
                        className="editInput"
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        onBlur={saveText}
                        onKeyDown={(e) => e.key === 'Enter' && saveText()}
                        autoFocus
                    />
                ) : (
                    <div>
                        <span className={'text ' + (todo.completed ? 'done' : '')}>
                            {todo.text}
                        </span>
                        <div className="muted" style={{ fontSize: 12 }}>Created at: {localCreated}</div>
                        <Due />
                        <Reminder />

                        <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                            <span className="badge" title={`Category: ${cat}`}>🗂️ {cat}</span>
                            <PriorityBadge />
                        </div>

                        {/* Description (autosave + Enter to save) */}
                        <input
                            className="editInput"
                            style={{ marginTop: 6, width: '100%' }}
                            placeholder="Add a description…"
                            value={desc}
                            onChange={(e) => setDesc(e.target.value)}
                            onBlur={saveDescription}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && !e.shiftKey) {
                                    e.preventDefault();
                                    saveDescription();
                                    e.currentTarget.blur();
                                }
                            }}
                        />

                        {/* Category quick-change (instant save) */}
                        <select
                            value={cat}
                            onChange={(e) => saveCategory(e.target.value)}
                            style={{ marginTop: 6 }}
                            title="Change category"
                        >
                            <option>General</option>
                            <option>Work</option>
                            <option>School</option>
                            <option>Fitness</option>
                            <option>Personal</option>
                        </select>
                    </div>
                )}
            </div>

            <div className="actions" style={{ display: 'flex', gap: 6 }}>
                {!editing && <button className="small secondary" onClick={() => setEditing(true)}>Edit</button>}
                <button className="small danger" onClick={() => onDelete(todo)}>Delete</button>
            </div>

            <SubtasksBlock todoId={todo.id} />
        </div>
    );
}

function BackupPanel({ enabled }) {
    if (!enabled) return null;

    const doExport = async () => {
        try {
            const { data } = await API.get("/backup/export");
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `backup-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`;
            a.click();
            URL.revokeObjectURL(url);
        } catch (e) {
            alert(e?.response?.data?.error || e.message);
        }
    };

    const onImportFile = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const text = await file.text();
            const payload = JSON.parse(text);
            payload.mode = e.altKey ? "replace" : "merge";
            await API.post("/backup/import", payload);
            alert(`Import (${payload.mode}) complete.`);
            window.location.reload();
        } catch (err) {
            alert(err?.message || "Import failed.");
        } finally {
            e.target.value = "";
        }
    };

    return (
        <div className="card" style={{ marginBottom: 12 }}>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div style={{ fontWeight: 600 }}>Backup & Restore</div>
                <div className="row" style={{ gap: 8 }}>
                    <button className="small" onClick={doExport}>Export JSON</button>
                    <label className="small secondary" style={{ cursor: "pointer" }}>
                        Import JSON
                        <input type="file" accept="application/json" onChange={onImportFile} style={{ display: "none" }} />
                    </label>
                </div>
            </div>
            <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                Hold <b>Alt/Option</b> while selecting a file to import in <b>replace</b> mode.
            </div>
        </div>
    );
}


/* ========== Main App ========== */
export default function App() {
    const [auth, setAuth] = useState({ token: localStorage.getItem('token') || null, user: null });
    setAuthStateExternal = setAuth; // expose to interceptor

    // Fetch /api/me when we have a token
    useEffect(() => {
        const init = async () => {
            if (!auth.token) return;
            try {
                const { data } = await API.get('/me');
                setAuth((s) => ({ ...s, user: data.user }));
            } catch (e) {
                // handled by interceptor if 401
            }
        };
        init();
    }, [auth.token]);

    // Data
    const [todos, setTodos] = useState([]);

    // Inputs
    const [text, setText] = useState('');
    const [dueDate, setDueDate] = useState('');   // YYYY-MM-DD
    const [dueTime, setDueTime] = useState('');   // HH:mm (optional)
    const [priority, setPriority] = useState('low');
    const [category, setCategory] = useState('General');
    const [description, setDescription] = useState('');
    const [reminderDate, setReminderDate] = useState('');
    const [reminderTime, setReminderTime] = useState('');

    // UI state
    const [filter, setFilter] = useState(() => localStorage.getItem('filter') || 'all');
    const [search, setSearch] = useState('');
    const [loading, setLoading] = useState(false);

    // Sorting (sticky)
    const [sortMode, setSortMode] = useState(() => localStorage.getItem('sortMode') || 'due');   // 'due' | 'created' | 'priority'
    const [sortOrder, setSortOrder] = useState(() =>
        localStorage.getItem('sortOrder') ||
        (localStorage.getItem('sortMode') === 'created' ? 'desc' : 'asc')
    );

    // Snackbar (undo)
    const [snackbar, setSnackbar] = useState(null); // { message, action: 'toggle'|'delete'|null, todo? }
    const timerRef = useRef(null);

    // Theme persistence
    useEffect(() => {
        const saved = localStorage.getItem('theme');
        if (saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
            document.body.classList.add('dark');
        }
    }, []);
    const toggleTheme = () => {
        const isDark = document.body.classList.toggle('dark');
        localStorage.setItem('theme', isDark ? 'dark' : 'light');
    };

    // Helpers to build date/time strings
    const buildDue = () => {
        if (!dueDate && !dueTime) return null;
        if (dueTime && !dueDate) { alert('Pick a date before setting a time.'); return null; }
        return dueDate ? (dueTime ? `${dueDate}T${dueTime}` : dueDate) : null;
    };
    const buildReminder = () => {
        if (!reminderDate && !reminderTime) return null;
        if (reminderTime && !reminderDate) { alert('Pick a reminder date before setting a time.'); return null; }
        return reminderDate ? (reminderTime ? `${reminderDate}T${reminderTime}` : reminderDate) : null;
    };

    // Load todos with current params
    const load = async (f = filter, s = sortMode, o = sortOrder) => {
        if (!auth.token) return;
        setLoading(true);
        const { data } = await API.get('/todos', {
            params: { filter: f, sort: s, order: s === 'created' ? o : 'asc' },
        });
        setTodos(data);
        setLoading(false);
    };

    // Auto-load when auth/filter/sort change (and persist prefs)
    useEffect(() => {
        if (!auth.token) return;
        localStorage.setItem('filter', filter);
        localStorage.setItem('sortMode', sortMode);
        localStorage.setItem('sortOrder', sortOrder);
        load(filter, sortMode, sortMode === 'created' ? sortOrder : 'asc');
    }, [auth.token, filter, sortMode, sortOrder]);

    // In-app reminders: schedule toasts for future reminder_at
    useEffect(() => {
        if (!auth.token) return;
        let timers = [];
        todos.forEach((t) => {
            if (!t.reminder_at) return;
            const hasTime = t.reminder_at.includes('T');
            const when = new Date(hasTime ? t.reminder_at : `${t.reminder_at}T09:00:00`);
            const delay = when.getTime() - Date.now();
            if (delay <= 0) return;
            const id = setTimeout(() => {
                showSnackbar({ message: `🔔 Reminder: ${t.text}`, action: null });
            }, delay);
            timers.push(id);
        });
        return () => timers.forEach(clearTimeout);
    }, [auth.token, todos]);

    // Add new todo (form-submit/Enter)
    const add = async () => {
        if (!auth.token) return alert('Please login first.');
        const t = text.trim();
        if (!t) return alert('Task text cannot be empty.');
        if (dueTime && !dueDate) return alert('Pick a date before setting a time.');
        if (reminderTime && !reminderDate) return alert('Pick a reminder date before setting a time.');

        await API.post('/todos', {
            text: t,
            due_date: buildDue(),
            priority,
            category,
            description,
            reminder_at: buildReminder(),
        });
        await load(filter, sortMode, sortMode === 'created' ? sortOrder : 'asc');

        // reset
        setText('');
        setDueDate(''); setDueTime('');
        setPriority('low'); setCategory('General'); setDescription('');
        setReminderDate(''); setReminderTime('');
    };

    // Toggle completion with undo
    const toggle = async (todo) => {
        if (!auth.token) return;
        await API.patch(`/todos/${todo.id}/toggle`);
        await load();
        showSnackbar({
            message: todo.completed ? 'Marked as active' : 'Marked as completed',
            action: 'toggle',
            todo: { ...todo, completed: !todo.completed },
        });
    };

    // Delete with undo
    const remove = async (todo) => {
        if (!auth.token) return;
        await API.delete(`/todos/${todo.id}`);
        setTodos((prev) => prev.filter((t) => t.id !== todo.id));
        showSnackbar({ message: 'Task deleted', action: 'delete', todo });
    };

    // Edit supports partial updates
    const edit = async (id, newText, extras = {}) => {
        if (!auth.token) return;
        const body = {};
        if (newText !== undefined) body.text = newText;
        Object.assign(body, extras);
        await API.put(`/todos/${id}`, body);
        await load();
    };

    // Clear completed
    const clearCompleted = async () => {
        if (!auth.token) return;
        const done = todos.filter((t) => t.completed);
        if (done.length === 0) return;
        const ok = window.confirm(`Delete ${done.length} completed task(s)?`);
        if (!ok) return;
        await Promise.all(done.map((t) => API.delete(`/todos/${t.id}`)));
        setTodos((prev) => prev.filter((t) => !t.completed));
    };

    // Delete all
    const deleteAll = async () => {
        if (!auth.token) return;
        const ok = window.confirm('Delete ALL tasks?');
        if (!ok) return;
        await API.delete('/todos');
        setTodos([]);
    };

    // Snackbar helpers
    const showSnackbar = ({ message, action = null, todo = null }) => {
        clearTimeout(timerRef.current);
        setSnackbar({ message, action, todo });
        timerRef.current = setTimeout(() => setSnackbar(null), 3000);
    };
    const undo = async () => {
        if (!auth.token || !snackbar) return;
        const { action, todo } = snackbar;
        clearTimeout(timerRef.current);
        setSnackbar(null);
        if (action === 'toggle') {
            await API.patch(`/todos/${todo.id}/toggle`);
            await load();
        } else if (action === 'delete') {
            await API.post('/todos', {
                text: todo.text,
                due_date: todo.due_date || null,
                priority: todo.priority || 'low',
                category: todo.category || 'General',
                description: todo.description || '',
                reminder_at: todo.reminder_at || null,
            });
            await load();
        }
    };
    const dismiss = () => {
        clearTimeout(timerRef.current);
        setSnackbar(null);
    };

    // Client-side search
    const q = search.trim().toLowerCase();
    const visible = q ? todos.filter((t) => t.text.toLowerCase().includes(q)) : todos;
    const remaining = visible.filter((t) => !t.completed).length;

    return (
        <div className="container">
            {/* Theme toggle */}
            <div className="theme-toggle theme-toggle-fixed" onClick={toggleTheme}>🌓</div>

            {/* Auth */}
            <AuthPanel auth={auth} setAuth={setAuth} />
            {/* Backup & Restore (only visible when logged in) */}
            {auth.token && <BackupPanel enabled />}


            {/* If not logged in, show tip and exit */}
            {!auth.token ? (
                <div className="card">
                    <h2>Welcome 👋</h2>
                    <p className="muted">
                        Please <b>Register</b> or <b>Login</b> above to start managing your tasks.
                    </p>
                </div>
            ) : (
                <div className="card">
                    <h1>✅ To-Do List</h1>

                    {/* Add new task */}
                    <form
                        className="row"
                        style={{ gap: 8 }}
                        onSubmit={(e) => { e.preventDefault(); add(); }}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
                    >
                        <input
                            type="text"
                            placeholder="What do you need to do?"
                            value={text}
                            onChange={(e) => setText(e.target.value)}
                        />

                        <select value={category} onChange={(e) => setCategory(e.target.value)}>
                            <option>General</option>
                            <option>Work</option>
                            <option>School</option>
                            <option>Fitness</option>
                            <option>Personal</option>
                        </select>

                        <input
                            type="date"
                            value={dueDate}
                            onChange={(e) => setDueDate(e.target.value)}
                            title="Due date"
                        />
                        <input
                            type="time"
                            value={dueTime}
                            onChange={(e) => setDueTime(e.target.value)}
                            title="Due time (optional)"
                            placeholder="Optional"
                        />

                        <select value={priority} onChange={(e) => setPriority(e.target.value)}>
                            <option value="low">Low priority</option>
                            <option value="medium">Medium priority</option>
                            <option value="high">High priority</option>
                        </select>

                        <input
                            type="text"
                            placeholder="Description / notes (optional)"
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            style={{ flexBasis: '100%' }}
                        />

                        <input
                            type="date"
                            value={reminderDate}
                            onChange={(e) => setReminderDate(e.target.value)}
                            title="Reminder date"
                        />
                        <input
                            type="time"
                            value={reminderTime}
                            onChange={(e) => setReminderTime(e.target.value)}
                            title="Reminder time (optional)"
                            placeholder="Optional"
                        />

                        <button className="btn" type="submit">Add</button>
                    </form>

                    {/* Search */}
                    <div className="row" style={{ marginTop: 8 }}>
                        <input
                            type="text"
                            placeholder="Search tasks…"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                        />
                    </div>

                    {/* Filters */}
                    <div className="filters">
                        <button className="btn secondary" onClick={() => setFilter('all')} aria-pressed={filter === 'all'}>All</button>
                        <button className="btn secondary" onClick={() => setFilter('active')} aria-pressed={filter === 'active'}>Active</button>
                        <button className="btn secondary" onClick={() => setFilter('completed')} aria-pressed={filter === 'completed'}>Completed</button>
                    </div>

                    {/* Sort controls */}
                    <div className="row" style={{ marginTop: 8, gap: 8, alignItems: 'center' }}>
                        <label className="muted" style={{ fontSize: 12 }}>Sort by</label>
                        <select
                            value={sortMode}
                            onChange={(e) => {
                                const mode = e.target.value;  // 'due' | 'created' | 'priority'
                                setSortMode(mode);
                                setSortOrder(mode === 'created' ? 'desc' : 'asc'); // created has asc/desc, others fixed
                            }}
                        >
                            <option value="due">Due date (soonest)</option>
                            <option value="created">Created (newest)</option>
                            <option value="priority">Priority (High → Low)</option>
                        </select>
                        {sortMode === 'created' && (
                            <select value={sortOrder} onChange={(e) => setSortOrder(e.target.value)}>
                                <option value="desc">Newest first</option>
                                <option value="asc">Oldest first</option>
                            </select>
                        )}
                    </div>

                    {/* List */}
                    {loading ? (
                        <p className="empty">Loading…</p>
                    ) : visible.length === 0 ? (
                        <p className="empty">{search ? 'No matches for your search.' : 'No todos yet. Add one above!'}</p>
                    ) : (
                        visible.map((t) => (
                            <TodoItem key={t.id} todo={t} onToggle={toggle} onDelete={remove} onEdit={edit} />
                        ))
                    )}

                    {/* Footer */}
                    <div className="footer" style={{ gap: 8 }}>
                        <span className="muted">
                            {remaining} item{remaining === 1 ? '' : 's'} left
                            {search && ` · Showing ${visible.length}/${todos.length}`}
                        </span>
                        <div style={{ display: 'flex', gap: 8 }}>
                            <button className="small danger" onClick={clearCompleted}>Clear completed</button>
                            <button className="small danger" onClick={deleteAll}>Delete all</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Snackbar */}
            <Snackbar
                message={snackbar?.message}
                onUndo={undo}
                onClose={dismiss}
                showUndo={!!snackbar?.action}
            />
        </div>
    );
}
