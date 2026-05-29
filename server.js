// Carbon local server — Express + better-sqlite3.
// Run with `npm start`. Binds to 127.0.0.1 only (never exposed externally).

const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

// Request-scoped actor context so audit() records WHO did each action
// without threading the user through all ~70 call sites.
const auditCtx = new AsyncLocalStorage();

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'carbon.db');
const SCHEMA_PATH = path.join(ROOT, 'db', 'schema.sql');
const SEED_PATH = path.join(ROOT, 'db', 'seed.sql');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Apply pending restore BEFORE opening the DB. /app/data is a bind mount on a
// different device than /app in production, so rename() across the two throws
// EXDEV. Stage with copy semantics and replace the data dir's contents in
// place — never rename the mount point itself.
const _pendingRestorePath = path.join(DATA_DIR, '_pending_restore.tar.gz');
if (fs.existsSync(_pendingRestorePath)) {
  console.log('Applying pending restore from', _pendingRestorePath);
  const { execSync } = require('child_process');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const stagingDir = path.join(ROOT, '_carbon-restoring');
  try {
    // Extract staged copy outside the mount (tar reads across devices fine).
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(stagingDir, { recursive: true });
    execSync(`tar -xzf "${_pendingRestorePath}" -C "${stagingDir}"`);
    const stagedDataDir = path.join(stagingDir, 'data');
    if (!fs.existsSync(path.join(stagedDataDir, 'carbon.db'))) {
      throw new Error('archive missing data/carbon.db');
    }
    // Safety copy of current data, then replace its contents in place. cpSync
    // works across devices; emptying + copying avoids renaming the mount point.
    const safety = path.join(ROOT, `data-pre-restore-${stamp}`);
    fs.cpSync(DATA_DIR, safety, { recursive: true });
    for (const entry of fs.readdirSync(DATA_DIR)) {
      fs.rmSync(path.join(DATA_DIR, entry), { recursive: true, force: true });
    }
    fs.cpSync(stagedDataDir, DATA_DIR, { recursive: true });
    fs.rmSync(stagingDir, { recursive: true, force: true });
    console.log('Restore applied. Previous data saved to', safety);
  } catch (e) {
    console.error('Restore failed:', e.message);
    // best-effort cleanup; drop the pending tar so we don't loop on a bad archive
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.unlinkSync(_pendingRestorePath); } catch (_) {}
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

const dbExisted = fs.existsSync(DB_PATH);
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
db.exec(fs.readFileSync(SEED_PATH, 'utf8'));
if (!dbExisted) console.log('Carbon DB initialised at', DB_PATH);

// Bootstrap-admin re-apply: if data/.carbon-admin.json exists, ensure that
// user is in the DB. Survives test wipes and `DELETE FROM users`.
const BOOTSTRAP_ADMIN_PATH = path.join(DATA_DIR, '.carbon-admin.json');
function ensureBootstrapAdmin() {
  if (!fs.existsSync(BOOTSTRAP_ADMIN_PATH)) return;
  try {
    const cfg = JSON.parse(fs.readFileSync(BOOTSTRAP_ADMIN_PATH, 'utf8'));
    if (!cfg.email || !cfg.password_hash || !cfg.password_salt) return;
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(cfg.email);
    if (existing) {
      // refresh hash/salt in case file changed
      db.prepare(`UPDATE users SET password_hash=?, password_salt=?, status='active', role=? WHERE id=?`)
        .run(cfg.password_hash, cfg.password_salt, cfg.role || 'admin', existing.id);
    } else {
      db.prepare(`INSERT INTO users (email, password_hash, password_salt, display_name, role, status)
                  VALUES (?, ?, ?, ?, ?, 'active')`)
        .run(cfg.email, cfg.password_hash, cfg.password_salt, cfg.display_name || cfg.email, cfg.role || 'admin');
      console.log('bootstrap admin restored from', BOOTSTRAP_ADMIN_PATH);
    }
  } catch (e) { console.error('bootstrap admin apply failed:', e.message); }
}
ensureBootstrapAdmin();

// Run session GC at startup, then every 6h.
setTimeout(() => { try { purgeExpiredSessions(); } catch (_) {} }, 1000);
setInterval(() => { try { purgeExpiredSessions(); } catch (_) {} }, 6 * 60 * 60 * 1000).unref();

// Nightly auto-backup with retention.
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_RETENTION = Number(process.env.CARBON_BACKUP_RETENTION) || 30;
function runNightlyBackup() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const out = path.join(BACKUP_DIR, `carbon-backup-${stamp}.tar.gz`);
    const { execSync } = require('child_process');
    execSync(`tar -czf "${out}" -C "${ROOT}" --exclude='data/backups' --exclude='data/_pending_restore.tar.gz' --exclude='data/_restoring' data`);
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('carbon-backup-')).sort();
    const toDelete = files.slice(0, Math.max(0, files.length - BACKUP_RETENTION));
    for (const f of toDelete) fs.unlinkSync(path.join(BACKUP_DIR, f));
    console.log(`nightly backup → ${path.basename(out)} (${files.length - toDelete.length}/${BACKUP_RETENTION} retained)`);
    notify('backup', `Nightly backup written: ${path.basename(out)} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`, out);
  } catch (e) { console.error('nightly backup failed:', e.message); notify('error', 'Nightly backup failed: ' + e.message); }
}
setTimeout(runNightlyBackup, 10000);
setInterval(runNightlyBackup, 24 * 60 * 60 * 1000).unref();

// Nightly scanner: fire contract.expiring + kyc.refresh_due webhooks.
function runEventScanner() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const in60  = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
    const in30  = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

    const contracts = db.prepare(`
      SELECT c.id, c.title, c.end_date, e.code AS entity_code, p.display_name AS counterparty
        FROM contracts c
        JOIN entities e ON e.id = c.entity_id
        JOIN contacts p ON p.id = c.counterparty_id
       WHERE c.status='active' AND c.end_date IS NOT NULL
         AND c.end_date >= ? AND c.end_date <= ?
    `).all(today, in60);
    for (const c of contracts) {
      // dedupe: skip if a delivery for this row was already logged today
      const already = db.prepare(`
        SELECT 1 FROM webhook_deliveries d
         WHERE d.event = 'contract.expiring' AND date(d.ts) = date('now') AND d.error IS NULL
           AND EXISTS (SELECT 1 FROM webhooks w WHERE w.id = d.webhook_id) LIMIT 1
      `).get();
      // Simple per-event-per-day dedupe (not per-row to keep it lean). Sufficient for daily fires.
      // (For per-row dedupe we'd need an extra column on contracts.)
      if (already && contracts.indexOf(c) > 0) continue;
      fireWebhook('contract.expiring', { id: c.id, title: c.title, end_date: c.end_date, entity_code: c.entity_code, counterparty: c.counterparty });
    }

    const kyc = db.prepare(`
      SELECT k.id, k.refresh_due, k.risk_tier, c.display_name AS contact_display_name
        FROM kyc_records k
        JOIN contacts c ON c.id = k.contact_id
       WHERE k.refresh_due IS NOT NULL
         AND k.refresh_due >= ? AND k.refresh_due <= ?
    `).all(today, in30);
    for (const k of kyc) {
      fireWebhook('kyc.refresh_due', { id: k.id, contact: k.contact_display_name, refresh_due: k.refresh_due, risk_tier: k.risk_tier });
    }
  } catch (err) { console.error('event scanner failed:', err.message); }
}
setTimeout(runEventScanner, 60_000);
setInterval(runEventScanner, 24 * 60 * 60 * 1000).unref();

// Dunning ticker: send polite reminders for overdue invoices.
async function sendDunningReminder(inv, smtpPlain) {
  const nodemailer = require('nodemailer');
  let smtpConfig;
  try { smtpConfig = JSON.parse(smtpPlain.notes || '{}'); } catch (_) { smtpConfig = {}; }
  const transporter = nodemailer.createTransport({
    host: smtpConfig.host || smtpPlain.client_id,
    port: Number(smtpConfig.port) || 587,
    secure: smtpConfig.secure === true || Number(smtpConfig.port) === 465,
    auth: { user: smtpPlain.api_key, pass: smtpPlain.client_secret },
  });
  const daysOverdue = Math.max(0, Math.round((Date.now() - new Date(inv.due_date).getTime()) / 86400000));
  const subject = `Friendly reminder: invoice ${inv.number} is ${daysOverdue} day(s) overdue`;
  const body = `Hello ${inv.contact_display_name || ''},\n\nOur records show invoice ${inv.number} from ${inv.entity_legal_name} is now ${daysOverdue} day(s) past due.\n\n  Amount: ${inv.currency} ${(inv.total - (inv.amount_paid || 0)).toFixed(2)}\n  Due:    ${inv.due_date}\n\nIf you've already paid, please ignore this message. Otherwise we'd appreciate settlement at your earliest convenience.\n\nThanks,\n${inv.entity_legal_name}`;
  await transporter.sendMail({
    from: smtpConfig.from || smtpPlain.api_key,
    to: inv.contact_email,
    subject,
    text: body,
  });
}

async function runDunning() {
  const smtp = db.prepare(`SELECT * FROM api_credentials WHERE provider='smtp' AND status='active' LIMIT 1`).get();
  if (!smtp) return; // no SMTP — silent skip
  const smtpPlain = decryptCredRow(smtp);
  const thresholdDays = Number(getSetting('dunning_threshold_days', '14')) || 14;
  const candidates = db.prepare(`
    SELECT i.id, i.number, i.due_date, i.total, i.amount_paid, i.currency, i.last_reminder_at,
           e.legal_name AS entity_legal_name, c.display_name AS contact_display_name, c.email AS contact_email
      FROM invoices i
      JOIN entities e ON e.id = i.entity_id
      JOIN contacts c ON c.id = i.contact_id
     WHERE i.direction='sales' AND i.status IN ('draft','sent')
       AND i.due_date IS NOT NULL
       AND julianday('now') - julianday(i.due_date) > ?
       AND c.email IS NOT NULL AND c.email != ''
       AND (i.last_reminder_at IS NULL OR julianday('now') - julianday(i.last_reminder_at) > ?)
  `).all(thresholdDays, thresholdDays);
  let sent = 0, errs = 0;
  for (const inv of candidates) {
    try {
      await sendDunningReminder(inv, smtpPlain);
      db.prepare(`UPDATE invoices SET last_reminder_at = datetime('now') WHERE id = ?`).run(inv.id);
      audit('invoices', inv.id, 'dunning-sent', null, { to: inv.contact_email });
      notify('dunning', `Reminder sent for ${inv.number} → ${inv.contact_email}`, 'invoices/' + inv.id);
      sent++;
    } catch (err) {
      console.error('Dunning send failed for invoice', inv.number, err.message);
      errs++;
    }
  }
  if (sent || errs) console.log(`dunning: sent=${sent} errors=${errs} threshold=${thresholdDays}d`);
}
setTimeout(() => { runDunning().catch(() => {}); }, 30000);
setInterval(() => { runDunning().catch(() => {}); }, 24 * 60 * 60 * 1000).unref();

// Audit log retention: prune rows older than N days (default 365). Override via env.
const AUDIT_RETENTION_DAYS = Number(process.env.CARBON_AUDIT_RETENTION_DAYS) || 365;
function pruneAuditLog() {
  try {
    const r = db.prepare(`DELETE FROM audit_log WHERE ts < datetime('now', ?)`).run(`-${AUDIT_RETENTION_DAYS} days`);
    if (r.changes) console.log('pruned', r.changes, 'audit rows older than', AUDIT_RETENTION_DAYS, 'days');
  } catch (_) {}
}
setTimeout(pruneAuditLog, 5000);
setInterval(pruneAuditLog, 24 * 60 * 60 * 1000).unref();

// Lightweight column-level migrations (idempotent).
function ensureColumn(table, col, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.find(c => c.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
    console.log(`migration: added ${table}.${col}`);
  }
}
ensureColumn('invoices', 'direction',       `TEXT NOT NULL DEFAULT 'sales'`);
ensureColumn('invoices', 'external_number', 'TEXT');
ensureColumn('bank_accounts', 'provider',      `TEXT NOT NULL DEFAULT 'csv'`);
ensureColumn('bank_accounts', 'credential_id', 'INTEGER REFERENCES api_credentials(id)');
ensureColumn('bank_accounts', 'last_synced_at','TEXT');
ensureColumn('api_credentials', 'sync_interval_minutes', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('entities', 'logo_path', 'TEXT');
ensureColumn('entities', 'logo_mime', 'TEXT');
ensureColumn('entities', 'invoice_header_text', 'TEXT');
ensureColumn('entities', 'invoice_footer_text', 'TEXT');
ensureColumn('entities', 'invoice_notes_default', 'TEXT');
ensureColumn('entities', 'period_lock_through', 'TEXT');
ensureColumn('invoices', 'share_token', 'TEXT');
ensureColumn('invoices', 'last_reminder_at', 'TEXT');
// webhook_deliveries.attempt — applied AFTER the inline CREATE TABLE below (line ~281)
// because the table doesn't exist in db/schema.sql.

// Indexes on schema.sql tables only (others are added after their inline CREATE TABLE below).
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_invoices_due_date  ON invoices(due_date);
  CREATE INDEX IF NOT EXISTS idx_invoices_direction ON invoices(direction);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS api_tokens (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    label         TEXT NOT NULL,
    token_hash    TEXT NOT NULL UNIQUE,
    scope         TEXT NOT NULL DEFAULT 'read',
    last_used_at  TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS calendar_tokens (
    token       TEXT PRIMARY KEY,
    label       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT
  );
  CREATE TABLE IF NOT EXISTS webhooks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    url         TEXT NOT NULL,
    secret      TEXT NOT NULL,
    events      TEXT NOT NULL,
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    webhook_id  INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    event       TEXT NOT NULL,
    status_code INTEGER,
    response_ms INTEGER,
    error       TEXT,
    ts          TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS contract_file_versions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id  INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    file_path    TEXT NOT NULL,
    file_name    TEXT NOT NULL,
    file_mime    TEXT,
    file_size    INTEGER,
    archived_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL,
    message     TEXT NOT NULL,
    ref         TEXT,
    is_read     INTEGER NOT NULL DEFAULT 0,
    ts          TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    due_date    TEXT,
    status      TEXT NOT NULL DEFAULT 'open',
    ref_table   TEXT,
    ref_id      INTEGER,
    notes       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
ensureColumn('invoices', 'recurrence_kind',     'TEXT');                  // monthly|quarterly|yearly|null
ensureColumn('invoices', 'recurrence_next_run', 'TEXT');                  // YYYY-MM-DD
ensureColumn('invoices', 'recurrence_active',   'INTEGER NOT NULL DEFAULT 0');
ensureColumn('invoices', 'amount_paid',         'REAL NOT NULL DEFAULT 0');
ensureColumn('money_flows', 'category',         'TEXT');                  // free-text expense/income tag
// Tables created inline above (CREATE TABLE IF NOT EXISTS) — apply their column migrations + indexes here.
ensureColumn('webhook_deliveries', 'attempt', 'INTEGER NOT NULL DEFAULT 1');
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_notifications_ts   ON notifications(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(is_read);
  CREATE INDEX IF NOT EXISTS idx_tasks_status       ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_due          ON tasks(due_date);
  CREATE INDEX IF NOT EXISTS idx_wh_deliveries_hook ON webhook_deliveries(webhook_id, ts DESC);
`);

// invoice_payments table (for partial payments)
db.exec(`
  CREATE TABLE IF NOT EXISTS invoice_payments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id  INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    paid_on     TEXT NOT NULL,
    amount      REAL NOT NULL,
    method      TEXT,
    reference   TEXT,
    notes       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_payments_invoice ON invoice_payments(invoice_id);

  CREATE TABLE IF NOT EXISTS notes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_table  TEXT NOT NULL,
    entity_id     INTEGER NOT NULL,
    user_id       INTEGER REFERENCES users(id),
    body          TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_notes_entity ON notes(entity_table, entity_id);
`);

// Self-heal: purge orphan rows that may have leaked in through manual CLI edits
// (FK cascade only fires when foreign_keys=ON, which the sqlite3 shell doesn't set by default).
db.exec(`
  DELETE FROM webhook_deliveries    WHERE webhook_id   NOT IN (SELECT id FROM webhooks);
  DELETE FROM contact_entity_links  WHERE contact_id   NOT IN (SELECT id FROM contacts);
  DELETE FROM contact_entity_links  WHERE entity_id    NOT IN (SELECT id FROM entities);
  DELETE FROM invoice_lines         WHERE invoice_id   NOT IN (SELECT id FROM invoices);
  DELETE FROM kyc_documents         WHERE kyc_record_id NOT IN (SELECT id FROM kyc_records);
  DELETE FROM contract_file_versions WHERE contract_id NOT IN (SELECT id FROM contracts);
  DELETE FROM bank_transactions     WHERE account_id   NOT IN (SELECT id FROM bank_accounts);
  DELETE FROM sessions              WHERE user_id      NOT IN (SELECT id FROM users);
`);

// Self-heal: keep invoice_sequences.next_number ahead of any existing invoice number.
db.exec(`
  UPDATE invoice_sequences
     SET next_number = MAX(next_number, COALESCE((
       SELECT MAX(CAST(SUBSTR(i.number, LENGTH(i.number) - 3) AS INTEGER)) + 1
         FROM invoices i WHERE i.entity_id = invoice_sequences.entity_id
     ), 1));
`);

// ==================================================================
// Reference-aware delete: refuse if other records still link to this one
// ==================================================================

const REFERENCE_MAP = {
  contacts: [
    { table: 'invoices',             column: 'contact_id',        label: 'invoices' },
    { table: 'contracts',            column: 'counterparty_id',   label: 'contracts' },
    { table: 'kyc_records',          column: 'contact_id',        label: 'KYC records' },
    { table: 'money_flows',          column: 'from_contact_id',   label: 'flows (from)' },
    { table: 'money_flows',          column: 'to_contact_id',     label: 'flows (to)' },
    { table: 'contact_entity_links', column: 'contact_id',        label: 'entity links' },
  ],
  invoices: [
    { table: 'bank_transactions',    column: 'matched_invoice_id', label: 'matched bank txns' },
    { table: 'money_flows',          column: 'invoice_id',         label: 'flows' },
  ],
  contracts: [],
  bank_accounts: [
    { table: 'bank_transactions',    column: 'account_id',         label: 'transactions' },
    { table: 'api_credentials',      column: 'bank_account_id',    label: 'API credentials' },
  ],
  bank_transactions: [
    { table: 'money_flows',          column: 'bank_tx_id',         label: 'flows' },
  ],
  kyc_records: [],
  money_flows: [],
  entities: [
    { table: 'invoices',             column: 'entity_id',          label: 'invoices' },
    { table: 'contracts',            column: 'entity_id',          label: 'contracts' },
    { table: 'bank_accounts',        column: 'entity_id',          label: 'bank accounts' },
    { table: 'money_flows',          column: 'from_entity_id',     label: 'flows (from)' },
    { table: 'money_flows',          column: 'to_entity_id',       label: 'flows (to)' },
    { table: 'api_credentials',      column: 'entity_id',          label: 'API credentials' },
    { table: 'contact_entity_links', column: 'entity_id',          label: 'contact links' },
  ],
};

function countReferences(parentKey, parentId) {
  const refs = REFERENCE_MAP[parentKey] || [];
  const out = {};
  for (const r of refs) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${r.table} WHERE ${r.column} = ?`).get(parentId);
    if (row.n) out[r.label] = (out[r.label] || 0) + row.n;
  }
  return out;
}

function blockIfReferenced(parentKey, parentId, res) {
  const blockers = countReferences(parentKey, parentId);
  if (Object.keys(blockers).length) {
    res.status(409).json({
      error: 'Cannot delete — referenced elsewhere. Archive instead.',
      blockers,
    });
    return true;
  }
  return false;
}

function notify(kind, message, ref) {
  try {
    db.prepare(`INSERT INTO notifications (kind, message, ref) VALUES (?, ?, ?)`).run(kind, message, ref || null);
    // keep most recent 200; trim older
    db.exec(`DELETE FROM notifications WHERE id NOT IN (SELECT id FROM notifications ORDER BY id DESC LIMIT 200)`);
  } catch (_) {}
}

// Input validators — small + reusable.
const ISO_DATE_RX  = /^\d{4}-\d{2}-\d{2}$/;
const ISO_CCY_RX   = /^[A-Z]{3}$/;
const EMAIL_RX     = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidDate(s)  { return !s || (typeof s === 'string' && ISO_DATE_RX.test(s)); }
function isValidCcy(s)   { return !s || (typeof s === 'string' && ISO_CCY_RX.test(s)); }
function isValidEmail(s) { return !s || (typeof s === 'string' && EMAIL_RX.test(s)); }
const USERNAME_RX  = /^[a-z0-9][a-z0-9._-]{1,31}$/i;
// A login id is either an email (ben@aa.ag) or a bare username (jun, raphael).
function isValidLoginId(s) { return typeof s === 'string' && (EMAIL_RX.test(s) || USERNAME_RX.test(s)); }

function audit(table, rowId, action, before, after, actorOverride) {
  const store = auditCtx.getStore();
  const actor = actorOverride || (store && store.actor) || 'system';
  db.prepare(
    `INSERT INTO audit_log (table_name, row_id, action, actor, before_json, after_json)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    table,
    rowId,
    action,
    actor,
    before ? JSON.stringify(before) : null,
    after ? JSON.stringify(after) : null
  );
}

const CONTACT_COLS = [
  'contact_type', 'display_name', 'legal_name', 'jurisdiction_code', 'tax_id',
  'email', 'phone', 'website',
  'address_line1', 'address_line2', 'city', 'postal_code', 'country',
  'currency_default', 'payment_terms_days', 'notes', 'tags', 'status'
];

function normaliseContact(body) {
  const out = {};
  for (const c of CONTACT_COLS) {
    let v = body[c];
    if (v === '' || v === undefined) v = null;
    out[c] = v;
  }
  if (!out.status) out.status = 'active';
  return out;
}

// ==================================================================
// Auth — scrypt password hashing, cookie sessions, role middleware
// ==================================================================

// At-rest encryption for sensitive credential fields (AES-256-GCM).
const ENC_KEY_PATH = path.join(DATA_DIR, '.encryption.key');
let _encKey = null;
function getEncryptionKey() {
  if (_encKey) return _encKey;
  if (fs.existsSync(ENC_KEY_PATH)) {
    _encKey = fs.readFileSync(ENC_KEY_PATH);
    if (_encKey.length !== 32) throw new Error('corrupt encryption key file');
  } else {
    _encKey = crypto.randomBytes(32);
    fs.writeFileSync(ENC_KEY_PATH, _encKey, { mode: 0o600 });
    console.log('generated new encryption key at', ENC_KEY_PATH);
  }
  return _encKey;
}
function encField(plain) {
  if (plain == null || plain === '') return plain;
  if (typeof plain === 'string' && plain.startsWith('enc:')) return plain; // already encrypted
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'enc:' + Buffer.concat([iv, tag, enc]).toString('base64');
}
function decField(maybeEnc) {
  if (typeof maybeEnc !== 'string' || !maybeEnc.startsWith('enc:')) return maybeEnc;
  try {
    const buf = Buffer.from(maybeEnc.slice(4), 'base64');
    const iv = buf.slice(0, 12), tag = buf.slice(12, 28), enc = buf.slice(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch (_) {
    return null;
  }
}
const ENCRYPTED_CRED_FIELDS = ['client_secret', 'api_key', 'access_token', 'refresh_token'];
function decryptCredRow(row) {
  if (!row) return row;
  const out = { ...row };
  for (const f of ENCRYPTED_CRED_FIELDS) {
    if (out[f]) out[f] = decField(out[f]);
  }
  return out;
}

// Session garbage-collector
function purgeExpiredSessions() {
  const r = db.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`).run();
  if (r.changes) console.log('purged', r.changes, 'expired sessions');
}

