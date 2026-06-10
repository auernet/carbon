# Carbon — Locked Architectural Decisions

Durable decisions that apply across sessions. Newest on top. NEVER delete entries.

---

## 2026-06-10 — Auth gate is default-DENY

**Decision:** Everything requires a session/API token EXCEPT an explicit public allowlist
(landing page, auth routes, static assets). Token-gated public routes (share links, iCal,
healthz) register ABOVE the gate. New routes are private by default.

**Why locked:** The old allowlist-by-prefix gate leaked `/contacts/:id/statement` (names, tax
IDs, balances) to the open internet. Default-deny makes that class of leak impossible to
reintroduce by forgetting a prefix.

## 2026-06-10 — Ledger posting is atomic with the row write

**Decision:** `postInvoiceFull` runs INSIDE the invoice/payment transaction; posting errors are
never swallowed (boot backfill tolerates per-row); the AR/AP leg's base is the residual of the
other legs so FX rounding can't unbalance an entry. Payments enforce the period lock on add AND
delete; deleting a payment reopens a 'paid' invoice.

**Why locked:** The audit found tax-bearing FX invoices could silently post NOTHING (caught
throw → console only), payments bypassed the period lock, and paid invoices stuck 'paid'.
These silently corrupt the books — the invariants above are what keep trial balance trustworthy.

## 2026-06-10 — Bills: attachments + always-draft AI extraction

**Decision:** Supplier files attach to invoices (multi-file, KYC-doc pattern, hardened
serving). AI-extracted bill fields ALWAYS land in a draft a human reviews — never auto-posted.
Duplicate bills (vendor + supplier number) warn, never hard-block.

**Why locked:** AP accuracy beats automation speed; an unread number must never hit the books.

## 2026-06-10 — AI engine config: encrypted keys, honest subscription mode

**Decision:** AI keys live AES-GCM-encrypted in settings under `ai_*`, are never returned to
the client (masked "key set" only), and the generic settings routes refuse `ai_*` keys. The
engine selector defaults to 'subscription' which must stay an HONEST no-op on the server
(clear error telling Ben to add a key) — bills are never sent anywhere unless a key engine is
explicitly chosen.

**Why locked:** Ben's mental model ("use my subscription") would otherwise invite a placebo or
a silent data-send. Honesty about where documents go is non-negotiable for KYC-grade files.

## 2026-06-10 — Container runs non-root; cookies SameSite=Strict

**Decision:** Prod container drops to the unprivileged user via the gosu entrypoint (chowns
`/app/data` first); keep on any Dockerfile change. Session cookies are `SameSite=Strict`.

