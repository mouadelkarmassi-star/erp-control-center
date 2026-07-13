/* ======================================================================
   ERP CONTROL CENTER — BACKEND SERVER
   Node.js + Express + a lightweight server-side JSON store (db.json).
   No native modules, no compilation step — builds instantly on any host
   (Railway, Render, Bonto, a VPS...). Every logged-in user reads/writes
   the SAME server-side file, so data (KPIs, tickets, projects, reports)
   is shared between Manager <-> SAP <-> Inventory <-> Projects.
   ====================================================================== */
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

// ---------------------------------------------------------------------
// DEFAULT / SHARED STATE SHAPE
// ---------------------------------------------------------------------
const DEFAULT_STATE = {
  kpis: {
    sap: { client: [], supplier: [], production: [], reception: [], shipping: [] },
    inventory: { production: [], quality: [], shipping: [], reception: [] }
  },
  projects: [],
  reports: { sap: [], inventory: [], projects: [] },
  settings: { theme: "dark", lang: "en" },
  categories: ["Project", "Inventory", "SAP", "Flow"],
  statuses: ["Done", "Blocked", "In Progress"],
  blockingPoints: [],
  assignments: [],
  assignmentSeq: {}
};
function defaultDB() {
  return { users: [], sessions: [], appState: JSON.parse(JSON.stringify(DEFAULT_STATE)) };
}

// ---------------------------------------------------------------------
// FILE-BASED STORE (atomic writes, in-memory cache, synchronous — fine
// for a small internal team tool; avoids any native/database driver).
// ---------------------------------------------------------------------
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let store;
function loadStore() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      store = defaultDB();
      persist();
      return;
    }
    const raw = fs.readFileSync(DB_FILE, "utf8");
    const parsed = JSON.parse(raw);
    store = Object.assign(defaultDB(), parsed, {
      appState: Object.assign(JSON.parse(JSON.stringify(DEFAULT_STATE)), parsed.appState || {})
    });
  } catch (e) {
    console.error("Failed to load database, starting fresh:", e.message);
    store = defaultDB();
  }
}
function persist() {
  // Atomic write: write to a temp file then rename, to avoid a corrupted
  // db.json if the process is killed mid-write.
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
loadStore();

// ---------------------------------------------------------------------
// PASSWORD HASHING (scrypt, built into Node — zero extra dependencies)
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
function newId(prefix) { return prefix + "_" + crypto.randomBytes(8).toString("hex"); }
function nowIso() { return new Date().toISOString(); }

// ---------------------------------------------------------------------
// APP
// ---------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "30mb" })); // generous limit: state blob includes base64 screenshots/files
app.use(express.static(path.join(__dirname, "public")));

function publicUser(u) {
  return { id: u.id, username: u.username, role: u.role, pages: u.pages, createdAt: u.createdAt };
}

// --- Auth middleware ---
function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not authenticated." });
  const session = store.sessions.find(s => s.token === token);
  if (!session) return res.status(401).json({ error: "Session expired." });
  const user = store.users.find(u => u.id === session.userId);
  if (!user) return res.status(401).json({ error: "User not found." });
  req.user = user;
  req.token = token;
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
  res.json({ needsSetup: store.users.length === 0 });
});

app.get("/api/usernames", (req, res) => {
  res.json({ usernames: store.users.map(u => u.username) });
});

app.post("/api/setup", (req, res) => {
  if (store.users.length > 0) return res.status(400).json({ error: "Setup already completed." });
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Missing fields." });
  const user = {
    id: newId("usr"), username, passwordHash: hashPassword(password),
    role: "manager", pages: ["sap", "inventory", "projects"], createdAt: nowIso()
  };
  store.users.push(user);
  const token = newToken();
  store.sessions.push({ token, userId: user.id, createdAt: nowIso() });
  persist();
  res.json({ token, user: publicUser(user) });
});

app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  const user = store.users.find(u => u.username === username);
  if (!user || !verifyPassword(password || "", user.passwordHash)) {
    return res.status(401).json({ error: "Invalid username or password." });
  }
  const token = newToken();
  store.sessions.push({ token, userId: user.id, createdAt: nowIso() });
  persist();
  res.json({ token, user: publicUser(user) });
});

app.post("/api/logout", auth, (req, res) => {
  store.sessions = store.sessions.filter(s => s.token !== req.token);
  persist();
  res.json({ ok: true });
});

// -----------------------------------------------------------------
// USERS (Manager only for create/delete)
// -----------------------------------------------------------------
app.get("/api/users", auth, (req, res) => {
  res.json({ users: store.users.map(publicUser) });
});

app.post("/api/users", auth, requireManager, (req, res) => {
  const { username, password, pages } = req.body || {};
  if (!username || !password || !Array.isArray(pages) || pages.length === 0) {
    return res.status(400).json({ error: "Missing fields." });
  }
  if (store.users.some(u => u.username === username)) {
    return res.status(400).json({ error: "Username already exists." });
  }
  const user = {
    id: newId("usr"), username, passwordHash: hashPassword(password),
    role: "user", pages, createdAt: nowIso()
  };
  store.users.push(user);
  persist();
  res.json({ user: publicUser(user) });
});

app.delete("/api/users/:id", auth, requireManager, (req, res) => {
  const target = store.users.find(u => u.id === req.params.id);
  if (!target) return res.status(404).json({ error: "User not found." });
  if (target.role === "manager") return res.status(400).json({ error: "Cannot delete the Manager account." });
  store.users = store.users.filter(u => u.id !== req.params.id);
  store.sessions = store.sessions.filter(s => s.userId !== req.params.id);
  persist();
  res.json({ ok: true });
});

// -----------------------------------------------------------------
// SHARED APP STATE (kpis / projects / tickets / reports / settings)
// Every authenticated user reads & writes the SAME object — this is what
// makes data visible between users (Manager <-> SAP <-> Inventory ...).
// Passwords never travel through this endpoint.
// -----------------------------------------------------------------
app.get("/api/state", auth, (req, res) => {
  res.json({ state: store.appState, users: store.users.map(publicUser), me: publicUser(req.user) });
});

app.post("/api/state", auth, (req, res) => {
  const incoming = req.body || {};
  // Only these keys are persisted here — users are managed via /api/users only.
  store.appState = {
    kpis: incoming.kpis || DEFAULT_STATE.kpis,
    projects: incoming.projects || [],
    reports: incoming.reports || DEFAULT_STATE.reports,
    settings: incoming.settings || DEFAULT_STATE.settings,
    categories: incoming.categories || DEFAULT_STATE.categories,
    statuses: incoming.statuses || DEFAULT_STATE.statuses,
    blockingPoints: incoming.blockingPoints || [],
    assignments: incoming.assignments || [],
    assignmentSeq: incoming.assignmentSeq || {}
  };
  persist();
  res.json({ ok: true });
});

// -----------------------------------------------------------------
// ADMIN: full database wipe — protected by a secret key.
// -----------------------------------------------------------------
app.post("/api/admin/reset", (req, res) => {
  const key = req.query.key;
  if (!process.env.RESET_KEY || key !== process.env.RESET_KEY) {
    return res.status(403).json({ error: "Invalid or missing reset key." });
  }
  store = defaultDB();
  persist();
  res.json({ ok: true, message: "Database wiped. Reload the app to create a new Manager account." });
});

// -----------------------------------------------------------------
app.use((req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`ERP Control Center server running on http://localhost:${PORT}`);
});
