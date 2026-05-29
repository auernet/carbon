# Carbon — critical brainstorm (2026-05-25)

Local-first company management software for **HWG (Honorwell Group Ltd, HK)** and **Meridian (Meridian Ventures L.L.C-FZ, Dubai Meydan)**. Sole operator: Ben. Scope: general admin, invoicing, banking, KYC, money flows, suppliers/customers, contracts. Future jurisdictions.

Project root: `/Users/ben/Dev/Carbon/` (empty). Related context: `/Users/ben/Downloads/Honorwell & Meridian/` (websites + corporate docs already live).

---

## The core critical question: build vs. configure

For a **sole operator** running **two entities**, "build a company management platform" is almost always the wrong frame. The bottleneck is not software absence — it's operator time. Building Carbon is a 12–18 month side project even at MVP. Configuring an existing local-first system is a weekend.

### Existing local-first / self-hostable systems that already cover most scope

| Tool | License | Local-first? | Multi-entity | Multi-currency | KYC/Contracts | Notes |
|---|---|---|---|---|---|---|
| **Manager.io** | Free (desktop) / paid (server) | Yes — SQLite, no cloud | Yes (free for unlimited businesses) | Yes | No native, but custom fields work | Closest match. Active dev. |
| **ERPNext** | MIT | Self-host Docker | Yes (multi-company) | Yes | CRM + Contracts module exist | Heavier; needs server. |
| **Akaunting** | Open source PHP | Self-host | Yes | Yes | Apps marketplace | Web stack overhead. |
| **GnuCash** | GPL | Yes | Awkward | Yes | No | Accounting only. |
| **Holded / Odoo Community** | Various | Self-host Odoo | Yes | Yes | Yes (Odoo has KYC apps) | Odoo CE is the heavy-but-real option. |

If "Carbon" must be bespoke, the real value-add over Manager.io has to be **(a) KYC/AML workflow**, **(b) per-jurisdiction compliance bundles**, or **(c) cross-entity money-flow visualization** — because the accounting plumbing is already solved.

---

## Jurisdictional reality check (the "generalize later" trap)

HK and UAE differ enough that "build for HK first, generalize later" usually breaks. They need to be **plugins from day 1**, or you'll refactor everything on the second jurisdiction.

### Hong Kong (HWG)
- **No VAT/GST.** No sales-tax fields on invoices.
- **Profits Tax:** 8.25% on first HKD 2M, 16.5% above.
- **BR number** must appear on invoices (Business Registration).
- **Significant Controllers Register (SCR)** required — kept locally, produced on demand.
- **Audit:** statutory annual audit by HK CPA. Need clean export to auditor format.
- **Record retention:** 7 years.
- **Currency:** typically HKD or USD; invoicing in either is fine.
- **Companies Registry annual return** (NAR1) + IRD profits tax return.

### UAE / Meydan Free Zone (Meridian)
- **VAT 5%** — mandatory registration above AED 375k turnover, voluntary above 187.5k. If registered, TRN goes on every invoice; specific Arabic/English bilingual field requirements.
- **Corporate Tax 9%** on profits >AED 375k (since June 2023). Free-zone companies can qualify for 0% on qualifying income but must still file.
- **E-invoicing mandate:** UAE PINT-AE format rolling out 2026 — design must accommodate.
- **Economic Substance Regulations (ESR):** annual notification + report for relevant activities.
- **UBO Registry:** beneficial-owner register filed with authority.
- **AML for free-zone entities:** tightened post-FATF; KYC files per counterparty with refresh schedule.
- **Record retention:** 5 years (15 for real-estate transactions).
- **Currency:** AED primary; USD/EUR common.

### Implication
Chart of accounts, tax codes, invoice template, filing calendar, and retention rules are **per-jurisdiction**. The right shape:

```
/jurisdictions/
  hk/   { coa.json, tax-codes.json, invoice-template.html, calendar.yaml, retention.yaml }
  ae/   { ... }
```

Entity record → references one jurisdiction bundle. Adding NL/SG/etc. = adding a folder, not patching code.

---

## Critical critiques of stated scope

### 1. "Banking" — what does this actually mean locally?
Without licensed bank-API access (Plaid/TrueLayer/regional equivalents, all paid), "banking" reduces to:
- CSV / CAMT.053 / MT940 statement import
- Manual reconciliation against AR/AP
- Multi-currency cash positions
- FX gain/loss tracking

That's fine — call it "**bank reconciliation**," not "banking." Setting expectations matters; "banking" sounds like payment initiation, which requires PISP licensing in EU/UK or equivalent elsewhere.

### 2. "KYC" — workflow, not document storage
The risk is building a glorified file-cabinet. Real KYC value:
- Counterparty record with risk score (low/medium/high)
- Required-document checklist per risk tier
- Refresh schedule (e.g., high-risk re-verify every 12 months)
- Source-of-funds narrative field with audit trail
- Sanctions/PEP screening — even a periodic export-to-OpenSanctions check
- Audit log: who changed what, when (immutable)

If it's just "drag PDFs into a folder," `Finder` already does that.

