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

  if (consoleErrors.length) console.warn('⚠ console errors (non-fatal):', consoleErrors.slice(0, 5));
  console.log('\n✅ SMOKE OK — login + dashboard + 7 core tabs render, no uncaught errors.');
  cleanup();
  process.exit(0);
})().catch(e => fail(e.message));
