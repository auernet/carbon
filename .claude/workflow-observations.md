# Carbon — Workflow Observations

Longitudinal log of HOW sessions run (not product decisions). Newest on top.

---

### 2026-05-30 — UI polish + boot-bug fixes

**Friction noted:**
- "Make the UI nice" was largely a **blank-dashboard bug**; `/preview` scope-gate correctly pivoted to fix-first before design. Good catch — design ceremony on a broken screen would have wasted effort.
- **Coolify push ≠ deploy:** pushes did not auto-deploy; prod served stale code for hours and was only caught when Ben asked "everything shipped?". This happened on all 3 deploys this session — each needed a manual API trigger.
- **Background deploy-poll died on session pause** (twice). The `run_in_background` poll is killed when the session sleeps; had to re-verify prod on the next prompt.
- **No memory files existed** — locked-decisions / _explorations / workflow-observations were all missing (the prior session's edited `locked-decisions.md` was unfindable, likely lost with the deleted Desktop husk). Created fresh this handoff.

**Recurring patterns:**
- Casual triggers held: Ben said "ship" / "yes" / "ok lets go" / "keep going" repeatedly → AI executed by default, matched intent. `/preview` auto-invoked correctly after the recommendation.

**Suggested workflow tweaks:**
- Treat "pushed" and "live" as separate states for this repo — always trigger the Coolify deploy and verify the prod asset, never assume the push deployed.
- For deploys, prefer a short foreground re-check on resume over trusting a long background poll (it dies on pause).
