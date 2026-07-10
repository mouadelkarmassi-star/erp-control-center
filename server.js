/* ======================================================================
   ERP CONTROL CENTER — BACKEND SERVER
   Node.js + Express + SQLite (better-sqlite3)
   Provides a real shared database so every logged-in user (Manager,
   SAP, Inventory, Projects...) sees and edits the SAME data.
   ====================================================================== */
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "data", "erp.sqlite");

// ---------------------------------------------------------------------
// DB SETUP
// ---------------------------------------------------------------------
const fs = require("fs");
if (!fs.existsSync(path.join(__dirname, "data"))) fs.mkdirSync(path.join(__dirname, "data"));
const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,        -- 'manager' | 'user'
  pages TEXT NOT NULL,       -- JSON array e.g. ["sap","inventory"]
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL
);
`);

// Seed the single shared app_state row (kpis / projects / tickets / reports / settings)
const DEFAULT_STATE = {
  kpis: {
    sap: { client: [], supplier: [], production: [], reception: [], shipping: [] },
    inventory: { production: [], quality: [], shipping: [], reception: [] }
  },
  projects: [],
  tickets: { sap: [], inventory: [], projects: [] },
  reports: { sap: [], inventory: [], projects: [] },
  settings: { theme: "dark", lang: "en" }
};
const existingState = db.prepare("SELECT data FROM app_state WHERE id = 1").get();
if (!existingState) {
  db.prepare("INSERT INTO app_state (id, data) VALUES (1, ?)").run(JSON.stringify(DEFAULT_STATE));
}

// ---------------------------------------------------------------------
// PASSWORD HASHING (scrypt, built into Node — no extra native deps)
// ---------------------------------------------------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const check = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(check, "hex"));
}
function newToken() { return crypto.randomBytes(32).toString("hex"); }
function nowIso() { return new Date().toISOString(); }

// ---------------------------------------------------------------------
// APP
// ---------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "30mb" })); // generous limit: state blob includes base64 screenshots/files
app.use(express.static(path.join(__dirname, "public")));

function publicUser(row) {
  return { id: row.id, username: row.username, role: row.role, pages: JSON.parse(row.pages), createdAt: row.created_at };
}

// --- Auth middleware ---
function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not authenticated." });
  const session = db.prepare("SELECT * FROM sessions WHERE token = ?").get(token);
  if (!session) return res.status(401).json({ error: "Session expired." });
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(session.user_id);
  if (!user) return res.status(401).json({ error: "User not found." });
  req.user = user;
  next();
}
function requireManager(req, res, next) {
  if (req.user.role !== "manager") return res.status(403).json({ error: "Manager only." });
  next();
}

// -----------------------------------------------------------------
// SETUP / AUTH ROUTES
// -----------------------------------------------------------------
app.get("/api/needs-setup", (req, res) => {
  const count = db.prepare("SELECT COUNT(*) c FROM users").get().c;
  res.json({ needsSetup: count === 0 });
});

app.get("/api/usernames", (req, res) => {
  const rows = db.prepare("SELECT username FROM users").all();
  res.json({ usernames: rows.map(r => r.username) });
});

app.post("/api/setup", (req, res) => {
  const count = db.prepare("SELECT COUNT(*) c FROM users").get().c;
  if (count > 0) return res.status(400).json({ error: "Setup already completed." });
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Missing fields." });
  const id = "usr_" + crypto.randomBytes(8).toString("hex");
  db.prepare(
    "INSERT INTO users (id, username, password_hash, role, pages, created_at) VALUES (?,?,?,?,?,?)"
  ).run(id, username, hashPassword(password), "manager", JSON.stringify(["sap", "inventory", "projects"]), nowIso());
  const token = newToken();
  db.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)").run(token, id, nowIso());
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  res.json({ token, user: publicUser(user) });
});

app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!user || !verifyPassword(password || "", user.password_hash)) {
    return res.status(401).json({ error: "Invalid username or password." });
  }
  const token = newToken();
  db.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)").run(token, user.id, nowIso());
  res.json({ token, user: publicUser(user) });
});

app.post("/api/logout", auth, (req, res) => {
  const header = req.headers.authorization || "";
  const token = header.slice(7);
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  res.json({ ok: true });
});

// -----------------------------------------------------------------
// USERS (Manager only for create/delete)
// -----------------------------------------------------------------
app.get("/api/users", auth, (req, res) => {
  const rows = db.prepare("SELECT * FROM users").all();
  res.json({ users: rows.map(publicUser) });
});

app.post("/api/users", auth, requireManager, (req, res) => {
  const { username, password, pages } = req.body || {};
  if (!username || !password || !Array.isArray(pages) || pages.length === 0) {
    return res.status(400).json({ error: "Missing fields." });
  }
  const exists = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
  if (exists) return res.status(400).json({ error: "Username already exists." });
  const id = "usr_" + crypto.randomBytes(8).toString("hex");
  db.prepare(
    "INSERT INTO users (id, username, password_hash, role, pages, created_at) VALUES (?,?,?,?,?,?)"
  ).run(id, username, hashPassword(password), "user", JSON.stringify(pages), nowIso());
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  res.json({ user: publicUser(user) });
});

app.delete("/api/users/:id", auth, requireManager, (req, res) => {
  const target = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!target) return res.status(404).json({ error: "User not found." });
  if (target.role === "manager") return res.status(400).json({ error: "Cannot delete the Manager account." });
  db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(req.params.id);
  res.json({ ok: true });
});

// -----------------------------------------------------------------
// SHARED APP STATE (kpis / projects / tickets / reports / settings)
// Every authenticated user reads & writes the SAME row — this is what
// makes data visible between users (Manager <-> SAP <-> Inventory ...).
// Passwords never travel through this endpoint.
// -----------------------------------------------------------------
app.get("/api/state", auth, (req, res) => {
  const row = db.prepare("SELECT data FROM app_state WHERE id = 1").get();
  const data = JSON.parse(row.data);
  const users = db.prepare("SELECT * FROM users").all().map(publicUser);
  res.json({ state: data, users, me: publicUser(req.user) });
});

app.post("/api/state", auth, (req, res) => {
  const incoming = req.body || {};
  // Only these keys are persisted here — users are managed via /api/users only.
  const safe = {
    kpis: incoming.kpis || DEFAULT_STATE.kpis,
    projects: incoming.projects || [],
    tickets: incoming.tickets || DEFAULT_STATE.tickets,
    reports: incoming.reports || DEFAULT_STATE.reports,
    settings: incoming.settings || DEFAULT_STATE.settings
  };
  db.prepare("UPDATE app_state SET data = ? WHERE id = 1").run(JSON.stringify(safe));
  res.json({ ok: true });
});

// -----------------------------------------------------------------
app.use((req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`ERP Control Center server running on http://localhost:${PORT}`);
});
