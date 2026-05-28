-- Carbon schema v0.1
-- Local-first SQLite for multi-entity company management.
-- Append-only audit_log on every write.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS jurisdictions (
  code                    TEXT PRIMARY KEY,           -- 'hk', 'ae'
  name                    TEXT NOT NULL,
  currency_default        TEXT NOT NULL,
  vat_default             REAL NOT NULL DEFAULT 0,    -- 0.05 for UAE, 0 for HK
  tax_id_label            TEXT,                       -- 'BR' (HK), 'TRN' (UAE)
  invoice_footer          TEXT,
  record_retention_years  INTEGER,
  notes                   TEXT
);

CREATE TABLE IF NOT EXISTS entities (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  code                TEXT UNIQUE NOT NULL,           -- 'HWG', 'MER'
  legal_name          TEXT NOT NULL,
  jurisdiction_code   TEXT NOT NULL REFERENCES jurisdictions(code),
  tax_id              TEXT,
  registered_address  TEXT,
  base_currency       TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active',
  notes               TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contacts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_type        TEXT NOT NULL,                  -- customer|supplier|bank|advisor|intercompany|regulator|individual|other
  display_name        TEXT NOT NULL,
  legal_name          TEXT,
  jurisdiction_code   TEXT REFERENCES jurisdictions(code),
  tax_id              TEXT,
  email               TEXT,
  phone               TEXT,
  website             TEXT,
  address_line1       TEXT,
  address_line2       TEXT,
  city                TEXT,
  postal_code         TEXT,
  country             TEXT,
  currency_default    TEXT,
  payment_terms_days  INTEGER,
  notes               TEXT,
  tags                TEXT,                           -- comma-separated for v0.1
  status              TEXT NOT NULL DEFAULT 'active',
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_contacts_type ON contacts(contact_type);
CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(display_name);

CREATE TABLE IF NOT EXISTS contact_entity_links (
  contact_id    INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  entity_id     INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relationship  TEXT,
  PRIMARY KEY (contact_id, entity_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name   TEXT NOT NULL,
  row_id       INTEGER,
  action       TEXT NOT NULL,                         -- insert|update|delete
  actor        TEXT NOT NULL DEFAULT 'ben',
  before_json  TEXT,
  after_json   TEXT,
  ts           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_table ON audit_log(table_name, row_id);

-- ------------------------------------------------------------------
-- Phase 2: invoicing
-- ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS invoice_sequences (
  entity_id    INTEGER PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  prefix       TEXT NOT NULL DEFAULT '',
  next_number  INTEGER NOT NULL DEFAULT 1,
  pad_width    INTEGER NOT NULL DEFAULT 4
);

CREATE TABLE IF NOT EXISTS invoices (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id       INTEGER NOT NULL REFERENCES entities(id),
  contact_id      INTEGER NOT NULL REFERENCES contacts(id),
  number          TEXT NOT NULL,
  issue_date      TEXT NOT NULL,
  due_date        TEXT,
  currency        TEXT NOT NULL,
  fx_rate_to_base REAL NOT NULL DEFAULT 1.0,
  subtotal        REAL NOT NULL DEFAULT 0,
  tax_total       REAL NOT NULL DEFAULT 0,
  total           REAL NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'draft',   -- draft|sent|paid|void
  po_reference    TEXT,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(entity_id, number)
);

CREATE INDEX IF NOT EXISTS idx_invoices_entity   ON invoices(entity_id);
CREATE INDEX IF NOT EXISTS idx_invoices_contact  ON invoices(contact_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status   ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_issue    ON invoices(issue_date);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id     INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL DEFAULT 0,
  description    TEXT NOT NULL,
  quantity       REAL NOT NULL DEFAULT 1,
  unit_price     REAL NOT NULL DEFAULT 0,
  tax_rate       REAL NOT NULL DEFAULT 0,
  line_subtotal  REAL NOT NULL DEFAULT 0,
  line_tax       REAL NOT NULL DEFAULT 0,
  line_total     REAL NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_invoice_lines_inv ON invoice_lines(invoice_id);

-- ------------------------------------------------------------------
-- Phase 2: contracts
-- ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS contracts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id           INTEGER NOT NULL REFERENCES entities(id),
  counterparty_id     INTEGER NOT NULL REFERENCES contacts(id),
  title               TEXT NOT NULL,
  contract_type       TEXT,                              -- MSA|SOW|NDA|Lease|Service|License|Other
  reference           TEXT,
  start_date          TEXT,
  end_date            TEXT,
  auto_renew          INTEGER NOT NULL DEFAULT 0,
  renewal_notice_days INTEGER,
  value_amount        REAL,
  value_currency      TEXT,
  status              TEXT NOT NULL DEFAULT 'active',    -- draft|active|expired|terminated
  file_path           TEXT,
  file_name           TEXT,
  file_mime           TEXT,
  file_size           INTEGER,
  notes               TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_contracts_entity   ON contracts(entity_id);
CREATE INDEX IF NOT EXISTS idx_contracts_party    ON contracts(counterparty_id);
CREATE INDEX IF NOT EXISTS idx_contracts_status   ON contracts(status);
CREATE INDEX IF NOT EXISTS idx_contracts_end_date ON contracts(end_date);

-- ------------------------------------------------------------------
-- Phase 3: KYC
-- ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kyc_records (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id          INTEGER NOT NULL UNIQUE REFERENCES contacts(id) ON DELETE CASCADE,
  risk_tier           TEXT NOT NULL DEFAULT 'medium',    -- low|medium|high
  status              TEXT NOT NULL DEFAULT 'pending',   -- pending|in_progress|approved|rejected|expired
  verified_at         TEXT,
  refresh_due         TEXT,
  source_of_funds     TEXT,
  beneficial_owners   TEXT,
  pep_check           INTEGER NOT NULL DEFAULT 0,        -- 0|1
  sanctions_check     INTEGER NOT NULL DEFAULT 0,        -- 0|1
  notes               TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_kyc_status   ON kyc_records(status);
CREATE INDEX IF NOT EXISTS idx_kyc_refresh  ON kyc_records(refresh_due);

CREATE TABLE IF NOT EXISTS kyc_documents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kyc_record_id INTEGER NOT NULL REFERENCES kyc_records(id) ON DELETE CASCADE,
  doc_type      TEXT NOT NULL,                           -- passport|address_proof|register_extract|UBO|other
  file_path     TEXT NOT NULL,
  file_name     TEXT NOT NULL,
  file_mime     TEXT,
  file_size     INTEGER,
  uploaded_at   TEXT NOT NULL DEFAULT (datetime('now')),
  notes         TEXT
);

CREATE INDEX IF NOT EXISTS idx_kyc_docs_record ON kyc_documents(kyc_record_id);

-- ------------------------------------------------------------------
-- Phase 3: banking (reconciliation only — no external API)
-- ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bank_accounts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id        INTEGER NOT NULL REFERENCES entities(id),
  bank_name        TEXT NOT NULL,
  account_label    TEXT NOT NULL,
  account_number   TEXT,
  iban             TEXT,
  swift_bic        TEXT,
  currency         TEXT NOT NULL,
  opening_balance  REAL NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'active',
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bank_accts_entity ON bank_accounts(entity_id);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id        INTEGER NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  txn_date          TEXT NOT NULL,
  description       TEXT,
  reference         TEXT,
  amount            REAL NOT NULL,        -- positive = credit, negative = debit
  currency          TEXT NOT NULL,
  running_balance   REAL,
  matched_invoice_id INTEGER REFERENCES invoices(id),
  reconciled        INTEGER NOT NULL DEFAULT 0,    -- 0|1
  category          TEXT,                          -- income|expense|transfer|fee|other
  notes             TEXT,
  imported_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, txn_date, amount, description)
);

CREATE INDEX IF NOT EXISTS idx_bank_tx_account ON bank_transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_bank_tx_date    ON bank_transactions(txn_date);
CREATE INDEX IF NOT EXISTS idx_bank_tx_match   ON bank_transactions(matched_invoice_id);

-- ------------------------------------------------------------------
-- Phase 4: intercompany & external money flows
-- ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS money_flows (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  flow_date         TEXT NOT NULL,
  from_entity_id    INTEGER REFERENCES entities(id),
  from_contact_id   INTEGER REFERENCES contacts(id),
  to_entity_id      INTEGER REFERENCES entities(id),
  to_contact_id     INTEGER REFERENCES contacts(id),
  amount            REAL NOT NULL,
  currency          TEXT NOT NULL,
  fx_rate_to_usd    REAL NOT NULL DEFAULT 1.0,
  kind              TEXT NOT NULL DEFAULT 'transfer',    -- invoice|transfer|loan|dividend|capital|expense|other
  reference         TEXT,
  bank_tx_id        INTEGER REFERENCES bank_transactions(id),
  invoice_id        INTEGER REFERENCES invoices(id),
  notes             TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_flows_from_e ON money_flows(from_entity_id);
CREATE INDEX IF NOT EXISTS idx_flows_to_e   ON money_flows(to_entity_id);
CREATE INDEX IF NOT EXISTS idx_flows_date   ON money_flows(flow_date);

-- ------------------------------------------------------------------
-- Settings & Ops: API credentials vault + sync history
-- ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS api_credentials (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  provider          TEXT NOT NULL,                          -- 'aspire' | 'wio' | future
  label             TEXT,
  entity_id         INTEGER REFERENCES entities(id),
  bank_account_id   INTEGER REFERENCES bank_accounts(id) ON DELETE SET NULL,
  client_id         TEXT,
  client_secret     TEXT,
  api_key           TEXT,
  access_token      TEXT,
  refresh_token     TEXT,
  token_expires_at  TEXT,
  environment       TEXT NOT NULL DEFAULT 'sandbox',         -- sandbox | production
  status            TEXT NOT NULL DEFAULT 'active',          -- active | revoked
  notes             TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_creds_provider ON api_credentials(provider);
CREATE INDEX IF NOT EXISTS idx_creds_account  ON api_credentials(bank_account_id);

CREATE TABLE IF NOT EXISTS sync_runs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  provider         TEXT NOT NULL,
  bank_account_id  INTEGER REFERENCES bank_accounts(id) ON DELETE CASCADE,
  started_at       TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at      TEXT,
  status           TEXT NOT NULL DEFAULT 'running',          -- running | ok | error
  inserted         INTEGER NOT NULL DEFAULT 0,
  skipped          INTEGER NOT NULL DEFAULT 0,
  error_message    TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_account ON sync_runs(bank_account_id);
CREATE INDEX IF NOT EXISTS idx_sync_started ON sync_runs(started_at);

-- ------------------------------------------------------------------
-- Users + sessions
-- ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL,
  password_salt  TEXT NOT NULL,
  display_name   TEXT,
  role           TEXT NOT NULL DEFAULT 'admin',     -- admin | user | readonly
  status         TEXT NOT NULL DEFAULT 'active',    -- active | disabled
  last_login_at  TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,
  user_agent  TEXT,
  last_seen   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON sessions(expires_at);

-- ------------------------------------------------------------------
-- FX rates + app settings (reporting currency + future toggles)
-- ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS fx_rates (
  currency      TEXT PRIMARY KEY,             -- ISO 4217, e.g. 'HKD'
  rate_to_usd   REAL NOT NULL,                -- 1 unit of <currency> = N USD
  source        TEXT,                         -- 'manual' | 'ecb' | provider name
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS saved_views (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  panel       TEXT NOT NULL,
  name        TEXT NOT NULL,
  query_json  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