### 3. "Local-first" — bus factor 1 + total data-loss risk
Single-operator + local-only + regulated data = high risk. Mitigations:
- **Encrypted at rest** (SQLCipher or full-disk + filesystem encryption)
- **Automated encrypted backup** to ≥2 destinations (e.g., encrypted Backblaze B2 + USB SSD)
- **Append-only audit log** — never overwrite, only insert
- **Export-anytime** to neutral formats (CSV, PDF, JSON) — so the data survives the app
- KYC/contract PDFs: store hash + path, not blob, so backup is sane

### 4. "Contracts" — register, not editor
Don't build a contract editor. Build a register:
- Counterparty, contract type, effective/expiry dates, auto-renewal flag
- Linked PDF (hash + path)
- Renewal alert horizon (e.g., 90 days)
- Linked KYC record
- Linked AR/AP terms (payment days, currency)

### 5. "Money flows" — the genuinely novel piece
This is where Carbon could justify existence. Standard accounting shows ledgers; **cross-entity flow** between HWG ↔ Meridian (intercompany, capital movements, dividend repatriation) is where off-the-shelf tools get clumsy. A graph view:

```
[Client X] → invoice → [HWG] → intercompany transfer → [Meridian] → supplier payment → [Vendor Y]
```

with FX conversion at each hop, ESR/transfer-pricing implications flagged. **This** is worth building. Everything else is reinventing wheels.

---

## If Ben insists on building Carbon: minimum viable shape

### Stack (lean, sole-operator, no server)
- **Tauri** (Rust + web frontend) for cross-platform desktop app, small binary, local SQLite
- **SQLite + SQLCipher** for encrypted local DB
- **TypeScript + React** (or Svelte) for UI — Ben already has web-stack familiarity from HWG/Meridian sites
- **Append-only event log** table behind every entity write
- **Backup daemon**: nightly encrypted tarball → configured destinations
- **No** web server, no auth complexity (single user, OS-level lock)

### Data model (sketch)
```
entities          (id, name, jurisdiction, currency, br_or_trn, ...)
jurisdictions     (config bundle — see above)
counterparties    (id, type=customer|supplier, risk_tier, ...)
kyc_records       (counterparty_id, status, refresh_due, source_of_funds, ...)
kyc_documents     (kyc_id, doc_type, file_hash, file_path, uploaded_at)
contracts         (id, counterparty_id, entity_id, type, effective, expiry, auto_renew, file_hash)
invoices          (id, entity_id, counterparty_id, currency, lines, tax_lines, status)
bank_accounts     (id, entity_id, bank, account_no, currency)
bank_transactions (account_id, date, amount, currency, raw_description, matched_invoice_id?)
journal_entries   (id, entity_id, date, lines [debit/credit])
money_flows       (from_entity, to_entity, amount, currency, kind, ref_journal_id)
audit_log         (table, row_id, actor, action, before, after, ts) — append-only
```

### MVP scope (4 weeks, focused)
1. Two entities (HWG, HKD; Meridian, AED) seeded with their CoA
2. Counterparty + KYC register with document attach
3. Invoice issue (PDF) — HK template (no VAT) and UAE template (5% VAT, TRN, bilingual fields)
4. Bank CSV import + manual reconciliation
5. Contract register with renewal alerts
6. Money-flow graph (the differentiated piece)

Everything else (tax filing automation, e-invoicing PINT-AE submission, sanctions screening) = post-MVP.

### MVP scope (1 weekend, configure-don't-build alternative)
1. Install Manager.io. Set up HWG and Meridian as separate businesses.
2. Configure HK CoA + UAE CoA + tax codes.
3. Build templates: HK invoice (no VAT, BR), UAE invoice (5% VAT, TRN bilingual).
4. Notion/Obsidian database for KYC + contracts register, with links to Manager.io.
5. Encrypted backup of Manager.io data folder + Notion export to B2.
6. Total time: ~16 hours. Total cost: $0.

---

## Decisions needed before any building starts

1. **Build vs. configure** — have existing tools (Manager.io, ERPNext, Odoo CE) been tried and found wanting, or is "build" axiomatic?
2. **Solo or future team** — is this Ben-only forever, or will a bookkeeper/accountant ever log in? (Changes auth + concurrency.)
3. **Auditor handoff format** — what do the HK auditor and UAE auditor actually want? (Drives export schema.)
4. **VAT-registered status of Meridian** — under or over AED 375k threshold? (Drives whether VAT module is critical-path or future.)
5. **Existing accounting** — what is HWG/Meridian bookkeeping done in *right now*? (Manager.io? Spreadsheets? Accountant's QuickBooks?)
6. **Data-loss tolerance** — willing to accept "if my laptop dies, I restore from B2 backup" or want sync to a second device?
7. **Timeline** — is this "ship in a month" or "evolve over a year"?

## Recommended next move

Before writing a line of Carbon code: spend one evening with **Manager.io** loaded with HWG + Meridian dummy data. Identify the **specific friction** that justifies bespoke. Then scope Carbon to *only* that friction (likely: cross-entity money-flow + jurisdiction-aware KYC workflow). Wrap, don't replace.
