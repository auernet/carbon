# Carbon — Considered & Rejected Ideas

Alternatives explored and rejected, with reasoning. Newest on top. NEVER delete entries — old rejections are useful "we already tried that" references.

---

## 2026-06-10 — Ben's Claude subscription as the live site's AI engine

**Context:** AI document reading for bills ("we can use the local ai subscription no?").

**The idea:** Have carbon.aa.ag read bills using Ben's flat Claude subscription instead of a
pay-per-use API key.

**Why it lost:** A deployed server can't authenticate as a consumer subscription; that
subscription powers local/chat use (Claude Code). The honest design shipped instead: engine
selector defaults to 'subscription' (free, local-only, clear error on the server) and the live
site uses an Anthropic API key (~pennies per bill, encrypted in settings).

**Could we revisit?** Maybe later — if an official server-side subscription auth path ships, or
a Claude agent is installed on the VPS to process a queue locally.

## 2026-06-10 — Wire the OpenAI (GPT) engine now

**The idea:** Implement OpenAI extraction alongside Anthropic in the bill reader.

**Why it lost:** Ben needs one working engine; the key slot is stored (encrypted) and the
engine returns an honest "not wired yet" instead of placebo. Revisit when Ben asks to use it.

## 2026-06-10 — Email-in bill inbox

**The idea:** Forward a supplier email to bills@… → auto-creates a draft bill.

**Why it lost:** Carbon only *sends* mail today; inbound needs new infra (mail-in service,
parsing, security). Drag-drop + bulk queue + AI read cover the volume. Revisit after the
attach/AI flow proves out in daily use.

## 2026-06-10 — Hard-block duplicate bills

**The idea:** Refuse to save a bill whose vendor + supplier-number already exists.

**Why it lost:** Legit re-issues/corrections exist; a hard block punishes the honest case.
Shipped warn-and-confirm instead. Load-bearing: keep warn-only.

## 2026-06-10 — Transaction-wrap the whole migration block / schema_version table

**Context:** Audit flagged migrations as unguarded.

**The idea:** One big transaction around boot migrations plus a version table.

**Why it lost:** Every statement is already idempotent (guarded ALTER / IF NOT EXISTS), so a
crash mid-sequence resumes safely; a full wrap is high-risk/low-value churn. Shipped loud,
actionable failure logging instead. Revisit only if a non-idempotent migration becomes necessary.

## 2026-06-10 — Delete the "dead" dashboard counter CSS (audit false positive)

**The idea:** The audit's design pass flagged the counter styles as orphaned and removable.

**Why it lost:** Verified live — the dashboard renders those classes. FALSE POSITIVE; do not
remove. (General lesson logged: verify "dead code" findings against the running app first.)

## 2026-06-06 — Budgets / budget-vs-actual

**The idea:** A budgets subsystem — set a planned number per category, show actual vs plan.

**Why it lost:** Ben declined directly ("don't need this"). For a 3-person team that mostly
*records* what happened (which the ledger now does), budgets are control machinery they don't
need yet. Revisit only if Ben asks to start controlling spend against targets.

## 2026-06-06 — Full consolidated balance sheet (group)

**The idea:** A single group balance sheet across all entities, converted to one currency.

**Why it lost:** Entities use different base currencies (HKD, AED). FX translation knocks the
Assets = Liabilities + Equity identity out of balance — correct accounting needs a
currency-translation-adjustment (CTA) plug. Too much for the value. Shipped a USD *summary*
(net profit + cash per entity + group total) instead, which sidesteps the balancing problem.

## 2026-06-06 — Migrate ledger money to integer cents

**The idea:** Store ledger amounts as integer cents (×100), per the `AGENTS.md` money rule
the ship gate cited.

**Why it lost:** That rule is SPRKS-derived; Carbon's entire codebase uses `REAL` floats.
Converting only the ledger would make it inconsistent with invoices/flows. See
locked-decisions 2026-06-06. Would only make sense as an app-wide migration if Ben wants it.

## 2026-05-30 — Dashboard design: Option B (KPI tiles)

**Context:** `/preview` flow for "make the dashboard nicer"; one of three mocked options.

**The idea:** Every metric in its own bordered `panel-2` tile — 2×2 per entity card, 6 across the consolidated strip. Structured "analytics" look.

**Why it lost:** Too many boxes (6 + 4×N) — busy and heavy. Option A (Refined) showed the same data with less noise.

**Could we revisit?** Maybe later — if the dashboard grows many more metrics needing stronger per-metric separation.

---

## 2026-05-30 — Dashboard design: Option C (Branded / bold green)

**Context:** `/preview` flow, third mocked option.

**The idea:** Green gradient wash on cards, green left-accent border, enlarged entity codes, and metric labels recolored green.

**Why it lost:** Green metric labels lowered legibility — for a numbers tool, label contrast beats brand flourish. Green belongs on primary accents only.

**Could we revisit?** No on green labels (load-bearing legibility); the green-accent header partly lives on in Option A.

---

## 2026-05-30 — Green section titles on every dashboard card

**Context:** Implementing Option A; styling the 11 lower-dashboard `.dash-card` titles.

**The idea:** Make all `.dash-card` titles accent-green to echo the hero's green section label.

**Why it lost:** 11 green titles = too much green, flattens hierarchy. Used muted titles with a thin divider instead.

