# Carbon — review rules (for the code-review gate)

Carbon is a local-first ERP for a 3-person team — entities, contacts, invoices,
bills, banks, money flows, contracts, KYC, reports, audit log. Stack: vanilla
**Node/Express + better-sqlite3**, NO build step; single backend file `server.js`;
vanilla-JS frontend in `public/` (`index.html` + `app.js` + `style.css`). It holds
real money + KYC data, so correctness and honesty matter. Enforce the rules below;
the global honest-software rules apply on top.

## Boot & runtime traps (vanilla SPA — one throw blanks everything)
- **`app.js` `init()` is boot-critical: a single early throw blanks the WHOLE app**
  (no framework, no error boundary). Flag new boot-path code that can throw before
  render — unguarded DOM lookups, `JSON.parse` of localStorage, assuming an element
  exists — and **event listeners wired before their handler is defined**.
- **No native `confirm()` / `alert()` / `prompt()`** — they were replaced with
  styled in-app dialogs. Flag any reintroduction.
- **Panel show/hide must fully reset state.** Hidden panels staying laid out, or
  stuck permanently open, has regressed more than once — flag a toggle that hides
  without clearing the layout/open state.

## SQLite / better-sqlite3 (synchronous; migration order bites)
- **better-sqlite3 is synchronous.** Flag `await` / Promise-wrapping of db calls and
  `async` transaction callbacks — it breaks atomicity and signals a wrong mental model.
- **Use prepared statements with bound params** (the codebase has ~300 `.prepare()`
  calls). Flag string-interpolated SQL — injection risk and a break from convention.
- **Migration order: indexes, `ALTER`s, and FKs run AFTER their `CREATE TABLE`
  block.** This exact ordering bug has shipped twice. Flag a migration that references
  a table or column before it is created.

## Money & data integrity (it's an accounting system)
- **Money is integer cents.** Amounts are stored ×100 and rounded (`Math.round`),
  formatted with `toFixed` only at display. Flag float arithmetic on money, new
  `parseFloat` on amounts, or persisting a non-integer amount — rounding drift here
  is a real defect, not a nit.
- **Mutations write an audit entry capturing the real actor.** Flag a new
  create/update/delete path that doesn't record an audited event with its actor.
- **`data/` is sacred** — the live DB, encryption key, and bootstrap admin live there
  (gitignored). Flag code that moves/renames/deletes under `data/`, or anything that
  could commit its contents.

## Security & auth
- **Don't break the login-id contract** — bare username OR email is accepted, and the
  bootstrap admin must keep working. Flag changes that narrow this or that log/hardcode
  credentials.
- **No secrets in code or logs** — tokens (including the Coolify deploy token) and the
  encryption key come from env / `data/`, never literals. KYC and bank fields are
  sensitive; flag a new endpoint that returns them without an auth check.

## UI / theming ("Refined" design language)
- **Token-based theming via `data-theme` (dark + light).** Flag hardcoded colors that
  bypass the CSS variables — they break one of the two themes. Accent green
  (`--accent`) is for **primary** labels only (entity codes, section headers), never
  every label.

## Ops
- **Push ≠ live.** Deploy to carbon.aa.ag is a MANUAL Coolify trigger. Flag code or
  comments that assume a push auto-deploys, or a "deployed/live" claim with no verify.
- **Docker bind mount: copy, don't rename across `/app/data`** — rename across the
  mount fails (the restore bug). Flag an `fs.rename` that crosses the data bind mount.
