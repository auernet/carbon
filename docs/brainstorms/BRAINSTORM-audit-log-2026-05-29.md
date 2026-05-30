# Carbon — Audit log redesign brainstorm (2026-05-29)

Read-only brainstorm. Topic: make the **Audit** tab denser/readable, more useful, and—critically—make it actually *capture everything*. Source of truth reviewed: `server.js` (`audit()` ~L457, `/api/audit` ~L4332, schema `db/schema.sql audit_log`), `public/app.js` (`loadAudit`/`renderAuditDiff` ~L3576-3667), and the live screenshot.

---

## TL;DR — the headline problem isn't the layout, it's the integrity

Ben framed three asks (space, readability, "captures everything"). The third is the real story: **the audit log is currently lying about who did things, and silently skips whole classes of events.** Layout is cosmetic by comparison. Priority order should be: **(1) capture the actor + close coverage gaps → (2) surface "what changed" → (3) make it dense/readable.**

---

## 1. Completeness — what it FAILS to capture (highest priority)

### 1a. Actor is never recorded — everything says "ben"
Schema: `actor TEXT NOT NULL DEFAULT 'ben'`. The `audit(table, rowId, action, before, after)` helper **never sets actor**, so every row falls back to the literal default `'ben'`. This was harmless when Ben was the only user. **It is now actively wrong** — jun and raphael are admins, and every action they take will be attributed to Ben. An audit trail that misattributes the actor is worse than none (false confidence).

**Fix options:**
- **(A, recommended) `AsyncLocalStorage`**: a request-scoped store set by the auth middleware (`req.user.email`), read inside `audit()`. One middleware + one read; zero changes to the 71 call sites. Clean and concurrency-safe.
- (B) Add an `actor` argument to all 71 `audit()` calls — tedious, error-prone, easy to forget on the next new route.
- (C) Module-level `currentActor` variable — **rejected**: unsafe under concurrent requests (interleaved awaits clobber it).
- Drop the `DEFAULT 'ben'` so a missing actor becomes a visible `NULL`/`system`, not a false attribution. Use `'system'` for cron/automated writes (nightly backup, dunning, FX refresh, recurring-invoice ticker).

### 1b. Authentication events are not audited at all
`/api/auth/login` and `/api/auth/logout` never call `audit()`. So: **successful logins, failed logins, and logouts leave no trace.** For a system holding financial + KYC data with three admins, *failed login attempts* and *session creation* are the events a real audit cares about most. (`change-password` and `setup` are audited; login/logout are the gap.)
- Add: `auth/login` (success), `auth/login-failed` (with IP, already rate-limited so the data exists), `auth/logout`, session revocations.

### 1c. ~6 mutating routes write data without an audit row
77 mutation routes; 71 `audit()` calls, several routes call it twice (insert+something) — so the audited-route count is lower than it looks. Spot gaps worth a systematic sweep: `settings/:key` (config changes — important), `fx-rates/:currency` edits, `bank-transactions/:id/match`, `saved-views`, `calendar-tokens` create/revoke, `tokens` (API token create/revoke — security-sensitive), `webhooks` create/delete. **Recommendation:** treat "every mutating route audits" as an invariant and add a lightweight test/lint that fails CI if a `db.prepare` INSERT/UPDATE/DELETE handler has no `audit()` on its path.

### 1d. "Append-only" is asserted, not enforced
The page header says *"Append-only."* but nothing stops an `UPDATE`/`DELETE` on `audit_log` — it's a normal table. The 2026-05-25 brief explicitly listed "append-only audit log — never overwrite" as a hard requirement. Two levels of rigor:
- **Cheap:** a SQLite trigger that raises on `UPDATE`/`DELETE` of `audit_log`.
- **Real tamper-evidence:** hash-chain each row (`row_hash = sha256(prev_hash + canonical(row))`). Lets you *prove* the log wasn't altered. Probably overkill for a 3-person internal tool, but worth a one-line note in the trail header instead of an unenforced "append-only" claim.

### 1e. Delete payloads are thin
Some deletes capture only a sliver of `before` (e.g., users delete logs `{email}` only). For a delete, the *entire* prior row is the most valuable thing to keep. Standardize: deletes snapshot the full `before` row.

---

## 2. Readability / density — why it "wastes space"

Current: a 5-column table — **When | Table | Row | Action | Actor** — full-width, tall rows, low information per screen.

