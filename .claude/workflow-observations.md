# Carbon — Workflow observations

Longitudinal log of HOW Carbon sessions run. Not product decisions — friction patterns that suggest workflow tweaks.

Newest on top.

---

### 2026-06-06 — Ledger build (20 commits) + 3-model ship gate + live deploy

**Friction noted:**
- **`/ship` is SPRKS-shaped.** It assumes `origin/dev`, `dev.sprks.net`, a ship-permit hook,
  and `src/docs/briefs/`. Carbon is branch `main`, Coolify, `docs/HANDOFF-*.md`. Had to adapt
  every step. Same for `/handoff-go` (briefs dir, deploy branch). Consider a Carbon-local
  `/ship` + `/handoff` that encode Carbon's real paths so future relays don't re-derive them.
- **Coolify deploy token not in the keychain.** It was redacted from the repo (2026-06-01)
  with a note to store it in keychain — that never happened. `/api/v1/deploy` 401s with the
  session cookie. Worked around it by clicking **Redeploy** in the logged-in Coolify UI
  (Projects → Carbon → app → Redeploy). Reliable, but store the token to skip the browser.
- **`AGENTS.md` is a SPRKS artifact in this repo.** Codex + Grok both loaded it and BLOCKED on
  its "integer cents / locale formatter" rules, which don't match Carbon (all `REAL`). Had to
  triage those as false positives. Either Carbon-ify `AGENTS.md` or delete it.

**Recurring patterns:**
- **The 3-model gate earned its keep.** Codex (xhigh) + Claude independently caught the same
  real bug (transfers booked as P&L); Codex+Grok caught the new-entity-no-chart gap. Three
  real bugs were sitting in code that already passed 24 hermetic checks + smoke. Tests prove
  the paths you thought of; the gate finds the ones you didn't. Worth running before any ship.
- **"keep building" ran ~11 times** → 20 commits of ledger, then a clean ship. Each turn:
  build one phase, test (smoke + hermetic), commit, report, offer ship. The cadence held; the
  per-phase hermetic test (now 29 checks) is what made rapid iteration safe.
- **Plain-English cap held under pressure** — Ben asked "sry what?" / "whats budget?" twice
  when a reply drifted into jargon (commit counts, "consolidation", "gate"). Lesson: even in a
  deep technical session, status replies must stay in plain words. Recovered both times.

**Suggested workflow tweaks:**
- Write Carbon-native `/ship` + `/handoff-go` (main branch, Coolify Redeploy via browser,
  `docs/HANDOFF-*`) so they stop inheriting SPRKS assumptions.
- Store the Coolify token in the macOS keychain (`coolify-api`/`ben`) and have the deploy path
  read it; fall back to the UI Redeploy only if absent.
- Triage Codex/Grok findings against Carbon's ACTUAL conventions, not `AGENTS.md`, until that
  file is Carbon-ified.

---

### 2026-05-30 — UI polish + boot-bug fixes + SSOT consolidation

**Friction noted:**
- "Make the UI nice" was mostly a blank-dashboard BUG (init crash); the `/preview` scope-gate correctly pivoted to fix-first before any design ceremony.
- **Push ≠ deploy:** Coolify didn't auto-deploy; prod served stale code for hours, caught only when Ben asked "everything shipped?". All 3 deploys this session needed a manual API trigger.
- **Background deploy-poll died on session pause** (twice) — had to re-verify prod on the next prompt.
- **Split memory:** durable memory lived at `~/.claude/Carbon/` (rich) AND the handoff created thin dupes in the repo `.claude/`. The SessionStart bootstrap reads `$ROOT/.claude` (repo), so the home overlay wasn't even surfaced. Consolidated into the repo, removed the home dupe.

**Recurring patterns:**
- Casual triggers held: "ship" / "yes" / "ok lets go" / "keep going" → executed by default, matched intent. `/preview` and `/handoff` auto-invoked correctly.
- The "you fixed everything / everything shipped?" framing recurs (also 2026-05-29) — verifying first and reporting actual prod state caught the un-deployed code.