**Why locked:** Code-exec in the container must not be root on a shared VPS; Strict closes the
clicked-link request-forgery class (the audit's backup-download exfil).

## 2026-06-06 — Ledger money stays REAL (NOT integer cents)

**Decision:** The ledger persists money as `REAL` + `round2()` + 0.01 balance tolerance,
consistent with the rest of Carbon (invoices, flows — all REAL).

**Why locked:** The ship gate (Codex + Grok) flagged "store money as integer cents" per
`AGENTS.md`. That rule is **carried over from SPRKS and does not match Carbon's codebase**.
Migrating only the ledger to cents would make it inconsistent with every other table. If
cents is ever wanted, it's an app-wide migration — a separate, deliberate decision. Treat
`AGENTS.md` conventions as SPRKS-derived; verify against Carbon's actual code before applying.

## 2026-06-06 — Money-flow kind → account mapping

**Decision:** Only `income`/`expense` flows hit the P&L (Revenue 4000 / Expense 5000). All
other kinds — `transfer` (the default), `capital`, `dividend`, `loan` — post against
Owner's equity (3000), a balance-sheet movement.

**Why locked:** Original code booked every inflow as Revenue / outflow as Expense, so the
default `transfer` kind fabricated P&L. Equity is an approximation for transfers (proper
intercompany accounting is future work) but is strictly correct-er and keeps books balanced.

## 2026-06-06 — Group view is a USD summary, NOT a consolidated balance sheet

**Decision:** The "Group overview (USD)" shows net profit + cash per entity converted to USD
with a group total. We deliberately do NOT produce a consolidated balance sheet.

**Why locked:** Entities have different base currencies (HWG=HKD, MER=AED). FX translation
across them breaks the Assets = Liabilities + Equity identity (needs a currency-translation
adjustment plug). A summary avoids a false "out of balance" without the CTA machinery.

## 2026-06-06 — Period lock enforced on ALL ledger writes

**Decision:** `period_lock_through` is checked on invoices (create/update/void/delete),
money flows (create/update/delete, both entity sides), and manual journal (create/delete).

**Why locked:** It was previously enforced only on invoice create/update, so flows and
journals could still post into a "closed" period — a half-working control.

---

## 2026-05-30 — Single source of truth = ~/Dev/Carbon repo (memory included)

**Decision:** The entire project — code, docs, AND durable memory — lives in `~/Dev/Carbon`. Memory files (`locked-decisions.md`, `_explorations.md`, `workflow-observations.md`) live in the repo's `.claude/` (committed to git), NOT in a home-level `~/.claude/Carbon/` overlay. A root `CLAUDE.md` declares this. Future sessions and handoffs write here only.

**Why locked:** Memory had split between `~/.claude/Carbon/` (rich) and the repo `.claude/` (thin dupes) — exactly the scatter Ben asked to end. In-repo memory is versioned in git and is what the SessionStart bootstrap surfaces (it reads `$ROOT/.claude`); the home overlay wasn't being surfaced at all.

**Hard constraint:** Never create Carbon files outside `~/Dev/Carbon`. Keep off iCloud.

---

## 2026-05-30 — Prod deploy is MANUAL (push ≠ live)

**Decision:** Pushing to `origin/main` does NOT auto-deploy carbon.aa.ag. Each deploy must be triggered explicitly via Coolify's deploy API, then verified on prod. Treat "pushed" and "live" as separate states.

**Why locked:** Coolify auto-deploy/webhook is off or broken — pushes sat undeployed for hours this session (caught only when Ben asked "everything shipped?").

**Access path:** Admin port 8000 is firewalled from the dev machine and the self-signed cert blocks the automation browser over https. Working route: Chrome MCP → `http://83.228.220.166:8000` (logged-in UI) → same-origin `GET /api/v1/deploy?uuid=f4kgsgckgw408co0440kso40&force=true` with the Bearer token → poll the changed prod asset (~3–4 min).

**Could change if:** auto-deploy is re-enabled in Coolify.

---

## 2026-05-30 — App visual design language = "Refined"

**Decision:** Bordered cards (`--radius-lg`), generous padding, section dividers, larger tabular-num figures, subtle hover. Accent green (`--accent`) only on PRIMARY labels (entity codes, section headers) — never every label. Token-based; adapts to dark + light.

**Why locked:** Chosen over "KPI tiles" (too busy) and "Branded/green-labels" (legibility) — see `_explorations.md`. Applies to hero, consolidated, `.dash-card`, Reports; tables share the bordered radius-lg container.

---

## 2026-05-30 — app.js init() is boot-critical

**Decision:** `init()` is a single async IIFE at the bottom of `public/app.js`. Anything it runs before reaching `loadDashboard()` that throws — including a bare identifier referenced before its `window.x = …` assignment — silently aborts the whole boot (blank app). Wire event listeners AFTER the handlers they reference.

**Why locked:** This exact bug (a `loadTasks` listener wired one line early) blanked the dashboard for every user. Uncaught promise rejections in init do NOT surface via the Preview MCP console (only `console.*` does) — add a temporary `unhandledrejection → console.error` shim to debug invisible boot failures.

---

## 2026-05-29 (later) — Project root moved to ~/Dev/Carbon (off iCloud Desktop)

**Decision:** The canonical Carbon working copy is `/Users/ben/Dev/Carbon`. The old `/Users/ben/Desktop/Carbon` is abandoned — iCloud Desktop sync was corrupting the repo mid-build (files vanishing, `.git` object read errors, stale rollbacks). Treat any `~/Desktop/Carbon` as a dead husk.

**Why locked:** iCloud sync on Desktop intermittently evicts/rolls back files, breaking git and builds — confirmed live this session (the dir reverted to a pre-session state mid-command). Same remote (`github.com/auernet/carbon`), so prod deploys are unaffected.

**Hard constraint:** Work only in `~/Dev/Carbon`. Future sessions + Ben's bookmarks must point there, not Desktop.

---

## 2026-05-29 (later) — Login id: bare usernames allowed, not email-only

**Decision:** A Carbon login id may be a bare username OR an email. Production users: `ben@aa.ag` (email, keychain) stays as-is; `jun` and `raphael` log in with plain usernames + password — NOT `@aa.ag` emails. This SUPERSEDES the email-only convention below.

**Why locked:** Ben explicitly rejected made-up `@aa.ag` addresses for Jun/Raphael — those mailboxes don't exist. `/api/users` now validates username-or-email (`isValidLoginId`); the login form input is `type="text"`.

**Could change if:** Carbon serves external clients who expect email-based logins.

---

## 2026-05-29 — Production hosting + domain

**Decision:** Carbon runs at `https://carbon.aa.ag`, hosted on Ben's existing Coolify VPS (`83.228.220.166`). Coolify app UUID = `f4kgsgckgw408co0440kso40`. DNS A-record managed via Porkbun (Ben owns `aa.ag`). TLS auto-provisioned by Coolify's Let's Encrypt integration.

**Why locked:** Reuses existing infrastructure (sprks already lives on the same VPS), keeps data on Ben's hardware (the "data stays with us" original constraint relaxes only as far as Ben's own VPS), and `aa.ag` matches the `ben@aa.ag` login convention.

