#!/usr/bin/env node
// Carbon smoke test — boots the server, drives a headless Chrome through login +
// the core tabs, and fails if the app doesn't actually render. Catches the
// "blank screen on boot" class of regression (the 2026-05-30 init crash) that a
// syntax check alone misses. Run before any deploy:  npm run smoke
const { spawn } = require('child_process');
const path = require('path');
const puppeteer = require('puppeteer-core');

const PORT = process.env.SMOKE_PORT || 4099;
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ADMIN = { email: 'ben@aa.ag', password: 'nobfa3-cobjip-zIjpob' };
const ROOT = path.resolve(__dirname, '..');

let server, browser;
const cleanup = () => { try { browser && browser.close(); } catch (_) {} try { server && server.kill(); } catch (_) {} };
const fail = (msg) => { console.error('\n❌ SMOKE FAIL:', msg); cleanup(); process.exit(1); };

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/login.html`); if (r.ok) return; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  fail('server did not start on ' + BASE);
}

(async () => {
  server = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test' }, stdio: 'ignore' });
  server.on('error', e => fail('could not spawn server: ' + e.message));
  await waitForServer();

  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => fail('uncaught JS error in page: ' + e.message)); // a real boot crash

  // --- login ---
  await page.goto(`${BASE}/login.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[name="email"]', { timeout: 8000 }).catch(() => fail('login form never rendered'));
  await page.type('input[name="email"]', ADMIN.email);
  await page.type('input[name="password"]', ADMIN.password);
  await page.click('#login-form button[type="submit"]');

  // --- the app must boot and the dashboard must finish loading ---
  await page.waitForSelector('.tab[data-tab="dashboard"]', { timeout: 12000 }).catch(() => fail('app shell never loaded after login'));
  await page.waitForFunction(
    () => { const el = document.getElementById('dash-today'); return el && el.textContent.trim().length > 0; },
    { timeout: 12000 }
  ).catch(() => fail('dashboard did not finish loading (dash-today empty) — the blank-screen regression'));

  // --- the boot error banner must NOT be present ---
  if (await page.$('#app-error-bar')) fail('boot error banner is showing — init() threw');

  // --- each core tab must actually show its panel ---
  for (const t of ['invoices', 'flows', 'banks', 'ledger', 'audit', 'reports', 'contacts']) {
    await page.click(`.tab[data-tab="${t}"]`).catch(() => fail(`tab "${t}" not clickable`));
    await page.waitForFunction(
      (id) => { const p = document.getElementById('tab-' + id); return p && !p.hidden; },
      { timeout: 8000 }, t
    ).catch(() => fail(`tab "${t}" did not show its panel`));
    if (await page.$('#app-error-bar')) fail(`boot error banner appeared after opening "${t}"`);
  }

  // Ledger journal dialog must actually open (catches missing wiring / api methods)
  await page.click('.tab[data-tab="ledger"]');
  await page.waitForFunction(() => { const p = document.getElementById('tab-ledger'); return p && !p.hidden; }, { timeout: 6000 }).catch(() => fail('ledger tab did not show'));
  await page.click('#btn-new-journal');
  await page.waitForFunction(() => { const d = document.getElementById('journal-dialog'); return d && d.open && d.querySelector('.je-acct'); }, { timeout: 6000 }).catch(() => fail('journal entry dialog did not open'));
  if (await page.$('#app-error-bar')) fail('error banner appeared opening the journal dialog');

  // Account drill-down must open and render (catches missing api method / wiring)
  await page.evaluate(() => { const d = document.getElementById('journal-dialog'); if (d && d.open) d.close(); });
  await page.click('#tab-ledger tr.acct-row').catch(() => fail('no clickable account row in the ledger'));
  await page.waitForFunction(() => { const d = document.getElementById('account-dialog'); return d && d.open && d.querySelector('#ad-body table, #ad-body .dash-empty'); }, { timeout: 6000 }).catch(() => fail('account drill-down dialog did not open'));
  if (await page.$('#app-error-bar')) fail('error banner appeared opening the account dialog');

  // CSV export: builder escapes correctly + export buttons rendered on the cards
  const csvCheck = await page.evaluate(() => ({
    csv: window.__buildCSV(['a', 'b'], [['1', 'x,y']]),
    buttons: !!document.querySelector('#tab-ledger [data-export="pl"]') && !!document.querySelector('#tab-ledger [data-export="trial"]'),
  }));
  if (csvCheck.csv !== 'a,b\r\n1,"x,y"') fail('CSV builder output malformed: ' + JSON.stringify(csvCheck.csv));
  if (!csvCheck.buttons) fail('CSV export buttons missing from ledger cards');

  // Comparative P&L: prior-period date math (pure) + the comparison render path
  const pw = await page.evaluate(() => ({
    month: window.__priorWindow('month', '2026-06-15'),
    ytd: window.__priorWindow('ytd', '2026-06-15'),
    quarter: window.__priorWindow('quarter', '2026-05-10'),
    all: window.__priorWindow('all', '2026-06-15'),
  }));
  if (!(pw.month && pw.month.from === '2026-05-01' && pw.month.to === '2026-05-31')) fail('priorWindow month wrong: ' + JSON.stringify(pw.month));
  if (!(pw.ytd && pw.ytd.from === '2025-01-01' && pw.ytd.to === '2025-06-15')) fail('priorWindow ytd wrong: ' + JSON.stringify(pw.ytd));
  if (!(pw.quarter && pw.quarter.from === '2026-01-01' && pw.quarter.to === '2026-03-31')) fail('priorWindow quarter wrong: ' + JSON.stringify(pw.quarter));
  if (pw.all !== null) fail('priorWindow "all" should be null');
  await page.evaluate(() => { const d = document.getElementById('account-dialog'); if (d && d.open) d.close(); });
  await page.select('#ledger-period', 'month');
  await page.waitForFunction(() => { const h = document.querySelector('#ledger-pl table thead'); return h && /prev month/.test(h.textContent); }, { timeout: 6000 }).catch(() => fail('comparative P&L (prior-period column) did not render'));
  if (await page.$('#app-error-bar')) fail('error banner appeared rendering comparative P&L');

  if (consoleErrors.length) console.warn('⚠ console errors (non-fatal):', consoleErrors.slice(0, 5));
  console.log('\n✅ SMOKE OK — login + dashboard + 7 core tabs render, no uncaught errors.');
  cleanup();
  process.exit(0);
})().catch(e => fail(e.message));
