# Carbon — Ledger build + ship Handoff 2026-06-06

**Status: DONE.** A full double-entry ledger was built, three-model-reviewed, bug-fixed,
tested, and **shipped live to https://carbon.aa.ag**. Nothing open to relay.

## What shipped (20 commits, `origin/main` → Coolify, confirmed live)
A complete accounting ledger in the **Ledger** tab, all entity- and period-aware:
- **Double-entry posting engine** — invoices, payments, and money flows auto-post; trial
  balance held balanced after every path (29 hermetic checks prove it).
- **Statements:** P&L (period flow), balance sheet (as-of, cumulative), cash flow
  (opening/in/out/closing per bank account), trial balance (as-of).
- **Comparative P&L** vs prior period (prev month/quarter/YTD/last year — `priorWindow()`).
- **AR/AP aging** (outstanding, bucketed, per-contact) — Ledger tab, as-of date.
- **Account drill-down** (click any account → entries + running balance).
- **CSV export** on every statement + the drill-down (client-side, matches the screen).
- **Chart-of-accounts management** (add/rename/archive/delete; system accounts protected).
- **Period lock** enforced on ALL ledger writes (invoices, flows, journal, void/delete).
- **Group overview (USD)** — net profit + cash per entity, converted to USD, group total.

## Three-model ship gate caught 3 REAL bugs (all fixed)
Codex (xhigh) + Grok + Claude reviewed the diff. Confirmed + fixed:
1. **Money flows ignored `kind`** — every inflow booked Revenue, outflow Expense. Since
   `transfer` is the DEFAULT kind, transfers/capital faked P&L. Fixed: only income/expense
   hit P&L; capital/dividend/transfer/loan post against **equity (3000)**.
2. **Deleting a payment orphaned its ledger legs** (cleanup keyed off rows still in the
   payments table). Fixed: delete the payment's legs explicitly before reposting.
3. **Entities created after boot had no chart of accounts.** Fixed: seed the starter chart
   on entity creation.
Plus 4 robustness hardenings (false "deleted" toast, double-post guard, aging shows errors
not false-zero, malformed-aging guard).

**Dismissed (NOT Carbon bugs):** Grok/Codex flagged "store money as integer cents / use a
locale formatter" — those are `AGENTS.md` rules carried over from SPRKS. Carbon's whole
codebase uses `REAL` money (invoices, flows, everything); the ledger is consistent with that.
Do NOT migrate only the ledger to cents — see locked-decisions.

## Key landmarks (server.js)
- Posting engine ~L420–516: `postInvoiceFull`, `clearInvoiceLedger`, `postMoneyFlow`
  (kind→contra mapping), `baseConvert`, boot backfills.
- `checkPeriodLock` / `checkFlowLock` ~L1394; called in invoice/flow/journal write paths.
- Ledger endpoints: `/api/ledger/{accounts,statements,trial-balance,aging,cashflow,group}`,
  `/api/ledger/journal`, account CRUD. (`/api/reports/aging` is the OLDER per-entity Reports
  view — fixed this session to net payments, distinct from `/api/ledger/aging`.)
- Frontend: `loadLedger()` + render/dialog helpers in `public/app.js`; cards in `#tab-ledger`.

## Tests (green)
- `npm run test:ledger` — **29 hermetic checks** (copies real data to a temp DB; touches
  nothing live). Covers every posting path + the 3 fixes + group reconciliation.
- `npm run smoke` — headless Chrome: login + 7 tabs + ledger dialogs + CSV + aging + cashflow
  + group cards render, no uncaught errors.

## Deploy notes (Carbon-specific — `/ship` is SPRKS-shaped, had to adapt)
- Carbon = branch **main**, remote `auernet/carbon`, deploy via **Coolify** (push ≠ live).
- Coolify admin port 8000 is firewalled + self-signed → deploy by triggering it from the
  **logged-in Coolify UI** in the browser (Carbon app → **Redeploy**). The `/api/v1/deploy`
  API needs a Bearer token which is **NOT in the keychain**.
- Verified live by polling `carbon.aa.ag/app.js` for a new symbol + `/api/ledger/group`→401.

## Open follow-ups (none blocking; Ben declined more features)
- [ ] **Store the Coolify deploy token in the keychain** (`security add-generic-password -s
      coolify-api -a ben -w <token>`) so deploys don't need the browser session. (Token was
      redacted from the repo 2026-06-01; rotate + store.)
- [ ] (Pre-existing) Fix Coolify auto-deploy; lock down `/api/auth/setup`; off-server backups.
- [ ] (Optional, low value) Dedupe money-formatter helpers — Ben explicitly said no more
      features/cleanup needed this session.

## Explicitly deferred (see _explorations.md)
- **Budgets / budget-vs-actual** — Ben declined ("don't need this").
- **Full consolidated balance sheet** — FX translation across HKD/AED breaks the balanced
  identity (needs a translation-adjustment plug). Group overview is a USD *summary* instead.
