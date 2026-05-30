# Carbon

> ## ⛔ SINGLE SOURCE OF TRUTH: `~/Dev/Carbon`
> This directory is the **only** place Carbon work happens. Never create, copy, or edit
> Carbon files anywhere else — not `~/Desktop`, not iCloud, not a scratch folder, not a
> second clone. iCloud sync previously corrupted this repo mid-build (files vanished, git
> objects went unreadable); the project was moved here specifically to escape that.
> **Keep it off iCloud. One repo, one location, forever.**

## What this is
A local-first ERP for a 3-person team (Ben, Jun, Raphael) — entities, contacts, invoices,
bills, banks, money flows, contracts, KYC, reports, audit log. Vanilla **Node/Express +
SQLite (better-sqlite3)**, no build step. Single backend file `server.js`; the frontend is
`public/` (`index.html` + `app.js` + `style.css`).

## Local dev
- Run: `node server.js` (or Preview MCP server **`carbon`**) → http://127.0.0.1:**4040**.
- Login (bootstrap admin, do NOT change): `ben@aa.ag` / `nobfa3-cobjip-zIjpob`.
- Theme is stored in `localStorage` key `carbon.theme` (`dark` | `light`). Ben uses dark.
- The live DB, bootstrap admin, and encryption key live in `data/` (gitignored). Never
  move or rename anything under `data/`.

## Production
- Live at **https://carbon.aa.ag**, deployed via **Coolify** on Ben's VPS (`83.228.220.166`).
  Coolify builds from this repo, branch `main`. App UUID `f4kgsgckgw408co0440kso40`.
- **Deploy is MANUAL — a `git push` does NOT auto-deploy.** "Pushed" ≠ "live". After
  pushing, trigger Coolify's deploy API, then verify the changed asset on prod yourself.
  (Admin port 8000 is firewalled from the dev machine + self-signed cert; the working path
  is a browser on **http://**83.228.220.166:8000 + a same-origin call to the deploy API.
  Full steps + token reference: `docs/HANDOFF-ui-polish-2026-05-30.md` §6. Rotate that token.)

## Design language ("Refined")
Bordered cards (`--radius-lg`), generous padding, section dividers, larger tabular-num
figures, subtle hover. Accent green (`--accent`) only on **primary** labels (entity codes,
section headers) — never every label. Token-based; adapts to dark + light automatically.

## Where things live (don't scatter)
- App code/config: repo root + `public/`, `db/`, `data/` — **load-bearing, never restructure**.
- Handoffs: `docs/HANDOFF-*.md` (flat in `docs/` — the SessionStart bootstrap globs them there).
- Brainstorms: `docs/brainstorms/`.
- Durable memory (read these at session start): `.claude/locked-decisions.md`,
  `.claude/_explorations.md` (rejected ideas — don't re-litigate), `.claude/workflow-observations.md`.

## Decision log
| Date | Decision |
|---|---|
| 2026-05-30 | `~/Dev/Carbon` is the single source of truth; off iCloud; never write Carbon files elsewhere. |
| 2026-05-30 | Prod deploy is manual (push ≠ live); trigger Coolify + verify on prod. |
| 2026-05-30 | App design language = "Refined" (bordered cards, dividers, accent green on primary labels only). |
| 2026-05-30 | `app.js` `init()` is boot-critical — an early throw blanks the whole app; wire listeners after their handlers. |
