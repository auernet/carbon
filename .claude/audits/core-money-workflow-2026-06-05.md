# Audit — Core money workflow — 2026-06-05

Scope: Invoices & Bills / AR, Money Flows, Bank reconciliation. Read-only trace of every affordance → handler → endpoint → DB write (server.js, public/app.js, public/index.html). Second-model pass via an Explore subagent, findings confirmed against source.

## Verdict
The core money workflow is **fundamentally solid** — invoice CRUD, payments + status recompute, recurring generator (12h ticker), dunning (scheduled), CSV import with preview, exports, and money-flow CRUD are all genuinely persisted with correct transitions. Two real issues found.

## Findings (ranked by trust cost)

### 🔴 1. Bank "unmatch" left the invoice stuck on `paid` — FIXED 2026-06-05
- **Where:** `server.js` bank-transactions `/:id/match` endpoint.
- **Was:** matching a bank txn to an invoice set the invoice `status='paid'`; unmatching (invoice_id null) cleared the txn link but never reverted the invoice — it stayed `paid` with no payment behind it.
- **Fix:** capture the previously-matched invoice; on unmatch / re-match, recompute it from real recorded payments → keep `paid` only if payments still cover the total, else revert to `sent` (never touch `void`).

### 🟠 2. Bank-transaction dedup can silently drop legit transactions — OPEN
- **Where:** `db/schema.sql` `UNIQUE(account_id, txn_date, amount, description)` + CSV import `INSERT OR IGNORE`.
- **Risk:** two real transfers of the same amount + identical description on the same day are dropped as "duplicates" with no feedback.
- **Recommended:** prefer a bank-provided txn id as the dedup key when present; and surface a "N duplicate rows skipped" notice on import so silent drops are visible.

## Confirmed solid (no action)
Invoice create/edit/delete + status; invoice payments add/remove with recompute; recurring invoices (12h generator, copies lines, advances dates); email/bulk-email (success only after SMTP); CSV import (invoices, contacts); money flows CRUD; bank txn editing; exports (invoices/contacts/flows/contracts/kyc/audit); dunning reminders (scheduled, cooldown tracked).

## Next move
Ship the unmatch fix; add the dedup "skipped" notice; then make these three the deep, tested core (see docs/PLAN-narrow-and-deepen-2026-06-05.md).
