# Carbon — UI Polish + Boot-Bug Fixes Handoff 2026-05-30

## §0 Session at a glance

**Original ask:** "check the old carbon session and continue where we left off." The previous session had crashed because its working dir `~/Desktop/Carbon` vanished (moved off iCloud to `~/Dev/Carbon`).

**What it became:** A UI-quality session that uncovered two real bugs before any design work, then a full visual polish:
1. Confirmed the crashed session's work was already complete + live; pushed one lingering docs commit.
2. Ben: "make the UX/UI really nice, it sucks a bit" → started `/preview` on the dashboard.
3. **Found the dashboard was rendering 100% blank on every load** — a boot-time JS crash, not a design problem. Root-caused + fixed.
4. **Found the notifications panel stuck permanently open** — a CSS rule overriding the `hidden` attribute. Fixed.
5. **Found Coolify was NOT auto-deploying** — prod served stale code for hours after pushes. Established a manual deploy path.
6. Dashboard visual polish via `/preview`: 3 options → Ben picked A (Refined) → shipped.
7. Carried the polish to the other screens (cards + tables) → shipped.

**State:** All work committed, pushed to `origin/main`, and **verified live on https://carbon.aa.ag**. Prod healthy (200), data durable, three users intact (ben@aa.ag, jun, raphael).

## §1 Commits shipped this session

| Hash | Title |
|---|---|
| 31f1acb | docs: repoint old ~/Desktop/Carbon paths to ~/Dev/Carbon (moved off iCloud) — lingering from prior session, pushed |
| 7463d7e | Fix dashboard rendering blank on load |
| e6b4184 | Fix notifications panel stuck permanently open |
| 10abd71 | Polish dashboard: refined hero + consolidated cards |
| d9d7762 | Polish pass: consistent cards + tables across screens |

All five are on `origin/main` and confirmed serving on prod.

## §2 Decisions locked this session

| Decision | Why |
|---|---|
| **Coolify deploy is MANUAL** — pushing to `origin/main` does NOT auto-deploy | Auto-deploy/webhook is off or broken; pushes sat undeployed for hours. Must trigger explicitly via the deploy API. |
| **Deploy access path** = browser on **http://** Coolify origin + Bearer token | The admin port (8000) is firewalled from the dev machine, and the self-signed cert blocks the automation browser over https. Plain http loads the (logged-in) Coolify UI, enabling a same-origin API fetch. |
| **App design language = "Refined" (Option A)** | Bordered `radius-lg` cards, accent-green on PRIMARY labels only (entity codes, section headers), section dividers, larger tabular figures, subtle hover. Legible + professional for a daily numbers tool. |
| Local dev = port **4040**, bootstrap admin `ben@aa.ag` / `nobfa3-cobjip-zIjpob`, theme via `localStorage carbon.theme` | Unchanged from prior sessions; confirmed working. |

## §3 Briefs / specs touched

None. Execution + bug-fix + design session. The `/preview` flow was used for the dashboard (3 throwaway CSS-injection mockups, not committed).

## §4 Open items / future work

1. **Rotate the Coolify API token** — still cleartext (in the 2026-05-29 prod-deploy handoff §5); used again this session inside browser JS. Long-flagged, still not done.
2. **Fix Coolify auto-deploy** — so pushes deploy automatically instead of the manual API trigger. Check the app's auto-deploy toggle / GitHub webhook in the Coolify UI.
3. **Extend the polish** (optional) — the invoice editor, Tasks, KYC, Contracts detail panes could get the same card/table language if Ben wants.
4. **Off-server backups** — still not configured (carried from prior handoff).
5. `.claude/launch.json` exists **locally only** (untracked) — it's the Preview MCP config for Carbon on 4040. Lets `/preview` and `preview_*` tools drive the app. Not committed on purpose.

## §5 Conversational context (the critical section)

**The crash was cosmetic.** The "old session" had actually finished its work; it only errored because its cwd (`~/Desktop/Carbon`) was deleted. No work was lost. Ben confirmed the Desktop husk is already gone — no migration cleanup needed.

**"Make it nice" was mostly a bug.** The dashboard *looked* like it "sucked" largely because it rendered **completely blank on load**. Root cause: `init()` (an async IIFE at the bottom of `app.js`) wired a `change` listener referencing a bare `loadTasks` **one line before** `window.loadTasks` was defined. Because the target element exists, evaluating the argument threw a `ReferenceError`, aborting `init()` before it ever reached `loadDashboard()`. Fix: attach that listener *after* the definition.

**Key debugging lesson:** an unhandled promise rejection in the init IIFE silently aborts boot, and Chrome's "Uncaught (in promise)" does **not** surface through the Preview MCP console capture (only `console.*` does). Diagnosing it required a temporary `window.addEventListener('unhandledrejection', …→console.error)` shim (added, used, reverted).

**Notifications-always-open** was a pure CSS bug: `.notif-panel { display:flex }` overrode the `[hidden]` attribute (equal specificity, author rule wins over the UA `[hidden]{display:none}`), so the toggle/close handlers set `hidden` with no visual effect. Fix: `.notif-panel[hidden] { display:none }`.

**"everything shipped?" was the pivotal moment.** Ben asked, and checking revealed prod was still serving the OLD blank-dashboard build despite the push — Coolify had not deployed. This is the session's biggest recurring gotcha: **a push is not a deploy here.**

**Design decision:** Ben asked "what do you rec" → recommended A and implemented it (execute-by-default). He approved by saying "ok lets go." A was chosen over B and C for legibility (see `_explorations.md`).

**The Coolify API token is in cleartext** (carried from the prior handoff) and was transmitted through browser JS again this session. Rotate it.

## §6 Resume protocol

1. **Read this handoff first.**
2. `git log -15 --oneline` — confirm the 5 commits above are present. `git status -sb`.
3. **Remember: prod deploy is MANUAL.** `origin/main` ≠ what's live until you trigger Coolify.
4. **Run local Carbon:** Preview MCP `preview_start` name `carbon` (or `node server.js`) → http://127.0.0.1:4040. Login `ben@aa.ag` / `nobfa3-cobjip-zIjpob`. Dark theme: `localStorage carbon.theme = 'dark'` then reload.
5. **To deploy to prod:**
   - `git push origin main`
   - In the Chrome MCP browser, navigate to **http://83.228.220.166:8000** (plain http — bypasses the self-signed cert; Ben's session is logged in).
   - `fetch('/api/v1/deploy?uuid=f4kgsgckgw408co0440kso40&force=true', {headers:{Authorization:'Bearer <coolify-token>'}})` — token is in the 2026-05-29 prod-deploy handoff §5 (rotate it).
   - Poll `https://carbon.aa.ag/<changed-asset>` for a marker until the new build serves (~3–4 min).
6. **You verify on prod, not Ben** (rule #12).

## §7 Pickup hints

- Coolify app UUID: `f4kgsgckgw408co0440kso40`; watches branch `main`; fqdn carbon.aa.ag.
- The dashboard/Reports cards share the `.dash-card` class; the hero/consolidated cards are separate (`.hero-card` / `.consolidated-card`). Design tokens: `--accent` (mint green), `--radius-lg` (14px), `--panel`/`--panel-2`/`--border`/`--shadow-sm`.
- `app.js` is a single vanilla file; `init()` is an async IIFE near the bottom — anything it touches before `loadDashboard()` can abort the whole boot if it throws.
- The Preview MCP console only captures `console.*`, not uncaught promise rejections — add a shim if a boot bug is invisible.
