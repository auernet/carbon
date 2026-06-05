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

  // 8) Income money flow (non-invoice) → DR Bank / CR Revenue
  d0 = t.totalDebit;
  const inflow = await api('POST', '/api/flows', { flow_date: TODAY, amount: 300, currency: 'HKD', kind: 'income', to_entity_id: 1, from_contact_id: 2 });
  t = await tb();
  if (!t.balanced) die('income flow not balanced');
  if (dd(t.totalDebit - d0) !== 300) die(`income flow: debit delta ${dd(t.totalDebit - d0)} != 300`);
  if (acct(t, '1010').debit < 300) die('income flow: Bank not debited');
  ok('income money flow → DR Bank 300 / CR Revenue 300, balanced');

  // 9) Expense money flow → DR Expense / CR Bank
  d0 = t.totalDebit;
  await api('POST', '/api/flows', { flow_date: TODAY, amount: 200, currency: 'HKD', kind: 'expense', from_entity_id: 1, to_contact_id: 2 });
  t = await tb();
  if (!t.balanced) die('expense flow not balanced');
  if (dd(t.totalDebit - d0) !== 200) die(`expense flow: debit delta ${dd(t.totalDebit - d0)} != 200`);
  ok('expense money flow → DR Expense 200 / CR Bank 200, balanced');

  // 10) Invoice-linked flow is NOT posted (avoids double-count)
  d0 = t.totalDebit;
  await api('POST', '/api/flows', { flow_date: TODAY, amount: 999, currency: 'USD', kind: 'income', to_entity_id: 1, from_contact_id: 2, invoice_id: fxInv.id });
  t = await tb();
  if (!t.balanced) die('invoice-linked flow not balanced');
  if (dd(t.totalDebit - d0) !== 0) die(`invoice-linked flow wrongly posted (delta ${dd(t.totalDebit - d0)})`);
  ok('invoice-linked flow is skipped (no double-count), balanced');

  // 11) Delete a flow clears its footprint
  d0 = t.totalDebit;
  await api('DELETE', `/api/flows/${inflow.id}`);
  t = await tb();
  if (!t.balanced) die('flow delete not balanced');
  if (dd(d0 - t.totalDebit) !== 300) die(`flow delete: debit drop ${dd(d0 - t.totalDebit)} != 300`);
  ok('delete money flow clears its footprint, balanced');

  // 12) Manual journal — balanced (opening balance)
  d0 = t.totalDebit;
  const j = await api('POST', '/api/ledger/journal', { entity_id: 1, event_date: TODAY, description: 'Opening balance', lines: [{ account_code: '1000', direction: 'debit', amount: 5000 }, { account_code: '3000', direction: 'credit', amount: 5000 }] });
  t = await tb();
  if (!t.balanced) die('manual journal not balanced');
  if (dd(t.totalDebit - d0) !== 5000) die(`manual journal: debit delta ${dd(t.totalDebit - d0)} != 5000`);
  ok('manual journal (DR Cash 5000 / CR Equity 5000) posts, balanced');

  // 13) Manual journal — unbalanced is rejected
  let rejected = false;
  try { await api('POST', '/api/ledger/journal', { entity_id: 1, event_date: TODAY, lines: [{ account_code: '1000', direction: 'debit', amount: 100 }, { account_code: '3000', direction: 'credit', amount: 50 }] }); }
  catch (e) { rejected = /balanced|≠/.test(e.message); }
  if (!rejected) die('unbalanced manual journal was NOT rejected');
  ok('unbalanced manual journal is rejected');

  // 14) Delete the manual journal clears its footprint
  d0 = t.totalDebit;
  await api('DELETE', `/api/ledger/journal/${j.txn_id}`);
  t = await tb();
  if (!t.balanced) die('after journal delete not balanced');
  if (dd(d0 - t.totalDebit) !== 5000) die(`journal delete: debit drop ${dd(d0 - t.totalDebit)} != 5000`);
  ok('delete manual journal clears its footprint, balanced');

  // 15) Financial statements derive correctly + balance-sheet identity holds
  const st = await api('GET', '/api/ledger/statements?entity_id=1');
  if (dd((st.pl.income - st.pl.expenses) - st.pl.net) !== 0) die(`P&L net mismatch (${st.pl.income} - ${st.pl.expenses} ≠ ${st.pl.net})`);
  if (!st.bs.balanced) die(`balance sheet does not balance (A=${st.bs.assets}, L+Eq+NI=${st.bs.liabilities + st.bs.equity + st.bs.netIncome})`);
  ok(`statements: P&L net ${st.pl.net}; balance sheet balances (A ${st.bs.assets} = L+Eq+NetIncome)`);

  // 16) Period filtering — P&L is a flow over [from,to]; balance sheet is cumulative "as of" to
  await api('POST', '/api/invoices', { entity_id: 1, contact_id: 2, currency: 'HKD', status: 'sent', direction: 'sales', issue_date: '2020-06-15', lines: [{ description: '2020 sale', quantity: 1, unit_price: 100, tax_rate: 0 }] });
  const st19 = await api('GET', '/api/ledger/statements?entity_id=1&from=2019-01-01&to=2019-12-31');
  const st20 = await api('GET', '/api/ledger/statements?entity_id=1&from=2020-01-01&to=2020-12-31');
  if (dd(st19.pl.net) !== 0)    die(`2019 window should be empty, got P&L net ${st19.pl.net}`);
  if (dd(st20.pl.net) !== 100)  die(`2020 window P&L net ${st20.pl.net} != 100 (should isolate the 2020 sale)`);
  if (dd(st19.bs.assets) !== 0)   die(`balance sheet as-of 2019 assets ${st19.bs.assets} != 0`);
  if (dd(st20.bs.assets) !== 100) die(`balance sheet as-of 2020 assets ${st20.bs.assets} != 100`);
  if (!st19.bs.balanced || !st20.bs.balanced) die('period balance sheet does not balance');
  ok('period filtering: empty 2019 window, isolated 2020 P&L, cumulative as-of balance sheet, balanced');

  // 17) Chart of accounts — create a custom account and post to it
  await api('POST', '/api/ledger/accounts', { entity_id: 1, code: '6000', name: 'Marketing', category: 'E' });
  let dupRej = false;
  try { await api('POST', '/api/ledger/accounts', { entity_id: 1, code: '6000', name: 'Dup', category: 'E' }); } catch (e) { dupRej = /already exists/.test(e.message); }
  if (!dupRej) die('duplicate account code was not rejected');
  await api('POST', '/api/ledger/journal', { entity_id: 1, event_date: TODAY, description: 'Mktg spend', lines: [{ account_code: '6000', direction: 'debit', amount: 250 }, { account_code: '1000', direction: 'credit', amount: 250 }] });
  t = await tb();
  if (!t.balanced) die('after posting to custom account not balanced');
  if (acct(t, '6000').debit < 250) die('custom account 6000 not debited in trial balance');
  ok('create custom account + post to it (balanced, shows in trial balance)');

  // 18) Account guards: system + in-use protected; archive hides; empty custom deletes
  let sysGuard = false;
  try { await api('DELETE', '/api/ledger/accounts/1100?entity_id=1'); } catch (e) { sysGuard = /system/.test(e.message); }
  if (!sysGuard) die('deleting a system account was not blocked');
  let postGuard = false;
  try { await api('DELETE', '/api/ledger/accounts/6000?entity_id=1'); } catch (e) { postGuard = /postings/.test(e.message); }
  if (!postGuard) die('deleting an in-use account was not blocked');
  await api('PUT', '/api/ledger/accounts/6000?entity_id=1', { archived: 1 });
  if ((await api('GET', '/api/ledger/accounts?entity_id=1')).find(a => a.code === '6000')) die('archived account still listed as active');
  await api('POST', '/api/ledger/accounts', { entity_id: 1, code: '6001', name: 'Temp', category: 'E' });
  await api('DELETE', '/api/ledger/accounts/6001?entity_id=1');
  if ((await api('GET', '/api/ledger/accounts?entity_id=1')).find(a => a.code === '6001')) die('empty custom account was not deleted');
  ok('account guards: system + in-use protected, archive hides, empty custom deletes');

  console.log(`\n✅ LEDGER TEST OK — ${passed} checks passed, trial balance held at every step.`);
  cleanup();
  process.exit(0);
})().catch(e => die(e.message));
