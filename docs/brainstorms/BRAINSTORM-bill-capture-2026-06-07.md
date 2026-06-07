# Carbon — Supplier bill capture brainstorm (2026-06-07)

Read-only brainstorm. Topic: how we **upload + add cost invoices (supplier bills)** — the capture →
entry → attachment → AP/ledger workflow. Source reviewed: `public/index.html` (invoice/bill dialog
~L932-970, Invoices & Bills tab ~L316-367), `public/app.js` (`saveInvoice`, `openInvoiceDialog`),
`server.js` (invoice POST/PUT + `postInvoiceFull` AP posting, bank-match), `db/schema.sql` (`invoices`).

---

## TL;DR — the gap is CAPTURE, not posting

Posting already works: a bill posts correctly to **Accounts Payable + Input VAT**, shows in AP aging,
and can be paid/reconciled. The pain is getting the bill *in*: today, adding a supplier bill means
**re-typing their PDF, by hand, into the same editor you use to issue your own invoices** — and Carbon
can't even **store the original file** (contracts and KYC can attach files; bills can't). The original
supplier document lives nowhere in the system.

The path, in order of value-to-effort:
1. **Attach the original file to a bill** (foundation — reuses existing upload infra).
2. **Vendor-first prefill + show the file beside the form** (fast manual entry, no AI).
3. **Drop the file → it reads the fields → fills a draft bill for you to confirm** (the big lever).

---

## How a bill works TODAY (grounded)

- **Entry:** Invoices & Bills tab → "+ New bill" / "Record a bill" opens the **same invoice dialog**
  flipped to direction **"Bill (you owe)"**. You hand-type: vendor (contact), supplier's number
  (`external_number`), entity, issue + due date, currency + FX, line items with tax rate, notes.
- **Posting:** on save it posts to the ledger — **DR Expense + DR Input VAT / CR Accounts Payable** —
  and appears under the **Bills (AP)** filter + AP aging.
- **Paying it:** record a payment, OR **match a bank transaction** to it (bank-match reconciliation
  already exists). Period lock + audit trail apply.
- **Missing entirely:**
  - **No file attachment on bills** — you cannot keep the supplier's PDF/photo with the bill.
  - No upload, no auto-extraction, no email-in, no duplicate check.
  - The bill editor's split-pane shows an *outgoing-invoice* preview — meaningless for a bill you
    received (you're not issuing it), so that screen space is currently wasted on the purchase side.

---

## The capture approaches (escalating effort)

### A. Attach-the-file — the foundation *(small)*
Let a bill carry the original document: drag/drop or pick the supplier's PDF/photo. Reuse the **exact
contract/KYC upload pattern** plus the upload pipeline just hardened in the audit (25 MB cap, safe
inline/attachment serving, path-safe storage). Even if entry stays manual, this alone fixes "the
original lives nowhere" — you get the source-of-truth doc + audit beside every bill. **Highest
value-to-effort; everything below builds on it.**

### B. Faster manual entry *(small–medium)*
- **Vendor-first:** pick the supplier → prefill their usual currency, payment terms (due date),
  default expense category + tax rate from their last bill.
- **Show the file beside the form:** repurpose the editor's split-pane (useless for purchases today)
  to display the uploaded supplier file next to the fields, so you read off the image — not a second
  window. Tax presets (0 / standard).

### C. Upload → auto-extract → draft bill *(the big lever; medium–large)*
Drop the PDF/photo → read it and propose **vendor, supplier number, dates, currency, subtotal, tax,
total** (and ideally line items) → prefill a **DRAFT** bill for one-tap review/correct → post.
- **Engine options:** (i) an **AI model reads the document** (e.g. Claude with PDF/vision) and returns
  structured fields — flexible, no per-vendor templates; (ii) a **dedicated invoice-OCR API**
  (Mindee / Veryfi / Textract / Azure) — purpose-built accuracy.
- **Trade-offs:** AI-read = one dependency + a per-document cost, handles any layout, must be reviewed.
  OCR API = strong accuracy but another vendor + cost. For this team's volume, **AI-read → human
  confirm** is the sweet spot.
- **Guardrail:** extraction fills a **draft only** — a human confirms before it ever posts to AP.
  Leave every field editable; show low-confidence fields.

### D. Email-in inbox *(medium–large; convenience)*
A dedicated address (e.g. bills@…) — forward the supplier's email → Carbon ingests the attachment →
creates a draft bill (with C's extraction) waiting for review. Removes the download-then-upload step.
New **inbound** email infra (Carbon only *sends* today); could lean on a mail-in service.

### E. Bulk drag-drop queue *(medium)*
Drop 10 PDFs → a "to-process" queue of pre-extracted draft bills; swipe through and confirm. Good for
month-end catch-up.

---

## Cross-cutting (applies to all approaches)

- **Vendor linking:** match to an existing supplier contact or quick-create; remember per-vendor defaults.
- **Multi-currency + Input VAT:** already modelled — extraction just fills currency + tax; FX-to-base
  reuses existing logic.
- **Duplicate-bill guard:** warn on same vendor + supplier number (or vendor + amount + date) — stops
  paying a bill twice. Cheap, high value.
- **Draft → review → post:** never auto-post an extracted bill; AP accuracy comes first.
- **Payment + reconciliation:** existing bank-match ties the bill to the real outflow — nothing new.
- **Audit + period lock:** already enforced (incl. the recent hardening).
- **Storage/security:** reuse the hardened attachment pipeline; treat supplier docs as KYC-grade.

---

## Recommended shape + first slice

1. **Attach-the-file on bills (A)** — foundation; mirrors contract/KYC infra; small lift.
2. **Vendor-first prefill + file-beside-the-form (B)** — makes manual entry fast with **zero AI**.
3. **Upload → AI-extract → draft for confirm (C)** — the speed lever; gated behind human review.

Email-in (D) and bulk queue (E) are follow-ups once 1–3 prove out.

A satisfying **first slice** = A + B: you can drop the supplier's file onto a bill, see it next to the
form, and type fast with vendor defaults — no new external dependency, immediate value, and it lays the
rails for the AI-extract step.

---

## Decisions needed from Ben

1. **Extraction engine:** AI-read (Claude/vision) vs a dedicated invoice-OCR API vs none-for-now?
   *(Recommend: ship attach + manual first, then AI-read with human confirm.)*
2. **Auto-post vs always-draft** for extracted bills? *(Recommend always-draft — unread numbers never
   hit the books.)*
3. **Email-in** worth building, or is drag/drop upload enough? *(Recommend drag/drop first.)*
4. **Duplicate-bill guard:** warn-only or hard-block? *(Recommend warn.)*
5. **Attached bill files** on the same data volume as KYC/contracts? *(Recommend yes — same hardened
   pipeline.)*
