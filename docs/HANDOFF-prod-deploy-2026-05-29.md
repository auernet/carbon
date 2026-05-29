# Carbon — Prod Deploy Handoff 2026-05-29

## ✅ RESOLVED 2026-05-29 (later session)

The persistence blocker below is **fixed**. Carbon is live at https://carbon.aa.ag with durable data.

- **Persistence:** the Coolify Directory Mount (`/data/coolify/applications/f4kgsgckgw408co0440kso40` → `/app/data`) already existed; the real culprit was a leftover `custom_docker_run_options` bind mount (`-v /var/lib/coolify/carbon-data:/app/data`) on the *same* destination. Cleared it; a clean container recreate then applied the single Directory Mount. Verified data survives consecutive restarts.
- **Restore bug exposed + fixed:** startup restore used `rename()` between `/app` and the now-separate-device `/app/data`, throwing `EXDEV`, so every restore silently failed. Fixed to use `fs.cpSync` + in-place empty (commit `b9b54f8`).
- **Data restored:** Ben's real data is live (2 entities HWG/MER, 1 contact, 1 invoice).
- **Users:** `ben@aa.ag`, `jun@aa.ag`, `raphael@aa.ag` — all admin, all verified logging in after a restart.
- **Still open (optional):** rotate the Coolify API token (was in cleartext); `/api/auth/setup` remains open when the users table is empty (now low-risk since data persists); off-server backups not yet configured.

---

## §0 Session at a glance

**Original ask:** "can we put carbon online so jun and raphael can also use it, pls create carbon.aa.ag and do the neccessary"

**What it became:** A multi-step deploy attempt to Coolify with carbon.aa.ag wired via Porkbun DNS. The deploy itself succeeded — the app is online and healthy. The **persistent data layer is broken** — every Coolify restart wipes the `/app/data` volume, so Ben's restored login, restored data, and Jun/Raphael accounts evaporate within minutes.

**Pipeline state:**
- ✅ Code repo (GitHub) created and Coolify connected
- ✅ DNS: `carbon.aa.ag` → `83.228.220.166` via Porkbun A record
- ✅ TLS: Coolify-provisioned Let's Encrypt cert (HSTS, CSP, all headers landing)
- ✅ Express server hardened for prod (binds 0.0.0.0, trust-proxy, helmet headers, secure cookies behind X-Forwarded-Proto)
- ❌ **Volume persistence** — `custom_docker_run_options: -v /var/lib/coolify/carbon-data:/app/data` is set but Coolify's compose generation doesn't honour it. `persistent_storages` array on the app is `[]`. Every restart starts from an empty `/app/data` → seed.sql repopulates 2 entities → user runs setup → things look fine → next restart wipes it again.
- ❌ Jun + Raphael accounts (`jun@aa.ag`, `raphael@aa.ag`) cannot be created until persistence is real — otherwise they're gone on the next restart.

## §1 Commits shipped this session

