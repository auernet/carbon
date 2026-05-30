# Carbon — Considered & Rejected Log

Newest entries on top. Never delete — old rejections are "we already tried that" references.

---

## 2026-05-30 — Dashboard design Option B (KPI tiles)

**Context:** `/preview` flow for the "make the dashboard nicer" request; one of three mocked options.

**The idea:** Turn every metric into its own bordered `panel-2` tile — a 2×2 grid of tiles per entity card, and 6 tiles across the consolidated strip. A structured "analytics dashboard" look.

**Why it lost:** Too many boxes — 6 consolidated tiles + 4 per entity × N entities reads busy and heavy. Option A (Refined) conveyed the same data with less visual noise.

**Could we revisit?** Maybe later — if the dashboard grows many more metrics and needs stronger per-metric separation.

---

## 2026-05-30 — Dashboard design Option C (Branded / bold green)

**Context:** `/preview` flow, third mocked option.

**The idea:** Green gradient wash on cards, green left-accent border, entity codes enlarged, and metric labels (CASH, REVENUE YTD…) recolored green.

**Why it lost:** The green metric labels lowered legibility — for a numbers tool, label contrast matters more than brand flourish. Green is better reserved for primary accents (entity code, section header) only.

**Could we revisit?** No on green labels (load-bearing legibility). The green-accent header idea partly lives on in Option A.

---

## 2026-05-30 — Green section titles on every dashboard card

**Context:** Implementing Option A; deciding how to style `.dash-card h3` (the 11 lower-dashboard list-card titles).

**The idea:** Make all `.dash-card` titles accent-green to echo the hero's green section label.

**Why it lost:** 11 green titles is too much green and flattens hierarchy. Used muted titles with a thin bottom divider instead — echoes the hero's dividers without over-coloring.

**Could we revisit?** No — restraint is intentional. Green stays on primary labels only.