// Login rate limit (in-memory; survives until process restart)
const loginAttempts = new Map();
const MAX_LOGIN_FAILS = 10;
const LOCKOUT_MS = 15 * 60 * 1000;

function checkLoginRate(ip) {
  const rec = loginAttempts.get(ip);
  if (!rec) return { blocked: false };
  if (rec.until > Date.now()) {
    return { blocked: true, retry_in_seconds: Math.ceil((rec.until - Date.now()) / 1000) };
  }
  // expired lockout — reset for a fresh start. (count alone without lockout: keep counting.)
  if (rec.until > 0) loginAttempts.delete(ip);
  return { blocked: false };
}

function recordLoginFail(ip) {
  const rec = loginAttempts.get(ip) || { count: 0, until: 0 };
  rec.count++;
  if (rec.count >= MAX_LOGIN_FAILS) rec.until = Date.now() + LOCKOUT_MS;
  loginAttempts.set(ip, rec);
}

function clearLoginFails(ip) {
  loginAttempts.delete(ip);
}

function hashPassword(plain, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plain, salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(plain, salt, expectedHash) {
  try {
    const got = crypto.scryptSync(plain, salt, 64);
    const want = Buffer.from(expectedHash, 'hex');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch (_) { return false; }
}

function newSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

const SESSION_COOKIE = 'carbon_sid';
const SESSION_TTL_DAYS = 30;

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i < 0) return;
    out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function getSession(req) {
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (!sid) return null;
  const row = db.prepare(`
    SELECT s.id AS sid, s.expires_at, u.*
      FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > datetime('now') AND u.status = 'active'
  `).get(sid);
  if (!row) return null;
  db.prepare(`UPDATE sessions SET last_seen = datetime('now') WHERE id = ?`).run(sid);
  return row;
}

const IS_PROD = process.env.NODE_ENV === 'production';
const COOKIE_SECURE_FLAG = IS_PROD ? '; Secure' : '';

function setSessionCookie(res, sid) {
  const maxAge = SESSION_TTL_DAYS * 86400;
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${COOKIE_SECURE_FLAG}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${COOKIE_SECURE_FLAG}`);
}

function usersExist() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
}

const app = express();
app.use(express.json({ limit: '2mb' }));

// Production security headers (no helmet dep — hand-rolled for the few we need).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (IS_PROD) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; " +
      "img-src 'self' data: blob:; " +
      "style-src 'self' 'unsafe-inline'; " +
      "script-src 'self' 'unsafe-inline'; " +
      "font-src 'self' data:; " +
      "connect-src 'self'; " +
      "frame-ancestors 'none'; " +
      "base-uri 'self'; " +
      "form-action 'self'"
    );
  }
  next();
});

// Subscribable iCal feed (token-gated, no cookie required)
app.get('/api/calendar/:token.ics', (req, res, next) => {
  const t = String(req.params.token || '');
  if (!t) return res.status(404).send('Not found');
  const row = db.prepare('SELECT * FROM calendar_tokens WHERE token = ?').get(t);
  if (!row) return res.status(404).send('Not found');
  db.prepare(`UPDATE calendar_tokens SET last_used_at = datetime('now') WHERE token = ?`).run(t);
  // Reuse the calendar building logic by setting an internal flag
  req._bypassAuth = true;
  req.url = '/api/calendar.ics';
  next();
});

// Public health probe (always public, no auth)
app.get('/healthz', (req, res) => {
  let dbWritable = false;
  try { db.prepare('SELECT 1').get(); dbWritable = true; } catch (_) {}
  res.json({
    status: dbWritable ? 'ok' : 'degraded',
    db_writable: dbWritable,
    uptime_seconds: Math.round(process.uptime()),
    node_version: process.version,
    timestamp: new Date().toISOString(),
  });
});

// Public share view for an invoice via signed token (no auth)
app.get('/share/invoice/:token', (req, res) => {
  const token = String(req.params.token || '');
  if (!token || token.length < 16) return res.status(404).send('Not found');
  const inv = loadInvoice(db.prepare('SELECT id FROM invoices WHERE share_token = ?').get(token)?.id || 0);
  if (!inv) return res.status(404).send('Not found');
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(renderInvoiceHTML(inv));
});

// Bearer-token check: alternative to session cookie for API access.
function getApiToken(req) {
  const auth = req.headers['authorization'] || '';
  if (!auth.toLowerCase().startsWith('bearer ')) return null;
  const raw = auth.slice(7).trim();
  if (!raw) return null;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const row = db.prepare('SELECT * FROM api_tokens WHERE token_hash = ?').get(hash);
  if (row) {
    db.prepare(`UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?`).run(row.id);
  }
  return row || null;
}

// Auth gate: /api/* and /invoices/* (print views) need a valid session OR API token.
app.use((req, res, next) => {
  if (req._bypassAuth) return next();
  const needsAuth = req.path.startsWith('/api/') || req.path.startsWith('/invoices/');
  if (!needsAuth) return next();
  if (req.path.startsWith('/api/auth/')) return next();
  const sess = getSession(req);
  const token = !sess ? getApiToken(req) : null;
  if (!sess && !token) {
    return req.path.startsWith('/api/')
      ? res.status(401).json({ error: 'auth required' })
      : res.redirect('/');
  }
  if (sess) {
    req.user = sess;
    if (sess.role === 'readonly' && req.method !== 'GET') {
      return res.status(403).json({ error: 'read-only role' });
    }
  } else {
    req.apiToken = token;
    req.user = { id: 0, role: token.scope === 'write' ? 'user' : 'readonly', email: 'token:' + token.label };
    if (token.scope === 'read' && req.method !== 'GET') {
      return res.status(403).json({ error: 'token is read-only' });
    }
  }
  auditCtx.run({ actor: (req.user && req.user.email) || 'system' }, () => next());
});

// Static + landing-page routing (login / setup before app).
app.get('/', (req, res, next) => {
  if (!usersExist()) return res.sendFile(path.join(ROOT, 'public', 'setup.html'));
  if (!getSession(req)) return res.sendFile(path.join(ROOT, 'public', 'login.html'));
  next();
});

app.use(express.static(path.join(ROOT, 'public')));

// --- auth endpoints ---
app.post('/api/auth/setup', (req, res) => {
  if (usersExist()) return res.status(409).json({ error: 'setup already done' });
  const { email, password, display_name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  if (String(password).length < 8) return res.status(400).json({ error: 'password must be 8+ chars' });
  const { hash, salt } = hashPassword(password);
  const result = db.prepare(
    `INSERT INTO users (email, password_hash, password_salt, display_name, role)
     VALUES (?, ?, ?, ?, 'admin')`
  ).run(String(email).toLowerCase(), hash, salt, display_name || email);
  const sid = newSessionId();
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 86400000).toISOString();
  db.prepare(
    `INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)`
  ).run(sid, result.lastInsertRowid, expires, req.headers['user-agent'] || '');
  setSessionCookie(res, sid);
  audit('users', result.lastInsertRowid, 'setup', null, { email });
  res.json({ ok: true });
});

app.post('/api/auth/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const rate = checkLoginRate(ip);
  if (rate.blocked) {
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${rate.retry_in_seconds}s.` });
  }
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const u = db.prepare('SELECT * FROM users WHERE email = ? AND status = ?').get(String(email).toLowerCase(), 'active');
  if (!u || !verifyPassword(password, u.password_salt, u.password_hash)) {
    recordLoginFail(ip);
    audit('auth', u ? u.id : null, 'login-failed', null, { email: String(email).toLowerCase(), ip }, String(email || '').toLowerCase() || 'anon');
    return res.status(401).json({ error: 'invalid email or password' });
  }
  clearLoginFails(ip);
  const sid = newSessionId();
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 86400000).toISOString();
  db.prepare(
    `INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)`
  ).run(sid, u.id, expires, req.headers['user-agent'] || '');
  db.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).run(u.id);
  setSessionCookie(res, sid);
  audit('users', u.id, 'login', null, null, u.email);
  res.json({ ok: true, user: { id: u.id, email: u.email, display_name: u.display_name, role: u.role } });
});

app.post('/api/auth/change-password', (req, res) => {
  const sess = getSession(req);
  if (!sess) return res.status(401).json({ error: 'auth required' });
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) return res.status(400).json({ error: 'both passwords required' });
  if (String(new_password).length < 8) return res.status(400).json({ error: 'password must be 8+ chars' });
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(sess.id);
  if (!verifyPassword(current_password, u.password_salt, u.password_hash)) {
    return res.status(401).json({ error: 'current password incorrect' });
  }
  const { hash, salt } = hashPassword(new_password);
  db.prepare(`UPDATE users SET password_hash = ?, password_salt = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(hash, salt, sess.id);
  // revoke all other sessions for this user
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(sess.id, sess.sid);
  audit('users', sess.id, 'password-change', null, null, sess.email);
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  const sess = getSession(req);
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (sid) db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
  if (sess) audit('users', sess.id, 'logout', null, null, sess.email);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const sess = getSession(req);
  if (!sess) return res.status(401).json({ error: 'no session' });
  res.json({
    id: sess.id, email: sess.email, display_name: sess.display_name,
    role: sess.role, last_login_at: sess.last_login_at,
  });
});

// --- users CRUD (admin-only) ---
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'admin role required' });
  }
  next();
}

app.get('/api/users', requireAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT id, email, display_name, role, status, last_login_at, created_at
      FROM users ORDER BY id
  `).all());
});

app.post('/api/users', requireAdmin, (req, res) => {
  const { email, password, display_name, role } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  if (!isValidLoginId(email)) return res.status(400).json({ error: 'invalid username or email' });
  if (String(password).length < 8) return res.status(400).json({ error: 'password must be 8+ chars' });
  if (!['admin', 'user', 'readonly'].includes(role || 'user')) {
    return res.status(400).json({ error: 'invalid role' });
  }
  const { hash, salt } = hashPassword(password);
  try {
    const result = db.prepare(
      `INSERT INTO users (email, password_hash, password_salt, display_name, role)
       VALUES (?, ?, ?, ?, ?)`
    ).run(String(email).toLowerCase(), hash, salt, display_name || email, role || 'user');
    audit('users', result.lastInsertRowid, 'insert', null, { email, role: role || 'user' });
    res.json({ id: result.lastInsertRowid, email, display_name, role: role || 'user' });
  } catch (e) {
    if (String(e).includes('UNIQUE')) return res.status(409).json({ error: 'email already exists' });
    throw e;
  }
});

app.put('/api/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const before = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!before) return res.status(404).json({ error: 'not found' });
  const { display_name, role, status, password } = req.body || {};
  const updates = [];
  const args = {};
  if (display_name !== undefined) { updates.push('display_name = @display_name'); args.display_name = display_name; }
  if (role && ['admin', 'user', 'readonly'].includes(role)) { updates.push('role = @role'); args.role = role; }
  if (status && ['active', 'disabled'].includes(status)) { updates.push('status = @status'); args.status = status; }
  if (password) {
    if (String(password).length < 8) return res.status(400).json({ error: 'password must be 8+ chars' });
    const { hash, salt } = hashPassword(password);
    updates.push('password_hash = @h, password_salt = @s');
    args.h = hash; args.s = salt;
  }
  if (!updates.length) return res.status(400).json({ error: 'no changes' });
  db.prepare(`UPDATE users SET ${updates.join(', ')}, updated_at = datetime('now') WHERE id = @id`).run({ ...args, id });
  if (status === 'disabled') db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  const after = db.prepare('SELECT id, email, display_name, role, status FROM users WHERE id = ?').get(id);
  audit('users', id, 'update', { role: before.role, status: before.status }, after);
  res.json(after);
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'cannot delete your own account' });
  const before = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!before) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  audit('users', id, 'delete', { email: before.email }, null);
  res.json({ ok: true });
});

// --- jurisdictions
app.get('/api/jurisdictions', (req, res) => {
  res.json(db.prepare('SELECT * FROM jurisdictions ORDER BY name').all());
});

app.post('/api/jurisdictions', (req, res) => {
  const body = req.body || {};
  if (!body.code) return res.status(400).json({ error: 'code required' });
  if (!body.name) return res.status(400).json({ error: 'name required' });
  if (!body.currency_default) return res.status(400).json({ error: 'currency_default required' });
  const code = String(body.code).toLowerCase();
  const existing = db.prepare('SELECT code FROM jurisdictions WHERE code = ?').get(code);
  if (existing) return res.status(409).json({ error: 'jurisdiction already exists', code });
  const row = {
    code,
    name: body.name,
    currency_default: String(body.currency_default).toUpperCase(),
    vat_default: Number(body.vat_default) || 0,
    tax_id_label: body.tax_id_label || 'Tax ID',
    invoice_footer: body.invoice_footer || null,
    record_retention_years: Number(body.record_retention_years) || 7,
    notes: body.notes || null,
  };
  db.prepare(
    `INSERT INTO jurisdictions (code, name, currency_default, vat_default, tax_id_label, invoice_footer, record_retention_years, notes)
     VALUES (@code, @name, @currency_default, @vat_default, @tax_id_label, @invoice_footer, @record_retention_years, @notes)`
  ).run(row);
  audit('jurisdictions', null, 'insert', null, row);
  res.json(row);
});

app.delete('/api/jurisdictions/:code', (req, res) => {
  const code = String(req.params.code).toLowerCase();
  const before = db.prepare('SELECT * FROM jurisdictions WHERE code = ?').get(code);
  if (!before) return res.status(404).json({ error: 'not found' });
  const inUseEntities = db.prepare('SELECT COUNT(*) AS n FROM entities  WHERE jurisdiction_code = ?').get(code).n;
  const inUseContacts = db.prepare('SELECT COUNT(*) AS n FROM contacts  WHERE jurisdiction_code = ?').get(code).n;
  if (inUseEntities || inUseContacts) {
    return res.status(409).json({
      error: `Jurisdiction is in use by ${inUseEntities} entity/entities and ${inUseContacts} contact(s). Reassign first.`,
      entities: inUseEntities, contacts: inUseContacts,
    });
  }
  db.prepare('DELETE FROM jurisdictions WHERE code = ?').run(code);
  audit('jurisdictions', null, 'delete', before, null);
  res.json({ ok: true });
});

app.put('/api/jurisdictions/:code', (req, res) => {
  const code = String(req.params.code).toLowerCase();
  const before = db.prepare('SELECT * FROM jurisdictions WHERE code = ?').get(code);
  if (!before) return res.status(404).json({ error: 'not found' });
  const body = req.body || {};
  const after = {
    code,
    name: body.name ?? before.name,
    currency_default: ((body.currency_default ?? before.currency_default) || '').toUpperCase(),
    vat_default: body.vat_default != null ? Number(body.vat_default) : before.vat_default,
    tax_id_label: body.tax_id_label ?? before.tax_id_label,
    invoice_footer: body.invoice_footer ?? before.invoice_footer,
    record_retention_years: body.record_retention_years != null ? Number(body.record_retention_years) : before.record_retention_years,
    notes: body.notes ?? before.notes,
  };
  db.prepare(
    `UPDATE jurisdictions
       SET name=@name, currency_default=@currency_default, vat_default=@vat_default,
           tax_id_label=@tax_id_label, invoice_footer=@invoice_footer,
           record_retention_years=@record_retention_years, notes=@notes
     WHERE code=@code`
  ).run(after);
  audit('jurisdictions', null, 'update', before, after);
  res.json(after);
});

// --- entities
app.get('/api/entities', (req, res) => {
  res.json(db.prepare('SELECT * FROM entities ORDER BY code').all());
});

const ENTITY_COLS = [
  'code', 'legal_name', 'jurisdiction_code', 'tax_id',
  'registered_address', 'base_currency', 'status', 'notes',
  'invoice_header_text', 'invoice_footer_text', 'invoice_notes_default',
  'period_lock_through'
];

app.put('/api/entities/:id', (req, res) => {
  const id = Number(req.params.id);
  const before = db.prepare('SELECT * FROM entities WHERE id = ?').get(id);
  if (!before) return res.status(404).json({ error: 'not found' });
  const body = req.body || {};
  const data = {};
  for (const c of ENTITY_COLS) {
    let v = body[c] ?? before[c];
    if (v === '') v = null;
    data[c] = v;
  }
  if (!data.code || !data.legal_name || !data.jurisdiction_code || !data.base_currency) {
    return res.status(400).json({ error: 'code, legal_name, jurisdiction_code, base_currency required' });
  }
  data.base_currency = String(data.base_currency).toUpperCase();
  const setClause = ENTITY_COLS.map(c => `${c} = @${c}`).join(', ');
  db.prepare(
    `UPDATE entities SET ${setClause}, updated_at = datetime('now') WHERE id = @id`
  ).run({ ...data, id });
  const after = db.prepare('SELECT * FROM entities WHERE id = ?').get(id);
  audit('entities', id, 'update', before, after);
  res.json(after);
});

app.post('/api/entities', (req, res) => {
  const body = req.body || {};
  const data = {};
  for (const c of ENTITY_COLS) {
    let v = body[c];
    if (v === '' || v === undefined) v = null;
    data[c] = v;
  }
  if (!data.code || !data.legal_name || !data.jurisdiction_code || !data.base_currency) {
    return res.status(400).json({ error: 'code, legal_name, jurisdiction_code, base_currency required' });
  }
  if (!data.status) data.status = 'active';
  data.base_currency = String(data.base_currency).toUpperCase();
  const cols = ENTITY_COLS.join(', ');
  const placeholders = ENTITY_COLS.map(c => '@' + c).join(', ');
  const result = db.prepare(`INSERT INTO entities (${cols}) VALUES (${placeholders})`).run(data);
  const id = result.lastInsertRowid;
  // seed an invoice sequence for the new entity
  db.prepare(`INSERT OR IGNORE INTO invoice_sequences (entity_id, prefix, next_number, pad_width) VALUES (?, ?, 1, 4)`)
    .run(id, data.code + '-');
  const after = db.prepare('SELECT * FROM entities WHERE id = ?').get(id);
  audit('entities', id, 'insert', null, after);
  res.json(after);
});

app.delete('/api/entities/:id', (req, res) => {
  const id = Number(req.params.id);
  const before = db.prepare('SELECT * FROM entities WHERE id = ?').get(id);
  if (!before) return res.status(404).json({ error: 'not found' });
  if (blockIfReferenced('entities', id, res)) return;
  // also drop the auto-created invoice sequence row (not in REFERENCE_MAP — admin-owned)
  db.prepare('DELETE FROM invoice_sequences WHERE entity_id = ?').run(id);
  // and the entity's logo file
  if (before.logo_path) {
    try { fs.unlinkSync(path.join(DATA_DIR, before.logo_path)); } catch (_) {}
    try { fs.rmdirSync(path.join(DATA_DIR, 'attachments', 'entities', String(id))); } catch (_) {}
  }
  db.prepare('DELETE FROM entities WHERE id = ?').run(id);
  audit('entities', id, 'delete', before, null);
  res.json({ ok: true });
});

// --- contacts: list
app.get('/api/contacts', (req, res) => {
  const rows = db.prepare(`
    SELECT c.*,
           GROUP_CONCAT(e.code, ',') AS entity_codes,
           GROUP_CONCAT(e.id,   ',') AS entity_ids_csv
      FROM contacts c
      LEFT JOIN contact_entity_links l ON l.contact_id = c.id
      LEFT JOIN entities e             ON e.id         = l.entity_id
     GROUP BY c.id
     ORDER BY c.display_name COLLATE NOCASE
  `).all();
  res.json(rows);
});

// --- contacts: get one
app.get('/api/contacts/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  c.entity_ids = db
    .prepare('SELECT entity_id FROM contact_entity_links WHERE contact_id = ?')
    .all(req.params.id)
    .map(r => r.entity_id);
  res.json(c);
});

// --- contacts: create
app.post('/api/contacts', (req, res) => {
  const body = req.body || {};
  if (!body.display_name) return res.status(400).json({ error: 'display_name required' });
  if (!body.contact_type) return res.status(400).json({ error: 'contact_type required' });
  const data = normaliseContact(body);
  const cols = CONTACT_COLS.join(', ');
  const placeholders = CONTACT_COLS.map(c => '@' + c).join(', ');
  const result = db.prepare(`INSERT INTO contacts (${cols}) VALUES (${placeholders})`).run(data);
  const id = result.lastInsertRowid;
  if (Array.isArray(body.entity_ids) && body.entity_ids.length) {
    const ins = db.prepare(
      'INSERT INTO contact_entity_links (contact_id, entity_id, relationship) VALUES (?, ?, ?)'
    );
    for (const eid of body.entity_ids) ins.run(id, eid, body.relationship || null);
  }
  const after = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
  audit('contacts', id, 'insert', null, after);
  res.json(after);
});

// --- contacts: update
app.put('/api/contacts/:id', (req, res) => {
  const id = Number(req.params.id);
  const before = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
  if (!before) return res.status(404).json({ error: 'not found' });
  const body = req.body || {};
  const data = normaliseContact({ ...before, ...body });
  const setClause = CONTACT_COLS.map(c => `${c} = @${c}`).join(', ');
  db.prepare(
    `UPDATE contacts SET ${setClause}, updated_at = datetime('now') WHERE id = @id`
  ).run({ ...data, id });
  if (Array.isArray(body.entity_ids)) {
    db.prepare('DELETE FROM contact_entity_links WHERE contact_id = ?').run(id);
    if (body.entity_ids.length) {
      const ins = db.prepare(
        'INSERT INTO contact_entity_links (contact_id, entity_id, relationship) VALUES (?, ?, ?)'
      );
      for (const eid of body.entity_ids) ins.run(id, eid, body.relationship || null);
    }
  }
  const after = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
  audit('contacts', id, 'update', before, after);
  res.json(after);
});

// --- contacts: delete (soft = archived; hard delete via ?hard=1)
app.delete('/api/contacts/:id', (req, res) => {
  const id = Number(req.params.id);
  const before = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
  if (!before) return res.status(404).json({ error: 'not found' });
  if (req.query.hard === '1') {
    if (blockIfReferenced('contacts', id, res)) return;
    db.prepare('DELETE FROM contacts WHERE id = ?').run(id);
    audit('contacts', id, 'delete', before, null);
  } else {
    db.prepare(
      `UPDATE contacts SET status = 'archived', updated_at = datetime('now') WHERE id = ?`
    ).run(id);
    const after = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
    audit('contacts', id, 'archive', before, after);
  }
  res.json({ ok: true });
});

// ==================================================================
// Invoicing
// ==================================================================

function nextInvoiceNumber(entityId, issueDate) {
  const seq = db.prepare('SELECT * FROM invoice_sequences WHERE entity_id = ?').get(entityId);
  if (!seq) throw new Error('no invoice sequence for entity ' + entityId);
  const year = (issueDate || new Date().toISOString().slice(0, 10)).slice(0, 4);
  const padded = String(seq.next_number).padStart(seq.pad_width, '0');
  const number = `${seq.prefix}${year}-${padded}`;
  db.prepare('UPDATE invoice_sequences SET next_number = next_number + 1 WHERE entity_id = ?').run(entityId);
  return number;
}

