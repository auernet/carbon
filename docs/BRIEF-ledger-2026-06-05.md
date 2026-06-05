# Carbon — Double-entry Ledger — Build Brief — 2026-06-05

Reference: ported the shape from SPRKS's "accounting universal fabric" (one balanced entries table + a 5-category chart of accounts). SPRKS's scars to avoid: no persistence, toast-only buttons, one-sided "deposit" postings that made money vanish, forced DR=CR hacks, hardcoded FX. Carbon must persist (SQLite ✓), post BOTH sides always, and enforce balance server-side.

## Data model (SQLite)
**chart_of_accounts** — `code` (PK, e.g. 1100), `category` ('A'|'L'|'Eq'|'I'|'E'), `name`, `entity_id` (nullable = shared), `currency` (nullable), `display_order`, `archived`.

**ledger_entries** — the universal table. One business event = ≥2 rows sharing a `txn_id`, summing to balanced:
`id`, `entity_id`, `txn_id` (groups the paired rows), `event_date`, `account_code` (FK → chart), `direction` ('debit'|'credit'), `amount` (>0, entry currency), `currency`, `amount_base` (amount × fx → entity base ccy, for the trial balance), `description`, `source_table`, `source_id` (e.g. invoices/42), `created_at`. Unique on (source_table, source_id, account_code, direction) so posting is idempotent (safe backfill / no double-post).

**Invariant (enforced in postLedger()):** per txn_id, Σ debit.amount_base == Σ credit.amount_base, else throw — never write an unbalanced event.

## Starter chart of accounts (seeded on boot if empty)
- 1000 Cash · 1010 Bank · 1090 Undeposited funds (payment clearing)
- 1100 Accounts receivable · 1200 Input VAT (tax receivable)
- 2000 Accounts payable · 2100 Output VAT (tax payable)
- 3000 Owner's equity / retained earnings
- 4000 Revenue · 5000 Expenses · 7000 FX gain/loss
(Per-entity copies via entity_id; codes shared.)

## Posting rules (each event self-balances)
- **Sales invoice issued** (direction=sales, not draft): DR 1100 AR (total) · CR 4000 Revenue (subtotal) · CR 2100 Output VAT (tax_total).
- **Invoice payment** (sales): DR 1090 Undeposited (amount) · CR 1100 AR (amount).
- **Purchase invoice / bill** (direction=purchase): DR 5000 Expense (subtotal) · DR 1200 Input VAT (tax) · CR 2000 AP (total).
- **Bill payment:** DR 2000 AP · CR 1090/1010.
- **Money flow** (income): DR 1010 Bank · CR 4000 Revenue. (expense): DR 5000 Expense · CR 1010.
- **Bank transaction:** DR/CR the bank account's GL + contra; if matched to an invoice, the contra is 1100 AR.
- **Void/delete:** post the reversing entry (don't delete history).

## Phases
1. **Foundation + AR cycle (THIS build):** schema, chart seed, `postLedger()` with the balance invariant, auto-post sales invoices + payments, backfill existing rows, read + trial-balance endpoints. Verify trial balance nets to zero.
2. **Extend coverage:** purchase/bills, money flows, bank transactions (per-bank GL accounts), FX gain/loss on settlement.
3. **Ledger UI tab:** per-account running balance, trial balance, P&L + balance sheet from the chart, manual journal entries (DR=CR enforced) for adjustments.

## Out of scope (for now)
Crypto/metals, period close + "official mode", multi-entity consolidation, accruals/depreciation schedules.

## Note
The existing Audit log is a *change* log, not this financial GL — they stay separate.
