# Carbon — full in-depth audit — 2026-06-06

Read-only audit of the whole app (no code changed). Five parallel deep passes:
security, backend correctness, frontend, data/ops, design/UX. Findings consolidated,
deduped, ranked. Items marked **[VERIFIED]** were re-checked by hand against the source
after the agent reported them.

Scope: `server.js` (4956 lines), `public/app.js` (4881), `public/index.html` (1545),
`public/style.css` (2508), `db/schema.sql`, Docker/ops config.

Baseline: `node --check` passes on both JS files. `npm audit` clean, deps current.
SQL is parameterised throughout (no injection found). Password hashing is scrypt +
per-user salt + `timingSafeEqual` (solid). Secrets are correctly gitignored. The ledger
table carries good CHECK constraints. These are genuinely well done — see "Confirmed good".

---

## TIER 0 — CRITICAL (close before treating carbon.aa.ag as safely internet-facing)

### C1 🔴 Counterparty statements are fully UNAUTHENTICATED **[VERIFIED]**
- `server.js:876` — auth gate only guards `/api/*` and `/invoices/*`.
- `server.js:4048` — `GET /contacts/:id/statement` is NOT covered, so it returns data with no login.
- Anyone on the internet can hit `https://carbon.aa.ag/contacts/1/statement`, `/2`, `/3`… and
  read each contact's display name, legal name, **tax ID**, all open invoices, all open bills,
  12-month paid history, and outstanding balances. Numeric IDs enumerate the whole book.