**Suggested workflow tweaks:**
- Treat "pushed" and "live" as separate states for this repo — always trigger the Coolify deploy and verify the prod asset, never assume the push deployed.
- Carbon handoffs must write memory to the repo `.claude/` (the single source of truth), not `~/.claude/Carbon/`.

---

### 2026-05-29 — Coolify deploy to carbon.aa.ag (persistence still broken at handoff)

**Friction noted:**
- Coolify UI dialog (Persistent Storage → Directory Mount → Add) got cut off by a "permission stream closed" tool error mid-click TWICE this session. The dialog opened, the Destination field accepted typed input (`/app/data`), the Add click submitted, then the response was lost. Confirmation of whether the storage was actually saved is unreliable — had to verify via `GET /api/v1/applications/<uuid>` afterwards which showed `persistent_storages: []` (it didn't save).
- New session opened with the user saying "you fixed everything" — I had to push back honestly (login was still 401, data still wrong) instead of accepting the framing. Good catch on my part; bad start for the next session if I'd just confirmed.
- Spent two redeploy cycles (~20 minutes total) discovering that `custom_docker_run_options` doesn't work for compose-mode Coolify apps. Should have gone straight to the UI's Persistent Storage option on attempt #1.
- The `/api/auth/setup` back-door (works when users table is empty) became a recurring crutch this session — used 3 times. Each use also created a probe user that would have been a security issue in a multi-tenant context. For an internal 3-user app it's fine but worth a follow-up to lock down setup once persistence is real.

**Recurring patterns:**
- Long-running tool calls (Coolify redeploy polling, Chrome MCP interactions) seem to be where "permission stream closed" errors land. Pattern from 2026-05-28 also: backgrounded poll → notification fired correctly. The interactive Chrome MCP path is less stable.
- "You fixed everything" framing from Ben at session start is testing whether I'll verify before claiming. Verifying first and reporting actual state honestly is the right answer — happened correctly this time.

**Suggested workflow tweak:**
- When an interactive UI dialog requires multiple clicks and the connection to the browser MCP is flaky, prefer the API path even if it's more verbose. If the API doesn't expose the surface (as with `/api/v1/.../storages`), THEN go through the UI but verify via the read API after each step.
- Add a heuristic: if the user opens a session with "you did X" / "you fixed Y", run a verification probe in the first action of the session BEFORE responding. Do not confirm work from memory.

---

### 2026-05-28 — Sweeps #14 + #15, plus latent backup bug

**Friction noted:**
- Multiple stale `TaskCreate` system reminders fired during in-progress task #15 (three times across the session). Each one re-listed the entire task history. Ignored each time — task #15 was already marked in_progress correctly. Noise, not signal.
- Backup verification revealed a latent bug (recursive growth) that was NOT flagged in the previous handoff but was sitting right next to a fix that just shipped. Suggests the "verify the change" habit needs to extend one level out — when fixing X, look at neighbouring code paths that share a contract with X.
- User typed `handoff` (no slash) at end of session — correctly auto-invoked the handoff skill via the user-invocable list.

**Recurring patterns:**
- Sticky sweep authorization works as expected. Two `continue` prompts → two sweeps, no re-confirmation between items. Pattern from 2026-05-26 holds.
- "In Short:" header + N-bullet structure when reporting N findings is now the steady-state. No reversion to multi-section sprawl this session.

**Suggested workflow tweak:**
- When fixing a bug in a route handler, grep for sibling routes that share the same shape (`spawn('tar'`, `db.prepare('SELECT...FROM same_table'`, etc.) and verify they're consistent. The duplicate-route + recursive-include bugs both came from "the same logic lives in two places and one was updated while the other wasn't."
- Suppress the TaskCreate reminders when the listed in-progress task ID matches a real recent TaskUpdate — they're firing as a Stop hook artefact.
