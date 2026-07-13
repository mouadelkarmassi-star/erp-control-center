# ERP Control Center

A full-stack multi-user dashboard (SAP Master Data, Inventory, Projects, Tickets, Reports)
with a **real shared database**. Every user (Manager, SAP, Inventory, Projects...) logs
into the same server and sees the same data — this is a real client/server app, not a
single-browser demo.

- **Backend:** Node.js + Express — a small server-side JSON store (`data/db.json`), **zero native dependencies** (no compile step, builds instantly on any host)
- **Frontend:** single `public/index.html` (HTML/CSS/JS, Chart.js) served by the same server
- **Auth:** username/password, hashed with scrypt, session tokens
- **No external services required** — everything runs from one small Node app

---

## 1. Run it locally

Requirements: [Node.js](https://nodejs.org) 18 or newer.

```bash
cd erp-control-center
npm install
npm start
```

Open **http://localhost:3000**. The first person to open the app creates the **Manager**
account. The Manager can then create other users and choose which pages (SAP / Inventory /
Projects) each one can access.

All data lives in `data/db.json`, created automatically on first run. Back it up like any
normal file (copy it, put it on a schedule, etc.).

---

## 2. Host it online (so your team can access it from anywhere)

Because this is a real Node.js server, you need a host that can **run a Node process**, not
a static-file host. Any of the following work well and have free tiers:

### Option A — Render.com (simplest)
1. Push this folder to a GitHub repository.
2. On [render.com](https://render.com) → **New +** → **Web Service** → connect your repo.
3. Build command: `npm install` — Start command: `npm start`.
4. Deploy. Render gives you a public URL (e.g. `https://your-app.onrender.com`).
5. ⚠️ Add a **persistent disk** (Render dashboard → your service → Disks) mounted at
   `/opt/render/project/src/data` so the SQLite file survives restarts/deploys.

### Option B — Railway.app
1. Push to GitHub → on [railway.app](https://railway.app), **New Project** → **Deploy from GitHub repo**.
2. Railway auto-detects Node, runs `npm install` and `npm start`.
3. Add a **Volume** mounted at `/app/data` so `data/db.json` persists across deploys.

### Option C — Any VPS (DigitalOcean, OVH, Hetzner...)
1. Install Node.js 18+ on the server.
2. Copy this folder, run `npm install --production`.
3. Run it with a process manager so it survives reboots:
   ```bash
   npm install -g pm2
   pm2 start server.js --name erp-center
   pm2 save
   pm2 startup
   ```
4. Put Nginx or Caddy in front for HTTPS (recommended), pointing to `http://localhost:3000`.

In every case: the only thing that must persist between deploys/restarts is the
**`data/` folder** — that's your database.

---

## 3. How the shared database works

- `users` table: username, hashed password, role (`manager`/`user`), and which pages
  they can access.
- `app_state` table: one row containing all KPIs, projects, tickets and reports as JSON.
- Every API call is authenticated with a bearer token (`Authorization: Bearer ...`)
  obtained at login. The Manager account is created once, the first time the app is
  opened (`/api/setup`); after that, only the Manager can create further users
  (`/api/users`, Manager-only).
- Because everyone talks to the same server/database, if the Manager creates a KPI
  ticket, milestone, or uploaded report, every user with access to that page sees it
  immediately on their next refresh — no more per-browser local storage.

---

## 4. Project structure

```
erp-control-center/
├── server.js          → Express API + static file server
├── package.json
├── public/
│   └── index.html      → the entire frontend (HTML+CSS+JS)
└── data/                → created automatically, contains db.json (your database)
```

---

## FR — Résumé rapide

Ce projet est une vraie application client/serveur : le Manager et les utilisateurs se
connectent au **même serveur**, donc ils voient **les mêmes données** (KPI, tickets,
projets, rapports) — contrairement à la version précédente qui stockait tout dans le
navigateur de chacun.

--- for wiping the data base ---
curl -X POST "https://erp-control-center-production.up.railway.app/api/admin/reset?key=Valeo2026Reset"