- Compounded by `server.js:3981-4046` (`renderStatementHTML`) interpolating those DB strings
  with **no HTML escaping** (the invoice renderer escapes; this one doesn't).
- **Fix:** invert the gate to default-deny — allowlist only public paths (`/`, `/healthz`,
  static assets, `/api/auth/*`) and require auth for everything else; run every interpolated
  value in `renderStatementHTML` through the existing `htmlEscape()`.

### C2 🔴 No off-server backups — one disk loss wipes everything **[VERIFIED via .env + handoff]**
- `server.js:97-116` (`runNightlyBackup`) writes archives into `data/backups/` — the **same**
  bind-mounted volume as the live `carbon.db` and the KYC attachments.
- A VPS disk failure, deleted/corrupted Coolify volume, or botched redeploy takes the database
  **and every backup at once**. Nothing ever leaves the machine. (Flagged "off-server backups"
  as open in the last two handoffs; still not done.)
- **Fix:** ship nightly archives off-box (S3 / Backblaze / `rclone` / `scp` to a second host)
  and verify the upload succeeded.

### C3 🟠 Live production admin password committed in plaintext
- `CLAUDE.md:18`, `scripts/smoke-test.js:13`, `scripts/test-ledger.js:13`,
  `.claude/locked-decisions.md`, and 4 `docs/HANDOFF-*.md` all contain
  `ben@aa.ag` / `nobfa3-cobjip-zIjpob`, marked "NEVER change."
- Anyone with repo read access (or the built image, if the registry is ever exposed) has full
  admin to all financial data.
- **Fix:** rotate the admin password, move test creds to an env var / untracked `.env`, purge
  the value from the working tree (history scrub optional).

### C4 🟠 `/api/backup` streams the whole DB over a GET, no admin gate **[VERIFIED]**
- `server.js:3797` — `app.get('/api/backup', …)` with **no `requireAdmin`** (unlike `/api/restore`).
- It IS behind the login gate, but any logged-in user — including a **read-only** role or a
  **read-scoped API token** (GET is allowed for them) — can pull a full `tar.gz` of `data/`:
  the SQLite file (password hashes, AES-encrypted credentials) **plus `.encryption.key`**, which
  defeats the at-rest credential encryption (key + ciphertext in one bundle).
- Session cookie is `SameSite=Lax` (`server.js:786`), which still sends on top-level
  cross-site navigation — so a logged-in admin clicking a crafted link
  (`<a href="https://carbon.aa.ag/api/backup">`) hands over the whole database. `encrypt=1` is
  optional, so the default download is plaintext.
- **Fix:** make backup/export POST + CSRF token (or custom-header check), add `requireAdmin`,
  set the session cookie `SameSite=Strict`, and exclude `.encryption.key` from the archive.

### C5 🟠 Coolify deploy token leaked in git history, still un-rotated
- Redacted from `HEAD` on 2026-06-01 but recoverable from prior commits; it grants full deploy
  control of the VPS app. Flagged "rotate it" since 2026-05-29.
- **Fix:** revoke the old token in Coolify, issue a new one, store in macOS keychain
  (`security add-generic-password -s coolify-api -a ben -w <token>`).

---

## TIER 1 — HIGH: silent accounting-integrity bugs (the books can drift without warning)

### H1 🔴 Foreign-currency tax invoices can silently post NOTHING to the ledger **[VERIFIED mechanism]**
- `server.js:434` — `mk` computes each leg's base independently: `base: round2(amt * fx)`.
- For a tax-bearing invoice, debit `round2(total*fx)` is compared against
  `round2(subtotal*fx) + round2(tax*fx)`. Independent rounding can push the imbalance past the
  `Math.abs(d - c) > 0.01` tolerance (`server.js:457`), which **throws**.
- The throw is caught at `server.js:466` and only `console.error`'d — so the invoice row
  persists (it was committed by the route handler's own transaction earlier) but **no ledger
  legs are written**. P&L, trial balance, and balance sheet silently understate.
- **Fix:** make the largest leg a balancing plug (residual of the others), or post the rounding
  difference to an FX gain/loss account — and stop swallowing the error (see H3).

### H2 🔴 Recording or deleting a payment BYPASSES the period lock **[VERIFIED]**
- `server.js:3609` (`POST …/payments`) and `server.js:3627` (`DELETE …/payments/:pid`) — neither
  calls `checkPeriodLock`. Every other money path (invoice create/edit/void, flows, journal)
  does. Both call `postInvoiceFull`, which rewrites ledger legs dated inside the (possibly
  locked) period — so a user can mutate the cash position of a filed/closed quarter.
- **Fix:** add `checkPeriodLock(inv.entity_id, paidOn)` (and the invoice issue date) to both
  handlers before writing.

### H3 🔴 Ledger posting runs OUTSIDE the row transaction and swallows errors **[VERIFIED]**
- `server.js:1474-1477` (invoice POST), `:1548-1551` (PUT), `:3621-3622` (payment add): the row
  is committed by `tx()`, **then** `postInvoiceFull()` runs as a separate transaction whose
  errors are caught-and-logged (`:466`). Any failure (H1, a crash, a missing account) leaves the
  invoice/payment saved with missing or stale legs and **no error surfaced to the caller**.
- **Fix:** call `postInvoiceFull` inside the same `db.transaction` as the row write and let an
  imbalance roll the whole thing back (return 4xx/5xx).

### H4 🔴 Deleting a payment never re-opens a 'paid' invoice
- `recomputeInvoicePaidStatus` (`server.js:3592-3601`) only ever *upgrades* status. Delete the
  payment on a `paid` invoice and it stays `paid` with a lower `amount_paid` — it drops out of
  AR aging while no longer actually settled, overstating collected revenue.
- **Fix:** add `else if (paid < inv.total && status === 'paid') newStatus = 'sent';`.

### H5 🟠 Missing FX rate posts raw foreign amounts as base currency
- `baseConvert` (`server.js:484`) returns `round2(amount)` unconverted when a rate is
  missing/zero. The legs still balance (both share the value), so nothing trips the guard, but
  the "base" column now mixes currencies — silently corrupting trial balance / statements.
- **Fix:** refuse to post (or post the diff to FX gain/loss) and warn "rate missing".

### H6 🟠 Consolidated dashboard silently zeroes an entity with a missing rate
- `convert()` returns `null`; consumed as `cash += cashConv || 0` (`server.js:4592-4601`). That
  entity contributes **zero** to group totals with no flag (the `/api/ledger/group` view DOES
  flag fx_missing — the dashboard doesn't). Report looks complete but undercounts.
- **Fix:** track and surface an `fx_missing` flag like the ledger group endpoint.

### H7 🟠 NaN amounts can reach the DB on flows
- `normaliseFlow` (`server.js:2419-2423`) guards `== null` then does `Number(o.amount)`, so
  `"abc"` passes as `NaN`. Also accepts `0` and negative amounts, and never checks referenced
  entity/contact IDs exist (a bad entity id is silently dropped by `postMoneyFlow`, leaving a
  flow with no ledger footprint).
- **Fix:** reject `!Number.isFinite(amount)` and require `amount > 0`; validate FKs.

---

## TIER 1 — HIGH: data durability (ops)

### D1 🔴 Restore wipes the live data dir in place; only safety copy is on ephemeral storage **[VERIFIED]**
- `server.js:27-59` (boot-time `_pending_restore`): empties `DATA_DIR` entry-by-entry, then
  `cpSync`s from staging. A kill between empty and copy leaves the volume **wiped or
  half-populated**. The pre-restore safety copy is written to `ROOT` (`/app`) — the container
  layer on Coolify, which vanishes on the next redeploy.
- **Fix:** stage beside the volume and swap by rename within the same device; keep the safety
  copy inside the persistent volume.

### D2 🔴 No `synchronous` / `busy_timeout` pragmas
- `server.js:62-64` sets only `journal_mode=WAL` and `foreign_keys=ON`. No
  `PRAGMA synchronous` (unclean restart can lose/corrupt the last transactions) and no
  `busy_timeout` (a write colliding with the WAL checkpoint throws `SQLITE_BUSY` immediately;
  many such writes are wrapped in `catch(_){}` and fail silently — e.g. ledger posting).
- **Fix:** `db.pragma('synchronous = FULL')` (or explicit NORMAL) + `db.pragma('busy_timeout = 5000')`.

### D3 🟠 Container runs as root
- `Dockerfile` has no `USER` directive. A code-exec bug (puppeteer / tar / execSync paths) runs
  as root inside the container on a shared VPS.
- **Fix:** add a non-root `USER` and `chown /app/data` to it.

### D4 🟡 Migrations: no version guard, run outside a transaction, ALTER errors uncaught
- `server.js:229-359`. Each step is individually idempotent and the earlier ordering bugs are
  fixed, but there's no `schema_version`, the block isn't transactional, and a future bad DDL
  throws and blanks the app at boot.
- **Fix:** add a `schema_version` row and wrap the migration block in one transaction.

---

## TIER 2 — frontend trust (buttons that lie, break, or fail silently)

### F1 🟠 "Change password" is dead — duplicate dialog id **[VERIFIED]**
- `public/index.html:1356` and `:1452` both define `<dialog id="account-dialog">`.
  `getElementById` returns the first (the ledger account drill-down shell), so clicking your
  name pops an empty box with Export/Close — the password form never shows. Users cannot change
  their password at all.
- **Fix:** rename the password dialog to a unique id (e.g. `password-dialog`) and update the
  references at `app.js:3080-3092`.

### F2 🟠 Bulk "Void selected" always toasts success, even when every void failed
- `app.js:1904-1911` loops, `api.voidInvoice` (`app.js:57`) doesn't check `r.ok`, no try/catch,
  so `toast("Voided N invoice(s)")` fires unconditionally — e.g. period-locked invoices report
  success while the server rejected them.
- **Fix:** make `voidInvoice` throw on non-2xx, count real successes/failures, toast the truth.

### F3 🟠 Contact / invoice / bill save can fail silently while the dialog closes "as saved"
- `saveContact` (`app.js:1400-1419`) and `saveInvoice` (`app.js:2172-2201`) have no try/catch;
  `api.createContact/updateContact/createInvoice/updateInvoice` (`app.js:32-56`) don't check
  `r.ok`. On any server rejection (duplicate, validation, period lock, 500) the dialog closes,
  the list reloads, and `saveInvoice` even `clearInvoiceDraft()`s — the user believes it saved
  and can lose the entered invoice.
- **Fix:** route these through the `r.ok`-checking `jsonReq` helper, wrap in try/catch with an
  error toast, only `clearInvoiceDraft()` after confirmed success. (Matches `saveEntity`.)

### F4 🟠 Single void / archive / delete actions swallow server refusals
- Handlers at `app.js:1182, 1824, 2267, 2422, 2724, 2979`; the DELETE api methods `.then(r =>
  r.json())` with no status check. A period-lock or FK-block refusal reloads the list and the
  record reappears with no explanation — looks like a glitch, not a refusal.
- **Fix:** have these throw on non-2xx and toast the error.

### F5 🔴 One failing dashboard endpoint blanks the whole dashboard
- `app.js:328-331` — `Promise.all` where only `tasks` has a `.catch`. A 500 or network blip on
  any of dashboard/hero/trend/top/consolidated rejects the lot; `loadDashboard` throws; no cards
  render. This is the exact "blank dashboard" class the locked decisions warn about.
- **Fix:** give each dashboard fetch its own `.catch` returning a safe default; render what
  succeeded. (Same pattern needed on Reports — `app.js:627-632`.)

### F6 🔴 Clicking "Tasks" before boot finishes throws
- Tab handler `app.js:315` calls bare `loadTasks`, which is only assigned as `window.loadTasks`
  inside the async `init()` at `app.js:4693`. Every other loader is top-level hoisted. Clicking
  Tasks during load shows an empty panel + error banner.
- **Fix:** declare `loadTasks` as a top-level `function`, or guard the handler.

### F7 🟢 No double-submit guard on Save dialogs (except the journal entry)
- Only `je-save` is disabled during post (`app.js:3960`). A double-click on a slow network can
  create duplicate contacts/invoices/flows/bills.
- **Fix:** disable the primary button on click, re-enable in `finally`.

### F8 🔵 `escapeHtml` omits single quotes; duplicated money formatters
- `app.js:4207-4214` — no live XSS today (attributes are double-quoted), but a latent foot-gun.
- `fmtMoney` (`app.js:1913`) is re-implemented inline ~6 times (`app.js:3637, 3651, 3663, 3684,
  3827`) — formatting drift risk. `fmtMoney(n, ccy)` is called with a currency arg it ignores.

---

## TIER 2 — security, medium

### S1 🟡 Any authenticated user can read any KYC doc / contract file by ID
- `server.js:2155` (KYC), `:2025` (contract files). Authorization is binary (logged-in + role),
  no per-entity scoping. For a 3-person trusted team this is largely by-design, but one
  compromised non-admin session (or a write token) exposes all PII (passports, UBO docs).
- **Fix:** add entity-scoped checks, or explicitly document that all authed users are fully trusted.

### S2 🟡 Uploads: no type validation, served inline → stored-XSS / DoS
- `server.js:1871` (`express.raw({ limit: '100mb' })`), `:2138/:1984` (no type check), `:2161/
  :2031` (served `inline` with client-supplied MIME). An uploaded HTML/SVG opens same-origin and
  runs script; 100 MB raw bodies with no quota can fill the disk.
- **Fix:** force `Content-Disposition: attachment` + fixed safe Content-Type + `nosniff`;
  allowlist MIME types; lower the raw limit and add a per-account quota.

### S3 🟡 `/api/auth/setup` reopens whenever the users table is empty
- `server.js:911-929`. Hard-blocks (409) once any user exists, and the bootstrap admin
  re-seeds from `data/.carbon-admin.json` on boot — but if the table is ever emptied (failed
  restore, fresh volume before the file lands), the first unauthenticated caller creates an admin.
- **Fix:** also refuse setup when `.carbon-admin.json` exists, or bind it to a one-time env token.

### S4 🔵 Info-disclosure odds and ends
- Global handler echoes `err.message` on `/api/*` (`server.js:4945`) — can leak table/column
  names. `/healthz` leaks `node_version` (`server.js:837`). Login throttling is per-IP only
  (botnet/rotating-IP bypass; 8-char min password). Puppeteer runs `--no-sandbox` (`server.js:1656`).

---

## TIER 3 — design / UX polish (vs the "Refined" spec)

### P1 🟠 New design tokens defined only under `[data-theme]`, not base `:root`
- `style.css:1405-1445` — `--radius-lg`, `--divider`, `--shadow-*` live only in the dark/light
  blocks. If `data-theme` is ever absent (JS off, pre-paint failure, print/screenshot context),
  radii collapse and divider borders vanish — the whole layout breaks.
- **Fix:** define the full token set once in base `:root` and mirror into `prefers-color-scheme`.

### P2 🟠 No `:focus-visible` anywhere; inputs remove the outline
- `style.css:283-286, 1491-1495` (`outline: none`); zero `:focus-visible` rules. Keyboard users
  get no focus ring on buttons, tabs, row-actions, pills, links. Biggest a11y gap.
- **Fix:** global `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }`.

### P3 🟡 Cards split bordered vs borderless; Reports/Settings tables uncarded
- The "Notion redesign" makes cards borderless (`style.css:1471`) but later rules re-add borders
  to `.hero-card` (`:2236`), `.consolidated-card` (`:1962`), `.trend-card` (`:1830`). On the
  Dashboard, bordered and borderless cards sit side by side. Reports/Settings (`index.html:547,
  605`) use bare `<table>` + inline `margin-top:24px` with no card wrapper — look unfinished next
  to Ledger.
- **Fix:** pick one card treatment, delete the later border rules; wrap report/settings sections
  in the same card + divider pattern.

### P4 🟡 QoQ delta colors rising expenses GREEN (semantically inverted)
- `app.js:692` — positive `expense_delta_pct` rendered `color:var(--accent)`. Growing costs look
  "good"; shrinking costs look red. Also paints accent on a value (accent-discipline drift).
- **Fix:** color deltas by good/bad direction per metric, not by sign.

### P5 🔵 Dead CSS & inline magic numbers
- Orphaned `.counter*` block (`style.css:736-758`, markup uses `.dash-counter/.n/.label`);
  ~120 lines of superseded tinted-pill CSS; 84 inline `style="…"` in `app.js` with repeated
  magic spacing (`margin-top:24px`, `font-size:11px`); `.notif-count` uses literal `white`;
  `notif-close` "×" has no `aria-label`.
- **Fix:** delete dead blocks; promote recurring inline patterns to utility classes; add the label.

---

## Confirmed GOOD (no action — recorded so we don't re-litigate)
- **SQL injection:** none. All queries use prepared statements with `?`/`@named` bindings;
  dynamic fragments are built only from server-side constant column arrays.
- **Password hashing:** scrypt + per-user 16-byte salt + `timingSafeEqual`. Reasonable.
- **Secrets hygiene:** `data/`, `*.db*`, `.env`, `.encryption.key`, `.carbon-admin.json` all
  gitignored and untracked; `.env.example` holds no real secret; `.dockerignore` excludes
  `data`/`node_modules`/`.git`/`.env*`; encryption key is `0600`, auto-generated.
- **Dependencies:** `npm audit` clean, deps current, lockfile committed, Node pinned `>=20`.
- **Path traversal on downloads:** mitigated (`safeFilename` strips `../`; `readAttachment`
  re-checks `startsWith(DATA_DIR)`; lookups are by DB id).
- **`/api/auth/setup`:** blocks with 409 once any user exists (the residual risk is S3).
- **Ledger table:** has good CHECK constraints; writes are transactional and balance-checked
  (the gap is H1/H3 — the *posting call site*, not the table).
- **Money as REAL (not cents):** deliberate, locked decision — NOT a finding.

---

## Recommended sequencing
1. **TIER 0 first** (C1 + C2 are the two that should not wait a day): close the open
   `/contacts/:id/statement` route, get backups off the box, rotate the admin password + Coolify
   token, gate `/api/backup`.
2. **TIER 1 next** (H1–H4, D1–D2): the silent accounting-integrity and durability bugs — these
   corrupt trust in the numbers and the data quietly.
3. **TIER 2** (frontend trust F1–F6, security S1–S3): the lying/broken buttons users hit daily.
4. **TIER 3** polish last.

Every fix above is scoped to existing files (`server.js`, `public/*`, `Dockerfile`, schema).
No restructuring required.