- **Dead column:** `Actor` is always "ben" → pure noise today (and misleading per §1a). Until actor is real, it earns no column.
- **Raw internals leak:** `table_name` (`money_flows`, `calendar_tokens`, `api_tokens`) and bare `row_id` are developer terms, not user language. "money_flows / 1 / delete" tells Ben nothing about *what* was deleted.
- **Timestamp repetition:** `2026-05-29 04:12:58` on every row, no grouping. Eight rows share one second and one minute — begging for day/time grouping + relative times ("2 min ago").
- **No action affordance:** insert/update/delete/create are plain grey text — no color, no icon, no scannability.
- **The useful bit is hidden:** the before/after diff (`renderAuditDiff`) only appears on row-click. The single most useful thing the log knows ("role: user → admin") is invisible until you hunt for it.

## 3. Usefulness — what would make it genuinely good

- **Human event sentences** instead of `table/row/action`: *"Created invoice #7 (DupTest, HKD 2,075)"*, *"Changed user jun → admin"*, *"Deleted bank account ‘HSBC HKD'"*. Build these from `table_name` + `action` + a few fields from `after_json`/`before_json`. This alone fixes most of the "hard to read".
- **Inline change chips:** surface changed fields on the row itself — `role: user→admin`, `status: draft→sent` — not behind a click. Keep full diff on expand.
- **Action color + icon:** green insert/create, amber update, red delete, blue share/email, grey system.
- **Day grouping + relative time:** `Today`, `Yesterday`, `May 26` headers; hover for exact timestamp.
- **Drill-through for all entity types,** not just contacts/invoices/contracts/kyc (the current 4). Add bank accounts, flows, tasks, entities, etc.
- **Free-text search** across the human summary + diff values (keep the existing table/action/actor/date filters, but collapse them).
- **Pagination / "load more":** the API hard-caps `LIMIT 500`. Beyond 500 events the UI silently hides history that *is* in the DB → contradicts "captures everything" from the user's POV. Cursor on `id DESC`.
- **Per-record history:** "show all audit events for *this* invoice" — a timeline on each entity's dialog (the data + `row_id` filter already support it).
- **Export:** CSV/JSON export of a filtered range (auditor handoff — flagged in the 2026-05-25 brief).

---

## Proposed shape (build target)

**Backend**
1. `AsyncLocalStorage` actor context set in auth middleware; `audit()` reads it; drop `DEFAULT 'ben'`, use `'system'` for automated writes.
2. Add auth-event auditing (login ok/failed/logout) + sweep the ~6 missing mutation routes.
3. `/api/audit`: add keyset pagination (`?before_id=`), free-text `q` param, and an `?export=csv` mode.
4. (Optional) `UPDATE`/`DELETE` guard trigger on `audit_log`; or hash-chain column.
5. One-time data note: existing rows stay attributed to "ben" (can't retro-fix); new rows get real actors. Optionally stamp a marker row "actor-tracking enabled @ <ts>".

**Frontend (the Audit tab)**
- Replace the 5-col table with a **dense activity feed**: `‹color dot/icon› ‹human sentence› ‹changed-field chips› ‹relative time›`, grouped under day headers, expandable to the full before/after diff (reuse `renderAuditDiff`).
- Collapse filters into a single bar + free-text search; drop the standalone Actor column (show actor inline as a small avatar/initials once it's real).
- "Load more" at the bottom.

---

## Decisions needed from Ben

1. **Actor history:** OK that pre-today rows stay labelled "ben" (no retro-fix possible), real attribution from now on?
2. **Tamper-evidence depth:** none / cheap trigger / full hash-chain? (Recommend: cheap trigger now, hash-chain only if an auditor ever requires it.)
3. **Failed-login logging:** record failed attempts + IP in the audit trail? (Recommend yes — it's the highest-value security signal and the data already exists from rate-limiting.)
4. **Feed vs table:** go full "activity feed" redesign, or keep a table but dense + summarized? (Recommend feed — it's what kills the wasted space.)
5. **Retention/volume:** any cap on audit_log growth, or keep forever + paginate? (3-person tool → keep forever, paginate.)

## Recommended first slice (small, high-value)

1. `AsyncLocalStorage` actor capture + drop `DEFAULT 'ben'` + audit login/logout. *(This is the "captures everything" fix and it's ~30 lines.)*
2. Human event sentences + action color + day grouping in the feed. *(Kills "hard to read / wastes space".)*
3. Inline changed-field chips (diff data already exists). 

Pagination, export, hash-chain, per-record timeline = follow-up slices.