**Could we revisit?** No — restraint intentional. Green stays on primary labels only.

---

## 2026-05-29 — Modify auth to accept bare usernames (not email-shaped)

**Context:** Ben asked "better use usernames for them just Jun and Raphael". Carbon's `/api/users` enforces `isValidEmail()` so plain "jun" / "raphael" rejected.

**The idea:** Change `isValidEmail()` to also accept bare usernames, change `login.html`'s `<input type="email">` to `type="text"`, change all references in display logic to handle the no-`@` case.

**Why it lost:** Multi-file code change in an operations session focused on deployment. Email-shaped identifiers with simple display names (`jun@aa.ag` displayed as "Jun") give the username experience without touching auth code. Picked the lower-risk path.

**Could we revisit?** Yes — if Ben strongly prefers bare login (e.g. for a future external user-facing flow), this becomes a dedicated sweep with proper validator changes + login form rework.

---

## 2026-05-29 — Coolify `custom_docker_run_options` for volume mount

**Context:** First attempt at persistent storage for `/app/data` on prod. Set `custom_docker_run_options: -v carbon-data:/app/data` (named volume), then `-v /var/lib/coolify/carbon-data:/app/data` (host bind).

**The idea:** Use Coolify's free-form docker-run flags field to attach a volume without going through the Persistent Storage UI.

**Why it lost:** Coolify uses docker compose under the hood for the "Restart" cycle, and compose regeneration doesn't carry `custom_docker_run_options` flags. Both attempts looked OK on first deploy (data was there) but were silently wiped on subsequent restarts. The canonical fix is the UI's `Persistent Storage → Directory Mount`, which writes to a separate `persistent_storages` config that DOES get honoured by compose generation.

**Could we revisit?** No — this is a Coolify-internal architectural mismatch. Anyone trying to mount volumes this way will hit the same wall. Stick to the UI/API persistent_storages flow.

---

## 2026-05-29 — Coolify `POST /api/v1/applications/<uuid>/storages` API

**Context:** After the UI click for Directory Mount got cut off by a permission stream close, tried to add the storage entry via API.

**The idea:** Coolify's v4 REST API should have a CRUD endpoint for persistent storages.

**Why it lost:** Endpoint doesn't exist in the public v1 API. Tried both `{"mount_path":...,"host_path":...,"storage_type":"directory"}` and `{"path_in_container":...,"path_on_host":...}` shapes — both returned 404. Persistent storage is only addable through the UI in current Coolify versions.

**Could we revisit?** Yes — Coolify's API expands regularly; check the OpenAPI spec at `http://<coolify>:8000/api/v1/openapi.json` periodically.

---

## 2026-05-28 — Standalone "Expenses" module

**Context:** Sweep #15, looking at what's missing for a small-ERP feature set.

**The idea:** Create a new `expenses` table (separate from `money_flows`) with categories, receipts, approval workflow, and a dedicated tab. Mirror the invoices tab's structure.

**Why it lost:** `money_flows.kind='expense'` already exists, is rendered on the Flows tab, and feeds the Sankey + cash-flow forecast. A separate table would have:
- Duplicated UI surface (two places to record outflows)
- Introduced FK ambiguity (does a contract bill reference `expenses.id` or `money_flows.id`?)
- Required a migration path for any existing kind='expense' flows

Adding `money_flows.category` as a free-text column with datalist autocomplete gave 90% of the value at 5% of the surface area.

**Could we revisit?** Maybe later — if expense approval workflow becomes a real need (multi-step approve→pay state machine), a dedicated table starts to make sense. Not before that.

---

## 2026-05-28 — Project / matter grouping in this sweep

**Context:** Sweep #15, listed in the prior brief as a candidate.

**The idea:** Add `projects` table + `project_id` FK on invoices/contracts/flows for billable work tracking.

**Why it lost:** Deferred, not rejected. Required scoping that wasn't urgent in this sweep, and would have broken the "three small improvements per sweep" rhythm. Listed in HANDOFF §4 as the top next-sweep candidate.

**Could we revisit?** Yes — first sweep after Ben confirms client-billable work is happening (currently HWG/MER are holding companies, not professional services firms).

---

## 2026-05-28 — Sum raw (not ABS) amounts in expense-categories report

**Context:** First implementation of `/api/reports/expense-categories`.

**The idea:** `SUM(amount × fx_rate_to_usd)` to preserve sign convention.

**Why it lost:** Test data showed -1250 USD for a flow entered as amount=-1250, kind='expense'. The same expense entered as +1250 would show +1250. Two valid conventions in active use → report needs to normalize. Switched to `SUM(ABS(amount × fx_rate_to_usd))`.

**Could we revisit?** Only if a single canonical sign convention is enforced via validation on the flow form. Not currently planned.

---

## 2026-05-28 — Cash runway from bank transactions

**Context:** First sketch of the runway calculation.

**The idea:** Use cleared bank transactions over last 90 days as the burn signal.

**Why it lost:** Cleared transactions lag commitments by days/weeks. A runway built on cleared data misses the bill that landed yesterday. Invoices (especially `purchase` direction in any status) capture the forward-looking liability picture better.

**Could we revisit?** A "cleared cash runway" variant alongside the invoice-based one — but only if Ben asks for it. Two-number dashboards are usually worse than one-number dashboards.
