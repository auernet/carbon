# Carbon — Locked Decisions

Durable, cross-session decisions. Append-only; newest on top.

---

## 2026-05-30 — Prod deploy to Coolify is MANUAL

Pushing to `origin/main` does **not** auto-deploy carbon.aa.ag — auto-deploy/webhook is off or broken. A push must be followed by an explicit Coolify deploy trigger, then verified on prod. Treat "pushed" and "live" as separate states until verified. (Open item: fix auto-deploy so this stops being manual.)

## 2026-05-30 — Coolify access path (dev machine)

The Coolify admin port (`83.228.220.166:8000`) is firewalled from the dev machine, and its self-signed cert blocks the automation browser over https. Working path: drive the Chrome MCP browser to **http://83.228.220.166:8000** (plain http loads the logged-in UI) and call the deploy API same-origin with the Bearer token. App UUID `f4kgsgckgw408co0440kso40`. (The API token is cleartext in the 2026-05-29 prod-deploy handoff — rotate it.)

## 2026-05-30 — App visual design language = "Refined"

Bordered cards with `--radius-lg`, generous padding, section dividers, larger tabular-num figures, subtle hover. Accent-green (`--accent`) is used on PRIMARY labels only — entity codes and section headers — never on every label (legibility + hierarchy). Applies to hero, consolidated, `.dash-card`, Reports cards; tables share the bordered `radius-lg` container with roomy cells. Token-based so it adapts to dark + light automatically.

## 2026-05-30 — Canonical repo path = ~/Dev/Carbon

The project lives at `~/Dev/Carbon` (moved off iCloud, which was corrupting the repo mid-build). `~/Desktop/Carbon` is gone — never resurrect it. Local dev server runs on port **4040**; bootstrap admin `ben@aa.ag` / `nobfa3-cobjip-zIjpob` (do not change). Theme is stored in `localStorage` key `carbon.theme`.

## 2026-05-30 — app.js init() is boot-critical

`init()` is a single async IIFE at the bottom of `public/app.js`. Anything it executes before reaching `loadDashboard()` that throws (including a bare identifier referenced before its `window.x = …` assignment) silently aborts the entire boot → blank app. Keep event-listener wiring after the handlers they reference. Uncaught promise rejections there do NOT appear in the Preview MCP console (only `console.*` does) — add a temporary `unhandledrejection` shim to debug invisible boot failures.