**Hard constraints:**
- DO NOT change the A-record without Ben's say-so.
- Coolify must use a Directory Mount (host bind path) for `/app/data` — named volumes and `custom_docker_run_options` flags don't survive Coolify's compose restart cycle (proven twice in the 2026-05-29 session).

**Could change if:** the VPS goes away (full migration to a different host) or if multi-region becomes a need (would require external Postgres/equivalent, not SQLite).

---

## 2026-05-29 — Production user convention

**Decision:** All Carbon production users use `<firstname>@aa.ag` as the login email + `<Firstname>` as the display name. Confirmed users: `ben@aa.ag` (admin), planned: `jun@aa.ag` (admin), `raphael@aa.ag` (admin).

**Why locked:** Carbon's `/api/users` endpoint enforces `isValidEmail()`. Bare usernames would need code changes across auth/setup/login. Email-shaped identifiers with simple display names give the "username feel" without modifying auth.

**Could change if:** Carbon ever serves external clients (not just the HWG/MER internal team), at which point real work emails would replace the aa.ag handles.

---

## 2026-05-28 — Encrypted backup format

**Decision:** Encrypted backups use the layout `"CARB" (4 bytes) + salt (16) + IV (12) + GCM tag (16) + ciphertext`. Key derived with `scrypt(passphrase, salt, 32)`. Cipher is AES-256-GCM.

**Why locked:** The magic bytes make the file self-identifying. Single-file (no JSON envelope). GCM provides authenticity without a separate HMAC pass. scrypt's CPU/memory cost protects weak passphrases.

**Implementation:** server.js encrypt block (`/api/backup?encrypt=1`) and decrypt block (`POST /api/backup/decrypt`).

**Could change if:** Adding integrity for a streaming variant (current implementation buffers the whole tar in memory before encryption — fine for ~150 KB backups, would be a problem at GB scale).

---

## 2026-05-28 — Cash runway formula

**Decision:** `runway_months = (cash_on_hand ÷ ((expenses_90d − revenue_90d) ÷ 90)) ÷ 30`, computed per entity in `/api/dashboard/hero`. Returns `null` if not burning (revenue ≥ expenses over the 90-day window).

**Why locked:** Uses invoices (forward-looking commitments) not bank transactions (reactive). 90-day window smooths spikes. Per-entity (not consolidated) so each company stands on its own.

**Could change if:** A "cleared cash runway" variant is requested — would be a separate field, not a replacement.

---

## 2026-05-28 — Backup excludes (both on-demand and nightly)

**Decision:** Every tar invocation that snapshots `data/` MUST exclude:
- `data/backups/` (prevents recursive growth)
- `data/_pending_restore.tar.gz` (staged restore artefact)
- `data/_restoring/` (in-flight restore staging)

**Why locked:** Each prior bug came from this list being incomplete. The recursive-include caused exponential backup growth (3.5 MB and climbing).

**Implementation:** server.js nightly helper (~line 101) and on-demand handler (~line 3228). If a third backup path is ever added, it MUST replicate these excludes.

---

## 2026-05-26 — Bootstrap admin persists across DB wipes

**Decision:** `data/.carbon-admin.json` (chmod 600) stores the scrypt hash + email + display name. On startup, if the `users` table has no admin or the admin doesn't match the bootstrap email, the bootstrap user is re-inserted.

**Why locked:** Test scripts and migrations do `DELETE FROM users` regularly. Without this, the user gets locked out and needs manual SQL recovery.

**Hard constraint:** Bootstrap credentials are `ben@aa.ag` / `nobfa3-cobjip-zIjpob`. NEVER change. Ben uses iCloud Keychain on these.

---

## 2026-05-26 — Carbon runs on port 4040, NOT 3000

**Decision:** Default `PORT=4040`. Port 3000 is reserved for the sprks project.

**Why locked:** Conflict caused login confusion in earlier sessions. Hardcoded into startup scripts and Ben's bookmarks.
