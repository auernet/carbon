# Carbon — Audit hardening + Bills capture Handoff 2026-06-10

**Status: code DONE + tested; bills batch NOT live.** The audit-fix batch (9 commits) IS live
on carbon.aa.ag (verified 2026-06-06, incl. browser check of the fixed password dialog). The
**five bill-capture commits are pushed to origin/main at handoff but await the manual Coolify
Redeploy** — that's the next move (see §6 / `docs/briefs/bills-ship.md`).

## §0 Session at a glance
- Ask 1: *"full in-depth audit"* → 5-dimension audit (security / accounting / frontend / ops /
  design), ~40 ranked findings, top items hand-verified → report at
  `.claude/audits/full-audit-2026-06-06.md`.
- Ask 2: *"pls do all one by one"* → 16 tracked fixes across 8 commits, each batch tested
  (smoke + 30-check hermetic ledger), then `/ship` **without gates** (Ben's explicit call) →
  pushed → Coolify Redeploy driven via Ben's browser ("no pls fix your self") → verified live.
- Ask 3: *"brainstorm how we add cost invoices"* → brainstorm brief → *"pls add all one by one"*
  → built the full bill-capture stack (attachments, vendor prefill, dupe guard, bulk queue).
- Ask 4: *"add gpt + anthropic keys to settings, subscription on by default"* → AI document
  reading: engine selector + encrypted keys + Read-&-fill, honest about subscription limits.

## §1 Commits this session (oldest first)
| hash | title |
|---|---|
| c283e22 | Add full-project audit report (2026-06-06) |
| 1523ed4 | Security: default-deny auth gate, gate DB backup, SameSite=Strict, env admin creds |
| 92b122e | Ledger integrity: balanced FX legs, atomic posting, payment period-lock, missing-rate flags |
| 636e5a2 | Durability: FULL sync + busy_timeout, atomic restore on-volume, non-root container |
| fdb9034 | Frontend: honest save/delete errors, working password dialog, fault-tolerant dashboard |
| 2c6aeb4 | Harden uploads, setup endpoint, and error/health hygiene |
| 39cedf6 | Polish: theme-safe tokens, keyboard focus ring, expense-delta color, aria-label |
| f2229aa | Backups: optional off-site copy hook after each nightly backup |
| 33227b7 | Audit report: mark resolution + remaining manual follow-ups |
| — | *(↑ shipped LIVE 2026-06-06)* |
| 4d5296a | Brainstorm: supplier bill capture |
| 86691ee | Bills: attach the supplier's file, vendor-first prefill, duplicate-bill guard |
| 23b9508 | Bills: bulk-bills queue — file a stack of supplier docs one by one |
| da815e0 | Bills: AI document reading — engine + keys in Settings, Read-&-fill from file |
| — | *(↑ pushed at handoff, NOT yet deployed)* |

## §2 Decisions locked (full text in `.claude/locked-decisions.md`)
| Decision |
|---|
| Auth gate is default-DENY; public routes are an explicit allowlist (token-gated routes register above the gate) |
| Ledger posting runs INSIDE the row transaction, errors never swallowed; AR/AP leg carries the FX-rounding residual |
| Payments enforce period lock (add + delete); deleting a payment can reopen a paid invoice |
| Bills carry attachments (multi-file, KYC-doc pattern); AI-extracted bills are ALWAYS drafts a human confirms |
| AI keys live encrypted in settings, never returned to the client; 'subscription' engine must stay an honest no-op on the server |
| Container runs non-root (gosu entrypoint); session cookie SameSite=Strict |

## §3 Briefs / specs touched
- `docs/brainstorms/BRAINSTORM-bill-capture-2026-06-07.md` (new — the bill-capture exploration)
- `docs/briefs/bills-ship.md` (new at handoff — the ship instructions the relay chip targets)
- `.claude/audits/full-audit-2026-06-06.md` (new — findings + resolution log)

## §4 Open items
1. **SHIP the bills batch** ← the chip's job. Coolify Redeploy + verify (steps in the brief).
2. **Ben-only manual items** (also in auto-memory): rotate live admin password → set
   `BOOTSTRAP_ADMIN_*` in Coolify; rotate the Coolify deploy token → keychain; pick an off-site
   backup destination → set `CARBON_BACKUP_POSTHOOK` (+ tool in image); **paste an Anthropic API
   key in Settings → AI reading** to enable live bill reading; non-root container verifies
   itself on the next deploy (= item 1).
3. OpenAI engine wiring (key slot exists, returns an honest "not wired yet").
4. Deferred: email-in bill inbox; Reports/Settings card-polish via `/preview`; Carbon-native
   `/ship` + `/handoff-go` commands (third session to re-derive SPRKS paths).

## §5 Conversational context (not in any spec)
- **"without using the gates"** — Ben explicitly waived the 3-model review gate for that one
  `/ship`. One-time waiver, NOT a standing preference; default back to the gate next ship.
- **"no pls fix your self"** — when offered browser-vs-Ben for the Coolify Redeploy, Ben wants
  ME to drive it via the Chrome connector. Standing preference for deploys.
- **Subscription-vs-API mental model:** Ben expected his Claude subscription to power the live
  site's AI reading ("we can use the local ai subscription no?"). Resolved honestly: the flat
  subscription powers local/chat use; a deployed server needs a usage API key (pennies/bill).
  The engine selector defaults to 'subscription' but returns a clear error on the live site
  instead of pretending. Watch for this mental model on every future AI feature.
- **Sweep authorization is sticky** — "do all one by one" / "add all one by one" each covered
  the whole list (16 fixes, 7 features) with zero re-asking, and that matched Ben's intent.
- **The audit's "dead .counter CSS" finding was a FALSE POSITIVE** — verified live on the
  dashboard; don't remove it (logged in explorations).
- Bulk-void toast, save-silently-fails, and the dead change-password dialog were the
  user-trust bugs Ben's team would have hit daily — all fixed + browser-verified.

## §6 Resume protocol
1. Read this handoff, then `docs/briefs/bills-ship.md`.
2. `git log -15 --oneline` + `git status` (expect clean, in sync with origin/main).
3. Execute the brief: Coolify Redeploy via the logged-in browser UI → poll
   `carbon.aa.ag/app.js` for `invoice-read-file` → verify AI panel + healthz + no console
   errors → report plainly.
4. Then surface §4 item 2 (Ben's manual list) in plain English.
5. Keep this handoff updated if more lands.