function recomputeInvoiceTotals(invoiceId) {
  const lines = db.prepare('SELECT * FROM invoice_lines WHERE invoice_id = ?').all(invoiceId);
  let subtotal = 0, taxTotal = 0;
  for (const l of lines) {
    const sub = +(l.quantity * l.unit_price).toFixed(2);
    const tax = +(sub * l.tax_rate).toFixed(2);
    db.prepare(
      'UPDATE invoice_lines SET line_subtotal = ?, line_tax = ?, line_total = ? WHERE id = ?'
    ).run(sub, tax, sub + tax, l.id);
    subtotal += sub;
    taxTotal += tax;
  }
  subtotal = +subtotal.toFixed(2);
  taxTotal = +taxTotal.toFixed(2);
  const total = +(subtotal + taxTotal).toFixed(2);
  db.prepare(
    `UPDATE invoices SET subtotal = ?, tax_total = ?, total = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(subtotal, taxTotal, total, invoiceId);
  return { subtotal, taxTotal, total };
}

function loadInvoice(id) {
  const inv = db.prepare(`
    SELECT i.*,
           e.code AS entity_code, e.legal_name AS entity_legal_name,
           e.base_currency AS entity_base_currency, e.tax_id AS entity_tax_id,
           e.registered_address AS entity_address, e.jurisdiction_code AS entity_juris,
           e.logo_path AS entity_logo_path, e.logo_mime AS entity_logo_mime,
           e.invoice_header_text AS entity_invoice_header,
           e.invoice_footer_text AS entity_invoice_footer,
           c.display_name AS contact_display_name, c.legal_name AS contact_legal_name,
           c.email AS contact_email, c.tax_id AS contact_tax_id,
           c.address_line1 AS contact_addr1, c.address_line2 AS contact_addr2,
           c.city AS contact_city, c.postal_code AS contact_postal, c.country AS contact_country
      FROM invoices i
      JOIN entities e ON e.id = i.entity_id
      JOIN contacts c ON c.id = i.contact_id
     WHERE i.id = ?
  `).get(id);
  if (!inv) return null;
  inv.lines = db.prepare(
    'SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY position, id'
  ).all(id);
  inv.jurisdiction = inv.entity_juris
    ? db.prepare('SELECT * FROM jurisdictions WHERE code = ?').get(inv.entity_juris)
    : null;
  return inv;
}

app.get('/api/invoices', (req, res) => {
  const direction = req.query.direction; // 'sales' | 'purchase' | undefined
  const where = direction ? `WHERE i.direction = ?` : '';
  const stmt = db.prepare(`
    SELECT i.*,
           e.code AS entity_code,
           c.display_name AS contact_display_name
      FROM invoices i
      JOIN entities e ON e.id = i.entity_id
      JOIN contacts c ON c.id = i.contact_id
      ${where}
     ORDER BY i.issue_date DESC, i.id DESC
  `);
  res.json(direction ? stmt.all(direction) : stmt.all());
});

app.get('/api/invoices/:id', (req, res) => {
  const inv = loadInvoice(Number(req.params.id));
  if (!inv) return res.status(404).json({ error: 'not found' });
  res.json(inv);
});

function checkPeriodLock(entityId, issueDate) {
  const row = db.prepare('SELECT period_lock_through FROM entities WHERE id = ?').get(entityId);
  if (row && row.period_lock_through && issueDate <= row.period_lock_through) {
    return `Entity period locked through ${row.period_lock_through}. Unlock under Ops & Settings → General → Entities.`;
  }
  return null;
}

app.post('/api/invoices', (req, res) => {
  const body = req.body || {};
  if (!body.entity_id)  return res.status(400).json({ error: 'entity_id required' });
  if (!body.contact_id) return res.status(400).json({ error: 'contact_id required' });
  if (!body.currency)   return res.status(400).json({ error: 'currency required' });
  const issueDate = body.issue_date || new Date().toISOString().slice(0, 10);
  if (!isValidDate(issueDate))                    return res.status(400).json({ error: 'issue_date must be YYYY-MM-DD' });
  if (body.due_date && !isValidDate(body.due_date)) return res.status(400).json({ error: 'due_date must be YYYY-MM-DD' });
  const ccy = String(body.currency).toUpperCase();
  if (!isValidCcy(ccy)) return res.status(400).json({ error: 'currency must be 3-letter ISO 4217 code' });
  body.currency = ccy;
  const lockErr = checkPeriodLock(body.entity_id, issueDate);
  if (lockErr) return res.status(409).json({ error: lockErr });
  const direction = body.direction === 'purchase' ? 'purchase' : 'sales';
  const tx = db.transaction(() => {
    let number;
    if (direction === 'purchase') {
      // Use external number provided by supplier (or fallback to placeholder)
      number = body.number || body.external_number || ('BILL-' + Date.now());
    } else {
      number = body.number || nextInvoiceNumber(body.entity_id, issueDate);
    }
    const result = db.prepare(`
      INSERT INTO invoices (entity_id, contact_id, number, issue_date, due_date,
                            currency, fx_rate_to_base, status, po_reference, notes,
                            direction, external_number,
                            recurrence_kind, recurrence_next_run, recurrence_active)
      VALUES (@entity_id, @contact_id, @number, @issue_date, @due_date,
              @currency, @fx_rate_to_base, @status, @po_reference, @notes,
              @direction, @external_number,
              @recurrence_kind, @recurrence_next_run, @recurrence_active)
    `).run({
      entity_id: body.entity_id,
      contact_id: body.contact_id,
      number,
      issue_date: issueDate,
      due_date: body.due_date || null,
      currency: String(body.currency).toUpperCase(),
      fx_rate_to_base: Number(body.fx_rate_to_base) || 1.0,
      status: body.status || 'draft',
      po_reference: body.po_reference || null,
      notes: body.notes || null,
      direction,
      external_number: body.external_number || null,
      recurrence_kind:     body.recurrence_kind || null,
      recurrence_next_run: body.recurrence_next_run || null,
      recurrence_active:   body.recurrence_active ? 1 : 0,
    });
    const id = result.lastInsertRowid;
    const lines = Array.isArray(body.lines) ? body.lines : [];
    const ins = db.prepare(`
      INSERT INTO invoice_lines (invoice_id, position, description, quantity, unit_price, tax_rate)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    lines.forEach((l, idx) => {
      ins.run(
        id,
        idx,
        l.description || '',
        Number(l.quantity)   || 0,
        Number(l.unit_price) || 0,
        Number(l.tax_rate)   || 0
      );
    });
    recomputeInvoiceTotals(id);
    return id;
  });
  const id = tx();
  const after = loadInvoice(id);
  audit('invoices', id, 'insert', null, after);
  fireWebhook('invoice.created', { id: after.id, number: after.number, currency: after.currency, total: after.total, direction: after.direction });
  res.json(after);
});

app.put('/api/invoices/:id', (req, res) => {
  const id = Number(req.params.id);
  const before = loadInvoice(id);
  if (!before) return res.status(404).json({ error: 'not found' });
  const body = req.body || {};
  // Block edits in locked periods (covers both before & after entity_id/issue_date)
  const lockA = checkPeriodLock(before.entity_id, before.issue_date);
  const lockB = body.entity_id || body.issue_date
    ? checkPeriodLock(body.entity_id || before.entity_id, body.issue_date || before.issue_date)
    : null;
  if (lockA || lockB) return res.status(409).json({ error: lockA || lockB });
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE invoices
         SET entity_id       = @entity_id,
             contact_id      = @contact_id,
             issue_date      = @issue_date,
             due_date        = @due_date,
             currency        = @currency,
             fx_rate_to_base = @fx_rate_to_base,
             status          = @status,
             po_reference    = @po_reference,
             notes           = @notes,
             direction       = @direction,
             external_number = @external_number,
             recurrence_kind     = @recurrence_kind,
             recurrence_next_run = @recurrence_next_run,
             recurrence_active   = @recurrence_active,
             updated_at      = datetime('now')
       WHERE id = @id
    `).run({
      id,
      entity_id: body.entity_id ?? before.entity_id,
      contact_id: body.contact_id ?? before.contact_id,
      issue_date: body.issue_date ?? before.issue_date,
      due_date: body.due_date ?? before.due_date,
      currency: (body.currency ?? before.currency).toUpperCase(),
      fx_rate_to_base: Number(body.fx_rate_to_base ?? before.fx_rate_to_base),
      status: body.status ?? before.status,
      po_reference: body.po_reference ?? before.po_reference,
      notes: body.notes ?? before.notes,
      direction: body.direction ?? before.direction ?? 'sales',
      external_number: body.external_number ?? before.external_number,
      recurrence_kind:     body.recurrence_kind     ?? before.recurrence_kind ?? null,
      recurrence_next_run: body.recurrence_next_run ?? before.recurrence_next_run ?? null,
      recurrence_active:   (body.recurrence_active != null ? (body.recurrence_active ? 1 : 0) : (before.recurrence_active || 0)),
    });
    if (Array.isArray(body.lines)) {
      db.prepare('DELETE FROM invoice_lines WHERE invoice_id = ?').run(id);
      const ins = db.prepare(`
        INSERT INTO invoice_lines (invoice_id, position, description, quantity, unit_price, tax_rate)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      body.lines.forEach((l, idx) => {
        ins.run(
          id,
          idx,
          l.description || '',
          Number(l.quantity)   || 0,
          Number(l.unit_price) || 0,
          Number(l.tax_rate)   || 0
        );
      });
    }
    recomputeInvoiceTotals(id);
  });
  tx();
  const after = loadInvoice(id);
  audit('invoices', id, 'update', before, after);
  if (before.status !== after.status) {
    if (after.status === 'paid') fireWebhook('invoice.paid', { id: after.id, number: after.number, total: after.total, currency: after.currency });
    if (after.status === 'void') fireWebhook('invoice.void', { id: after.id, number: after.number });
  }
  res.json(after);
});

