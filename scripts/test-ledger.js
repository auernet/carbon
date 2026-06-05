#!/usr/bin/env node
// Hermetic ledger test. Copies the real data dir to a throwaway temp dir, boots
// the server against it (CARBON_DATA_DIR), and drives every Phase-1 posting path
// end-to-end via the API, asserting the trial balance stays balanced after each.
// Touches NO real data. Run:  npm run test:ledger
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.LEDGER_TEST_PORT || 4097;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { email: 'ben@aa.ag', password: 'nobfa3-cobjip-zIjpob' };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-ledger-'));
fs.cpSync(path.join(ROOT, 'data'), path.join(tmp, 'data'), { recursive: true });

let server, cookie = '', passed = 0;
const cleanup = () => { try { server && server.kill(); } catch (_) {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} };
const die = (m) => { console.error('\n❌ LEDGER TEST FAIL:', m); cleanup(); process.exit(1); };
const ok  = (m) => { passed++; console.log('  ✓', m); };

async function api(method, p, body) {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch (_) { j = txt; }
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status}: ${String(txt).slice(0, 140)}`);
  return j;
}
const tb = (eid = 1) => api('GET', `/api/ledger/trial-balance?entity_id=${eid}`);
const acct = (t, code) => t.rows.find(r => r.account_code === code) || { debit: 0, credit: 0 };
const dd = (n) => Math.round(n);
async function waitUp() { for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/login.html'); if (r.ok) return; } catch (_) {} await new Promise(r => setTimeout(r, 250)); } die('server did not start'); }

(async () => {
  server = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), CARBON_DATA_DIR: path.join(tmp, 'data'), NODE_ENV: 'test' }, stdio: 'ignore' });
  server.on('error', e => die('spawn: ' + e.message));
  await waitUp();
  await api('POST', '/api/auth/login', ADMIN); ok('login');
  const TODAY = new Date().toISOString().slice(0, 10);

  let t = await tb();
  if (!t.balanced) die('baseline trial balance not balanced'); ok(`baseline balanced (D=${t.totalDebit} C=${t.totalCredit})`);

  // 1) Sales invoice WITH tax → DR AR(total) / CR Revenue(subtotal) / CR Output VAT(tax)
  let d0 = t.totalDebit;
  const inv = await api('POST', '/api/invoices', { entity_id: 1, contact_id: 2, currency: 'HKD', status: 'sent', direction: 'sales', issue_date: TODAY, lines: [{ description: 'Test sale', quantity: 1, unit_price: 1000, tax_rate: 0.05 }] });
  t = await tb();
  if (!t.balanced) die('sales+tax not balanced');
  if (dd(t.totalDebit - d0) !== 1050) die(`sales+tax: debit delta ${dd(t.totalDebit - d0)} != 1050`);
  if (acct(t, '2100').credit < 50) die('sales+tax: Output VAT not credited');
  ok('sales invoice w/ tax → DR AR 1050 / CR Rev 1000 / CR VAT 50, balanced');

  // 2) Payment → DR Undeposited / CR AR
  d0 = t.totalDebit;
  await api('POST', `/api/invoices/${inv.id}/payments`, { amount: 500, paid_on: TODAY });
  t = await tb();
  if (!t.balanced) die('payment not balanced');
  if (dd(t.totalDebit - d0) !== 500) die(`payment: debit delta ${dd(t.totalDebit - d0)} != 500`);
  if (acct(t, '1090').debit < 500) die('payment: Undeposited not debited');
  ok('payment → DR Undeposited 500 / CR AR 500, balanced');

  // 3) Purchase bill WITH tax → DR Expense + Input VAT / CR AP
  d0 = t.totalDebit;
  const bill = await api('POST', '/api/invoices', { entity_id: 1, contact_id: 2, currency: 'HKD', status: 'sent', direction: 'purchase', issue_date: TODAY, external_number: 'TEST-BILL', lines: [{ description: 'Test bill', quantity: 1, unit_price: 800, tax_rate: 0.05 }] });
  t = await tb();
  if (!t.balanced) die('bill not balanced');
  if (dd(t.totalDebit - d0) !== 840) die(`bill: debit delta ${dd(t.totalDebit - d0)} != 840`);
  if (acct(t, '2000').credit < 840) die('bill: AP not credited');
  if (acct(t, '5000').debit < 800) die('bill: Expense not debited');
  ok('purchase bill w/ tax → DR Expense 800 + Input VAT 40 / CR AP 840, balanced');

  // 4) Multi-currency: 100 USD × fx 7.8 → base 780
  d0 = t.totalDebit;
  const fxInv = await api('POST', '/api/invoices', { entity_id: 1, contact_id: 2, currency: 'USD', fx_rate_to_base: 7.8, status: 'sent', direction: 'sales', issue_date: TODAY, lines: [{ description: 'FX sale', quantity: 1, unit_price: 100, tax_rate: 0 }] });
  t = await tb();
  if (!t.balanced) die('fx not balanced');
  if (dd(t.totalDebit - d0) !== 780) die(`fx: base debit delta ${dd(t.totalDebit - d0)} != 780`);
  ok('multi-currency invoice (100 USD × 7.8) → AR base 780, balanced');

  // 5) Idempotent re-post on update (no duplicate rows)
  const countFx = async () => (await api('GET', '/api/ledger?entity_id=1')).filter(e => e.description && e.description.includes(fxInv.number)).length;
  const before = await countFx();
  await api('PUT', `/api/invoices/${fxInv.id}`, { lines: [{ description: 'FX sale', quantity: 2, unit_price: 100, tax_rate: 0 }] });
  t = await tb();
  const after = await countFx();
  if (!t.balanced) die('update not balanced');
  if (after !== before) die(`update not idempotent: entry count ${before} → ${after}`);
  ok(`invoice update re-posts idempotently (${after} rows, no dupes), balanced`);

  // 6) Void clears the invoice footprint
  d0 = t.totalDebit;
  await api('DELETE', `/api/invoices/${inv.id}`); // no ?hard → void
  t = await tb();
  if (!t.balanced) die('void not balanced');
  if (t.totalDebit >= d0) die('void: footprint not removed (debit did not drop)');
  ok('void invoice clears its footprint, still balanced');

  // 7) Hard delete clears the invoice footprint
  d0 = t.totalDebit;
  await api('DELETE', `/api/invoices/${bill.id}?hard=1`);
  t = await tb();
  if (!t.balanced) die('delete not balanced');
  if (t.totalDebit >= d0) die('delete: footprint not removed');
  ok('hard delete invoice clears its footprint, still balanced');

  console.log(`\n✅ LEDGER TEST OK — ${passed} checks passed, trial balance held at every step.`);
  cleanup();
  process.exit(0);
})().catch(e => die(e.message));
