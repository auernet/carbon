# Brief: bills-ship — make the bill-capture batch live

**Problem.** Five commits (bill attachments, vendor prefill, duplicate guard, bulk queue, AI
document reading) are on `origin/main` but carbon.aa.ag still serves the previous build —
Carbon's deploy is MANUAL (push ≠ live).

**Locked decisions carried forward**
- Deploy path: Coolify UI **Redeploy** in the logged-in browser (token NOT in keychain; the
  API 401s with a session cookie). Coolify: http://83.228.220.166:8000 → Projects → Carbon →
  carbon app → Redeploy. App UUID `f4kgsgckgw408co0440kso40`.
- Never claim "live" without verifying the new asset on prod (rule from 2026-05-30).
- AI keys stay encrypted server-side; 'subscription' engine is an honest no-op on prod.
- Container now runs non-root via the gosu entrypoint — this deploy is its first prod build;
  watch the deploy log for boot/permission errors (rollback = Coolify "Rollback" to prior image).

**Steps**
1. `git -C ~/Dev/Carbon log origin/main..HEAD --oneline` → must be empty (push first if not).
2. Trigger Redeploy via the Chrome connector (path above). Build takes ~2-3 min.
3. Poll `https://carbon.aa.ag/app.js` until it contains `invoice-read-file` (new symbol in
   this batch). 15s interval, ~12 min timeout, background.
4. Verify: `/healthz` ok with RESET uptime (new container); statements page still redirects
   (302) logged-out; login via preview/browser → Settings → AI reading panel renders; a bill
   dialog shows "Attached files" + (with a file) "Read & fill from file".
5. Report in plain English, then list Ben's manual items: paste Anthropic key (Settings → AI
   reading) for live bill reading; rotate admin password (`BOOTSTRAP_ADMIN_*` env in Coolify);
   rotate Coolify token → keychain; set `CARBON_BACKUP_POSTHOOK` for off-site backups.

**Success criteria**
- Prod app.js serves the new symbol; healthz ok; no boot errors in the Coolify deploy log;
  data intact (entities/invoices render); AI panel + attach UI visible on prod.

**TODO (later sessions, not this one)**
- OpenAI engine wiring; email-in bills; Reports/Settings card polish via /preview.
