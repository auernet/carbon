# Carbon — Narrow & Deepen plan — 2026-06-05

## Why it currently feels like "AI slop"
- **Breadth over depth:** 12 modules/tabs, but the DB is near-empty — 2 entities, 1 invoice, 1 contact, 0 money flows / bank txns / contracts / KYC / tasks. Built to *look* complete, not shaped by real use.
- **Fragile + untested:** two ~4,400-line files, zero automated tests — a one-line ordering slip blanked the whole app in prod and went unnoticed.
- **Half-wired edges:** ~18 TODO/placeholder markers; the Aspire bank adapter was coded against *assumed* API docs and never run.

## The principle
Pick the 2–3 workflows the 3-person team actually does, make those genuinely excellent and reliable, and **hide everything else until real use earns it.** Depth + reliability over breadth.

## Tiers
**Core — keep + deepen (the spine):**
1. Invoices / AR — issue, track, get paid. (Audit: solid.)
2. Money Flows — cash in/out + runway.
3. Bank reconciliation — import + match. (Unmatch bug fixed 2026-06-05.)
- Dashboard sits on top as the cockpit over these three.

**Tier 2 — keep, thin, deepen only when used:** Contacts (needed by all), Entities, Reports.

**Tier 3 — hide behind an "Advanced/More" section until earned:** KYC, Contracts, Webhooks, API credentials + sync (incl. Aspire until tested against the real API), Tasks.

## Hardening backbone (so it stops feeling fragile)
- ✅ Boot error boundary — a single uncaught error now shows a banner instead of a silent blank (done 2026-06-05).
- **Add a smoke test:** headless load of the dashboard + each core tab, asserting it renders with no console error. This would have caught the blank-dashboard bug before deploy.
- **Pre-deploy gate:** `node --check` + the smoke test before any Coolify deploy.
- **Opportunistic split:** carve the 4,400-line files into modules as each core area is deepened — not a big-bang refactor.

## Data-first
The design only gets good once it's pressure-tested by **real data**. Load real entities/invoices, and wire the **Aspire bank feed** (the unlock for real bank data) once Jun provides API access + credentials.

## Sequenced next moves
1. Fix the 2 audit findings — unmatch bug (✅ done); add a "N duplicates skipped" notice on bank CSV import.
2. Add the core-tabs smoke test + make it a pre-deploy gate.
3. Hide Tier-3 tabs behind "Advanced".
4. Wire Aspire for real → real bank data flowing in.
5. Deepen invoices/flows/bank with real data driving the polish.