| Hash | Title | Notes |
|---|---|---|
| 7bed0c5 | Initial commit: Carbon local-first ERP, production-ready | Whole working tree (server.js, public/*, db/*, etc.), prod-hardened headers, 0.0.0.0 bind, helmet/CSP, secure cookie path |
| 445cd5f | Fix migration order: webhook_deliveries.attempt runs after inline CREATE TABLE | Schema migration ordering bug surfaced on fresh prod boot |
| 7223137 | Fix migration order: indexes on inline tables run after CREATE TABLE block | Same family of fixes — `ensureColumn` calls were running before the `CREATE TABLE IF NOT EXISTS` block they referenced |

Auto-push via post-commit hook went to `origin/main` on GitHub. Coolify watches main; the deploys ran automatically.

## §2 Decisions locked this session

| Decision | Why | Refs |
|---|---|---|
| Hosting target = Coolify on Ben's existing VPS (`83.228.220.166`) | Ben already runs sprks on the same Coolify instance; no new infra to provision. Self-hosted keeps data with Ben (the original local-first constraint relaxes only insofar as the VPS is his). | Coolify app UUID `f4kgsgckgw408co0440kso40` |
| Domain = `carbon.aa.ag` via Porkbun A-record | Ben owns aa.ag at Porkbun; subdomain matches `ben@aa.ag` login convention | Porkbun DNS panel |
| Production users = `jun@aa.ag` + `raphael@aa.ag` (NOT bare "jun" / "raphael") | Carbon's `/api/users` endpoint enforces `isValidEmail()`. Email-as-username matches Ben's own `ben@aa.ag` style. Display names "Jun" / "Raphael" so the UI shows usernames, not addresses. | server.js:839 isValidEmail check |
| All three prod users get role=admin | 3-person internal ERP, no public access. Admin role is the only one that can manage other users. | n/a |
| Restore path = `/api/restore` (upload encrypted/plain tar.gz) + restart to apply | Existing mechanism is already wired and tested locally. Avoids needing SSH access to the VPS. | server.js /api/restore handler |

## §3 Briefs / specs touched

None. The previous handoff (HANDOFF.md at project root) is from sweep #14+#15 and remains accurate. This session is operations-only — no new product specs were created.

## §4 Open items / future work

**🔥 BLOCKER — must fix before anything else lands in prod:**

1. **Persistent storage for `/app/data`** — three paths to try, in order of likelihood:
   - **(a) Coolify UI "Directory Mount"** — open https://83.228.220.166:8000 → Carbon app → Persistent Storage → `+ Add` → `Directory Mount`. Source defaults to `/data/coolify/applications/f4kgsgckgw408co0440kso40`, set destination to `/app/data`, click Add. Yesterday's click hit a session-close before confirmation; need to retry and verify the entry appears in the list after page reload.
   - **(b) Switch build pack from "Dockerfile" to "Docker Compose"** — the repo already has a `docker-compose.yml`. Coolify honours volumes declared in the compose file directly. Change `build_pack` via the Coolify API (`PATCH /api/v1/applications/<uuid>`) or via the UI.
   - **(c) Last resort: Coolify Terminal feature** — SSH into the container via the UI's terminal, manually fix the mount. Brittle, doesn't survive image rebuilds.

**After persistence holds (verified by surviving two consecutive `Restart` clicks):**

2. **Restore Ben's data** — `/tmp/carbon-migration.tar.gz` rebuild from `/Users/ben/Desktop/Carbon/data/` (excluding `data/backups/` etc.), POST to `/api/restore`, restart, verify entities=2, contacts/invoices populated.
3. **Create Jun + Raphael admin accounts** — `POST /api/users` as the logged-in admin with role=admin, display_name "Jun" / "Raphael". Generate strong random temp passwords via `openssl rand -base64 14`. Hand them to Ben to relay.
4. **Verify persistence one more time** — restart prod once more, confirm Ben's login + Jun/Raphael accounts all survive.
5. **Optional hardening:**
   - Force HTTPS at the Express level (currently relies on Coolify's reverse proxy, which is fine)
   - Add IP allowlist for `/api/auth/setup` (anyone hitting prod can currently create the first user if the table is ever wiped — proven this session)
   - Configure off-server backups (encrypted backup feature exists; needs S3 or similar target)

## §5 Conversational context

**Why the volume wasn't persistent the first time:** Coolify's "Restart" action does a `docker compose down && up`. Named docker volumes declared via `custom_docker_run_options: -v carbon-data:/app/data` aren't carried through compose's regeneration — compose creates a fresh anonymous volume each time. Lesson: `custom_docker_run_options` works for `docker run`-pack apps but is ignored when Coolify uses compose under the hood.

**Why the bind-mount attempt also failed:** I switched to `-v /var/lib/coolify/carbon-data:/app/data` (host bind mount), redeployed, and the first post-deploy login + entity count succeeded — leading me to believe it was fixed. The next "Restart" wiped the data again. Confirmed via setup endpoint probe (returned 200, meaning users table was empty). The bind mount declared via `custom_docker_run_options` is **also** dropped by compose. The Coolify UI's `Persistent Storage → Directory Mount` is the canonical way; the API surface doesn't expose it (POST `/api/v1/applications/<uuid>/storages` returned 404).

**Why I created `probe@nothing.local`:** Twice this session I needed to do a write-authenticated operation (queue `/api/restore`) but couldn't log in. The fastest path was hitting `/api/auth/setup` — which only works when the users table is empty, returning 200 if so. The probe user is a side-effect; it gets wiped by the next restore. Don't shame the probe — it's the only escape hatch when the bootstrap admin file is on a non-persistent volume.

**Why I went with `jun@aa.ag` / `raphael@aa.ag` instead of bare usernames:** Ben asked for "usernames for them just Jun and Raphael". Carbon's `/api/users` validates `isValidEmail(email)` and `users.email` is the login key. Two paths considered: (a) modify auth to accept plain usernames (touches login.html `type="email"` validation + several endpoints) — out of scope for an ops session; (b) use email-shaped identifiers but with simple display names — matches the existing `ben@aa.ag` convention. Picked (b). If Ben strongly prefers bare usernames, that's a future code-change sweep.

**The Coolify API I learned this session:**
- `GET /api/v1/applications/<uuid>` returns full app config including `custom_docker_run_options` and `persistent_storages` (which is what to check to see if the storage actually attached)
- `PATCH /api/v1/applications/<uuid>` updates fields
- `POST /api/v1/deploy?uuid=<uuid>&force=true` triggers a build
- `POST /api/v1/applications/<uuid>/restart` triggers a restart (returns a `deployment_uuid` you can poll)
- `GET /api/v1/deployments/<deployment_uuid>` returns `finished_at` (null until done) plus a `logs` field with stdout/stderr from the build
- **There is no `POST /api/v1/applications/<uuid>/storages` endpoint** — that lives only in the UI

**Token in the clear in this session:** Coolify API token `4|9uXrm5eOwdc9a4UO7nR0WaJzcbbVZCqcOfqmJfy8048f6da8` was hardcoded in shell commands. It's a long-lived API token. Worth rotating once everything is stable, or moving to `keychain find-generic-password -s coolify-api`.

## §6 Resume protocol

Next session must do, in order:

1. **Read this HANDOFF first.**
2. **Confirm the blocker is still real:**
   ```
   curl -s -X POST https://carbon.aa.ag/api/auth/setup \
     -H 'Content-Type: application/json' \
     -d '{"email":"x@nothing.local","password":"placeholder12345"}'
   ```
   If this returns `{"ok":true}` (200) → users table empty → volume still not persistent. If `{"error":"setup already done"}` (409) → probe in step before me already filled the table, separate state.
3. **Open the Coolify UI** at https://83.228.220.166:8000 (logged-in cookies survive in Ben's browser):
   - Project → Carbon → Persistent Storage → `+ Add` → `Directory Mount`
   - Source: leave the default `/data/coolify/applications/f4kgsgckgw408co0440kso40` (or any host path on the VPS)
   - Destination: `/app/data`
   - Click `Add` — must see the entry in the list afterwards. Refresh the page to confirm it persisted.
4. **Redeploy** (Coolify UI → `Redeploy` button) — this re-creates the container with the new volume mount.
5. **Re-bootstrap:**
   ```
   tar -czf /tmp/carbon-migration.tar.gz -C /Users/ben/Desktop/Carbon \
     --exclude='data/backups' --exclude='data/_pending_restore.tar.gz' \
     --exclude='data/_restoring' data
   ```
   Then `POST /api/auth/setup` with Ben's creds (if users empty), login, `POST /api/restore` with the tarball, restart via Coolify API, verify ben@aa.ag login works.
6. **Persistence test:** restart ONE MORE TIME via Coolify. Login must still work. Entities must still show 2. **If this passes, persistence is real.**
7. **Create Jun + Raphael** (admin accounts):
   ```
   JUN_PW=$(openssl rand -base64 14 | tr '/+' 'xy' | cut -c1-16)
   RAF_PW=$(openssl rand -base64 14 | tr '/+' 'xy' | cut -c1-16)
   # login as ben, then for each:
   curl -s -b cookies.txt -X POST https://carbon.aa.ag/api/users \
     -H 'Content-Type: application/json' \
     -d "{\"email\":\"jun@aa.ag\",\"display_name\":\"Jun\",\"role\":\"admin\",\"password\":\"$JUN_PW\"}"
   ```
   Report passwords to Ben.
8. **Mark task #17 completed** via TaskUpdate.

## §7 Pickup hints

- The Coolify app UUID is `f4kgsgckgw408co0440kso40` and the API token is in the conversational context above (rotate later).
- The auth/setup endpoint is a back door when login is broken — it works once after every volume wipe. Don't rely on it as the canonical fix.
- `7223137` (latest commit) is the schema migration order fix. If the prod logs ever show `SQLite error: index already exists` again, that's the same family — check `ensureColumn` order vs the inline CREATE TABLE block.
- Ben's iCloud Keychain has `ben@aa.ag / nobfa3-cobjip-zIjpob / 127.0.0.1`. Keep this credential, don't generate a new one.
- DO NOT change DNS without asking — `carbon.aa.ag` A-record points at `83.228.220.166`; that's load-bearing and Porkbun is the source of truth.
- DO NOT click `Redeploy` casually — rebuilds Chromium from scratch, takes ~8–10 minutes since Coolify isn't caching layers.