app.post('/api/invoices/:id/duplicate', (req, res) => {
  const id = Number(req.params.id);
  const original = loadInvoice(id);
  if (!original) return res.status(404).json({ error: 'not found' });
  const today = new Date().toISOString().slice(0, 10);
  const tx = db.transaction(() => {
    const number = nextInvoiceNumber(original.entity_id, today);
    const result = db.prepare(`
      INSERT INTO invoices (entity_id, contact_id, number, issue_date, due_date,
                            currency, fx_rate_to_base, status, po_reference, notes,
                            direction, external_number)
      VALUES (@entity_id, @contact_id, @number, @issue_date, NULL,
              @currency, @fx_rate_to_base, 'draft', @po_reference, @notes,
              @direction, NULL)
    `).run({
      entity_id: original.entity_id,
      contact_id: original.contact_id,
      number,
      issue_date: today,
      currency: original.currency,
      fx_rate_to_base: original.fx_rate_to_base,
      po_reference: original.po_reference,
      notes: original.notes,
      direction: original.direction || 'sales',
    });
    const newId = result.lastInsertRowid;
    const ins = db.prepare(`
      INSERT INTO invoice_lines (invoice_id, position, description, quantity, unit_price, tax_rate)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    (original.lines || []).forEach((l, idx) => {
      ins.run(newId, idx, l.description, l.quantity, l.unit_price, l.tax_rate);
    });
    recomputeInvoiceTotals(newId);
    return newId;
  });
  const newId = tx();
  const after = loadInvoice(newId);
  audit('invoices', newId, 'duplicate', { from: id }, after);
  res.json(after);
});

app.delete('/api/invoices/:id', (req, res) => {
  const id = Number(req.params.id);
  const before = loadInvoice(id);
  if (!before) return res.status(404).json({ error: 'not found' });
  if (req.query.hard === '1') {
    if (blockIfReferenced('invoices', id, res)) return;
    db.prepare('DELETE FROM invoices WHERE id = ?').run(id);
    audit('invoices', id, 'delete', before, null);
  } else {
    db.prepare(`UPDATE invoices SET status='void', updated_at = datetime('now') WHERE id = ?`).run(id);
    const after = loadInvoice(id);
    audit('invoices', id, 'void', before, after);
  }
  res.json({ ok: true });
});

// ==================================================================
// PDF export — server-rendered via headless Chrome (puppeteer-core)
// ==================================================================

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

function findChrome() {
  for (const p of CHROME_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

let _browser = null;
let _browserPromise = null;

async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  if (_browserPromise) return _browserPromise;
  const chromePath = findChrome();
  if (!chromePath) {
    throw new Error('No Chrome/Chromium installation found. Install Google Chrome to enable PDF export.');
  }
  const puppeteer = require('puppeteer-core');
  _browserPromise = puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  }).then(b => {
    _browser = b;
    b.on('disconnected', () => { _browser = null; _browserPromise = null; });
    return b;
  }).catch(e => {
    _browserPromise = null;
    throw e;
  });
  return _browserPromise;
}

app.get('/api/invoices/:id/pdf', async (req, res) => {
  const id = Number(req.params.id);
  const inv = loadInvoice(id);
  if (!inv) return res.status(404).json({ error: 'not found' });
  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    // Render directly via setContent — avoids HTTP round-trip and bypasses auth gate.
    const html = renderInvoiceHTML(inv);
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });
    await page.emulateMediaType('print');
    const pdf = await page.pdf({
      format: 'A4',
      margin: { top: '18mm', bottom: '18mm', left: '18mm', right: '18mm' },
      printBackground: true,
      preferCSSPageSize: false,
    });
    const safe = String(inv.number).replace(/[^a-zA-Z0-9._-]/g, '_');
    const prefix = inv.direction === 'purchase' ? 'BILL' : 'INV';
    const pdfBuf = Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Length', pdfBuf.length);
    res.set('Content-Disposition', `attachment; filename="${prefix}-${safe}.pdf"`);
    res.end(pdfBuf);
  } catch (err) {
    console.error('PDF gen failed:', err);
    res.status(500).json({ error: err.message || 'PDF generation failed' });
  } finally {
    if (page) { try { await page.close(); } catch (_) {} }
  }
});

// printable invoice view
app.get('/invoices/:id/print', (req, res) => {
  const inv = loadInvoice(Number(req.params.id));
  if (!inv) return res.status(404).send('Invoice not found');
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(renderInvoiceHTML(inv));
});

function htmlEscape(s) {
  if (s == null) return '';
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function fmtMoney(n, ccy) {
  const v = Number(n) || 0;
  return `${ccy || ''} ${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function renderInvoiceHTML(inv) {
  const j = inv.jurisdiction || {};
  const taxIdLabel = j.tax_id_label || 'Tax ID';
  const footerTpl = j.invoice_footer || '';
  const footer = footerTpl.replace('{tax_id}', inv.entity_tax_id || '—');
  const contactAddr = [inv.contact_addr1, inv.contact_addr2, [inv.contact_postal, inv.contact_city].filter(Boolean).join(' '), inv.contact_country]
    .filter(Boolean).map(htmlEscape).join('<br>');
  let logoTag = '';
  if (inv.entity_logo_path) {
    try {
      const buf = readAttachment(inv.entity_logo_path);
      if (buf) {
        const b64 = buf.toString('base64');
        const mime = inv.entity_logo_mime || 'image/png';
        logoTag = `<img class="entity-logo" src="data:${mime};base64,${b64}" alt="logo" />`;
      }
    } catch (_) {}
  }
  const linesHtml = inv.lines.map(l => `
    <tr>
      <td>${htmlEscape(l.description)}</td>
      <td class="num">${(Number(l.quantity)).toLocaleString()}</td>
      <td class="num">${fmtMoney(l.unit_price, inv.currency)}</td>
      <td class="num">${(Number(l.tax_rate) * 100).toFixed(2)}%</td>
      <td class="num">${fmtMoney(l.line_total, inv.currency)}</td>
    </tr>
  `).join('');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>Invoice ${htmlEscape(inv.number)}</title>
<style>
  @page { size: A4; margin: 18mm; }
  body { font: 12pt/1.4 -apple-system, "Helvetica Neue", Arial, sans-serif; color: #111; max-width: 800px; margin: 0 auto; padding: 24px; }
  header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 32px; border-bottom: 2px solid #111; padding-bottom: 16px; }
  .from h1 { margin: 0 0 4px; font-size: 18pt; }
  .from .small, .meta .small { color: #555; font-size: 10pt; }
  .meta { text-align: right; }
  .meta .number { font-size: 22pt; font-weight: 600; letter-spacing: 0.02em; }
  .bill-to { margin: 24px 0; }
  .bill-to h3 { margin: 0 0 4px; font-size: 10pt; color: #555; text-transform: uppercase; letter-spacing: 0.06em; }
  .bill-to .name { font-weight: 600; }
  table.lines { width: 100%; border-collapse: collapse; margin: 24px 0; }
  table.lines th, table.lines td { padding: 8px 6px; border-bottom: 1px solid #ddd; vertical-align: top; }
  table.lines th { text-align: left; font-size: 9pt; color: #555; text-transform: uppercase; letter-spacing: 0.05em; }
  table.lines td.num, table.lines th.num { text-align: right; white-space: nowrap; }
  .totals { width: 320px; margin-left: auto; }
  .totals .row { display: flex; justify-content: space-between; padding: 4px 0; }
  .totals .row.grand { font-weight: 700; font-size: 14pt; border-top: 2px solid #111; padding-top: 8px; margin-top: 6px; }
  footer { margin-top: 48px; font-size: 9pt; color: #555; border-top: 1px solid #ddd; padding-top: 12px; }
  .status { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 9pt; text-transform: uppercase; letter-spacing: 0.05em; }
  .status.draft { background: #f3f4f6; color: #555; }
  .status.sent  { background: #dbeafe; color: #1e3a8a; }
  .status.paid  { background: #d1fae5; color: #065f46; }
  .status.void  { background: #fee2e2; color: #991b1b; }
  .print-bar { background: #f3f4f6; padding: 12px; text-align: center; margin-bottom: 16px; }
  .print-bar button { padding: 8px 16px; border: 1px solid #111; background: white; cursor: pointer; }
  .entity-logo { max-height: 64px; max-width: 200px; margin-bottom: 10px; display: block; }
  @media print { .print-bar { display: none; } body { padding: 0; } }
</style>
</head><body>
<div class="print-bar">
  <button onclick="window.print()">Print / Save as PDF</button>
</div>
<header>
  <div class="from">
    ${logoTag}
    <h1>${htmlEscape(inv.entity_legal_name)}</h1>
    <div class="small">${htmlEscape(inv.entity_address || '')}</div>
    ${inv.entity_tax_id ? `<div class="small">${htmlEscape(taxIdLabel)}: ${htmlEscape(inv.entity_tax_id)}</div>` : ''}
  </div>
  <div class="meta">
    <div class="number">${inv.direction === 'purchase' ? 'BILL' : 'INVOICE'}</div>
    <div class="small"># ${htmlEscape(inv.number)}${inv.external_number ? ` (ref ${htmlEscape(inv.external_number)})` : ''}</div>
    <div class="small">Issued ${htmlEscape(inv.issue_date)}</div>
    ${inv.due_date ? `<div class="small">Due ${htmlEscape(inv.due_date)}</div>` : ''}
    <div style="margin-top:6px"><span class="status ${htmlEscape(inv.status)}">${htmlEscape(inv.status)}</span></div>
  </div>
</header>

<div class="bill-to">
  <h3>Bill to</h3>
  <div class="name">${htmlEscape(inv.contact_legal_name || inv.contact_display_name)}</div>
  ${contactAddr ? `<div class="small">${contactAddr}</div>` : ''}
  ${inv.contact_tax_id ? `<div class="small">Tax ID: ${htmlEscape(inv.contact_tax_id)}</div>` : ''}
  ${inv.contact_email ? `<div class="small">${htmlEscape(inv.contact_email)}</div>` : ''}
  ${inv.po_reference ? `<div class="small">PO: ${htmlEscape(inv.po_reference)}</div>` : ''}
</div>

<table class="lines">
  <thead><tr>
    <th>Description</th>
    <th class="num">Qty</th>
    <th class="num">Unit</th>
    <th class="num">Tax</th>
    <th class="num">Total</th>
  </tr></thead>
  <tbody>${linesHtml || '<tr><td colspan="5" style="text-align:center;color:#999;padding:24px">No line items</td></tr>'}</tbody>
</table>

<div class="totals">
  <div class="row"><span>Subtotal</span><span>${fmtMoney(inv.subtotal, inv.currency)}</span></div>
  <div class="row"><span>Tax</span><span>${fmtMoney(inv.tax_total, inv.currency)}</span></div>
  <div class="row grand"><span>Total</span><span>${fmtMoney(inv.total, inv.currency)}</span></div>
</div>

${inv.entity_invoice_header ? `<div style="margin-top:18px;padding:10px 14px;background:#f9f9fa;border-radius:6px;font-size:10pt">${htmlEscape(inv.entity_invoice_header)}</div>` : ''}

${inv.notes ? `<div style="margin-top:24px"><h3 style="font-size:10pt;color:#555;text-transform:uppercase;letter-spacing:.05em">Notes</h3><div>${htmlEscape(inv.notes)}</div></div>` : ''}

${inv.entity_invoice_footer ? `<div style="margin-top:24px;font-size:9pt;color:#444;white-space:pre-wrap">${htmlEscape(inv.entity_invoice_footer)}</div>` : ''}

<footer>${htmlEscape(footer)}</footer>
</body></html>`;
}

// ==================================================================
// Attachments helpers (raw-body upload pattern, no new deps)
// ==================================================================

const ATTACH_DIR = path.join(DATA_DIR, 'attachments');
if (!fs.existsSync(ATTACH_DIR)) fs.mkdirSync(ATTACH_DIR, { recursive: true });

function safeFilename(s) {
  return String(s || 'file').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 200) || 'file';
}

function saveAttachment(kind, ownerId, filename, mime, buffer) {
  const dir = path.join(ATTACH_DIR, kind, String(ownerId));
  fs.mkdirSync(dir, { recursive: true });
  const safe = safeFilename(filename);
  const full = path.join(dir, safe);
  fs.writeFileSync(full, buffer);
  return {
    rel_path: path.relative(DATA_DIR, full),
    name: safe,
    mime: mime || 'application/octet-stream',
    size: buffer.length,
  };
}

function readAttachment(relPath) {
  const full = path.join(DATA_DIR, relPath);
  if (!full.startsWith(DATA_DIR)) throw new Error('path traversal');
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full);
}

const rawBodyMb = express.raw({ type: '*/*', limit: '100mb' });

// ==================================================================
// Contracts
// ==================================================================

function loadContract(id) {
  const row = db.prepare(`
    SELECT c.*,
           e.code AS entity_code, e.legal_name AS entity_legal_name,
           p.display_name AS counterparty_name
      FROM contracts c
      JOIN entities e ON e.id = c.entity_id
      JOIN contacts p ON p.id = c.counterparty_id
     WHERE c.id = ?
  `).get(id);
  return row || null;
}

app.get('/api/contracts', (req, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.title, c.contract_type, c.reference,
           c.start_date, c.end_date, c.auto_renew, c.renewal_notice_days,
           c.value_amount, c.value_currency, c.status,
           c.file_name, c.file_size,
           c.entity_id, e.code AS entity_code,
           c.counterparty_id, p.display_name AS counterparty_name,
           c.updated_at
      FROM contracts c
      JOIN entities e ON e.id = c.entity_id
      JOIN contacts p ON p.id = c.counterparty_id
     ORDER BY (c.end_date IS NULL), c.end_date, c.title
  `).all();
  res.json(rows);
});

app.get('/api/contracts/:id', (req, res) => {
  const c = loadContract(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json(c);
});

const CONTRACT_COLS = [
  'entity_id', 'counterparty_id', 'title', 'contract_type', 'reference',
  'start_date', 'end_date', 'auto_renew', 'renewal_notice_days',
  'value_amount', 'value_currency', 'status', 'notes'
];

function normaliseContract(body) {
  const o = {};
  for (const c of CONTRACT_COLS) {
    let v = body[c];
    if (v === '' || v === undefined) v = null;
    o[c] = v;
  }
  o.auto_renew = body.auto_renew ? 1 : 0;
  if (!o.status) o.status = 'active';
  if (!o.title) throw new Error('title required');
  if (!o.entity_id) throw new Error('entity_id required');
  if (!o.counterparty_id) throw new Error('counterparty_id required');
  return o;
}

app.post('/api/contracts', (req, res) => {
  let data;
  try { data = normaliseContract(req.body || {}); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  const cols = CONTRACT_COLS.join(', ');
  const placeholders = CONTRACT_COLS.map(c => '@' + c).join(', ');
  const result = db.prepare(`INSERT INTO contracts (${cols}) VALUES (${placeholders})`).run(data);
  const id = result.lastInsertRowid;
  const after = loadContract(id);
  audit('contracts', id, 'insert', null, after);
  res.json(after);
});

app.put('/api/contracts/:id', (req, res) => {
  const id = Number(req.params.id);
  const before = loadContract(id);
  if (!before) return res.status(404).json({ error: 'not found' });
  let data;
  try { data = normaliseContract({ ...before, ...req.body }); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  const setClause = CONTRACT_COLS.map(c => `${c} = @${c}`).join(', ');
  db.prepare(
    `UPDATE contracts SET ${setClause}, updated_at = datetime('now') WHERE id = @id`
  ).run({ ...data, id });
  const after = loadContract(id);
  audit('contracts', id, 'update', before, after);
  res.json(after);
});

app.delete('/api/contracts/:id', (req, res) => {
  const id = Number(req.params.id);
  const before = loadContract(id);
  if (!before) return res.status(404).json({ error: 'not found' });
  if (req.query.hard === '1') {
    if (blockIfReferenced('contracts', id, res)) return;
    // remove attached file too
    if (before.file_path) {
      try { fs.unlinkSync(path.join(DATA_DIR, before.file_path)); } catch (_) {}
      try { fs.rmdirSync(path.join(DATA_DIR, 'attachments', 'contracts', String(id))); } catch (_) {}
    }
    db.prepare('DELETE FROM contracts WHERE id = ?').run(id);
    audit('contracts', id, 'delete', before, null);
  } else {
    db.prepare(`UPDATE contracts SET status='terminated', updated_at=datetime('now') WHERE id=?`).run(id);
    const after = loadContract(id);
    audit('contracts', id, 'terminate', before, after);
  }
  res.json({ ok: true });
});

app.post('/api/contracts/:id/file', rawBodyMb, (req, res) => {
  const id = Number(req.params.id);
  const before = loadContract(id);
  if (!before) return res.status(404).json({ error: 'not found' });
  const filename = req.headers['x-filename'] || 'file.bin';
  const mime = req.headers['content-type'] || 'application/octet-stream';
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'empty body' });
  // Archive existing file as a version before overwriting
  if (before.file_path) {
    db.prepare(`INSERT INTO contract_file_versions (contract_id, file_path, file_name, file_mime, file_size) VALUES (?, ?, ?, ?, ?)`)
      .run(id, before.file_path, before.file_name, before.file_mime, before.file_size);
    // Trim to last 5 versions
    const stale = db.prepare(`SELECT id FROM contract_file_versions WHERE contract_id = ? ORDER BY id DESC LIMIT -1 OFFSET 5`).all(id);
    for (const s of stale) db.prepare('DELETE FROM contract_file_versions WHERE id = ?').run(s.id);
  }
  const meta = saveAttachment('contracts', id, filename, mime, req.body);
  db.prepare(
    `UPDATE contracts
        SET file_path = ?, file_name = ?, file_mime = ?, file_size = ?, updated_at = datetime('now')
      WHERE id = ?`
  ).run(meta.rel_path, meta.name, meta.mime, meta.size, id);
  audit('contracts', id, 'attach', { file_name: before.file_name }, meta);
  res.json(loadContract(id));
});

app.get('/api/contracts/:id/file-versions', (req, res) => {
  const id = Number(req.params.id);
  const rows = db.prepare('SELECT * FROM contract_file_versions WHERE contract_id = ? ORDER BY archived_at DESC').all(id);
  res.json(rows);
});

app.get('/api/contracts/:id/file-version/:versionId', (req, res) => {
  const v = db.prepare('SELECT * FROM contract_file_versions WHERE id = ? AND contract_id = ?').get(Number(req.params.versionId), Number(req.params.id));
  if (!v) return res.status(404).json({ error: 'not found' });
  const buf = readAttachment(v.file_path);
  if (!buf) return res.status(404).json({ error: 'file missing on disk' });
  res.set('Content-Type', v.file_mime || 'application/octet-stream');
  res.set('Content-Disposition', `attachment; filename="${v.file_name}"`);
  res.send(buf);
});

app.get('/api/contracts/:id/file', (req, res) => {
  const c = loadContract(Number(req.params.id));
  if (!c || !c.file_path) return res.status(404).json({ error: 'no file' });
  const buf = readAttachment(c.file_path);
  if (!buf) return res.status(404).json({ error: 'file missing on disk' });
  res.set('Content-Type', c.file_mime || 'application/octet-stream');
  res.set('Content-Disposition', `inline; filename="${c.file_name}"`);
  res.send(buf);
});

// ==================================================================
// KYC
// ==================================================================

function loadKyc(id) {
  const row = db.prepare(`
    SELECT k.*,
           c.display_name AS contact_display_name,
           c.contact_type, c.jurisdiction_code
      FROM kyc_records k
      JOIN contacts c ON c.id = k.contact_id
     WHERE k.id = ?
  `).get(id);
  if (!row) return null;
  row.documents = db.prepare(
    'SELECT * FROM kyc_documents WHERE kyc_record_id = ? ORDER BY uploaded_at DESC'
  ).all(id);
  return row;
}

app.get('/api/kyc', (req, res) => {
  const rows = db.prepare(`
    SELECT k.id, k.contact_id, c.display_name AS contact_display_name,
           c.contact_type, c.jurisdiction_code,
           k.risk_tier, k.status, k.refresh_due, k.verified_at,
           (SELECT COUNT(*) FROM kyc_documents d WHERE d.kyc_record_id = k.id) AS doc_count,
           k.updated_at
      FROM kyc_records k
      JOIN contacts c ON c.id = k.contact_id
     ORDER BY
       CASE k.status WHEN 'pending' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END,
       (k.refresh_due IS NULL),
       k.refresh_due
  `).all();
  res.json(rows);
});

app.get('/api/kyc/:id', (req, res) => {
  const k = loadKyc(Number(req.params.id));
  if (!k) return res.status(404).json({ error: 'not found' });
  res.json(k);
});

const KYC_COLS = [
  'contact_id', 'risk_tier', 'status', 'verified_at', 'refresh_due',
  'source_of_funds', 'beneficial_owners', 'pep_check', 'sanctions_check', 'notes'
];

function normaliseKyc(body) {
  const o = {};
  for (const c of KYC_COLS) {
    let v = body[c];
    if (v === '' || v === undefined) v = null;
    o[c] = v;
  }
  o.pep_check = body.pep_check ? 1 : 0;
  o.sanctions_check = body.sanctions_check ? 1 : 0;
  if (!o.risk_tier) o.risk_tier = 'medium';
  if (!o.status) o.status = 'pending';
  if (!o.contact_id) throw new Error('contact_id required');
  return o;
}

app.post('/api/kyc', (req, res) => {
  let data;
  try { data = normaliseKyc(req.body || {}); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  const existing = db.prepare('SELECT id FROM kyc_records WHERE contact_id = ?').get(data.contact_id);
  if (existing) return res.status(409).json({ error: 'kyc record already exists for contact', id: existing.id });
  const cols = KYC_COLS.join(', ');
  const placeholders = KYC_COLS.map(c => '@' + c).join(', ');
  const result = db.prepare(`INSERT INTO kyc_records (${cols}) VALUES (${placeholders})`).run(data);
  const id = result.lastInsertRowid;
  const after = loadKyc(id);
  audit('kyc_records', id, 'insert', null, after);
  res.json(after);
});

app.put('/api/kyc/:id', (req, res) => {
  const id = Number(req.params.id);
  const before = loadKyc(id);
  if (!before) return res.status(404).json({ error: 'not found' });
  let data;
  try { data = normaliseKyc({ ...before, ...req.body }); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  const setClause = KYC_COLS.map(c => `${c} = @${c}`).join(', ');
  db.prepare(
    `UPDATE kyc_records SET ${setClause}, updated_at = datetime('now') WHERE id = @id`
  ).run({ ...data, id });
  const after = loadKyc(id);
  audit('kyc_records', id, 'update', before, after);
  res.json(after);
});

app.delete('/api/kyc/:id', (req, res) => {
  const id = Number(req.params.id);
  const before = loadKyc(id);
  if (!before) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM kyc_records WHERE id = ?').run(id);
  audit('kyc_records', id, 'delete', before, null);
  res.json({ ok: true });
});

app.post('/api/kyc/:id/document', rawBodyMb, (req, res) => {
  const id = Number(req.params.id);
  const before = loadKyc(id);
  if (!before) return res.status(404).json({ error: 'not found' });
  const filename = req.headers['x-filename'] || 'doc.bin';
  const mime = req.headers['content-type'] || 'application/octet-stream';
  const docType = req.headers['x-doc-type'] || 'other';
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'empty body' });
  const meta = saveAttachment('kyc', id, filename, mime, req.body);
  const result = db.prepare(
    `INSERT INTO kyc_documents (kyc_record_id, doc_type, file_path, file_name, file_mime, file_size)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, docType, meta.rel_path, meta.name, meta.mime, meta.size);
  audit('kyc_documents', result.lastInsertRowid, 'insert', null, meta);
  res.json(loadKyc(id));
});

app.get('/api/kyc/document/:docId', (req, res) => {
  const d = db.prepare('SELECT * FROM kyc_documents WHERE id = ?').get(Number(req.params.docId));
  if (!d) return res.status(404).json({ error: 'not found' });
  const buf = readAttachment(d.file_path);
  if (!buf) return res.status(404).json({ error: 'file missing on disk' });
  res.set('Content-Type', d.file_mime || 'application/octet-stream');
  res.set('Content-Disposition', `inline; filename="${d.file_name}"`);
  res.send(buf);
});

app.delete('/api/kyc/document/:docId', (req, res) => {
  const d = db.prepare('SELECT * FROM kyc_documents WHERE id = ?').get(Number(req.params.docId));
  if (!d) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM kyc_documents WHERE id = ?').run(d.id);
  // delete file from disk too
  try { fs.unlinkSync(path.join(DATA_DIR, d.file_path)); } catch (_) {}
  audit('kyc_documents', d.id, 'delete', d, null);
  res.json({ ok: true });
});

// ==================================================================
// Banking
// ==================================================================

app.get('/api/bank-accounts', (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, e.code AS entity_code,
           (SELECT COUNT(*) FROM bank_transactions t WHERE t.account_id = a.id) AS tx_count,
           (SELECT COUNT(*) FROM bank_transactions t WHERE t.account_id = a.id AND t.reconciled = 0) AS unreconciled_count,
           a.opening_balance + COALESCE((SELECT SUM(t.amount) FROM bank_transactions t WHERE t.account_id = a.id), 0) AS current_balance
      FROM bank_accounts a
      JOIN entities e ON e.id = a.entity_id
     ORDER BY e.code, a.bank_name, a.account_label
  `).all();
  res.json(rows);
});

const BANK_ACCT_COLS = [
  'entity_id', 'bank_name', 'account_label', 'account_number', 'iban', 'swift_bic',
  'currency', 'opening_balance', 'status', 'notes',
  'provider', 'credential_id'
];

function normaliseBankAcct(body) {
  const o = {};
  for (const c of BANK_ACCT_COLS) {
    let v = body[c];
    if (v === '' || v === undefined) v = null;
    o[c] = v;
  }
  if (!o.status) o.status = 'active';
  if (!o.provider) o.provider = 'csv';
  if (!o.entity_id)     throw new Error('entity_id required');
  if (!o.bank_name)     throw new Error('bank_name required');
  if (!o.account_label) throw new Error('account_label required');
  if (!o.currency)      throw new Error('currency required');
  o.currency = String(o.currency).toUpperCase();
  o.opening_balance = Number(o.opening_balance) || 0;
  if (o.credential_id) o.credential_id = Number(o.credential_id);
  return o;
}

app.post('/api/bank-accounts', (req, res) => {
  let data;
  try { data = normaliseBankAcct(req.body || {}); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  const cols = BANK_ACCT_COLS.join(', ');
  const placeholders = BANK_ACCT_COLS.map(c => '@' + c).join(', ');
  const result = db.prepare(`INSERT INTO bank_accounts (${cols}) VALUES (${placeholders})`).run(data);
  const id = result.lastInsertRowid;
  audit('bank_accounts', id, 'insert', null, { ...data, id });
  res.json({ ...data, id });
});

app.put('/api/bank-accounts/:id', (req, res) => {
  const id = Number(req.params.id);
  const before = db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(id);
  if (!before) return res.status(404).json({ error: 'not found' });
  let data;
  try { data = normaliseBankAcct({ ...before, ...req.body }); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  const setClause = BANK_ACCT_COLS.map(c => `${c} = @${c}`).join(', ');
  db.prepare(`UPDATE bank_accounts SET ${setClause}, updated_at = datetime('now') WHERE id = @id`).run({ ...data, id });
  const after = db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(id);
  audit('bank_accounts', id, 'update', before, after);
  res.json(after);
});

app.delete('/api/bank-accounts/:id', (req, res) => {
  const id = Number(req.params.id);
  const before = db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(id);
  if (!before) return res.status(404).json({ error: 'not found' });
  if (req.query.hard === '1') {
    if (blockIfReferenced('bank_accounts', id, res)) return;
    db.prepare('DELETE FROM bank_accounts WHERE id = ?').run(id);
    audit('bank_accounts', id, 'delete', before, null);
  } else {
    db.prepare(`UPDATE bank_accounts SET status='archived' WHERE id = ?`).run(id);
    audit('bank_accounts', id, 'archive', before, null);
  }
  res.json({ ok: true });
});

app.get('/api/bank-transactions', (req, res) => {
  const accountId = req.query.account_id ? Number(req.query.account_id) : null;
  const stmt = accountId
    ? db.prepare(`
        SELECT t.*, a.bank_name, a.account_label,
               i.number AS invoice_number
          FROM bank_transactions t
          JOIN bank_accounts a ON a.id = t.account_id
          LEFT JOIN invoices i ON i.id = t.matched_invoice_id
         WHERE t.account_id = ?
         ORDER BY t.txn_date DESC, t.id DESC
      `)
    : db.prepare(`
        SELECT t.*, a.bank_name, a.account_label,
               i.number AS invoice_number
          FROM bank_transactions t
          JOIN bank_accounts a ON a.id = t.account_id
          LEFT JOIN invoices i ON i.id = t.matched_invoice_id
         ORDER BY t.txn_date DESC, t.id DESC
         LIMIT 500
      `);
  res.json(accountId ? stmt.all(accountId) : stmt.all());
});

app.post('/api/bank-transactions/import', (req, res) => {
  const body = req.body || {};
  const accountId = Number(body.account_id);
  const acct = db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(accountId);
  if (!acct) return res.status(404).json({ error: 'unknown account' });
  const rows = Array.isArray(body.transactions) ? body.transactions : [];
  let inserted = 0, skipped = 0;
  const ins = db.prepare(`
    INSERT OR IGNORE INTO bank_transactions
      (account_id, txn_date, description, reference, amount, currency, category, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const r of rows) {
      const result = ins.run(
        accountId,
        r.txn_date || r.date,
        r.description || null,
        r.reference || null,
        Number(r.amount) || 0,
        (r.currency || acct.currency).toUpperCase(),
        r.category || null,
        r.notes || null
      );
      if (result.changes) inserted++; else skipped++;
    }
  });
  tx();
  audit('bank_transactions', accountId, 'import', null, { inserted, skipped, total: rows.length });
  res.json({ inserted, skipped, total: rows.length });
});

app.post('/api/bank-transactions/:id/match', (req, res) => {
  const id = Number(req.params.id);
  const tx = db.prepare('SELECT * FROM bank_transactions WHERE id = ?').get(id);
  if (!tx) return res.status(404).json({ error: 'not found' });
  const invoiceId = req.body && req.body.invoice_id ? Number(req.body.invoice_id) : null;
  if (invoiceId) {
    const inv = db.prepare('SELECT id FROM invoices WHERE id = ?').get(invoiceId);
    if (!inv) return res.status(400).json({ error: 'unknown invoice' });
  }
  db.prepare(
    `UPDATE bank_transactions SET matched_invoice_id = ?, reconciled = ? WHERE id = ?`
  ).run(invoiceId, invoiceId ? 1 : 0, id);
  // also flip the invoice status to paid when we link payment
  if (invoiceId && req.body && req.body.mark_invoice_paid !== false) {
    db.prepare(`UPDATE invoices SET status='paid', updated_at=datetime('now') WHERE id=?`).run(invoiceId);
  }
  const after = db.prepare('SELECT * FROM bank_transactions WHERE id = ?').get(id);
  audit('bank_transactions', id, 'match', tx, after);
  res.json(after);
});

app.delete('/api/bank-transactions/:id', (req, res) => {
  const id = Number(req.params.id);
  const before = db.prepare('SELECT * FROM bank_transactions WHERE id = ?').get(id);
  if (!before) return res.status(404).json({ error: 'not found' });
  if (blockIfReferenced('bank_transactions', id, res)) return;
  db.prepare('DELETE FROM bank_transactions WHERE id = ?').run(id);
  audit('bank_transactions', id, 'delete', before, null);
  res.json({ ok: true });
});

// ==================================================================
// Money flows
// ==================================================================

function loadFlow(id) {
  return db.prepare(`
    SELECT f.*,
           fe.code AS from_entity_code, te.code AS to_entity_code,
           fc.display_name AS from_contact_name, tc.display_name AS to_contact_name
      FROM money_flows f
      LEFT JOIN entities fe ON fe.id = f.from_entity_id
      LEFT JOIN entities te ON te.id = f.to_entity_id
      LEFT JOIN contacts fc ON fc.id = f.from_contact_id
      LEFT JOIN contacts tc ON tc.id = f.to_contact_id
     WHERE f.id = ?
  `).get(id);
}

app.get('/api/flows', (req, res) => {
  const rows = db.prepare(`
    SELECT f.*,
           fe.code AS from_entity_code, te.code AS to_entity_code,
           fc.display_name AS from_contact_name, tc.display_name AS to_contact_name
      FROM money_flows f
      LEFT JOIN entities fe ON fe.id = f.from_entity_id
      LEFT JOIN entities te ON te.id = f.to_entity_id
      LEFT JOIN contacts fc ON fc.id = f.from_contact_id
      LEFT JOIN contacts tc ON tc.id = f.to_contact_id
     ORDER BY f.flow_date DESC, f.id DESC
  `).all();
  res.json(rows);
});

app.get('/api/flows/summary', (req, res) => {
  // aggregate entity ↔ entity net flow (in USD-equivalent via fx_rate_to_usd)
  const rows = db.prepare(`
    SELECT from_entity_id, to_entity_id, currency,
           SUM(amount) AS total,
           SUM(amount * fx_rate_to_usd) AS total_usd,
           COUNT(*) AS count
      FROM money_flows
     WHERE from_entity_id IS NOT NULL AND to_entity_id IS NOT NULL
     GROUP BY from_entity_id, to_entity_id, currency
     ORDER BY total_usd DESC
  `).all();
  const entities = db.prepare('SELECT id, code, legal_name FROM entities').all();
  res.json({ entities, edges: rows });
});

const FLOW_COLS = [
  'flow_date', 'from_entity_id', 'from_contact_id', 'to_entity_id', 'to_contact_id',
  'amount', 'currency', 'fx_rate_to_usd', 'kind', 'reference', 'bank_tx_id', 'invoice_id', 'notes', 'category'
];

function normaliseFlow(body) {
  const o = {};
  for (const c of FLOW_COLS) {
    let v = body[c];
    if (v === '' || v === undefined) v = null;
    o[c] = v;
  }
  if (!o.flow_date) throw new Error('flow_date required');
  if (o.amount == null) throw new Error('amount required');
  if (!o.currency) throw new Error('currency required');
  if (!o.kind) o.kind = 'transfer';
  if (!o.fx_rate_to_usd) o.fx_rate_to_usd = 1.0;
  o.amount = Number(o.amount);
  o.fx_rate_to_usd = Number(o.fx_rate_to_usd);
  o.currency = String(o.currency).toUpperCase();
  return o;
}

app.post('/api/flows', (req, res) => {
  let data;
  try { data = normaliseFlow(req.body || {}); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  const cols = FLOW_COLS.join(', ');
  const placeholders = FLOW_COLS.map(c => '@' + c).join(', ');
  const result = db.prepare(`INSERT INTO money_flows (${cols}) VALUES (${placeholders})`).run(data);
  const id = result.lastInsertRowid;
  const after = loadFlow(id);
  audit('money_flows', id, 'insert', null, after);
  res.json(after);
});

app.put('/api/flows/:id', (req, res) => {
  const id = Number(req.params.id);
  const before = loadFlow(id);
  if (!before) return res.status(404).json({ error: 'not found' });
  let data;
  try { data = normaliseFlow({ ...before, ...req.body }); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  const setClause = FLOW_COLS.map(c => `${c} = @${c}`).join(', ');
  db.prepare(`UPDATE money_flows SET ${setClause} WHERE id = @id`).run({ ...data, id });
  const after = loadFlow(id);
  audit('money_flows', id, 'update', before, after);
  res.json(after);
});

app.delete('/api/flows/:id', (req, res) => {
  const id = Number(req.params.id);
  const before = loadFlow(id);
  if (!before) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM money_flows WHERE id = ?').run(id);
  audit('money_flows', id, 'delete', before, null);
  res.json({ ok: true });
});

// ==================================================================
// Backup (tar.gz of the data directory via built-in tar)
// ==================================================================

// (Old unencrypted /api/backup removed — encrypted-capable version lives below)

// ==================================================================
// Dashboard
// ==================================================================

app.get('/api/dashboard', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const in60 = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
  const in90 = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);

  const ar_outstanding = db.prepare(`
    SELECT e.code AS entity_code, i.currency, SUM(i.total) AS amount, COUNT(*) AS count
      FROM invoices i JOIN entities e ON e.id = i.entity_id
     WHERE i.direction='sales' AND i.status IN ('draft','sent')
     GROUP BY e.code, i.currency
     ORDER BY e.code
  `).all();

  const ap_outstanding = db.prepare(`
    SELECT e.code AS entity_code, i.currency, SUM(i.total) AS amount, COUNT(*) AS count
      FROM invoices i JOIN entities e ON e.id = i.entity_id
     WHERE i.direction='purchase' AND i.status IN ('draft','sent')
     GROUP BY e.code, i.currency
     ORDER BY e.code
  `).all();

  const overdue_invoices = db.prepare(`
    SELECT i.id, i.number, i.direction, i.due_date, i.currency, i.total, i.status,
           e.code AS entity_code, c.display_name AS contact_display_name,
           CAST(julianday(?) - julianday(i.due_date) AS INTEGER) AS days_overdue
      FROM invoices i
      JOIN entities e ON e.id = i.entity_id
      JOIN contacts c ON c.id = i.contact_id
     WHERE i.due_date IS NOT NULL
       AND i.due_date < ?
       AND i.status IN ('draft','sent')
     ORDER BY i.due_date ASC
     LIMIT 25
  `).all(today, today);

  const expiring_contracts = db.prepare(`
    SELECT c.id, c.title, c.end_date, e.code AS entity_code,
           p.display_name AS counterparty_name,
           CAST(julianday(c.end_date) - julianday(?) AS INTEGER) AS days_left
      FROM contracts c
      JOIN entities e ON e.id = c.entity_id
      JOIN contacts p ON p.id = c.counterparty_id
     WHERE c.status='active' AND c.end_date IS NOT NULL AND c.end_date < ?
     ORDER BY c.end_date ASC
     LIMIT 20
  `).all(today, in60);

  const kyc_due = db.prepare(`
    SELECT k.id, k.refresh_due, k.risk_tier, k.status,
           c.display_name AS contact_display_name,
           CAST(julianday(k.refresh_due) - julianday(?) AS INTEGER) AS days_left
      FROM kyc_records k
      JOIN contacts c ON c.id = k.contact_id
     WHERE k.refresh_due IS NOT NULL AND k.refresh_due < ?
     ORDER BY k.refresh_due ASC
     LIMIT 20
  `).all(today, in90);

  const unreconciled = db.prepare(`
    SELECT a.id AS account_id, a.bank_name, a.account_label, a.currency, e.code AS entity_code,
           COUNT(t.id) AS count, SUM(CASE WHEN t.reconciled=0 THEN t.amount ELSE 0 END) AS pending
      FROM bank_accounts a
      JOIN entities e ON e.id = a.entity_id
      LEFT JOIN bank_transactions t ON t.account_id = a.id AND t.reconciled = 0
     WHERE a.status='active'
     GROUP BY a.id
     ORDER BY count DESC
  `).all();

  const recent_activity = db.prepare(`
    SELECT id, ts, table_name, row_id, action, actor
      FROM audit_log
     ORDER BY id DESC
     LIMIT 12
  `).all();

  const counts = {
    contacts:  db.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE status='active'`).get().n,
    invoices:  db.prepare(`SELECT COUNT(*) AS n FROM invoices WHERE direction='sales'`).get().n,
    bills:     db.prepare(`SELECT COUNT(*) AS n FROM invoices WHERE direction='purchase'`).get().n,
    contracts: db.prepare(`SELECT COUNT(*) AS n FROM contracts WHERE status='active'`).get().n,
    kyc:       db.prepare(`SELECT COUNT(*) AS n FROM kyc_records`).get().n,
    bank_accounts: db.prepare(`SELECT COUNT(*) AS n FROM bank_accounts WHERE status='active'`).get().n,
    flows:     db.prepare(`SELECT COUNT(*) AS n FROM money_flows`).get().n,
  };

  res.json({
    today,
    counts,
    ar_outstanding,
    ap_outstanding,
    overdue_invoices,
    expiring_contracts,
    kyc_due,
    unreconciled,
    recent_activity,
  });
});

app.get('/api/reports/cashflow', (req, res) => {
  const horizon = Math.min(180, Number(req.query.days) || 90);
  const today = new Date();
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayStr = ymd(today);

  const entities = db.prepare(`SELECT id, code, base_currency FROM entities WHERE status='active' ORDER BY code`).all();

  // Build day buckets
  const days = [];
  for (let i = 0; i < horizon; i++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
    days.push(ymd(d));
  }

  const out = entities.map(e => {
    const buckets = days.map(d => ({ date: d, ar_in: 0, ap_out: 0, recurring_in: 0, recurring_out: 0 }));
    const idx = new Map(buckets.map((b, i) => [b.date, i]));

    // Open AR
    const ar = db.prepare(`
      SELECT due_date, issue_date, (total - amount_paid) AS remaining
        FROM invoices
       WHERE entity_id=? AND direction='sales' AND status IN ('draft','sent') AND (total - amount_paid) > 0
    `).all(e.id);
    for (const r of ar) {
      const date = r.due_date || r.issue_date;
      if (!date || date > days[days.length - 1] || date < todayStr) continue;
      const i = idx.get(date);
      if (i !== undefined) buckets[i].ar_in += r.remaining;
    }
    // Open AP
    const ap = db.prepare(`
      SELECT due_date, issue_date, (total - amount_paid) AS remaining
        FROM invoices
       WHERE entity_id=? AND direction='purchase' AND status IN ('draft','sent') AND (total - amount_paid) > 0
    `).all(e.id);
    for (const r of ap) {
      const date = r.due_date || r.issue_date;
      if (!date || date > days[days.length - 1] || date < todayStr) continue;
      const i = idx.get(date);
      if (i !== undefined) buckets[i].ap_out += r.remaining;
    }
    // Active recurring (project forward)
    const recurring = db.prepare(`
      SELECT direction, total, recurrence_kind, recurrence_next_run
        FROM invoices
       WHERE entity_id=? AND recurrence_active=1 AND recurrence_next_run IS NOT NULL
    `).all(e.id);
    for (const r of recurring) {
      let cursor = r.recurrence_next_run;
      while (cursor && cursor <= days[days.length - 1]) {
        if (cursor >= todayStr) {
          const i = idx.get(cursor);
          if (i !== undefined) {
            if (r.direction === 'sales') buckets[i].recurring_in += r.total;
            else buckets[i].recurring_out += r.total;
          }
        }
        const next = advanceRecurrenceDate(cursor, r.recurrence_kind);
        if (next === cursor) break;
        cursor = next;
      }
    }
    // running net
    let running = 0;
    const days_with_net = buckets.map(b => {
      const net = b.ar_in + b.recurring_in - b.ap_out - b.recurring_out;
      running += net;
      return { ...b, net, running };
    });
    return {
      entity_id: e.id, code: e.code, base_currency: e.base_currency,
      horizon, days: days_with_net,
      totals: {
        ar_in:        days_with_net.reduce((s, b) => s + b.ar_in, 0),
        ap_out:       days_with_net.reduce((s, b) => s + b.ap_out, 0),
        recurring_in: days_with_net.reduce((s, b) => s + b.recurring_in, 0),
        recurring_out:days_with_net.reduce((s, b) => s + b.recurring_out, 0),
        net_horizon:  days_with_net.reduce((s, b) => s + b.net, 0),
      },
    };
  });
  res.json({ today: todayStr, horizon, entities: out });
});

app.get('/api/dashboard/top', (req, res) => {
  const today = new Date();
  const start = `${today.getFullYear() - 1}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
  const customers = db.prepare(`
    SELECT c.id, c.display_name,
           COUNT(*) AS invoice_count,
           SUM(i.total) AS total,
           i.currency
      FROM invoices i
      JOIN contacts c ON c.id = i.contact_id
     WHERE i.direction='sales' AND i.status IN ('paid','sent') AND i.issue_date >= ?
     GROUP BY c.id, i.currency
     ORDER BY total DESC
     LIMIT 5
  `).all(start);
  const suppliers = db.prepare(`
    SELECT c.id, c.display_name,
           COUNT(*) AS invoice_count,
           SUM(i.total) AS total,
           i.currency
      FROM invoices i
      JOIN contacts c ON c.id = i.contact_id
     WHERE i.direction='purchase' AND i.status IN ('paid','sent') AND i.issue_date >= ?
     GROUP BY c.id, i.currency
     ORDER BY total DESC
     LIMIT 5
  `).all(start);
  res.json({ customers, suppliers, since: start });
});

app.get('/api/dashboard/trend', (req, res) => {
  const entities = db.prepare(`SELECT id, code, base_currency FROM entities WHERE status='active' ORDER BY code`).all();
  const today = new Date();
  const months = [];
  const pad = n => String(n).padStart(2, '0');
  for (let i = 11; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const ym = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    months.push({ start: `${ym}-01`, label: ym });
  }
  const series = entities.map(e => {
    const points = months.map((m, idx) => {
      const next = idx === months.length - 1
        ? new Date(today.getFullYear(), today.getMonth() + 1, 1).toISOString().slice(0, 10)
        : months[idx + 1].start;
      const rev = db.prepare(`SELECT COALESCE(SUM(total),0) AS s FROM invoices WHERE entity_id=? AND direction='sales' AND issue_date>=? AND issue_date<?`).get(e.id, m.start, next).s || 0;
      const exp = db.prepare(`SELECT COALESCE(SUM(total),0) AS s FROM invoices WHERE entity_id=? AND direction='purchase' AND issue_date>=? AND issue_date<?`).get(e.id, m.start, next).s || 0;
      return { month: m.label, revenue: rev, expense: exp };
    });
    return { entity_id: e.id, code: e.code, base_currency: e.base_currency, points };
  });
  res.json({ months: months.map(m => m.label), series });
});

app.get('/api/dashboard/hero', (req, res) => {
  const entities = db.prepare(`SELECT * FROM entities WHERE status='active' ORDER BY code`).all();
  const today = new Date();
  const ytdStart = today.getFullYear() + '-01-01';

  const sumOf = (sql, ...args) => db.prepare(sql).get(...args).s || 0;

  const out = entities.map(e => {
    const ytdRev  = sumOf(`SELECT COALESCE(SUM(total),0) AS s FROM invoices WHERE entity_id=? AND direction='sales'    AND status='paid' AND issue_date>=?`, e.id, ytdStart);
    const ytdExp  = sumOf(`SELECT COALESCE(SUM(total),0) AS s FROM invoices WHERE entity_id=? AND direction='purchase' AND status='paid' AND issue_date>=?`, e.id, ytdStart);
    const arOpen  = sumOf(`SELECT COALESCE(SUM(total),0) AS s FROM invoices WHERE entity_id=? AND direction='sales'    AND status IN ('draft','sent')`, e.id);
    const apOpen  = sumOf(`SELECT COALESCE(SUM(total),0) AS s FROM invoices WHERE entity_id=? AND direction='purchase' AND status IN ('draft','sent')`, e.id);
    const cash    = sumOf(`
      SELECT COALESCE(SUM(a.opening_balance + COALESCE((SELECT SUM(t.amount) FROM bank_transactions t WHERE t.account_id = a.id), 0)),0) AS s
        FROM bank_accounts a WHERE a.entity_id=? AND a.status='active'
    `, e.id);

    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d   = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const nx  = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      const s   = d.toISOString().slice(0, 10);
      const eS  = nx.toISOString().slice(0, 10);
      const rev = sumOf(`SELECT COALESCE(SUM(total),0) AS s FROM invoices WHERE entity_id=? AND direction='sales'    AND issue_date>=? AND issue_date<?`, e.id, s, eS);
      const exp = sumOf(`SELECT COALESCE(SUM(total),0) AS s FROM invoices WHERE entity_id=? AND direction='purchase' AND issue_date>=? AND issue_date<?`, e.id, s, eS);
      months.push({ month: d.toISOString().slice(0, 7), revenue: rev, expense: exp });
    }
    // Cash runway: cash on hand ÷ avg net burn over last 90 days (only if burning).
    const ninety = new Date(today.getTime() - 90 * 86400000).toISOString().slice(0, 10);
    const expIn90 = sumOf(
      `SELECT COALESCE(SUM(total),0) AS s FROM invoices
        WHERE entity_id=? AND direction='purchase' AND issue_date>=?`,
      e.id, ninety
    );
    const revIn90 = sumOf(
      `SELECT COALESCE(SUM(total),0) AS s FROM invoices
        WHERE entity_id=? AND direction='sales' AND issue_date>=?`,
      e.id, ninety
    );
    const dailyBurn  = (expIn90 - revIn90) / 90;        // > 0 means burning
    const runwayDays = dailyBurn > 0 ? cash / dailyBurn : null;
    const runwayMonths = runwayDays != null ? +(runwayDays / 30).toFixed(1) : null;

    return {
      id: e.id, code: e.code, legal_name: e.legal_name, base_currency: e.base_currency,
      ytd_revenue: ytdRev, ytd_expense: ytdExp,
      ar_open: arOpen, ap_open: apOpen, cash_on_hand: cash,
      runway_months: runwayMonths, daily_burn: dailyBurn > 0 ? dailyBurn : 0,
      monthly: months,
    };
  });
  res.json(out);
});

// ==================================================================
// Reports
// ==================================================================

app.get('/api/reports/pl', (req, res) => {
  // Per-entity rollup grouped by direction + status + currency
  const rows = db.prepare(`
    SELECT e.id AS entity_id, e.code AS entity_code, e.base_currency,
           i.direction, i.currency, i.status,
           SUM(i.total) AS total,
           SUM(i.total * i.fx_rate_to_base) AS total_in_base,
           COUNT(*) AS count
      FROM invoices i
      JOIN entities e ON e.id = i.entity_id
     GROUP BY e.id, i.direction, i.currency, i.status
     ORDER BY e.code, i.direction, i.status
  `).all();
  // shape into per-entity buckets in base currency
  const entities = db.prepare('SELECT id, code, base_currency, legal_name FROM entities').all();
  const out = entities.map(e => {
    const my = rows.filter(r => r.entity_id === e.id);
    const sum = (dir, statuses) => my
      .filter(r => r.direction === dir && statuses.includes(r.status))
      .reduce((a, r) => a + (r.total_in_base || 0), 0);
    return {
      entity_id: e.id,
      entity_code: e.code,
      legal_name: e.legal_name,
      base_currency: e.base_currency,
      revenue_paid: sum('sales',    ['paid']),
      revenue_open: sum('sales',    ['draft','sent']),
      expense_paid: sum('purchase', ['paid']),
      expense_open: sum('purchase', ['draft','sent']),
    };
  });
  res.json(out);
});

app.get('/api/reports/aging', (req, res) => {
  const direction = req.query.direction === 'purchase' ? 'purchase' : 'sales';
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT e.code AS entity_code, i.currency,
           CASE
             WHEN i.due_date IS NULL OR i.due_date >= ? THEN 'current'
             WHEN julianday(?) - julianday(i.due_date) <= 30  THEN 'd30'
             WHEN julianday(?) - julianday(i.due_date) <= 60  THEN 'd60'
             WHEN julianday(?) - julianday(i.due_date) <= 90  THEN 'd90'
             ELSE 'd90p'
           END AS bucket,
           SUM(i.total) AS amount
      FROM invoices i
      JOIN entities e ON e.id = i.entity_id
     WHERE i.direction = ? AND i.status IN ('draft','sent')
     GROUP BY e.code, i.currency, bucket
  `).all(today, today, today, today, direction);

  const grouped = {};
  for (const r of rows) {
    const key = `${r.entity_code}|${r.currency}`;
    if (!grouped[key]) grouped[key] = {
      entity_code: r.entity_code, currency: r.currency,
      current: 0, d30: 0, d60: 0, d90: 0, d90p: 0, total: 0
    };
    grouped[key][r.bucket] = r.amount;
    grouped[key].total += r.amount;
  }
  res.json(Object.values(grouped));
});

// ==================================================================
// API credentials vault + sync runs
// ==================================================================

const CRED_COLS = [
  'provider', 'label', 'entity_id', 'bank_account_id',
  'client_id', 'client_secret', 'api_key',
  'access_token', 'refresh_token', 'token_expires_at',
  'environment', 'status', 'notes', 'sync_interval_minutes',
];

function maskCred(row) {
  if (!row) return row;
  const m = { ...row };
  for (const f of ['client_secret', 'api_key', 'access_token', 'refresh_token']) {
    if (m[f]) m[f] = '••••' + String(m[f]).slice(-4);
  }
  return m;
}

app.get('/api/credentials', (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, e.code AS entity_code, b.bank_name, b.account_label
      FROM api_credentials c
      LEFT JOIN entities e      ON e.id = c.entity_id
      LEFT JOIN bank_accounts b ON b.id = c.bank_account_id
     ORDER BY c.provider, c.label
  `).all().map(r => maskCred(decryptCredRow(r)));
  res.json(rows);
});

app.post('/api/credentials', (req, res) => {
  const body = req.body || {};
  if (!body.provider) return res.status(400).json({ error: 'provider required' });
  const data = {};
  for (const c of CRED_COLS) data[c] = body[c] ?? null;
  if (!data.environment) data.environment = 'sandbox';
  if (!data.status) data.status = 'active';
  if (data.sync_interval_minutes == null) data.sync_interval_minutes = 0;
  // encrypt sensitive fields before persisting
  for (const f of ENCRYPTED_CRED_FIELDS) if (data[f]) data[f] = encField(data[f]);
  const cols = CRED_COLS.join(', ');
  const placeholders = CRED_COLS.map(c => '@' + c).join(', ');
  const result = db.prepare(`INSERT INTO api_credentials (${cols}) VALUES (${placeholders})`).run(data);
  const id = result.lastInsertRowid;
  audit('api_credentials', id, 'insert', null, { provider: data.provider, label: data.label });
  res.json({ ...maskCred(decryptCredRow(data)), id });
});

app.put('/api/credentials/:id', (req, res) => {
  const id = Number(req.params.id);
  const before = db.prepare('SELECT * FROM api_credentials WHERE id = ?').get(id);
  if (!before) return res.status(404).json({ error: 'not found' });
  const body = req.body || {};
  const data = {};
  for (const c of CRED_COLS) {
    // empty string from UI for secret fields = keep existing; null = clear
    if (body[c] === '••••' || body[c] === '') data[c] = before[c];
    else data[c] = body[c] ?? before[c];
  }
  // encrypt sensitive fields (skip if value already starts with enc:)
  for (const f of ENCRYPTED_CRED_FIELDS) if (data[f]) data[f] = encField(data[f]);
  const setClause = CRED_COLS.map(c => `${c} = @${c}`).join(', ');
  db.prepare(
    `UPDATE api_credentials SET ${setClause}, updated_at = datetime('now') WHERE id = @id`
  ).run({ ...data, id });
  const after = db.prepare('SELECT * FROM api_credentials WHERE id = ?').get(id);
  audit('api_credentials', id, 'update', maskCred(decryptCredRow(before)), maskCred(decryptCredRow(after)));
  res.json(maskCred(decryptCredRow(after)));
});

app.delete('/api/credentials/:id', (req, res) => {
  const id = Number(req.params.id);
  const before = db.prepare('SELECT * FROM api_credentials WHERE id = ?').get(id);
  if (!before) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM api_credentials WHERE id = ?').run(id);
  audit('api_credentials', id, 'delete', maskCred(before), null);
  res.json({ ok: true });
});

app.get('/api/sync/runs', (req, res) => {
  const rows = db.prepare(`
    SELECT r.*, b.bank_name, b.account_label, e.code AS entity_code
      FROM sync_runs r
      LEFT JOIN bank_accounts b ON b.id = r.bank_account_id
      LEFT JOIN entities e      ON e.id = b.entity_id
     ORDER BY r.id DESC
     LIMIT 100
  `).all();
  res.json(rows);
});

// ==================================================================
// Aspire adapter (Connect API — Bank Feed)
// Docs: https://aspireapp.com/hk/api
// Auth: OAuth2 client-credentials with API key + client ID/secret.
// This is a real adapter with graceful fallback when creds are missing.
// ==================================================================

async function aspireFetch(creds, urlPath, opts = {}) {
  const base = creds.environment === 'production'
    ? 'https://api.aspireapp.com'
    : 'https://api.sandbox.aspireapp.com';
  const headers = {
    'Authorization': `Bearer ${creds.access_token}`,
    'Accept':        'application/json',
    'Content-Type':  'application/json',
    ...(opts.headers || {}),
  };
  const r = await fetch(base + urlPath, { ...opts, headers });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch (_) { body = { raw: text }; }
  if (!r.ok) {
    const err = new Error(`Aspire API ${r.status}: ${body.message || text.slice(0, 200)}`);
    err.status = r.status; err.body = body;
    throw err;
  }
  return body;
}

async function aspireAuthenticate(creds) {
  // Aspire uses client-credentials grant; documented endpoint /v1/auth/token
  const base = creds.environment === 'production'
    ? 'https://api.aspireapp.com'
    : 'https://api.sandbox.aspireapp.com';
  // Decrypt any sensitive fields before sending out.
  const plain = decryptCredRow(creds);
  const r = await fetch(base + '/v1/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     plain.client_id,
      client_secret: plain.client_secret,
      api_key:       plain.api_key || '',
    }).toString(),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.access_token) {
    throw new Error('Aspire auth failed: ' + (body.error_description || body.error || r.status));
  }
  const expiresAt = new Date(Date.now() + (body.expires_in || 3600) * 1000).toISOString();
  db.prepare(
    `UPDATE api_credentials SET access_token = ?, token_expires_at = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(encField(body.access_token), expiresAt, creds.id);
  return { ...plain, access_token: body.access_token, token_expires_at: expiresAt };
}

async function aspireSync(accountId, opts = {}) {
  const acct = db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(accountId);
  if (!acct) throw new Error('unknown account');
  let creds = db.prepare(
    `SELECT * FROM api_credentials WHERE provider='aspire' AND (bank_account_id = ? OR bank_account_id IS NULL) ORDER BY bank_account_id IS NULL LIMIT 1`
  ).get(accountId);
  if (!creds) throw new Error('no Aspire credentials configured');
  creds = decryptCredRow(creds);

  const runResult = db.prepare(
    `INSERT INTO sync_runs (provider, bank_account_id, status) VALUES ('aspire', ?, 'running')`
  ).run(accountId);
  const runId = runResult.lastInsertRowid;

  try {
    if (!creds.access_token || !creds.token_expires_at || new Date(creds.token_expires_at) < new Date(Date.now() + 60000)) {
      creds = await aspireAuthenticate(creds);
    }
    const since = opts.since || acct.last_synced_at || '2020-01-01';
    const data = await aspireFetch(creds, `/v1/bank-feed/transactions?since=${encodeURIComponent(since)}`);
    const txns = Array.isArray(data.transactions) ? data.transactions : (Array.isArray(data) ? data : []);

    const ins = db.prepare(`
      INSERT OR IGNORE INTO bank_transactions
        (account_id, txn_date, description, reference, amount, currency, category, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let inserted = 0, skipped = 0;
    const tx = db.transaction(() => {
      for (const t of txns) {
        const r = ins.run(
          accountId,
          (t.date || t.transaction_date || t.value_date || '').slice(0, 10),
          t.description || t.narrative || null,
          t.reference || t.id || null,
          Number(t.amount) || 0,
          (t.currency || acct.currency).toUpperCase(),
          t.category || null,
          t.note || null
        );
        if (r.changes) inserted++; else skipped++;
      }
    });
    tx();
    db.prepare(`UPDATE bank_accounts SET last_synced_at = datetime('now') WHERE id = ?`).run(accountId);
    db.prepare(
      `UPDATE sync_runs SET finished_at = datetime('now'), status='ok', inserted=?, skipped=? WHERE id=?`
    ).run(inserted, skipped, runId);
    return { inserted, skipped, total: txns.length };
  } catch (err) {
    db.prepare(
      `UPDATE sync_runs SET finished_at = datetime('now'), status='error', error_message=? WHERE id=?`
    ).run(String(err.message || err), runId);
    throw err;
  }
}

app.post('/api/sync/aspire/:accountId', async (req, res) => {
  try {
    const result = await aspireSync(Number(req.params.accountId), { since: req.body?.since });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message || String(err) });
  }
});

// Auto-resync ticker — checks every 60s for credentials with sync_interval_minutes > 0.
setInterval(() => {
  const due = db.prepare(`
    SELECT a.id AS account_id, c.sync_interval_minutes, a.last_synced_at
      FROM api_credentials c
      JOIN bank_accounts   a ON a.credential_id = c.id
     WHERE c.provider = 'aspire'
       AND c.status   = 'active'
       AND c.sync_interval_minutes > 0
       AND a.provider = 'aspire'
       AND a.status   = 'active'
       AND (
         a.last_synced_at IS NULL
         OR julianday('now') - julianday(a.last_synced_at) > (c.sync_interval_minutes / 1440.0)
       )
  `).all();
  for (const row of due) {
    aspireSync(row.account_id).catch(err => {
      console.error('auto-resync failed for account', row.account_id, err.message);
    });
  }
}, 60_000).unref();

// ==================================================================
// System info
// ==================================================================

app.get('/api/system/backups', (req, res) => {
  const exists = fs.existsSync(BACKUP_DIR);
  const files = exists
    ? fs.readdirSync(BACKUP_DIR)
        .filter(f => f.startsWith('carbon-backup-') && f.endsWith('.tar.gz'))
        .map(f => {
          const stat = fs.statSync(path.join(BACKUP_DIR, f));
          return { name: f, size: stat.size, mtime: stat.mtime.toISOString() };
        })
        .sort((a, b) => b.name.localeCompare(a.name))
    : [];
  res.json({ retention: BACKUP_RETENTION, dir: BACKUP_DIR, files });
});

app.post('/api/system/backup-now', requireAdmin, (req, res) => {
  runNightlyBackup();
  res.json({ ok: true });
});

app.get('/api/system/launchd-plist', requireAdmin, (req, res) => {
  const projDir = ROOT;
  const nodePath = process.execPath;
  const serverJs = path.join(ROOT, 'server.js');
  const label = 'com.carbon.local';
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${serverJs}</string>
  </array>
  <key>WorkingDirectory</key><string>${projDir}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(projDir, 'carbon.out.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(projDir, 'carbon.err.log')}</string>
</dict>
</plist>
`;
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${label}.plist"`);
  res.send(plist);
});

// DB integrity check (admin-only) — useful before a backup or release
app.get('/api/system/integrity', requireAdmin, (req, res) => {
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get();
    const fkCheck   = db.prepare('PRAGMA foreign_key_check').all();
    res.json({
      integrity: integrity.integrity_check || integrity,
      foreign_key_violations: fkCheck,
      ok: (integrity.integrity_check === 'ok' || integrity['integrity_check'] === 'ok') && fkCheck.length === 0,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/system', (req, res) => {
  const dbStat = fs.statSync(DB_PATH);
  const attachDir = ATTACH_DIR;
  let attachBytes = 0, attachCount = 0;
  function walk(dir) {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else { attachCount++; attachBytes += fs.statSync(full).size; }
      }
    } catch (_) {}
  }
  walk(attachDir);
  res.json({
    db_path: DB_PATH,
    db_size_bytes: dbStat.size,
    attachments_path: attachDir,
    attachments_count: attachCount,
    attachments_size_bytes: attachBytes,
    node_version: process.version,
    pid: process.pid,
    uptime_seconds: Math.round(process.uptime()),
    last_sync: db.prepare(`SELECT MAX(started_at) AS ts FROM sync_runs`).get().ts,
    audit_retention_days: AUDIT_RETENTION_DAYS,
    audit_row_count: db.prepare(`SELECT COUNT(*) AS n FROM audit_log`).get().n,
  });
});

// ==================================================================
// Bank transactions: edit
// ==================================================================

app.put('/api/bank-transactions/:id', (req, res) => {
  const id = Number(req.params.id);
  const before = db.prepare('SELECT * FROM bank_transactions WHERE id = ?').get(id);
  if (!before) return res.status(404).json({ error: 'not found' });
  const body = req.body || {};
  const after = {
    txn_date:    body.txn_date    ?? before.txn_date,
    description: body.description ?? before.description,
    reference:   body.reference   ?? before.reference,
    amount:      body.amount != null ? Number(body.amount) : before.amount,
    currency:    (body.currency ?? before.currency).toUpperCase(),
    category:    body.category    ?? before.category,
    notes:       body.notes       ?? before.notes,
  };
  db.prepare(`
    UPDATE bank_transactions
       SET txn_date = @txn_date, description = @description, reference = @reference,
           amount = @amount, currency = @currency, category = @category, notes = @notes
     WHERE id = @id
  `).run({ ...after, id });
  const fresh = db.prepare('SELECT * FROM bank_transactions WHERE id = ?').get(id);
  audit('bank_transactions', id, 'update', before, fresh);
  res.json(fresh);
});

// ==================================================================
// Entity logo upload/retrieve
// ==================================================================

app.post('/api/entities/:id/logo', rawBodyMb, (req, res) => {
  const id = Number(req.params.id);
  const e = db.prepare('SELECT * FROM entities WHERE id = ?').get(id);
  if (!e) return res.status(404).json({ error: 'not found' });
  const filename = req.headers['x-filename'] || 'logo.png';
  const mime = req.headers['content-type'] || 'application/octet-stream';
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'empty body' });
  if (!/^image\//.test(mime)) return res.status(400).json({ error: 'must be image' });
  const meta = saveAttachment('entities', id, filename, mime, req.body);
  db.prepare(
    `UPDATE entities SET logo_path = ?, logo_mime = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(meta.rel_path, meta.mime, id);
  audit('entities', id, 'logo-upload', { logo_path: e.logo_path }, meta);
  res.json({ ok: true, ...meta });
});

app.get('/api/entities/:id/logo', (req, res) => {
  const e = db.prepare('SELECT logo_path, logo_mime FROM entities WHERE id = ?').get(Number(req.params.id));
  if (!e || !e.logo_path) return res.status(404).end();
  const buf = readAttachment(e.logo_path);
  if (!buf) return res.status(404).end();
  res.set('Content-Type', e.logo_mime || 'image/png');
  res.send(buf);
});

app.delete('/api/entities/:id/logo', (req, res) => {
  const id = Number(req.params.id);
  const e = db.prepare('SELECT * FROM entities WHERE id = ?').get(id);
  if (!e) return res.status(404).json({ error: 'not found' });
  if (e.logo_path) {
    try { fs.unlinkSync(path.join(DATA_DIR, e.logo_path)); } catch (_) {}
  }
  db.prepare(`UPDATE entities SET logo_path = NULL, logo_mime = NULL, updated_at = datetime('now') WHERE id = ?`).run(id);
  audit('entities', id, 'logo-delete', { logo_path: e.logo_path }, null);
  res.json({ ok: true });
});

// ==================================================================
// Restore — stage uploaded tar.gz; applies on next startup
// ==================================================================

app.post('/api/restore', requireAdmin, rawBodyMb, (req, res) => {
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'empty body' });
  if (req.body.length < 100) return res.status(400).json({ error: 'archive too small' });
  if (req.body[0] !== 0x1f || req.body[1] !== 0x8b) {
    return res.status(400).json({ error: 'not a gzip archive' });
  }
  fs.writeFileSync(_pendingRestorePath, req.body);
  audit('system', null, 'restore-queued', null, { bytes: req.body.length });
  res.json({
    ok: true,
    queued_bytes: req.body.length,
    message: 'Restore queued. Restart the server to apply. Previous data saved as data-pre-restore-<timestamp>.',
  });
});

// ==================================================================
// Invoice payments (partial pay) + recurrence + email send
// ==================================================================

function recomputeInvoicePaidStatus(invoiceId) {
  const inv = db.prepare('SELECT total, status FROM invoices WHERE id = ?').get(invoiceId);
  if (!inv) return;
  const paid = db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM invoice_payments WHERE invoice_id = ?').get(invoiceId).s;
  let newStatus = inv.status;
  if (paid >= inv.total && inv.total > 0) newStatus = 'paid';
  else if (paid > 0 && inv.status === 'draft') newStatus = 'sent';
  db.prepare(`UPDATE invoices SET amount_paid = ?, status = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(paid, newStatus, invoiceId);
}

app.get('/api/invoices/:id/payments', (req, res) => {
  const id = Number(req.params.id);
  const rows = db.prepare('SELECT * FROM invoice_payments WHERE invoice_id = ? ORDER BY paid_on DESC, id DESC').all(id);
  res.json(rows);
});

app.post('/api/invoices/:id/payments', (req, res) => {
  const id = Number(req.params.id);
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!inv) return res.status(404).json({ error: 'not found' });
  const body = req.body || {};
  const amount = Number(body.amount);
  if (!amount) return res.status(400).json({ error: 'amount required' });
  const paidOn = body.paid_on || new Date().toISOString().slice(0, 10);
  const result = db.prepare(`
    INSERT INTO invoice_payments (invoice_id, paid_on, amount, method, reference, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, paidOn, amount, body.method || null, body.reference || null, body.notes || null);
  recomputeInvoicePaidStatus(id);
  audit('invoice_payments', result.lastInsertRowid, 'insert', null, { invoice_id: id, amount });
  res.json({ id: result.lastInsertRowid, invoice_id: id, paid_on: paidOn, amount });
});

app.delete('/api/invoices/payments/:pid', (req, res) => {
  const pid = Number(req.params.pid);
  const before = db.prepare('SELECT * FROM invoice_payments WHERE id = ?').get(pid);
  if (!before) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM invoice_payments WHERE id = ?').run(pid);
  recomputeInvoicePaidStatus(before.invoice_id);
  audit('invoice_payments', pid, 'delete', before, null);
  res.json({ ok: true });
});

// Recurring invoice ticker — daily check.
function advanceRecurrenceDate(currentDate, kind) {
  const d = new Date(currentDate + 'T00:00:00Z');
  if (kind === 'weekly')    d.setUTCDate(d.getUTCDate() + 7);
  if (kind === 'monthly')   d.setUTCMonth(d.getUTCMonth() + 1);
  if (kind === 'quarterly') d.setUTCMonth(d.getUTCMonth() + 3);
  if (kind === 'yearly')    d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

function runRecurringInvoiceTicker() {
  const today = new Date().toISOString().slice(0, 10);
  const due = db.prepare(`
    SELECT id FROM invoices
     WHERE recurrence_active = 1
       AND recurrence_kind IS NOT NULL
       AND recurrence_next_run IS NOT NULL
       AND recurrence_next_run <= ?
  `).all(today);
  for (const row of due) {
    try {
      const original = loadInvoice(row.id);
      if (!original) continue;
      const tx = db.transaction(() => {
        const number = nextInvoiceNumber(original.entity_id, today);
        const result = db.prepare(`
          INSERT INTO invoices (entity_id, contact_id, number, issue_date, due_date,
                                currency, fx_rate_to_base, status, po_reference, notes,
                                direction, external_number)
          VALUES (@entity_id, @contact_id, @number, @issue_date, NULL,
                  @currency, @fx_rate_to_base, 'draft', @po_reference, @notes,
                  @direction, NULL)
        `).run({
          entity_id: original.entity_id,
          contact_id: original.contact_id,
          number,
          issue_date: today,
          currency: original.currency,
          fx_rate_to_base: original.fx_rate_to_base,
          po_reference: original.po_reference,
          notes: (original.notes ? original.notes + '\n' : '') + `Auto-generated from #${original.number} (${original.recurrence_kind} recurrence).`,
          direction: original.direction || 'sales',
        });
        const newId = result.lastInsertRowid;
        const ins = db.prepare(`
          INSERT INTO invoice_lines (invoice_id, position, description, quantity, unit_price, tax_rate)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        (original.lines || []).forEach((l, idx) => ins.run(newId, idx, l.description, l.quantity, l.unit_price, l.tax_rate));
        recomputeInvoiceTotals(newId);
        const nextRun = advanceRecurrenceDate(original.recurrence_next_run, original.recurrence_kind);
        db.prepare('UPDATE invoices SET recurrence_next_run = ? WHERE id = ?').run(nextRun, original.id);
        return newId;
      });
      const newId = tx();
      audit('invoices', newId, 'recurring-generate', { from: original.id }, null);
      console.log(`recurring invoice generated: ${original.number} → new id ${newId}`);
    } catch (e) {
      console.error('recurring ticker error for invoice', row.id, e.message);
    }
  }
}
setTimeout(runRecurringInvoiceTicker, 8000);
setInterval(runRecurringInvoiceTicker, 12 * 60 * 60 * 1000).unref();

// Notes (polymorphic across tables)
app.get('/api/notes', (req, res) => {
  const { entity_table, entity_id } = req.query;
  if (!entity_table || !entity_id) return res.status(400).json({ error: 'entity_table and entity_id required' });
  const rows = db.prepare(`
    SELECT n.*, u.email AS author_email, u.display_name AS author_name
      FROM notes n LEFT JOIN users u ON u.id = n.user_id
     WHERE n.entity_table = ? AND n.entity_id = ?
     ORDER BY n.id DESC
  `).all(String(entity_table), Number(entity_id));
  res.json(rows);
});

app.post('/api/notes', (req, res) => {
  const { entity_table, entity_id, body } = req.body || {};
  if (!entity_table || !entity_id || !body) return res.status(400).json({ error: 'entity_table, entity_id, body required' });
  const result = db.prepare(`
    INSERT INTO notes (entity_table, entity_id, user_id, body) VALUES (?, ?, ?, ?)
  `).run(String(entity_table), Number(entity_id), req.user?.id || null, String(body));
  audit('notes', result.lastInsertRowid, 'insert', null, { entity_table, entity_id });
  res.json({ id: result.lastInsertRowid });
});

app.delete('/api/notes/:id', (req, res) => {
  const id = Number(req.params.id);
  const before = db.prepare('SELECT * FROM notes WHERE id = ?').get(id);
  if (!before) return res.status(404).json({ error: 'not found' });
  if (before.user_id && req.user.role !== 'admin' && req.user.id !== before.user_id) {
    return res.status(403).json({ error: 'only the author or admin can delete this note' });
  }
  db.prepare('DELETE FROM notes WHERE id = ?').run(id);
  audit('notes', id, 'delete', before, null);
  res.json({ ok: true });
});

// Email invoice (SMTP via nodemailer)
app.post('/api/invoices/:id/email', async (req, res) => {
  const id = Number(req.params.id);
  const inv = loadInvoice(id);
  if (!inv) return res.status(404).json({ error: 'not found' });
  const to = (req.body && req.body.to) || inv.contact_email;
  if (!to) return res.status(400).json({ error: 'no recipient — provide "to" or set contact email' });

  const smtp = db.prepare(`SELECT * FROM api_credentials WHERE provider='smtp' AND status='active' LIMIT 1`).get();
  if (!smtp) return res.status(400).json({ error: 'no SMTP credentials configured — add one in Ops & Settings with provider=smtp' });
  const smtpPlain = decryptCredRow(smtp);

  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setContent(renderInvoiceHTML(inv), { waitUntil: 'networkidle0', timeout: 15000 });
    await page.emulateMediaType('print');
    const pdfBuf = Buffer.from(await page.pdf({ format: 'A4', margin: { top: '18mm', bottom: '18mm', left: '18mm', right: '18mm' }, printBackground: true }));

    const nodemailer = require('nodemailer');
    // SMTP config stored as JSON in notes field, or use simple defaults
    let smtpConfig;
    try { smtpConfig = JSON.parse(smtpPlain.notes || '{}'); } catch (_) { smtpConfig = {}; }
    const transporter = nodemailer.createTransport({
      host: smtpConfig.host || smtpPlain.client_id,
      port: Number(smtpConfig.port) || 587,
      secure: smtpConfig.secure === true || Number(smtpConfig.port) === 465,
      auth: { user: smtpPlain.api_key, pass: smtpPlain.client_secret },
    });

    const subject = req.body?.subject || `${inv.direction === 'purchase' ? 'Bill' : 'Invoice'} ${inv.number} from ${inv.entity_legal_name}`;
    const body = req.body?.body || `Please find attached ${inv.direction === 'purchase' ? 'bill' : 'invoice'} ${inv.number}.\n\nTotal: ${inv.currency} ${inv.total.toFixed(2)}\nDue: ${inv.due_date || 'on receipt'}\n\nThank you.`;
    const fromAddr = smtpConfig.from || smtpPlain.api_key;

    await transporter.sendMail({
      from: fromAddr,
      to,
      subject,
      text: body,
      attachments: [{ filename: `${inv.direction === 'purchase' ? 'BILL' : 'INV'}-${inv.number}.pdf`, content: pdfBuf, contentType: 'application/pdf' }],
    });
    audit('invoices', id, 'emailed', null, { to });
    res.json({ ok: true, to });
  } catch (err) {
    console.error('Email send failed:', err);
    res.status(502).json({ error: err.message || 'email send failed' });
  } finally {
    if (page) { try { await page.close(); } catch (_) {} }
  }
});

// ==================================================================
// Backup — stream tar.gz of the data dir
// ==================================================================

app.get('/api/backup', (req, res) => {
  const { spawn } = require('child_process');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const wantEncrypt = req.query.encrypt === '1';
  const passphrase = req.query.passphrase || '';
  if (wantEncrypt && !passphrase) return res.status(400).json({ error: 'passphrase required when encrypt=1' });
  const filename = wantEncrypt ? `carbon-backup-${stamp}.tar.gz.enc` : `carbon-backup-${stamp}.tar.gz`;
  res.set('Content-Type', wantEncrypt ? 'application/octet-stream' : 'application/gzip');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);

  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}

  // Exclude prior backups + in-flight restore staging so the archive doesn't recursively swallow itself.
  const tar = spawn('tar', [
    '-czf', '-',
    '-C', ROOT,
    '--exclude=data/backups',
    '--exclude=data/_pending_restore.tar.gz',
    '--exclude=data/_restoring',
    'data',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  if (!wantEncrypt) {
    tar.stdout.pipe(res);
  } else {
    const chunks = [];
    tar.stdout.on('data', d => chunks.push(d));
    tar.on('close', code => {
      if (code !== 0) { if (!res.headersSent) res.status(500).end('tar failed'); return; }
      try {
        const tarBuf = Buffer.concat(chunks);
        const salt = crypto.randomBytes(16);
        const iv   = crypto.randomBytes(12);
        const key  = crypto.scryptSync(String(passphrase), salt, 32);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const ct = Buffer.concat([cipher.update(tarBuf), cipher.final()]);
        const tag = cipher.getAuthTag();
        // header: magic 4 bytes + salt 16 + iv 12 + tag 16 + ciphertext
        const header = Buffer.from([0x43, 0x41, 0x52, 0x42]); // "CARB"
        res.end(Buffer.concat([header, salt, iv, tag, ct]));
      } catch (err) {
        console.error('encrypt failed:', err.message);
        if (!res.headersSent) res.status(500).end('encrypt failed');
      }
    });
  }
  tar.stderr.on('data', (chunk) => console.error('backup tar stderr:', chunk.toString()));
  tar.on('error', (err) => { if (!res.headersSent) res.status(500).end('backup failed'); });
});

// Decrypt helper: POST encrypted blob + passphrase → returns raw tar.gz
app.post('/api/backup/decrypt', requireAdmin, rawBodyMb, (req, res) => {
  const passphrase = req.headers['x-passphrase'];
  if (!passphrase) return res.status(400).json({ error: 'X-Passphrase header required' });
  if (!req.body || req.body.length < 48) return res.status(400).json({ error: 'body too small' });
  try {
    const magic = req.body.slice(0, 4);
    if (magic.toString() !== 'CARB') return res.status(400).json({ error: 'not a Carbon encrypted backup' });
    const salt = req.body.slice(4, 20);
    const iv   = req.body.slice(20, 32);
    const tag  = req.body.slice(32, 48);
    const ct   = req.body.slice(48);
    const key  = crypto.scryptSync(String(passphrase), salt, 32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    res.set('Content-Type', 'application/gzip');
    res.set('Content-Disposition', 'attachment; filename="carbon-backup-decrypted.tar.gz"');
    res.end(plain);
  } catch (err) {
    res.status(400).json({ error: 'decrypt failed — wrong passphrase or corrupted file' });
  }
});

// ==================================================================
// FX rates + app settings + consolidated dashboard
// ==================================================================

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`)
    .run(key, value);
}
function getRateToUSD(currency) {
  if (!currency) return 1;
  const row = db.prepare('SELECT rate_to_usd FROM fx_rates WHERE currency = ?').get(String(currency).toUpperCase());
  return row ? Number(row.rate_to_usd) : null;
}
function convert(amount, fromCcy, toCcy) {
  if (!amount || !fromCcy || !toCcy) return 0;
  if (fromCcy === toCcy) return Number(amount);
  const fromRate = getRateToUSD(fromCcy);
  const toRate   = getRateToUSD(toCcy);
  if (!fromRate || !toRate) return null;
  return (Number(amount) * fromRate) / toRate;
}

app.get('/api/fx-rates', (req, res) => {
  res.json(db.prepare('SELECT * FROM fx_rates ORDER BY currency').all());
});

app.put('/api/fx-rates/:currency', requireAdmin, (req, res) => {
  const code = String(req.params.currency).toUpperCase();
  const { rate_to_usd, source } = req.body || {};
  const rate = Number(rate_to_usd);
  if (!isFinite(rate) || rate <= 0) return res.status(400).json({ error: 'rate_to_usd must be positive number' });
  db.prepare(`INSERT INTO fx_rates (currency, rate_to_usd, source, updated_at)
              VALUES (?, ?, ?, datetime('now'))
              ON CONFLICT(currency) DO UPDATE SET rate_to_usd = excluded.rate_to_usd, source = excluded.source, updated_at = datetime('now')`)
    .run(code, rate, source || 'manual');
  audit('fx_rates', null, 'update', null, { currency: code, rate_to_usd: rate });
  res.json(db.prepare('SELECT * FROM fx_rates WHERE currency = ?').get(code));
});

app.delete('/api/fx-rates/:currency', requireAdmin, (req, res) => {
  const code = String(req.params.currency).toUpperCase();
  if (code === 'USD') return res.status(400).json({ error: 'USD is the base; cannot delete' });
  db.prepare('DELETE FROM fx_rates WHERE currency = ?').run(code);
  audit('fx_rates', null, 'delete', { currency: code }, null);
  res.json({ ok: true });
});

app.get('/api/settings/:key', (req, res) => {
  const v = getSetting(req.params.key, null);
  res.json({ key: req.params.key, value: v });
});

app.put('/api/settings/:key', requireAdmin, (req, res) => {
  const { value } = req.body || {};
  setSetting(req.params.key, value);
  audit('app_settings', null, 'update', null, { key: req.params.key, value });
  res.json({ key: req.params.key, value });
});

// Counterparty statement: open + paid-last-12mo + per-currency outstanding
function loadStatement(contactId) {
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId);
  if (!contact) return null;
  const ytdStart = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  const openSales = db.prepare(`
    SELECT i.*, e.code AS entity_code FROM invoices i JOIN entities e ON e.id = i.entity_id
     WHERE i.contact_id=? AND i.direction='sales' AND i.status IN ('draft','sent')
     ORDER BY i.due_date, i.issue_date
  `).all(contactId);
  const openBills = db.prepare(`
    SELECT i.*, e.code AS entity_code FROM invoices i JOIN entities e ON e.id = i.entity_id
     WHERE i.contact_id=? AND i.direction='purchase' AND i.status IN ('draft','sent')
     ORDER BY i.due_date, i.issue_date
  `).all(contactId);
  const paid = db.prepare(`
    SELECT i.*, e.code AS entity_code FROM invoices i JOIN entities e ON e.id = i.entity_id
     WHERE i.contact_id=? AND i.status='paid' AND i.issue_date >= ?
     ORDER BY i.issue_date DESC
  `).all(contactId, ytdStart);

  const sumBy = rows => {
    const out = {};
    for (const r of rows) {
      const k = r.currency || '';
      out[k] = (out[k] || 0) + Number(r.total || 0) - Number(r.amount_paid || 0);
    }
    return out;
  };
  return {
    contact,
    open_sales: openSales,
    open_bills: openBills,
    paid_last_12mo: paid,
    outstanding_ar: sumBy(openSales),
    outstanding_ap: sumBy(openBills),
    generated_at: new Date().toISOString(),
  };
}

app.get('/api/contacts/:id/statement', (req, res) => {
  const s = loadStatement(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'not found' });
  res.json(s);
});

function renderStatementHTML(s) {
  const fmt = n => (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const today = new Date().toISOString().slice(0, 10);
  const rows = arr => arr.map(i => `
    <tr>
      <td>${i.number}${i.external_number ? ' (' + i.external_number + ')' : ''}</td>
      <td>${i.issue_date || ''}</td>
      <td>${i.due_date || ''}</td>
      <td>${i.entity_code}</td>
      <td class="num">${i.currency} ${fmt(i.total)}</td>
      <td class="num">${i.currency} ${fmt((i.total || 0) - (i.amount_paid || 0))}</td>
      <td>${i.status}</td>
    </tr>`).join('') || `<tr><td colspan="7" style="text-align:center;color:#999;padding:20px">— none —</td></tr>`;
  const balRows = (label, map) => Object.entries(map).length === 0 ? '' :
    `<div class="bal-row"><span>${label}</span><span>${Object.entries(map).map(([c, v]) => `${c} ${fmt(v)}`).join(' · ')}</span></div>`;
  return `<!doctype html><html><head><meta charset="utf-8">
  <title>Statement — ${s.contact.display_name}</title>
  <style>
    @page { size: A4; margin: 18mm; }
    body { font: 12pt/1.4 -apple-system, "Helvetica Neue", Arial, sans-serif; color: #111; max-width: 800px; margin: 0 auto; padding: 24px; }
    header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px; padding-bottom: 14px; border-bottom: 2px solid #111; }
    h1 { margin: 0; font-size: 20pt; }
    h2 { margin: 24px 0 8px; font-size: 12pt; text-transform: uppercase; color: #555; letter-spacing: 0.05em; }
    table { width: 100%; border-collapse: collapse; font-size: 10pt; }
    th, td { padding: 6px 8px; border-bottom: 1px solid #ddd; text-align: left; vertical-align: top; }
    th { font-size: 9pt; color: #555; text-transform: uppercase; letter-spacing: 0.05em; }
    td.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .balances { margin-top: 16px; padding: 12px; background: #f9f9fa; border-radius: 8px; }
    .bal-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 11pt; }
    .bal-row span:last-child { font-weight: 600; }
    .print-bar { background: #f3f4f6; padding: 12px; text-align: center; margin-bottom: 16px; }
    .print-bar button { padding: 8px 16px; border: 1px solid #111; background: white; cursor: pointer; }
    @media print { .print-bar { display: none; } body { padding: 0; } }
  </style></head><body>
  <div class="print-bar"><button onclick="window.print()">Print / Save as PDF</button></div>
  <header>
    <div>
      <h1>${s.contact.display_name}</h1>
      ${s.contact.legal_name ? `<div>${s.contact.legal_name}</div>` : ''}
      ${s.contact.tax_id ? `<div>Tax ID: ${s.contact.tax_id}</div>` : ''}
    </div>
    <div style="text-align:right">
      <div style="font-size:14pt;font-weight:600">Statement</div>
      <div style="color:#555">${today}</div>
    </div>
  </header>

  <div class="balances">
    ${balRows('Outstanding receivables (we are owed)', s.outstanding_ar)}
    ${balRows('Outstanding payables (we owe)',        s.outstanding_ap)}
    ${(Object.keys(s.outstanding_ar).length + Object.keys(s.outstanding_ap).length) === 0 ? '<div class="bal-row"><span>No outstanding balances</span></div>' : ''}
  </div>

  <h2>Open invoices (we issued)</h2>
  <table><thead><tr><th>Number</th><th>Issued</th><th>Due</th><th>Entity</th><th class="num">Total</th><th class="num">Outstanding</th><th>Status</th></tr></thead>
  <tbody>${rows(s.open_sales)}</tbody></table>

  <h2>Open bills (they billed us)</h2>
  <table><thead><tr><th>Number</th><th>Issued</th><th>Due</th><th>Entity</th><th class="num">Total</th><th class="num">Outstanding</th><th>Status</th></tr></thead>
  <tbody>${rows(s.open_bills)}</tbody></table>

  <h2>Paid in last 12 months</h2>
  <table><thead><tr><th>Number</th><th>Issued</th><th>Due</th><th>Entity</th><th class="num">Total</th><th class="num">—</th><th>Status</th></tr></thead>
  <tbody>${rows(s.paid_last_12mo)}</tbody></table>
  </body></html>`;
}

app.get('/contacts/:id/statement', (req, res) => {
  const s = loadStatement(Number(req.params.id));
  if (!s) return res.status(404).send('Contact not found');
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(renderStatementHTML(s));
});

app.get('/api/contacts/:id/statement.pdf', async (req, res) => {
  const id = Number(req.params.id);
  const s = loadStatement(id);
  if (!s) return res.status(404).json({ error: 'not found' });
  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    const html = renderStatementHTML(s);
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });
    await page.emulateMediaType('print');
    const pdf = await page.pdf({ format: 'A4', margin: { top: '18mm', bottom: '18mm', left: '18mm', right: '18mm' }, printBackground: true });
    const pdfBuf = Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
    const safe = String(s.contact.display_name).replace(/[^a-zA-Z0-9._-]/g, '_');
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Length', pdfBuf.length);
    res.set('Content-Disposition', `attachment; filename="STMT-${safe}.pdf"`);
    res.end(pdfBuf);
  } catch (err) {
    res.status(500).json({ error: err.message || 'PDF generation failed' });
  } finally {
    if (page) { try { await page.close(); } catch (_) {} }
  }
});

// Share-link management: create/revoke per invoice
app.post('/api/invoices/:id/share', (req, res) => {
  const id = Number(req.params.id);
  const inv = db.prepare('SELECT id, share_token FROM invoices WHERE id = ?').get(id);
  if (!inv) return res.status(404).json({ error: 'not found' });
  let token = inv.share_token;
  if (!token) {
    token = crypto.randomBytes(24).toString('hex');
    db.prepare(`UPDATE invoices SET share_token = ?, updated_at = datetime('now') WHERE id = ?`).run(token, id);
    audit('invoices', id, 'share-link-created', null, null);
  }
  res.json({ token, url: `/share/invoice/${token}` });
});

app.delete('/api/invoices/:id/share', (req, res) => {
  const id = Number(req.params.id);
  db.prepare(`UPDATE invoices SET share_token = NULL, updated_at = datetime('now') WHERE id = ?`).run(id);
  audit('invoices', id, 'share-link-revoked', null, null);
  res.json({ ok: true });
});

// Bulk invoice import from CSV (rows grouped by date + contact)
app.post('/api/invoices/bulk-import', (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
  if (!rows || !rows.length) return res.status(400).json({ error: 'no rows' });

  // Map entity_code → id, contact display_name → id
  const entityByCode = new Map(db.prepare('SELECT id, code FROM entities').all().map(e => [e.code.toUpperCase(), e.id]));
  const contactByName = new Map(db.prepare(`SELECT id, display_name FROM contacts WHERE status='active'`).all()
    .map(c => [c.display_name.toLowerCase(), c.id]));

  // Group rows by (date, entity_code, contact, currency, direction)
  const groups = new Map();
  let lineErrors = [];
  for (const [idx, r] of rows.entries()) {
    const key = [r.date, r.entity_code, r.contact, r.currency || '', r.direction || 'sales'].join('|');
    if (!groups.has(key)) groups.set(key, { meta: { ...r }, lines: [] });
    groups.get(key).lines.push({
      description: r.description || '(no description)',
      quantity:    Number(r.quantity)   || 1,
      unit_price:  Number(r.unit_price) || 0,
      tax_rate:    Number(r.tax_rate)   || 0,
    });
  }

  const created = [];
  const errors = [];
  for (const grp of groups.values()) {
    try {
      const entId = entityByCode.get(String(grp.meta.entity_code || '').toUpperCase());
      const contactId = contactByName.get(String(grp.meta.contact || '').toLowerCase());
      if (!entId)     { errors.push({ contact: grp.meta.contact, error: `unknown entity ${grp.meta.entity_code}` }); continue; }
      if (!contactId) { errors.push({ contact: grp.meta.contact, error: 'contact not found (create it first)' }); continue; }
      if (!grp.meta.currency) { errors.push({ contact: grp.meta.contact, error: 'currency missing' }); continue; }

      const lockErr = checkPeriodLock(entId, grp.meta.date);
      if (lockErr) { errors.push({ contact: grp.meta.contact, error: lockErr }); continue; }

      const direction = grp.meta.direction === 'purchase' ? 'purchase' : 'sales';
      const tx = db.transaction(() => {
        const number = direction === 'purchase'
          ? (grp.meta.number || grp.meta.external_number || `BILL-${Date.now()}`)
          : nextInvoiceNumber(entId, grp.meta.date);
        const result = db.prepare(`INSERT INTO invoices
          (entity_id, contact_id, number, issue_date, due_date, currency, fx_rate_to_base, status, po_reference, notes, direction, external_number)
          VALUES (?, ?, ?, ?, ?, ?, 1.0, 'draft', ?, ?, ?, ?)`)
          .run(entId, contactId, number, grp.meta.date, grp.meta.due_date || null, String(grp.meta.currency).toUpperCase(),
               grp.meta.po_reference || null, grp.meta.notes || null, direction, grp.meta.external_number || null);
        const id = result.lastInsertRowid;
        const ins = db.prepare(`INSERT INTO invoice_lines (invoice_id, position, description, quantity, unit_price, tax_rate) VALUES (?, ?, ?, ?, ?, ?)`);
        grp.lines.forEach((l, i) => ins.run(id, i, l.description, l.quantity, l.unit_price, l.tax_rate));
        recomputeInvoiceTotals(id);
        return id;
      });
      const newId = tx();
      created.push({ id: newId, contact: grp.meta.contact, lines: grp.lines.length });
    } catch (err) {
      errors.push({ contact: grp.meta.contact, error: err.message });
    }
  }
  audit('invoices', null, 'bulk-import', null, { created: created.length, errors: errors.length });
  res.json({ created, errors, total_rows: rows.length, total_invoices: groups.size });
});

// API tokens
app.get('/api/tokens', requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT id, label, scope, last_used_at, created_at FROM api_tokens ORDER BY id DESC`).all();
  res.json(rows);
});

app.post('/api/tokens', requireAdmin, (req, res) => {
  const { label, scope } = req.body || {};
  if (!label) return res.status(400).json({ error: 'label required' });
  if (scope && !['read', 'write'].includes(scope)) return res.status(400).json({ error: 'scope must be read or write' });
  const raw = 'carb_' + crypto.randomBytes(24).toString('base64url');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const result = db.prepare(`INSERT INTO api_tokens (label, token_hash, scope) VALUES (?, ?, ?)`)
    .run(label, hash, scope || 'read');
  audit('api_tokens', result.lastInsertRowid, 'create', null, { label, scope: scope || 'read' });
  res.json({ id: result.lastInsertRowid, label, scope: scope || 'read', token: raw, note: 'Save this token now — it cannot be retrieved later.' });
});

app.delete('/api/tokens/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const before = db.prepare('SELECT label FROM api_tokens WHERE id = ?').get(id);
  if (!before) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM api_tokens WHERE id = ?').run(id);
  audit('api_tokens', id, 'revoke', before, null);
  res.json({ ok: true });
});

app.post('/api/dunning/run', requireAdmin, async (req, res) => {
  try { await runDunning(); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Single-invoice manual reminder (bypasses cooldown)
app.post('/api/invoices/:id/send-reminder', async (req, res) => {
  const id = Number(req.params.id);
  const inv = db.prepare(`
    SELECT i.*, e.legal_name AS entity_legal_name,
           c.display_name AS contact_display_name, c.email AS contact_email
      FROM invoices i
      JOIN entities e ON e.id = i.entity_id
      JOIN contacts c ON c.id = i.contact_id
     WHERE i.id = ?
  `).get(id);
  if (!inv) return res.status(404).json({ error: 'not found' });
  if (!inv.contact_email) return res.status(400).json({ error: 'no contact email — add one first' });
  const smtp = db.prepare(`SELECT * FROM api_credentials WHERE provider='smtp' AND status='active' LIMIT 1`).get();
  if (!smtp) return res.status(400).json({ error: 'no SMTP credentials configured' });
  const smtpPlain = decryptCredRow(smtp);
  try {
    await sendDunningReminder(inv, smtpPlain);
    db.prepare(`UPDATE invoices SET last_reminder_at = datetime('now') WHERE id = ?`).run(id);
    audit('invoices', id, 'reminder-sent', null, { to: inv.contact_email });
    res.json({ ok: true, sent_to: inv.contact_email });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Calendar tokens: mint / list / revoke
app.get('/api/calendar-tokens', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT token, label, created_at, last_used_at FROM calendar_tokens ORDER BY created_at DESC').all());
});
app.post('/api/calendar-tokens', requireAdmin, (req, res) => {
  const label = (req.body?.label || '').trim() || 'Calendar';
  const token = 'cal_' + crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO calendar_tokens (token, label) VALUES (?, ?)').run(token, label);
  audit('calendar_tokens', null, 'create', null, { label });
  res.json({ token, label, url: `/api/calendar/${token}.ics` });
});
app.delete('/api/calendar-tokens/:token', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM calendar_tokens WHERE token = ?').run(req.params.token);
  res.json({ ok: true });
});

// Outbound webhooks
const WEBHOOK_EVENTS = ['invoice.created', 'invoice.paid', 'invoice.void', 'contract.expiring', 'kyc.refresh_due'];

const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000]; // 30s, 2min, 10min
async function deliverWebhook(hook, event, payload, attempt = 1) {
  const body = JSON.stringify({ event, payload, ts: new Date().toISOString(), attempt });
  const sig = crypto.createHmac('sha256', hook.secret).update(body).digest('hex');
  const start = Date.now();
  let ok = false;
  try {
    const r = await fetch(hook.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Carbon-Signature': sig, 'X-Carbon-Event': event, 'X-Carbon-Attempt': String(attempt) },
      body,
    });
    db.prepare(`INSERT INTO webhook_deliveries (webhook_id, event, status_code, response_ms, attempt) VALUES (?, ?, ?, ?, ?)`)
      .run(hook.id, event, r.status, Date.now() - start, attempt);
    ok = r.ok;
  } catch (err) {
    db.prepare(`INSERT INTO webhook_deliveries (webhook_id, event, status_code, response_ms, error, attempt) VALUES (?, ?, NULL, ?, ?, ?)`)
      .run(hook.id, event, Date.now() - start, String(err.message || err), attempt);
  }
  if (!ok && attempt <= RETRY_DELAYS_MS.length) {
    const delay = RETRY_DELAYS_MS[attempt - 1];
    setTimeout(() => deliverWebhook(hook, event, payload, attempt + 1).catch(() => {}), delay).unref();
  } else if (!ok) {
    // Final failure: notify once with throttle
    const recent = db.prepare(
      `SELECT 1 FROM notifications WHERE kind='webhook' AND ref = ? AND julianday('now') - julianday(ts) < (5.0/1440) LIMIT 1`
    ).get('webhooks/' + hook.id);
    if (!recent) notify('webhook', `Webhook ${event} → ${hook.url} failed after ${attempt} attempts`, 'webhooks/' + hook.id);
  }
}

function fireWebhook(event, payload) {
  const hooks = db.prepare('SELECT * FROM webhooks WHERE active = 1').all();
  for (const h of hooks) {
    const events = (h.events || '').split(',').map(s => s.trim());
    if (events.includes('*') || events.includes(event)) {
      deliverWebhook(h, event, payload).catch(() => {});
    }
  }
}

app.get('/api/webhooks', requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT w.*, (SELECT COUNT(*) FROM webhook_deliveries d WHERE d.webhook_id = w.id) AS deliveries FROM webhooks w ORDER BY w.id DESC`).all();
  res.json({ webhooks: rows, events: WEBHOOK_EVENTS });
});
app.post('/api/webhooks', requireAdmin, (req, res) => {
  const { url, events } = req.body || {};
  if (!url || !events) return res.status(400).json({ error: 'url + events required' });
  const secret = crypto.randomBytes(24).toString('hex');
  const result = db.prepare('INSERT INTO webhooks (url, secret, events) VALUES (?, ?, ?)').run(url, secret, events);
  audit('webhooks', result.lastInsertRowid, 'create', null, { url, events });
  res.json({ id: result.lastInsertRowid, url, secret, events, active: 1 });
});
app.delete('/api/webhooks/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM webhooks WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});
app.post('/api/webhooks/:id/test', requireAdmin, async (req, res) => {
  const h = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(Number(req.params.id));
  if (!h) return res.status(404).json({ error: 'not found' });
  await deliverWebhook(h, 'test.ping', { message: 'Test ping from Carbon' });
  res.json({ ok: true });
});
app.get('/api/webhooks/:id/deliveries', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id DESC LIMIT 20').all(Number(req.params.id));
  res.json(rows);
});

// Contacts bulk-import: same shape as invoice bulk, simpler grouping
app.post('/api/contacts/bulk-import', (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
  if (!rows || !rows.length) return res.status(400).json({ error: 'no rows' });
  const created = [], errors = [];
  const ins = db.prepare(`INSERT INTO contacts (contact_type, display_name, legal_name, jurisdiction_code, tax_id, email, phone, website, address_line1, address_line2, city, postal_code, country, currency_default, payment_terms_days, notes, tags, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`);
  for (const r of rows) {
    try {
      if (!r.display_name) { errors.push({ row: r, error: 'display_name required' }); continue; }
      const result = ins.run(
        (r.contact_type || 'other').toLowerCase(),
        r.display_name,
        r.legal_name || null,
        (r.jurisdiction_code || '').toLowerCase() || null,
        r.tax_id || null,
        r.email || null,
        r.phone || null,
        r.website || null,
        r.address_line1 || null,
        r.address_line2 || null,
        r.city || null,
        r.postal_code || null,
        r.country || null,
        (r.currency_default || '').toUpperCase() || null,
        r.payment_terms_days ? Number(r.payment_terms_days) : null,
        r.notes || null,
        r.tags || null
      );
      created.push({ id: result.lastInsertRowid, display_name: r.display_name });
    } catch (err) {
      errors.push({ display_name: r.display_name, error: err.message });
    }
  }
  audit('contacts', null, 'bulk-import', null, { created: created.length, errors: errors.length });
  res.json({ created, errors, total_rows: rows.length });
});

// Saved filter views
app.get('/api/saved-views', (req, res) => {
  const panel = req.query.panel;
  const rows = panel
    ? db.prepare('SELECT * FROM saved_views WHERE panel = ? ORDER BY name').all(panel)
    : db.prepare('SELECT * FROM saved_views ORDER BY panel, name').all();
  res.json(rows.map(r => ({ ...r, query: JSON.parse(r.query_json) })));
});

app.post('/api/saved-views', (req, res) => {
  const { panel, name, query } = req.body || {};
  if (!panel || !name || !query) return res.status(400).json({ error: 'panel, name, query required' });
  const result = db.prepare(`INSERT INTO saved_views (panel, name, query_json) VALUES (?, ?, ?)`)
    .run(panel, name, JSON.stringify(query));
  res.json({ id: result.lastInsertRowid, panel, name, query });
});

app.delete('/api/saved-views/:id', (req, res) => {
  db.prepare('DELETE FROM saved_views WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// iCal calendar feed: invoice due dates + contract ends + KYC refresh dates
app.get('/api/calendar.ics', (req, res) => {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Carbon//Local ERP//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:Carbon — due dates`,
  ];
  const ymd = s => (s || '').slice(0, 10).replace(/-/g, '');
  const escape = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  const dtstamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');

  const invoices = db.prepare(`
    SELECT i.id, i.number, i.direction, i.due_date, i.total, i.currency, c.display_name AS contact, e.code AS entity_code
      FROM invoices i
      JOIN contacts c ON c.id = i.contact_id
      JOIN entities e ON e.id = i.entity_id
     WHERE i.due_date IS NOT NULL AND i.status IN ('draft','sent')
  `).all();
  for (const i of invoices) {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:carbon-invoice-${i.id}@carbon.local`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART;VALUE=DATE:${ymd(i.due_date)}`);
    lines.push(`SUMMARY:${escape(`${i.direction === 'purchase' ? 'Bill due' : 'Invoice due'} ${i.number} — ${i.contact}`)}`);
    lines.push(`DESCRIPTION:${escape(`${i.entity_code} · ${i.currency} ${i.total}`)}`);
    lines.push('END:VEVENT');
  }
  const contracts = db.prepare(`
    SELECT c.id, c.title, c.end_date, e.code AS entity_code, p.display_name AS counterparty
      FROM contracts c
      JOIN entities e ON e.id = c.entity_id
      JOIN contacts p ON p.id = c.counterparty_id
     WHERE c.end_date IS NOT NULL AND c.status='active'
  `).all();
  for (const c of contracts) {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:carbon-contract-${c.id}@carbon.local`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART;VALUE=DATE:${ymd(c.end_date)}`);
    lines.push(`SUMMARY:${escape(`Contract ends: ${c.title}`)}`);
    lines.push(`DESCRIPTION:${escape(`${c.entity_code} · counterparty ${c.counterparty}`)}`);
    lines.push('END:VEVENT');
  }
  const kyc = db.prepare(`
    SELECT k.id, k.refresh_due, k.risk_tier, c.display_name AS contact
      FROM kyc_records k
      JOIN contacts c ON c.id = k.contact_id
     WHERE k.refresh_due IS NOT NULL
  `).all();
  for (const k of kyc) {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:carbon-kyc-${k.id}@carbon.local`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART;VALUE=DATE:${ymd(k.refresh_due)}`);
    lines.push(`SUMMARY:${escape(`KYC refresh: ${k.contact}`)}`);
    lines.push(`DESCRIPTION:${escape(`Risk tier: ${k.risk_tier}`)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="carbon-calendar.ics"');
  res.send(lines.join('\r\n'));
});

// Auto-refresh FX rates: ECB primary + open-er-api fallback (covers AED etc).
app.post('/api/fx-rates/refresh', requireAdmin, async (req, res) => {
  const existing = new Set(db.prepare('SELECT currency FROM fx_rates').all().map(r => r.currency));
  const updated = [];
  const upd = db.prepare(`INSERT INTO fx_rates (currency, rate_to_usd, source, updated_at) VALUES (?, ?, ?, datetime('now'))
                          ON CONFLICT(currency) DO UPDATE SET rate_to_usd = excluded.rate_to_usd, source = excluded.source, updated_at = datetime('now')`);
  let errors = [];

  // 1. ECB (EUR-base)
  let eurToUsd = null;
  try {
    const r = await fetch('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml');
    if (!r.ok) throw new Error('ECB ' + r.status);
    const xml = await r.text();
    const pairs = {};
    const re = /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]/g;
    let m;
    while ((m = re.exec(xml)) !== null) pairs[m[1]] = parseFloat(m[2]);
    if (!pairs.USD) throw new Error('ECB response missing USD');
    eurToUsd = pairs.USD;
    if (existing.has('EUR')) { upd.run('EUR', eurToUsd, 'ecb'); updated.push({ currency: 'EUR', rate_to_usd: eurToUsd, source: 'ecb' }); }
    for (const [ccy, perEur] of Object.entries(pairs)) {
      if (!existing.has(ccy) || ccy === 'EUR') continue;
      const rateToUsd = eurToUsd / perEur;
      upd.run(ccy, rateToUsd, 'ecb');
      updated.push({ currency: ccy, rate_to_usd: rateToUsd, source: 'ecb' });
    }
  } catch (err) { errors.push('ECB: ' + err.message); }

  // 2. open-er-api.com fallback (USD-base; gives AED + many others)
  const covered = new Set(updated.map(u => u.currency));
  const remaining = [...existing].filter(c => !covered.has(c) && c !== 'USD');
  if (remaining.length) {
    try {
      const r = await fetch('https://open.er-api.com/v6/latest/USD');
      if (!r.ok) throw new Error('open-er-api ' + r.status);
      const data = await r.json();
      if (data.result !== 'success' || !data.rates) throw new Error('open-er-api unexpected response');
      // data.rates: { AED: 3.6725, ... } meaning 1 USD = N AED → rate_to_usd = 1/N
      for (const ccy of remaining) {
        const perUsd = data.rates[ccy];
        if (!perUsd) continue;
        const rateToUsd = 1 / perUsd;
        upd.run(ccy, rateToUsd, 'open-er-api');
        updated.push({ currency: ccy, rate_to_usd: rateToUsd, source: 'open-er-api' });
      }
    } catch (err) { errors.push('open-er-api: ' + err.message); }
  }

  // USD is the anchor
  if (existing.has('USD')) upd.run('USD', 1, 'manual');

  audit('fx_rates', null, 'auto-refresh', null, { updated_count: updated.length, errors });
  if (!updated.length && errors.length) {
    notify('error', 'FX refresh failed: ' + errors.join('; '));
    return res.status(502).json({ error: 'All FX sources failed: ' + errors.join('; ') });
  }
  notify('fx', `FX refreshed ${updated.length} currencies`, null);
  res.json({ ok: true, updated, errors, source: 'ECB + open-er-api' });
});

// VAT collected report — tax_total grouped by entity × quarter
app.get('/api/reports/vat', (req, res) => {
  const rows = db.prepare(`
    SELECT e.id    AS entity_id,
           e.code  AS entity_code,
           e.base_currency,
           strftime('%Y', i.issue_date) AS year,
           ((CAST(strftime('%m', i.issue_date) AS INTEGER) - 1) / 3 + 1) AS quarter,
           SUM(CASE WHEN i.direction='sales'    THEN i.tax_total ELSE 0 END) AS tax_collected,
           SUM(CASE WHEN i.direction='purchase' THEN i.tax_total ELSE 0 END) AS tax_paid,
           SUM(CASE WHEN i.direction='sales'    THEN i.subtotal  ELSE 0 END) AS sales_net,
           SUM(CASE WHEN i.direction='purchase' THEN i.subtotal  ELSE 0 END) AS purchases_net
      FROM invoices i
      JOIN entities e ON e.id = i.entity_id
     WHERE i.status IN ('paid','sent')
       AND i.issue_date IS NOT NULL
     GROUP BY e.id, year, quarter
     ORDER BY year DESC, quarter DESC, e.code
  `).all();
  res.json(rows.map(r => ({
    ...r,
    period: `${r.year} Q${r.quarter}`,
    net_vat_due: (r.tax_collected || 0) - (r.tax_paid || 0),
  })));
});

// Quarter-over-quarter P&L comparison (current vs same quarter last year)
app.get('/api/reports/qoq', (req, res) => {
  const today = new Date();
  const curYear = today.getFullYear();
  const curQ = Math.floor(today.getMonth() / 3) + 1;
  const lastYear = curYear - 1;
  function bounds(year, q) {
    const startMonth = (q - 1) * 3;
    const start = `${year}-${String(startMonth + 1).padStart(2, '0')}-01`;
    const endMonth = startMonth + 3;
    const endYear = endMonth > 11 ? year + 1 : year;
    const endMonthAdj = endMonth > 11 ? 1 : endMonth + 1;
    const end = `${endYear}-${String(endMonthAdj).padStart(2, '0')}-01`;
    return [start, end];
  }
  const [curStart, curEnd]  = bounds(curYear, curQ);
  const [lstStart, lstEnd]  = bounds(lastYear, curQ);
  const entities = db.prepare(`SELECT id, code, base_currency FROM entities WHERE status='active' ORDER BY code`).all();
  const rows = entities.map(e => {
    const fetchPeriod = (start, end) => ({
      revenue: db.prepare(`SELECT COALESCE(SUM(total), 0) AS s FROM invoices WHERE entity_id=? AND direction='sales'    AND status IN ('paid','sent') AND issue_date >= ? AND issue_date < ?`).get(e.id, start, end).s || 0,
      expense: db.prepare(`SELECT COALESCE(SUM(total), 0) AS s FROM invoices WHERE entity_id=? AND direction='purchase' AND status IN ('paid','sent') AND issue_date >= ? AND issue_date < ?`).get(e.id, start, end).s || 0,
    });
    const cur = fetchPeriod(curStart, curEnd);
    const lst = fetchPeriod(lstStart, lstEnd);
    const pct = (a, b) => !b ? null : Math.round(((a - b) / b) * 1000) / 10;
    return {
      entity_code: e.code,
      base_currency: e.base_currency,
      current_period: `${curYear} Q${curQ}`,
      previous_period: `${lastYear} Q${curQ}`,
      current_revenue:  cur.revenue, previous_revenue: lst.revenue, revenue_delta_pct: pct(cur.revenue, lst.revenue),
      current_expense:  cur.expense, previous_expense: lst.expense, expense_delta_pct: pct(cur.expense, lst.expense),
      current_net: cur.revenue - cur.expense,
      previous_net: lst.revenue - lst.expense,
    };
  });
  res.json(rows);
});

// Top expense categories — money_flows of kind='expense' grouped by category, in USD.
app.get('/api/reports/expense-categories', (req, res) => {
  const days  = Math.max(1, Math.min(3650, Number(req.query.days) || 365));
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT
      COALESCE(NULLIF(TRIM(category), ''), 'Uncategorised') AS category,
      COUNT(*) AS count,
      SUM(ABS(amount * fx_rate_to_usd)) AS total_usd
    FROM money_flows
    WHERE kind = 'expense' AND flow_date >= ?
    GROUP BY category
    ORDER BY total_usd DESC
  `).all(since);
  res.json({ since, days, rows });
});

app.get('/api/dashboard/consolidated', (req, res) => {
  const reporting = (getSetting('reporting_currency', 'USD') || 'USD').toUpperCase();
  const entities = db.prepare(`SELECT id, code, base_currency FROM entities WHERE status='active'`).all();
  const ytdStart = new Date().getFullYear() + '-01-01';
  let cash = 0, ar = 0, ap = 0, revenue = 0, expense = 0;
  const breakdown = [];
  for (const e of entities) {
    const cashLocal    = (db.prepare(`SELECT COALESCE(SUM(a.opening_balance + COALESCE((SELECT SUM(t.amount) FROM bank_transactions t WHERE t.account_id = a.id), 0)),0) AS s FROM bank_accounts a WHERE a.entity_id=? AND a.status='active'`).get(e.id).s) || 0;
    const arLocal      = (db.prepare(`SELECT COALESCE(SUM(total),0) AS s FROM invoices WHERE entity_id=? AND direction='sales'    AND status IN ('draft','sent')`).get(e.id).s) || 0;
    const apLocal      = (db.prepare(`SELECT COALESCE(SUM(total),0) AS s FROM invoices WHERE entity_id=? AND direction='purchase' AND status IN ('draft','sent')`).get(e.id).s) || 0;
    const revLocal     = (db.prepare(`SELECT COALESCE(SUM(total),0) AS s FROM invoices WHERE entity_id=? AND direction='sales'    AND status='paid' AND issue_date>=?`).get(e.id, ytdStart).s) || 0;
    const expLocal     = (db.prepare(`SELECT COALESCE(SUM(total),0) AS s FROM invoices WHERE entity_id=? AND direction='purchase' AND status='paid' AND issue_date>=?`).get(e.id, ytdStart).s) || 0;
    const cashConv = convert(cashLocal, e.base_currency, reporting);
    const arConv   = convert(arLocal,   e.base_currency, reporting);
    const apConv   = convert(apLocal,   e.base_currency, reporting);
    const revConv  = convert(revLocal,  e.base_currency, reporting);
    const expConv  = convert(expLocal,  e.base_currency, reporting);
    cash    += cashConv || 0;
    ar      += arConv   || 0;
    ap      += apConv   || 0;
    revenue += revConv  || 0;
    expense += expConv  || 0;
    breakdown.push({
      code: e.code, base_currency: e.base_currency,
      cash_local: cashLocal, cash_reporting: cashConv,
      ar_local: arLocal, ar_reporting: arConv,
      revenue_local: revLocal, revenue_reporting: revConv,
    });
  }
  res.json({
    reporting_currency: reporting,
    cash, ar, ap, revenue, expense,
    net_ytd: revenue - expense,
    breakdown,
    note: 'FX conversion uses rates from /api/fx-rates. Edit them under Ops & Settings → Currencies.',
  });
});

// ==================================================================
// Tax-ID validation: live (EU VIES) + format-only fallbacks
// ==================================================================

const EU_COUNTRIES = new Set(['AT','BE','BG','CY','CZ','DE','DK','EE','EL','ES','FI','FR','HR','HU','IE','IT','LT','LU','LV','MT','NL','PL','PT','RO','SE','SI','SK','XI']);
// XI = Northern Ireland post-Brexit, still queryable via VIES.

const NON_EU_RULES = {
  GB: { regex: /^(GB)?\d{9}(\d{3})?$/i, label: 'UK VAT', deeplink: 'https://www.tax.service.gov.uk/check-vat-number/enter-vat-details' },
  AE: { regex: /^[13]\d{14}$/,           label: 'UAE TRN', deeplink: 'https://eservices.tax.gov.ae/en-us/trn-verify' },
  HK: { regex: /^\d{8}$/,                label: 'HK BR',   deeplink: 'https://www.icris.cr.gov.hk/csci/' },
  US: { regex: /^\d{2}-?\d{7}$/,         label: 'US EIN',  deeplink: 'https://apps.irs.gov/app/eos/' },
  SG: { regex: /^[STFG]\d{7}[A-Z]$/i,    label: 'SG UEN',  deeplink: 'https://www.bizfile.gov.sg/' },
  CH: { regex: /^CHE-?\d{3}\.?\d{3}\.?\d{3}( (MWST|TVA|IVA))?$/i, label: 'CH UID', deeplink: 'https://www.uid.admin.ch/' },
};

async function viesCheck(countryCode, vatNumber) {
  const cc = String(countryCode).toUpperCase();
  const num = String(vatNumber).replace(/[\s-]/g, '').replace(new RegExp(`^${cc}`), '');
  const r = await fetch('https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ countryCode: cc, vatNumber: num }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`VIES ${r.status}: ${data.errorWrappers?.[0]?.message || 'service error'}`);
  return {
    source:   'VIES',
    valid:    !!data.valid,
    name:     data.name || null,
    address:  data.address || null,
    country:  cc,
    number:   num,
    checked_at: data.requestDate || new Date().toISOString(),
  };
}

app.get('/api/validate/tax-id', async (req, res) => {
  const country = String(req.query.country || '').toUpperCase();
  const number  = String(req.query.number  || '').trim();
  if (!country || !number) return res.status(400).json({ error: 'country and number required' });

  if (EU_COUNTRIES.has(country)) {
    try {
      const result = await viesCheck(country, number);
      res.json(result);
    } catch (err) {
      res.status(502).json({ source: 'VIES', valid: null, error: err.message });
    }
    return;
  }

  const rule = NON_EU_RULES[country];
  if (rule) {
    const cleaned = number.replace(/\s/g, '');
    const valid = rule.regex.test(cleaned);
    return res.json({
      source: 'format',
      valid,
      country,
      number: cleaned,
      label: rule.label,
      deeplink: rule.deeplink,
      message: valid
        ? `${rule.label} format looks valid. Verify identity manually at ${rule.deeplink}.`
        : `${rule.label} format does not match expected pattern.`,
    });
  }

  return res.json({
    source: 'unknown',
    valid: null,
    country,
    number,
    message: `No validator configured for ${country}. Check format manually.`,
  });
});

// ==================================================================
// CSV export — generic helper + per-resource endpoints
// ==================================================================

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function rowsToCSV(rows, cols) {
  const header = cols.join(',');
  if (!rows.length) return header + '\n';
  const body = rows.map(r => cols.map(c => csvCell(r[c])).join(',')).join('\n');
  return header + '\n' + body + '\n';
}
function sendCSV(res, filename, rows, cols) {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename}.csv"`);
  res.send(rowsToCSV(rows, cols));
}

app.get('/api/export/contacts.csv', (req, res) => {
  const where = [], args = [];
  if (req.query.contact_type) { where.push('contact_type = ?'); args.push(req.query.contact_type); }
  if (req.query.q) { where.push('(LOWER(display_name) LIKE ? OR LOWER(legal_name) LIKE ? OR LOWER(email) LIKE ? OR LOWER(tax_id) LIKE ?)');
    const q = '%' + String(req.query.q).toLowerCase() + '%'; args.push(q, q, q, q); }
  if (req.query.status) { where.push('status = ?'); args.push(req.query.status); }
  else if (req.query.include_archived !== '1') { where.push("status != 'archived'"); }
  if (req.query.tag) { where.push("(',' || LOWER(COALESCE(tags,'')) || ',') LIKE ?"); args.push('%,' + String(req.query.tag).toLowerCase() + ',%'); }
  const sql = `SELECT * FROM contacts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY display_name`;
  const rows = db.prepare(sql).all(...args);
  sendCSV(res, 'carbon-contacts', rows, [
    'id', 'contact_type', 'display_name', 'legal_name', 'jurisdiction_code',
    'tax_id', 'email', 'phone', 'website',
    'address_line1', 'address_line2', 'city', 'postal_code', 'country',
    'currency_default', 'payment_terms_days', 'tags', 'status', 'created_at', 'updated_at',
  ]);
});

app.get('/api/export/invoices.csv', (req, res) => {
  const where = [], args = [];
  if (req.query.entity_id) { where.push('i.entity_id = ?'); args.push(Number(req.query.entity_id)); }
  if (req.query.direction) { where.push('i.direction = ?'); args.push(req.query.direction); }
  if (req.query.status)    { where.push('i.status = ?'); args.push(req.query.status); }
  if (req.query.q)         { where.push('(i.number LIKE ? OR LOWER(c.display_name) LIKE ?)');
    const q = '%' + String(req.query.q).toLowerCase() + '%'; args.push('%' + req.query.q + '%', q); }
  if (req.query.include_void !== '1') where.push("i.status != 'void'");
  const sql = `
    SELECT i.id, i.number, i.external_number, i.direction, i.issue_date, i.due_date,
           e.code AS entity_code, c.display_name AS counterparty,
           i.currency, i.subtotal, i.tax_total, i.total, i.fx_rate_to_base,
           i.status, i.po_reference, i.notes, i.created_at
      FROM invoices i
      JOIN entities e ON e.id = i.entity_id
      JOIN contacts c ON c.id = i.contact_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY i.issue_date DESC, i.id DESC
  `;
  const rows = db.prepare(sql).all(...args);
  sendCSV(res, 'carbon-invoices', rows, [
    'id', 'number', 'external_number', 'direction', 'issue_date', 'due_date',
    'entity_code', 'counterparty', 'currency', 'subtotal', 'tax_total', 'total',
    'fx_rate_to_base', 'status', 'po_reference', 'notes', 'created_at',
  ]);
});

app.get('/api/export/contracts.csv', (req, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.title, c.contract_type, c.reference,
           e.code AS entity_code, p.display_name AS counterparty,
           c.start_date, c.end_date, c.auto_renew, c.renewal_notice_days,
           c.value_amount, c.value_currency, c.status, c.file_name, c.notes, c.updated_at
      FROM contracts c
      JOIN entities e ON e.id = c.entity_id
      JOIN contacts p ON p.id = c.counterparty_id
     ORDER BY c.title
  `).all();
  sendCSV(res, 'carbon-contracts', rows, [
    'id', 'title', 'contract_type', 'reference', 'entity_code', 'counterparty',
    'start_date', 'end_date', 'auto_renew', 'renewal_notice_days',
    'value_amount', 'value_currency', 'status', 'file_name', 'notes', 'updated_at',
  ]);
});

app.get('/api/export/kyc.csv', (req, res) => {
  const rows = db.prepare(`
    SELECT k.id, c.display_name AS counterparty, c.contact_type, c.jurisdiction_code,
           k.risk_tier, k.status, k.verified_at, k.refresh_due,
           k.pep_check, k.sanctions_check, k.source_of_funds, k.notes, k.updated_at,
           (SELECT COUNT(*) FROM kyc_documents d WHERE d.kyc_record_id = k.id) AS doc_count
      FROM kyc_records k
      JOIN contacts c ON c.id = k.contact_id
     ORDER BY c.display_name
  `).all();
  sendCSV(res, 'carbon-kyc', rows, [
    'id', 'counterparty', 'contact_type', 'jurisdiction_code',
    'risk_tier', 'status', 'verified_at', 'refresh_due',
    'pep_check', 'sanctions_check', 'source_of_funds', 'notes', 'doc_count', 'updated_at',
  ]);
});

app.get('/api/export/bank-accounts.csv', (req, res) => {
  const rows = db.prepare(`
    SELECT a.id, e.code AS entity_code, a.bank_name, a.account_label,
           a.account_number, a.iban, a.swift_bic, a.currency,
           a.opening_balance, a.provider, a.status, a.last_synced_at, a.notes
      FROM bank_accounts a JOIN entities e ON e.id = a.entity_id
     ORDER BY e.code, a.bank_name
  `).all();
  sendCSV(res, 'carbon-bank-accounts', rows, [
    'id', 'entity_code', 'bank_name', 'account_label',
    'account_number', 'iban', 'swift_bic', 'currency',
    'opening_balance', 'provider', 'status', 'last_synced_at', 'notes',
  ]);
});

app.get('/api/export/bank-transactions.csv', (req, res) => {
  const accountId = req.query.account_id ? Number(req.query.account_id) : null;
  const stmt = accountId
    ? db.prepare(`SELECT t.*, a.bank_name, a.account_label, i.number AS matched_invoice_number
                    FROM bank_transactions t
                    JOIN bank_accounts a ON a.id = t.account_id
                    LEFT JOIN invoices i ON i.id = t.matched_invoice_id
                   WHERE t.account_id = ? ORDER BY t.txn_date DESC, t.id DESC`)
    : db.prepare(`SELECT t.*, a.bank_name, a.account_label, i.number AS matched_invoice_number
                    FROM bank_transactions t
                    JOIN bank_accounts a ON a.id = t.account_id
                    LEFT JOIN invoices i ON i.id = t.matched_invoice_id
                   ORDER BY t.txn_date DESC, t.id DESC`);
  const rows = accountId ? stmt.all(accountId) : stmt.all();
  sendCSV(res, 'carbon-bank-transactions', rows, [
    'id', 'bank_name', 'account_label', 'txn_date', 'description', 'reference',
    'amount', 'currency', 'category', 'reconciled', 'matched_invoice_number', 'notes', 'imported_at',
  ]);
});

app.get('/api/export/flows.csv', (req, res) => {
  const rows = db.prepare(`
    SELECT f.id, f.flow_date, f.kind,
           fe.code AS from_entity, fc.display_name AS from_contact,
           te.code AS to_entity,   tc.display_name AS to_contact,
           f.amount, f.currency, f.fx_rate_to_usd, f.reference, f.notes, f.created_at
      FROM money_flows f
      LEFT JOIN entities fe ON fe.id = f.from_entity_id
      LEFT JOIN entities te ON te.id = f.to_entity_id
      LEFT JOIN contacts fc ON fc.id = f.from_contact_id
      LEFT JOIN contacts tc ON tc.id = f.to_contact_id
     ORDER BY f.flow_date DESC, f.id DESC
  `).all();
  sendCSV(res, 'carbon-flows', rows, [
    'id', 'flow_date', 'kind', 'from_entity', 'from_contact',
    'to_entity', 'to_contact', 'amount', 'currency', 'fx_rate_to_usd',
    'reference', 'notes', 'created_at',
  ]);
});

app.get('/api/export/audit.csv', (req, res) => {
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 10000').all();
  sendCSV(res, 'carbon-audit-log', rows, [
    'id', 'ts', 'table_name', 'row_id', 'action', 'actor', 'before_json', 'after_json',
  ]);
});

// --- audit log (read-only, with filters)
app.get('/api/audit', (req, res) => {
  const where = [];
  const args = [];
  if (req.query.table)  { where.push('table_name = ?'); args.push(req.query.table); }
  if (req.query.row_id) { where.push('row_id = ?');     args.push(Number(req.query.row_id)); }
  if (req.query.action) { where.push('action = ?');     args.push(req.query.action); }
  if (req.query.actor)  { where.push('actor LIKE ?');   args.push('%' + req.query.actor + '%'); }
  if (req.query.since)  { where.push('ts >= ?');        args.push(req.query.since); }
  if (req.query.until)  { where.push('ts <= ?');        args.push(req.query.until + ' 23:59:59'); }
  const sql = `SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 500`;
  res.json(db.prepare(sql).all(...args));
});

// Tasks (todos linked optionally to a record)
app.get('/api/tasks', (req, res) => {
  const status = req.query.status;
  const sql = status
    ? `SELECT * FROM tasks WHERE status = ? ORDER BY (due_date IS NULL), due_date, id`
    : `SELECT * FROM tasks ORDER BY status='done', (due_date IS NULL), due_date, id`;
  res.json(status ? db.prepare(sql).all(status) : db.prepare(sql).all());
});
app.post('/api/tasks', (req, res) => {
  const b = req.body || {};
  if (!b.title) return res.status(400).json({ error: 'title required' });
  const result = db.prepare(`INSERT INTO tasks (title, due_date, status, ref_table, ref_id, notes) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(b.title, b.due_date || null, b.status || 'open', b.ref_table || null, b.ref_id || null, b.notes || null);
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid);
  audit('tasks', row.id, 'insert', null, row);
  res.json(row);
});
app.put('/api/tasks/:id', (req, res) => {
  const id = Number(req.params.id);
  const before = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!before) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  db.prepare(`UPDATE tasks SET title=@title, due_date=@due_date, status=@status, ref_table=@ref_table, ref_id=@ref_id, notes=@notes, updated_at=datetime('now') WHERE id=@id`).run({
    id,
    title:     b.title     ?? before.title,
    due_date:  b.due_date  ?? before.due_date,
    status:    b.status    ?? before.status,
    ref_table: b.ref_table ?? before.ref_table,
    ref_id:    b.ref_id    ?? before.ref_id,
    notes:     b.notes     ?? before.notes,
  });
  const after = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  audit('tasks', id, 'update', before, after);
  res.json(after);
});
app.delete('/api/tasks/:id', (req, res) => {
  const id = Number(req.params.id);
  const before = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!before) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  audit('tasks', id, 'delete', before, null);
  res.json({ ok: true });
});

// Notifications inbox
app.get('/api/notifications', (req, res) => {
  const rows = db.prepare(`SELECT * FROM notifications ORDER BY id DESC LIMIT 50`).all();
  const unread = db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE is_read = 0`).get().n;
  res.json({ unread, items: rows });
});
app.post('/api/notifications/mark-read', (req, res) => {
  db.prepare(`UPDATE notifications SET is_read = 1`).run();
  res.json({ ok: true });
});
app.delete('/api/notifications', (req, res) => {
  db.prepare(`DELETE FROM notifications`).run();
  res.json({ ok: true });
});

app.get('/api/audit/facets', (req, res) => {
  const tables  = db.prepare('SELECT DISTINCT table_name FROM audit_log ORDER BY table_name').all().map(r => r.table_name);
  const actions = db.prepare('SELECT DISTINCT action FROM audit_log ORDER BY action').all().map(r => r.action);
  const actors  = db.prepare('SELECT DISTINCT actor FROM audit_log ORDER BY actor').all().map(r => r.actor);
  res.json({ tables, actions, actors });
});

// Global JSON error handler — convert thrown errors on /api/* to JSON instead of Express's HTML default.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error('API error on', req.method, req.path, '—', err.message);
  if (req.path.startsWith('/api/')) {
    const status = err.status || (String(err).includes('UNIQUE') ? 409 : 500);
    res.status(status).json({ error: err.message || String(err) });
  } else {
    res.status(500).type('text/plain').send('Internal error');
  }
});

const PORT = Number(process.env.PORT) || 4040;
const BIND_HOST = process.env.BIND_HOST || (IS_PROD ? '0.0.0.0' : '127.0.0.1');
if (IS_PROD) app.set('trust proxy', 1); // behind Coolify/Traefik
app.listen(PORT, BIND_HOST, () => {
  console.log(`Carbon running at http://${BIND_HOST}:${PORT} (NODE_ENV=${process.env.NODE_ENV || 'development'})`);
});
