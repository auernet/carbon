-- Seed: jurisdictions + the two operating entities.
-- Safe to re-run: uses INSERT OR IGNORE.

INSERT OR IGNORE INTO jurisdictions
  (code, name, currency_default, vat_default, tax_id_label, invoice_footer, record_retention_years, notes)
VALUES
  ('hk', 'Hong Kong SAR', 'HKD', 0,
   'BR',
   'Hong Kong Business Registration No.: {tax_id}',
   7,
   'No VAT/GST. Profits Tax 8.25% first HKD 2M, 16.5% above. Annual NAR1 + profits tax return. Significant Controllers Register required.'),
  ('ae', 'United Arab Emirates', 'AED', 0.05,
   'TRN',
   'TRN: {tax_id} | VAT charged at 5% where applicable',
   5,
   'VAT 5% mandatory above AED 375k turnover. Corporate Tax 9% on profits >AED 375k from June 2023. UBO Registry + ESR notifications. E-invoicing PINT-AE rolling out 2026.');

INSERT OR IGNORE INTO entities (code, legal_name, jurisdiction_code, base_currency, tax_id, registered_address, notes)
VALUES
  ('HWG', 'Honorwell Group Limited',    'hk', 'HKD',
   '73444980',
   'Room 1203, 12/F, Tower 3, China Hong Kong City, 33 Canton Road, Tsimshatsui, Hong Kong',
   'Hong Kong holding/operating entity. Domain honorwellgroup.com. Incorporated 2021-10-15.'),
  ('MER', 'Meridian Ventures L.L.C-FZ', 'ae', 'AED',
   '2647643.01',
   'Meydan Grandstand, 6th floor, Meydan Road, Nad Al Sheba, Dubai, U.A.E.',
   'Dubai Meydan Free Zone entity. Domain meridv.com. License issued 15/04/2026, expires 14/04/2027. Not VAT-registered (below AED 375k threshold).');

-- Backfill onto already-existing rows (idempotent — only when blank, so user edits stick).
UPDATE entities
   SET tax_id = '73444980'
 WHERE code = 'HWG' AND (tax_id IS NULL OR tax_id = '');
UPDATE entities
   SET registered_address = 'Room 1203, 12/F, Tower 3, China Hong Kong City, 33 Canton Road, Tsimshatsui, Hong Kong'
 WHERE code = 'HWG' AND (registered_address IS NULL OR registered_address = '');
UPDATE entities
   SET tax_id = '2647643.01'
 WHERE code = 'MER' AND (tax_id IS NULL OR tax_id = '');
UPDATE entities
   SET registered_address = 'Meydan Grandstand, 6th floor, Meydan Road, Nad Al Sheba, Dubai, U.A.E.'
 WHERE code = 'MER' AND (registered_address IS NULL OR registered_address = '');

-- Invoice sequence per entity. Numbers render as <prefix><YYYY>-<zero-padded N>.
INSERT OR IGNORE INTO invoice_sequences (entity_id, prefix, next_number, pad_width)
SELECT id, code || '-', 1, 4 FROM entities WHERE code IN ('HWG', 'MER');

-- Seed FX rates (rate_to_usd: 1 unit of <currency> in USD). Edit anytime in Settings.
INSERT OR IGNORE INTO fx_rates (currency, rate_to_usd, source) VALUES
  ('USD', 1.0000, 'manual'),
  ('HKD', 0.1280, 'manual'),
  ('AED', 0.2723, 'manual'),
  ('EUR', 1.0900, 'manual'),
  ('GBP', 1.2700, 'manual'),
  ('SGD', 0.7400, 'manual'),
  ('CHF', 1.1300, 'manual');

INSERT OR IGNORE INTO app_settings (key, value) VALUES
  ('reporting_currency', 'USD');
