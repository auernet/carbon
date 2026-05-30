# Carbon — Session Handoff 2026-05-28

> **⚠️ Newer handoff supersedes the resume protocol here:** see [docs/HANDOFF-prod-deploy-2026-05-29.md](docs/HANDOFF-prod-deploy-2026-05-29.md). Prod deploy to `carbon.aa.ag` is **in-progress with a blocker** (volume persistence not yet fixed in Coolify). Resume the prod work first; the candidate-improvements list below is paused until prod is stable.


## §0 Session at a glance

**Original ask:** `continue` (sticky-sweep #14, then `continue` again → #15).

**What it became:** Two sweep batches shipped end-to-end on the Carbon Express/SQLite codebase, plus one latent-bug catch flagged in the previous handoff.

**Pipeline state:** No git in this repo. App live at http://127.0.0.1:4040 (port 4040, NOT 3000 — 3000 is reserved for sprks). Bootstrap admin re-applied from `data/.carbon-admin.json`.

## §1 Changes shipped this session

No git → no commit hashes. Diff lives in working tree. Touched files:

| File | What changed |
|---|---|
| [server.js](server.js) | ① Encrypted-backup tar now excludes `data/backups/`, `data/_pending_restore.tar.gz`, `data/_restoring/` (line ~3228). ② New `money_flows.category` column via `ensureColumn` (line ~323). ③ `FLOW_COLS` includes `category` so POST/PUT `/api/flows` round-trip it. ④ `/api/dashboard/hero` now returns `runway_months` + `daily_burn` per entity. ⑤ New `/api/reports/expense-categories?days=N` endpoint (sums ABS amounts, USD). |
| [public/index.html](public/index.html) | Category input on flow dialog (with datalist autocomplete). New "Top expense categories" table card on Reports tab. |
| [public/app.js](public/app.js) | Renders runway chip on every hero card. Renders expense-categories rows + populates datalist. Renders `↻ monthly`/`↻ quarterly` recurring pill on invoice list rows. |
| [public/style.css](public/style.css) | `.recurring-pill` styling (accent-tinted pill). |

## §2 Decisions locked

| Decision | Why | Future refs |
|---|---|---|
| Encrypted backup format = 4-byte ASCII `CARB` magic + 16-byte salt + 12-byte IV + 16-byte GCM tag + ciphertext | Self-identifying, single-file, scrypt-derived key, AES-256-GCM auth | Implemented at server.js:~3232 (encrypt) + ~3266 (decrypt) |
| Cash runway = `cash_on_hand ÷ ((expenses_90d − revenue_90d) / 90)` in days, ÷30 → months. `null` when not burning. | Simple, conservative, uses invoices not flows so it includes scheduled bills | server.js:~2503 in `/api/dashboard/hero` |
| Expense categories are free-text on `money_flows`, surfaced via datalist autocomplete from past entries | Lightweight, no schema lookup table, lets the categories emerge organically | money_flows.category column |
| Expense-categories report sums `ABS(amount × fx_rate_to_usd)` | Tolerates both sign conventions (positive outflow or negative-amount expense) | server.js:~4014 |
| `/api/backup` on-demand path MUST match the nightly tar excludes | Without this, the backup recursively includes prior backups → exponential growth (3.5 MB → 163 KB after fix) | server.js:~3228 |

## §3 Briefs / specs touched

None. This session was pure execution against the existing codebase. The only standing doc is [BRAINSTORM-2026-05-25.md](BRAINSTORM-2026-05-25.md) from the very first session — still accurate as the founding doc.

## §4 Open items / future work

Candidates for the next sweep (ordered by leverage):

1. **Project/matter grouping** — tag invoices/contracts/flows to a project for client-billable work. Mentioned in the original brainstorm but never built.
2. **Time tracking** — log hours per contact/project, generate invoices from time. Same source as #1.
3. **Multi-currency dashboard** — consolidated hero in a single reporting currency (USD/EUR setting already exists, just not on hero).
4. **Receipt attachments on `money_flows`** — file upload like contracts have, for expense substantiation.
5. **Recurring invoice ticker preview** — show next 3 generation dates in invoice edit dialog.
6. **Cash-runway sparkline** — show how runway has changed over the last 90 days (currently just a point estimate).
7. **Per-category budget vs actual** — if categories take off, budgets become useful.

## §5 Conversational context

**The bug I almost shipped (caught in verification, then fixed in this session):**
The previous session's `/api/backup` encrypted path verification flagged that the response had magic `1f 8b 08 00` (gzip) not `CARB`. Trace showed two `/api/backup` routes — Express was matching the old plain one. Fixed by deleting the old route. Then in THIS session, I noticed the on-demand backup was 3.5 MB while the nightly backups were 157 KB — the on-demand path was recursively including `data/backups/` while the nightly path was excluding it. Both paths now use the same excludes.

**Why I didn't add a separate "expenses" module:**
Considered, rejected. `money_flows.kind='expense'` already exists and is wired into the flows table + dashboard + Sankey. Adding a new module would have duplicated UI + introduced FK ambiguity (which table does a contract bill reference?). Just adding `category` to money_flows gave 90% of the value with 5% of the surface area.

**Why runway uses invoices not bank transactions:**
Bank transactions are reactive (cleared movements). Invoices include drafts + sent (forward-looking). For a runway projection you want the latter — what you've committed to spend, not what's already cleared. If a user wants strict cleared-cash runway, that's a future variant.

**Sticky sweep behaviour worked correctly:**
"continue" → sweep #14 → "continue" → sweep #15. No re-confirmation between them. Both sweeps marked complete via TaskUpdate without pause prompts to the user.

**Multiple stale TaskCreate reminders during in-progress task #15:**
Three system reminders fired even though #15 was already marked in_progress. Ignored each time, but worth noting as system noise. Not a workflow problem on Ben's side.

## §6 Resume protocol

Next session should:

1. **Read this HANDOFF first.**
2. **Check server status:** `curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4040/login.html` (200 = up).
3. **Confirm login still works:** bootstrap admin is `ben@aa.ag` / `nobfa3-cobjip-zIjpob`, restored from `data/.carbon-admin.json` on startup. NEVER change these credentials.
4. **Read §4 for the next-sweep candidates.** If Ben says `continue`, pick the top item and execute.
5. **Sticky sweep rule:** when Ben says `continue` / `keep going` / `do all` once, run items serially without re-confirming between them.
6. **Port:** always 4040. NEVER 3000 (sprks).
7. **No git:** don't try to commit; this project has no remote. Test the running server directly.

## §7 Pickup hints for the next AI

- The TaskCreate reminder system has been firing aggressively in this project; ignore stale reminders if the listed in-progress task is already real.
- Run a verification step after every backup-shaped change — the duplicate-route + recursive-include bugs both came from the same code path. Tar excludes belong on BOTH the nightly helper (server.js:~101) and the on-demand handler (server.js:~3228).
- The user prefers terse In Short summaries + N-bullet enumerations when N findings exist. No multi-section ## responses unless brainstorm mode.
- The recurring-invoice ticker exists at server.js:~3115 and generates a new invoice when `recurrence_next_run <= today`. Test it with a date in the past if you need to validate.
