// Carbon UI — vanilla JS, no build step.

// --- Boot/runtime error surfacing -------------------------------------------
// A single uncaught error must never leave a silent blank screen again
// (see the 2026-05-30 blank-dashboard boot bug). Show a visible banner + log.
function showAppError(msg) {
  let bar = document.getElementById('app-error-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'app-error-bar';
    bar.setAttribute('role', 'alert');
    bar.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:99999;background:#7f1d1d;color:#fff;font:13px/1.45 system-ui,-apple-system,sans-serif;padding:10px 16px';
    (document.body || document.documentElement).appendChild(bar);
  }
  bar.textContent = '⚠ ' + msg + ' — reload the page, or open the console for details.';
}
window.addEventListener('error', (e) => showAppError('Something broke: ' + (e.message || 'script error')));
window.addEventListener('unhandledrejection', (e) => showAppError('Background error: ' + ((e.reason && e.reason.message) || e.reason || 'unknown')));

// Real implementation is wired inside init() (it closes over the task dialog), so it can't be a
// top-level function. This stub keeps an early Tasks-tab click from throwing before init wires it.
let loadTasks = () => {};

// Disable a save button while its async handler runs — prevents duplicate records from a double-click.
function guardSave(btnId, fn) {
  return async (...args) => {
    const b = document.getElementById(btnId);
    if (b) b.disabled = true;
    try { await fn(...args); } finally { if (b) b.disabled = false; }
  };
}

const api = {
  jurisdictions: () => fetch('/api/jurisdictions').then(r => r.json()),
  createJurisdiction: (body) => fetch('/api/jurisdictions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(async r => {
    if (!r.ok && r.status !== 409) throw new Error('jurisdiction create failed');
    return r.json();
  }),
  entities:      () => fetch('/api/entities').then(r => r.json()),
  contacts:      () => fetch('/api/contacts').then(r => r.json()),
  contact:       (id) => fetch('/api/contacts/' + id).then(r => r.json()),
  createContact: (body) => jsonReq('POST', '/api/contacts', body),
  updateContact: (id, body) => jsonReq('PUT', '/api/contacts/' + id, body),
  archiveContact: (id) => jsonReq('DELETE', '/api/contacts/' + id),
  audit:         () => fetch('/api/audit').then(r => r.json()),

  invoices:      (direction) => fetch('/api/invoices' + (direction ? '?direction=' + direction : '')).then(r => r.json()),
  tasks:         (status) => fetch('/api/tasks' + (status ? '?status=' + status : '')).then(r => r.json()),
  createTask:    (body) => jsonReq('POST', '/api/tasks', body),
  updateTask:    (id, body) => jsonReq('PUT', '/api/tasks/' + id, body),
  deleteTask:    (id) => jsonReq('DELETE', '/api/tasks/' + id),
  invoice:       (id) => fetch('/api/invoices/' + id).then(r => r.json()),
  createInvoice: (body) => jsonReq('POST', '/api/invoices', body),
  updateInvoice: (id, body) => jsonReq('PUT', '/api/invoices/' + id, body),
  voidInvoice:   (id) => jsonReq('DELETE', '/api/invoices/' + id),
  invoiceAttachments:      (id) => fetch('/api/invoices/' + id + '/attachments').then(r => r.json()),
  uploadInvoiceAttachment: (id, file) => fileReq('/api/invoices/' + id + '/attachments', file),
  deleteInvoiceAttachment: (attId) => jsonReq('DELETE', '/api/invoices/attachments/' + attId),
  billDefaults:            (contactId) => fetch('/api/contacts/' + contactId + '/bill-defaults').then(r => r.json()),
  checkBillDuplicate:      (contactId, ext, excludeId) => fetch('/api/bills/check-duplicate?contact_id=' + contactId + '&external_number=' + encodeURIComponent(ext) + '&exclude_id=' + (excludeId || 0)).then(r => r.json()),

  contracts:        () => fetch('/api/contracts').then(r => r.json()),
  contract:         (id) => fetch('/api/contracts/' + id).then(r => r.json()),
  createContract:   (body) => jsonReq('POST', '/api/contracts', body),
  updateContract:   (id, body) => jsonReq('PUT', '/api/contracts/' + id, body),
  archiveContract:  (id) => jsonReq('DELETE', '/api/contracts/' + id),
  uploadContractFile: (id, file) => fileReq('/api/contracts/' + id + '/file', file),

  kycList:        () => fetch('/api/kyc').then(r => r.json()),
  kyc:            (id) => fetch('/api/kyc/' + id).then(r => r.json()),
  createKyc:      (body) => jsonReq('POST', '/api/kyc', body),
  updateKyc:      (id, body) => jsonReq('PUT', '/api/kyc/' + id, body),
  deleteKyc:      (id) => jsonReq('DELETE', '/api/kyc/' + id),
  uploadKycDoc:   (id, file, docType) => fileReq('/api/kyc/' + id + '/document', file, { 'X-Doc-Type': docType }),
  deleteKycDoc:   (docId) => jsonReq('DELETE', '/api/kyc/document/' + docId),

  bankAccounts:        () => fetch('/api/bank-accounts').then(r => r.json()),
  createBankAccount:   (body) => jsonReq('POST', '/api/bank-accounts', body),
  updateBankAccount:   (id, body) => jsonReq('PUT', '/api/bank-accounts/' + id, body),
  archiveBankAccount:  (id) => jsonReq('DELETE', '/api/bank-accounts/' + id),
  bankTransactions:    (accountId) => fetch('/api/bank-transactions?account_id=' + accountId).then(r => r.json()),
  importTransactions:  (accountId, transactions) => jsonReq('POST', '/api/bank-transactions/import', { account_id: accountId, transactions }),
  matchTransaction:    (txId, invoiceId) => jsonReq('POST', '/api/bank-transactions/' + txId + '/match', { invoice_id: invoiceId }),

  dashboard:     () => fetch('/api/dashboard').then(r => r.json()),
  updateEntity:  (id, body) => jsonReq('PUT', '/api/entities/' + id, body),
  createEntity:  (body) => jsonReq('POST', '/api/entities', body),
  updateJurisdiction: (code, body) => jsonReq('PUT', '/api/jurisdictions/' + code, body),
  reportPL:      () => fetch('/api/reports/pl').then(r => r.json()),
  ledgerTrialBalance: (eid, to) => fetch('/api/ledger/trial-balance?entity_id=' + eid + (to ? '&to=' + to : '')).then(r => r.json()),
  ledgerEntries:      (eid, since, until) => fetch('/api/ledger?entity_id=' + eid + (since ? '&since=' + since : '') + (until ? '&until=' + until : '')).then(r => r.json()),
  ledgerAccounts:     (eid) => fetch('/api/ledger/accounts?entity_id=' + eid).then(r => r.json()),
  ledgerStatements:   (eid, from, to) => fetch('/api/ledger/statements?entity_id=' + eid + (from ? '&from=' + from : '') + (to ? '&to=' + to : '')).then(r => r.json()),
  ledgerAccount:      (eid, code, from, to) => fetch('/api/ledger?entity_id=' + eid + '&account=' + encodeURIComponent(code) + (from ? '&since=' + from : '') + (to ? '&until=' + to : '')).then(r => r.json()),
  createAccount:      (body) => jsonReq('POST', '/api/ledger/accounts', body),
  updateAccount:      (eid, code, body) => jsonReq('PUT', '/api/ledger/accounts/' + encodeURIComponent(code) + '?entity_id=' + eid, body),
  deleteAccount:      (eid, code) => fetch('/api/ledger/accounts/' + encodeURIComponent(code) + '?entity_id=' + eid, { method: 'DELETE' }).then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; }),
  ledgerAging:        (eid, asOf) => fetch('/api/ledger/aging?entity_id=' + eid + (asOf ? '&as_of=' + asOf : '')).then(r => r.json()),
  cashflow:           (eid, from, to) => fetch('/api/ledger/cashflow?entity_id=' + eid + (from ? '&from=' + from : '') + (to ? '&to=' + to : '')).then(r => r.json()),
  ledgerGroup:        (from, to) => fetch('/api/ledger/group?' + (from ? 'from=' + from + '&' : '') + (to ? 'to=' + to : '')).then(r => r.json()),
  postJournal:        (body) => jsonReq('POST', '/api/ledger/journal', body),
  deleteJournal:      (txnId) => fetch('/api/ledger/journal/' + encodeURIComponent(txnId), { method: 'DELETE' }).then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; }),
  reportAging:   (direction) => fetch('/api/reports/aging?direction=' + direction).then(r => r.json()),
  flows:         () => fetch('/api/flows').then(r => r.json()),
  flowSummary:   () => fetch('/api/flows/summary').then(r => r.json()),
  createFlow:    (body) => jsonReq('POST', '/api/flows', body),
  updateFlow:    (id, body) => jsonReq('PUT', '/api/flows/' + id, body),
  deleteFlow:    (id) => jsonReq('DELETE', '/api/flows/' + id),

  credentials:        () => fetch('/api/credentials').then(r => r.json()),
  createCredential:   (body) => jsonReq('POST', '/api/credentials', body),
  updateCredential:   (id, body) => jsonReq('PUT', '/api/credentials/' + id, body),
  deleteCredential:   (id) => jsonReq('DELETE', '/api/credentials/' + id),
  syncRuns:           () => fetch('/api/sync/runs').then(r => r.json()),
  syncAspire:         (accountId) => jsonReq('POST', '/api/sync/aspire/' + accountId, {}),
  system:             () => fetch('/api/system').then(r => r.json()),
  updateBankTx:       (id, body) => jsonReq('PUT', '/api/bank-transactions/' + id, body),

  dashboardHero:      () => fetch('/api/dashboard/hero').then(r => r.json()),
  dashboardTrend:     () => fetch('/api/dashboard/trend').then(r => r.json()),
  dashboardTop:       () => fetch('/api/dashboard/top').then(r => r.json()),
  dashboardConsolidated: () => fetch('/api/dashboard/consolidated').then(r => r.json()),
  fxRates:            () => fetch('/api/fx-rates').then(r => r.json()),
  putFxRate:          (currency, body) => jsonReq('PUT', '/api/fx-rates/' + currency, body),
  deleteFxRate:       (currency) => jsonReq('DELETE', '/api/fx-rates/' + currency),
  getSetting:         (key) => fetch('/api/settings/' + key).then(r => r.json()),
  setSetting:         (key, value) => jsonReq('PUT', '/api/settings/' + key, { value }),
  me:                 () => fetch('/api/auth/me').then(r => r.json()),
  logout:             () => fetch('/api/auth/logout', { method: 'POST' }).then(r => r.json()),
  users:              () => fetch('/api/users').then(r => r.json()),
  createUser:         (body) => jsonReq('POST', '/api/users', body),
  updateUser:         (id, body) => jsonReq('PUT', '/api/users/' + id, body),
  deleteUser:         (id) => jsonReq('DELETE', '/api/users/' + id),
};

function jsonReq(method, url, body) {
  return fetch(url, {
    method, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(async r => {
    if (r.status === 401) { window.location.href = '/'; throw new Error('auth required'); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    return data;
  });
}

async function tryHardDelete(url, name, refreshFn) {
  if (!await uiConfirm(`Permanently delete "${name}"? This cannot be undone.`)) return false;
  try {
    const r = await fetch(url + '?hard=1', { method: 'DELETE' });
    if (r.status === 409) {
      const data = await r.json();
      const list = Object.entries(data.blockers).map(([k, v]) => `• ${v} ${k}`).join('\n');
      await uiAlert(`Cannot delete "${name}":\n\n${list}\n\nUse Archive instead.`);
      return false;
    }
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data.error || ('HTTP ' + r.status));
    }
    if (refreshFn) await refreshFn();
    return true;
  } catch (err) {
    toast('Delete failed: ' + err.message, 'error');
    return false;
  }
}

function fileReq(url, file, extraHeaders) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-Filename': file.name,
      ...(extraHeaders || {})
    },
    body: file
  }).then(async r => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    return data;
  });
}

const state = {
  jurisdictions: [],
  entities: [],
  contacts: [],
  filterText: '',
  filterType: '',
  filterEntity: '',
  contactTagFilter: '',
  editingId: null,

  invoices: [],
  invFilterText: '',
  invFilterEntity: '',
  invFilterStatus: '',
  invFilterDirection: '',
  invEditingId: null,
  invEditingDirection: 'sales',
  invDraftLines: [],

  contracts: [],
  ctFilterText: '', ctFilterEntity: '', ctFilterStatus: '',
  ctEditingId: null,

  kyc: [],
  kycFilterText: '', kycFilterStatus: '', kycFilterRisk: '',
  kycEditingId: null,

  bankAccounts: [],
  bankCurrentAccountId: null,
  bankTransactions: [],

  flows: [],
  flowSummary: null,
  flowEditingId: null,

  credentials: [],
  credEditingId: null,
  settingsSub: 'general',
  bankTxEditingId: null,

  me: null,
  users: [],
  userEditingId: null,
};

// ---------- theme toggle (single button) ----------
const THEME_KEY = 'carbon.theme';

function resolveTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(pref) {
  const resolved = resolveTheme(pref);
  document.documentElement.setAttribute('data-theme', resolved);
  localStorage.setItem(THEME_KEY, pref);
}

const _toggleBtn = document.getElementById('btn-theme-toggle');
if (_toggleBtn) {
  _toggleBtn.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') || resolveTheme('system');
    applyTheme(cur === 'dark' ? 'light' : 'dark');
  });
}

applyTheme(localStorage.getItem(THEME_KEY) || 'light');

// Register the service worker for PWA install (best-effort, silent on failure).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ---------- toast helper ----------
function toast(message, type) {
  const stack = document.getElementById('toast-stack');
  if (!stack) { console.log('toast:', message); return; }
  const t = document.createElement('div');
  t.className = 'toast' + (type ? ' ' + type : '');
  t.textContent = message;
  stack.appendChild(t);
  setTimeout(() => {
    t.classList.add('fade-out');
    setTimeout(() => t.remove(), 200);
  }, type === 'error' ? 5000 : 3000);
}
window.toast = toast;

// ---------- tabs ----------
const TAB_TITLES = {
  dashboard: 'Dashboard',
  contacts:  'Contacts',
  invoices:  'Invoices & Bills',
  contracts: 'Contracts',
  kyc:       'KYC',
  banks:     'Banks',
  flows:     'Money Flows',
  reports:   'Reports',
  entities:  'Entities',
  audit:     'Audit',
  settings:  'Ops & Settings',
};

// Dashboard quick actions
document.querySelectorAll('.quick-actions button').forEach(btn => {
  btn.addEventListener('click', () => {
    const k = btn.dataset.quick;
    if (k === 'invoice') { document.querySelector('.tab[data-tab="invoices"]').click(); setTimeout(() => document.getElementById('btn-new-invoice').click(), 50); }
    if (k === 'bill')    { document.querySelector('.tab[data-tab="invoices"]').click(); setTimeout(() => document.getElementById('btn-new-bill').click(), 50); }
    if (k === 'contact') { document.querySelector('.tab[data-tab="contacts"]').click(); setTimeout(() => document.getElementById('btn-new-contact').click(), 50); }
    if (k === 'contract'){ document.querySelector('.tab[data-tab="contracts"]').click(); setTimeout(() => document.getElementById('btn-new-contract').click(), 50); }
  });
});

document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    const target = btn.dataset.tab;
    document.querySelectorAll('.panel').forEach(p => {
      p.hidden = p.id !== 'tab-' + target;
    });
    document.title = 'Carbon — ' + (TAB_TITLES[target] || target);
    localStorage.setItem('carbon.lastTab', target);
    if (target === 'entities') loadEntities();
    if (target === 'audit') loadAudit();
    if (target === 'invoices') loadInvoices();
    if (target === 'contracts') loadContracts();
    if (target === 'kyc') loadKyc();
    if (target === 'banks') loadBanks();
    if (target === 'flows') loadFlows();
    if (target === 'tasks') loadTasks();
    if (target === 'dashboard') loadDashboard();
    if (target === 'settings') loadSettings();
    if (target === 'reports') loadReports();
    if (target === 'ledger') loadLedger();
  });
});

// ==================================================================
// Dashboard
// ==================================================================

async function loadDashboard() {
  // One failing endpoint must never blank the whole dashboard: each fetch falls back to a
  // safe default, and each section renders inside its own guard.
  const safe = (p, fallback) => p.catch(() => fallback);
  const [d, hero, trend, top, cons, tasks] = await Promise.all([
    safe(api.dashboard(), { today: '', counts: { contacts: 0, invoices: 0, bills: 0, contracts: 0, kyc: 0, bank_accounts: 0, flows: 0 } }),
    safe(api.dashboardHero(), null),
    safe(api.dashboardTrend(), null),
    safe(api.dashboardTop(), null),
    safe(api.dashboardConsolidated(), null),
    safe(api.tasks('open'), []),
  ]);
  const sect = (fn) => { try { fn(); } catch (e) { console.error('dashboard section failed:', e); } };
  document.getElementById('dash-today').textContent = d.today || '';
  sect(() => renderConsolidated(cons));
  sect(() => renderHero(hero));
  sect(() => renderTrend(trend));
  sect(() => renderTopCounterparties(top));
  sect(() => renderDashTasks(tasks));
  sect(() => renderRecent());
  sect(() => renderFirstRunIfEmpty(d.counts));

  // counters
  const counters = [
    { label: 'Contacts',  value: d.counts.contacts,      tab: 'contacts' },
    { label: 'Invoices',  value: d.counts.invoices,      tab: 'invoices' },
    { label: 'Bills',     value: d.counts.bills,         tab: 'invoices' },
    { label: 'Contracts', value: d.counts.contracts,     tab: 'contracts' },
    { label: 'KYC',       value: d.counts.kyc,           tab: 'kyc' },
    { label: 'Accounts',  value: d.counts.bank_accounts, tab: 'banks' },
    { label: 'Flows',     value: d.counts.flows,         tab: 'flows' },
  ];
  document.getElementById('dash-counters').innerHTML = counters.map(c => `
    <div class="counter" data-go="${c.tab}">
      <div class="counter-value">${c.value}</div>
      <div class="counter-label">${escapeHtml(c.label)}</div>
    </div>
  `).join('');
  document.querySelectorAll('.counter[data-go]').forEach(el => {
    el.addEventListener('click', () => {
      const btn = document.querySelector(`.tab[data-tab="${el.dataset.go}"]`);
      if (btn) btn.click();
    });
  });

  renderDashList('dash-ar', d.ar_outstanding, r => `
    <span class="pill">${escapeHtml(r.entity_code)}</span>
    <span class="dash-amount">${escapeHtml(r.currency)} ${fmtMoney(r.amount)}</span>
    <span class="muted">${r.count} open</span>
  `, 'All paid.');

  renderDashList('dash-ap', d.ap_outstanding, r => `
    <span class="pill">${escapeHtml(r.entity_code)}</span>
    <span class="dash-amount">${escapeHtml(r.currency)} ${fmtMoney(r.amount)}</span>
    <span class="muted">${r.count} open</span>
  `, 'Nothing payable.');

  // urgent emphasis
  setCardClass('dash-overdue', d.overdue_invoices.length > 0 ? 'danger' : '');
  setCardClass('dash-contracts', d.expiring_contracts.length > 0 ? 'urgent' : '');
  setCardClass('dash-kyc', d.kyc_due.length > 0 ? 'urgent' : '');

  renderDashList('dash-overdue', d.overdue_invoices, r => `
    <span class="dir-tag dir-${r.direction}">${r.direction === 'purchase' ? 'Bill' : 'Sale'}</span>
    <strong>${escapeHtml(r.number)}</strong>
    <span>${escapeHtml(r.contact_display_name)}</span>
    <span class="dash-amount">${escapeHtml(r.currency)} ${fmtMoney(r.total)}</span>
    <span class="date-expired">${r.days_overdue}d overdue</span>
  `, 'Nothing overdue.');

  renderDashList('dash-contracts', d.expiring_contracts, r => `
    <span class="pill">${escapeHtml(r.entity_code)}</span>
    <strong>${escapeHtml(r.title)}</strong>
    <span>${escapeHtml(r.counterparty_name)}</span>
    <span class="${r.days_left < 0 ? 'date-expired' : 'date-warning'}">
      ${r.days_left < 0 ? `expired ${-r.days_left}d ago` : `${r.days_left}d left`}
    </span>
  `, 'No contracts expiring.');

  renderDashList('dash-kyc', d.kyc_due, r => `
    <strong>${escapeHtml(r.contact_display_name)}</strong>
    <span class="risk risk-${r.risk_tier}">${r.risk_tier}</span>
    <span class="${r.days_left < 0 ? 'date-expired' : 'date-warning'}">
      ${r.days_left < 0 ? `${-r.days_left}d overdue` : `${r.days_left}d left`}
    </span>
  `, 'All KYC current.');

  renderDashList('dash-bank', d.unreconciled, r => `
    <span class="pill">${escapeHtml(r.entity_code)}</span>
    <strong>${escapeHtml(r.bank_name)}</strong>
    <span>${escapeHtml(r.account_label)}</span>
    <span class="${r.count > 0 ? 'date-warning' : 'muted'}">${r.count} unreconciled</span>
  `, 'All transactions reconciled.');

  renderDashList('dash-activity', d.recent_activity, r => `
    <span class="muted">${escapeHtml(r.ts)}</span>
    <span class="pill">${escapeHtml(r.table_name)}</span>
    <span>${escapeHtml(r.action)}</span>
    ${r.row_id ? `<span class="muted">#${r.row_id}</span>` : ''}
  `, 'No activity yet.');
}

// ==================================================================
// Settings (entities + jurisdictions + backup)
// ==================================================================

const entDlg  = document.getElementById('entity-dialog');
const entForm = document.getElementById('entity-form');
const jurDlg  = document.getElementById('juris-dialog');
const jurForm = document.getElementById('juris-form');

document.getElementById('btn-backup').addEventListener('click', () => {
  window.location.href = '/api/backup';
});
document.getElementById('btn-new-entity').addEventListener('click', () => openEntityDialog(null));
document.getElementById('entity-cancel').addEventListener('click', () => entDlg.close());
document.getElementById('entity-save').addEventListener('click', guardSave('entity-save', saveEntity));
document.getElementById('juris-cancel').addEventListener('click', () => jurDlg.close());
document.getElementById('juris-save').addEventListener('click', saveJuris);

async function loadSettings() {
  // refresh entities + jurisdictions
  const [ents, jurs] = await Promise.all([api.entities(), api.jurisdictions()]);
  state.entities = ents;
  state.jurisdictions = jurs;
  const ebody = document.querySelector('#settings-entities-table tbody');
  ebody.innerHTML = ents.map(e => `
    <tr data-id="${e.id}">
      <td><strong>${escapeHtml(e.code)}</strong></td>
      <td>${escapeHtml(e.legal_name)}</td>
      <td>${escapeHtml((e.jurisdiction_code || '').toUpperCase())}</td>
      <td>${escapeHtml(e.tax_id || '')}</td>
      <td>${escapeHtml(e.base_currency)}</td>
      <td class="row-actions">
        <button data-act="edit-e">Edit</button>
        <button data-act="del-e" class="danger" title="Delete permanently">Del</button>
      </td>
    </tr>
  `).join('');
  ebody.querySelectorAll('button[data-act="edit-e"]').forEach(btn => {
    btn.addEventListener('click', e => openEntityDialog(Number(e.target.closest('tr').dataset.id)));
  });
  ebody.querySelectorAll('button[data-act="del-e"]').forEach(btn => {
    btn.addEventListener('click', async e => {
      const id = Number(e.target.closest('tr').dataset.id);
      const ent = state.entities.find(x => x.id === id);
      await tryHardDelete('/api/entities/' + id, ent?.code || 'entity', loadSettings);
    });
  });

  const jbody = document.querySelector('#settings-juris-table tbody');
  jbody.innerHTML = jurs.map(j => `
    <tr data-code="${j.code}">
      <td><strong>${escapeHtml(j.code.toUpperCase())}</strong></td>
      <td>${escapeHtml(j.name)}</td>
      <td>${escapeHtml(j.currency_default)}</td>
      <td>${escapeHtml(j.tax_id_label || '')}</td>
      <td class="num">${((j.vat_default || 0) * 100).toFixed(2)}%</td>
      <td class="muted">${escapeHtml(j.invoice_footer || '')}</td>
      <td class="row-actions">
        <button data-act="edit-j">Edit</button>
        <button data-act="del-j" class="danger">×</button>
      </td>
    </tr>
  `).join('');
  jbody.querySelectorAll('button[data-act="edit-j"]').forEach(btn => {
    btn.addEventListener('click', e => openJurisDialog(e.target.closest('tr').dataset.code));
  });
  jbody.querySelectorAll('button[data-act="del-j"]').forEach(btn => {
    btn.addEventListener('click', async e => {
      const code = e.target.closest('tr').dataset.code;
      if (!await uiConfirm(`Delete jurisdiction "${code.toUpperCase()}"? Refused if still in use.`)) return;
      try {
        const r = await fetch('/api/jurisdictions/' + code, { method: 'DELETE' });
        const data = await r.json();
        if (!r.ok) { toast(data.error || 'Delete failed', 'error'); return; }
        state.jurisdictions = await api.jurisdictions();
        await loadSettings();
      } catch (err) { toast('Delete failed: ' + err.message, 'error'); }
    });
  });
}

function openEntityDialog(id) {
  entForm.reset();
  const jurSel = document.getElementById('ent-jur');
  jurSel.innerHTML = state.jurisdictions.map(j =>
    `<option value="${j.code}">${escapeHtml(j.name)}</option>`).join('');
  document.getElementById('entity-form-title').textContent = id ? 'Edit entity' : 'New entity';
  entForm.dataset.id = id || '';
  const preview = document.getElementById('entity-logo-preview');
  const delBtn  = document.getElementById('entity-logo-delete');
  document.getElementById('entity-logo-input').value = '';
  if (id) {
    const e = state.entities.find(x => x.id === id);
    if (e) for (const [k, v] of Object.entries(e)) {
      const el = entForm.elements[k];
      if (el && v != null) el.value = String(v);
    }
    if (e && e.logo_path) {
      preview.innerHTML = `<img src="/api/entities/${id}/logo?t=${Date.now()}" style="max-height:60px;max-width:200px"/>`;
      delBtn.hidden = false;
    } else {
      preview.textContent = 'No logo uploaded.';
      delBtn.hidden = true;
    }
  } else {
    entForm.elements['status'].value = 'active';
    preview.textContent = 'Save the entity first, then upload a logo.';
    delBtn.hidden = true;
  }
  entDlg.showModal();
}

document.getElementById('entity-logo-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  const id = entForm.dataset.id ? Number(entForm.dataset.id) : null;
  if (!file || !id) return;
  try {
    await fetch('/api/entities/' + id + '/logo', {
      method: 'POST',
      headers: { 'Content-Type': file.type, 'X-Filename': file.name },
      body: file,
    }).then(r => { if (!r.ok) throw new Error('upload failed'); });
    document.getElementById('entity-logo-preview').innerHTML =
      `<img src="/api/entities/${id}/logo?t=${Date.now()}" style="max-height:60px;max-width:200px"/>`;
    document.getElementById('entity-logo-delete').hidden = false;
    // refresh entities cache
    state.entities = await api.entities();
  } catch (err) { toast('Logo upload failed: ' + err.message, 'error'); }
});

document.getElementById('entity-logo-delete').addEventListener('click', async () => {
  const id = entForm.dataset.id ? Number(entForm.dataset.id) : null;
  if (!id) return;
  if (!await uiConfirm('Remove the logo?')) return;
  await fetch('/api/entities/' + id + '/logo', { method: 'DELETE' });
  document.getElementById('entity-logo-preview').textContent = 'No logo uploaded.';
  document.getElementById('entity-logo-delete').hidden = true;
  state.entities = await api.entities();
});

// Restore upload
document.getElementById('btn-restore').addEventListener('click', async () => {
  const file = document.getElementById('restore-input').files[0];
  if (!file) { toast('Pick a tar.gz backup file first.', 'warn'); return; }
  if (!await uiConfirm('Queue this restore? Current data will be saved alongside as data-pre-restore-<timestamp>. Server must be restarted to apply.')) return;
  try {
    const r = await fetch('/api/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip', 'X-Filename': file.name },
      body: file,
    });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || 'restore failed');
    toast('Restore queued — restart the server to apply.', 'ok');
  } catch (err) { toast('Restore failed: ' + err.message, 'error'); }
});

async function saveEntity() {
  const data = {};
  for (const el of entForm.elements) {
    if (!el.name) continue;
    data[el.name] = el.value || null;
  }
  if (!data.code || !data.legal_name || !data.jurisdiction_code || !data.base_currency) {
    toast('Code, legal name, jurisdiction and currency are required', 'warn'); return;
  }
  data.base_currency = (data.base_currency || '').toUpperCase();
  try {
    const id = entForm.dataset.id ? Number(entForm.dataset.id) : null;
    if (id) await api.updateEntity(id, data);
    else    await api.createEntity(data);
  } catch (e) { toast('Save failed: ' + e.message, 'error'); return; }
  entDlg.close();
  await loadSettings();
}

function openJurisDialog(code) {
  jurForm.reset();
  const j = state.jurisdictions.find(x => x.code === code);
  if (!j) return;
  for (const [k, v] of Object.entries(j)) {
    const el = jurForm.elements[k];
    if (el && v != null) el.value = String(v);
  }
  document.getElementById('juris-form-title').textContent = 'Edit ' + j.name;
  jurDlg.showModal();
}

async function saveJuris() {
  const data = {};
  for (const el of jurForm.elements) {
    if (!el.name) continue;
    data[el.name] = el.value || null;
  }
  data.vat_default = data.vat_default ? Number(data.vat_default) : 0;
  data.record_retention_years = data.record_retention_years ? Number(data.record_retention_years) : null;
  try { await api.updateJurisdiction(data.code, data); }
  catch (e) { toast('Save failed: ' + e.message, 'error'); return; }
  jurDlg.close();
  await loadSettings();
}

// ==================================================================
// Reports
// ==================================================================

async function loadReports() {
  const safe = (p, fallback) => p.catch(() => fallback);
  const [pl, ar, ap] = await Promise.all([
    safe(api.reportPL(), []),
    safe(api.reportAging('sales'), []),
    safe(api.reportAging('purchase'), []),
  ]);
  const plEl = document.getElementById('reports-pl');
  if (!pl.length) {
    plEl.innerHTML = '<div class="muted">No entities yet.</div>';
  } else {
    const max = Math.max(
      1,
      ...pl.map(p => Math.max(p.revenue_paid + p.revenue_open, p.expense_paid + p.expense_open))
    );
    plEl.innerHTML = `
      <div class="dash-card dash-card-wide">
        <h3>Revenue vs Expenses per entity</h3>
        <div class="bar-legend">
          <span><span class="swatch sw-rev"></span> Revenue</span>
          <span><span class="swatch sw-exp"></span> Expenses</span>
          <span class="muted">Each entity in its own base currency</span>
        </div>
        ${pl.map(p => {
          const rev = p.revenue_paid + p.revenue_open;
          const exp = p.expense_paid + p.expense_open;
          const net = rev - exp;
          const revPct = (rev / max * 100).toFixed(1);
          const expPct = (exp / max * 100).toFixed(1);
          return `
            <div class="bar-row">
              <div class="bar-label"><strong>${escapeHtml(p.entity_code)}</strong> <span class="muted">${escapeHtml(p.base_currency)}</span></div>
              <div class="bar-track">
                <div class="bar-rev" style="width:${revPct}%" title="Revenue ${fmtMoney(rev)}"></div>
                <div class="bar-exp" style="width:${expPct}%" title="Expenses ${fmtMoney(exp)}"></div>
              </div>
              <div class="bar-meta">net <strong class="${net < 0 ? 'date-expired' : ''}">${fmtMoney(net)}</strong></div>
            </div>
          `;
        }).join('')}
      </div>
      ${pl.map(p => {
        const net = (p.revenue_paid + p.revenue_open) - (p.expense_paid + p.expense_open);
        return `
        <div class="dash-card">
          <h3>${escapeHtml(p.entity_code)} — ${escapeHtml(p.legal_name)}</h3>
          <div class="dash-row"><span>Revenue (paid)</span><span class="dash-amount">${escapeHtml(p.base_currency)} ${fmtMoney(p.revenue_paid)}</span></div>
          <div class="dash-row"><span>Revenue (open)</span><span class="dash-amount">${escapeHtml(p.base_currency)} ${fmtMoney(p.revenue_open)}</span></div>
          <div class="dash-row"><span>Expenses (paid)</span><span class="dash-amount">${escapeHtml(p.base_currency)} ${fmtMoney(p.expense_paid)}</span></div>
          <div class="dash-row"><span>Expenses (open)</span><span class="dash-amount">${escapeHtml(p.base_currency)} ${fmtMoney(p.expense_open)}</span></div>
          <div class="dash-row" style="border-top:1px solid var(--border);padding-top:8px;margin-top:6px;font-weight:600">
            <span>Net (paid + open)</span>
            <span class="dash-amount ${net < 0 ? 'date-expired' : ''}">${escapeHtml(p.base_currency)} ${fmtMoney(net)}</span>
          </div>
        </div>`;
      }).join('')}
    `;
  }

  renderAging('ar-aging-table', ar);
  renderAging('ap-aging-table', ap);
  try {
    const qoq = await fetch('/api/reports/qoq').then(r => r.json());
    const tbody = document.querySelector('#qoq-table tbody');
    if (tbody) {
      tbody.innerHTML = qoq.length ? qoq.map(r => {
        // riseIsBad=true for expenses: a rising cost is bad (danger), a falling cost is good (accent).
        const delta = (v, riseIsBad = false) => {
          if (v == null) return '<span class="muted">—</span>';
          const good = riseIsBad ? v < 0 : v >= 0;
          const color = v === 0 ? 'var(--muted)' : good ? 'var(--accent)' : 'var(--danger)';
          return `<span style="color:${color}">${v >= 0 ? '+' : ''}${v}%</span>`;
        };
        return `
          <tr>
            <td><span class="pill">${escapeHtml(r.entity_code)}</span></td>
            <td>${escapeHtml(r.current_period)}</td>
            <td class="num">${escapeHtml(r.base_currency)} ${fmtMoney(r.current_revenue)}</td>
            <td class="num">${delta(r.revenue_delta_pct)}</td>
            <td class="num">${escapeHtml(r.base_currency)} ${fmtMoney(r.current_expense)}</td>
            <td class="num">${delta(r.expense_delta_pct, true)}</td>
            <td class="num"><strong>${escapeHtml(r.base_currency)} ${fmtMoney(r.current_net)}</strong></td>
          </tr>
        `;
      }).join('') : '<tr><td colspan="7" class="empty">No activity yet.</td></tr>';
    }
  } catch (_) {}
  try {
    const vat = await fetch('/api/reports/vat').then(r => r.json());
    const tbody = document.querySelector('#vat-report-table tbody');
    if (tbody) {
      tbody.innerHTML = vat.length ? vat.map(r => `
        <tr>
          <td><span class="pill">${escapeHtml(r.entity_code)}</span></td>
          <td>${escapeHtml(r.period)}</td>
          <td>${escapeHtml(r.base_currency || '')}</td>
          <td class="num">${fmtMoney(r.sales_net)}</td>
          <td class="num">${fmtMoney(r.tax_collected)}</td>
          <td class="num">${fmtMoney(r.purchases_net)}</td>
          <td class="num">${fmtMoney(r.tax_paid)}</td>
          <td class="num ${r.net_vat_due < 0 ? 'date-warning' : ''}"><strong>${fmtMoney(r.net_vat_due)}</strong></td>
        </tr>
      `).join('') : '<tr><td colspan="8" class="empty">No VAT-bearing activity yet.</td></tr>';
    }
  } catch (_) {}
  try {
    const data = await fetch('/api/reports/expense-categories?days=365').then(r => r.json());
    const tbody = document.querySelector('#exp-cat-table tbody');
    if (tbody) {
      const rows = (data && data.rows) || [];
      const total = rows.reduce((s, r) => s + (r.total_usd || 0), 0);
      tbody.innerHTML = rows.length ? rows.map(r => {
        const pct = total > 0 ? ((r.total_usd / total) * 100).toFixed(1) : '0.0';
        return `
          <tr>
            <td>${escapeHtml(r.category)}</td>
            <td class="num">${r.count}</td>
            <td class="num">${fmtMoney(r.total_usd)}</td>
            <td class="num muted">${pct}%</td>
          </tr>`;
      }).join('') : '<tr><td colspan="4" class="empty">No categorised expenses in the last 365 days. Add a category to money flows of kind “expense”.</td></tr>';
    }
    // Populate datalist suggestions on the flow dialog (used as autocomplete).
    const dl = document.getElementById('flow-category-suggestions');
    if (dl && data && data.rows) {
      dl.innerHTML = data.rows
        .filter(r => r.category && r.category !== 'Uncategorised')
        .map(r => `<option value="${escapeHtml(r.category)}"></option>`)
        .join('');
    }
  } catch (_) {}
}

function renderAging(tableId, rows) {
  const tbody = document.querySelector(`#${tableId} tbody`);
  if (!rows || !rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">Nothing outstanding.</td></tr>';
    renderAgingChart(tableId, []);
    return;
  }
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td><span class="pill">${escapeHtml(r.entity_code)}</span></td>
      <td>${escapeHtml(r.currency)}</td>
      <td class="num">${fmtMoney(r.current)}</td>
      <td class="num">${fmtMoney(r.d30)}</td>
      <td class="num">${fmtMoney(r.d60)}</td>
      <td class="num">${fmtMoney(r.d90)}</td>
      <td class="num ${r.d90p > 0 ? 'date-expired' : ''}">${fmtMoney(r.d90p)}</td>
      <td class="num"><strong>${fmtMoney(r.total)}</strong></td>
    </tr>
  `).join('');
  renderAgingChart(tableId, rows);
}

function renderAgingChart(tableId, rows) {
  const chartId = tableId + '-chart';
  let host = document.getElementById(chartId);
  if (!host) {
    host = document.createElement('div');
    host.id = chartId;
    host.className = 'aging-chart';
    const table = document.getElementById(tableId);
    table.insertAdjacentElement('afterend', host);
  }
  if (!rows.length) { host.innerHTML = ''; return; }
  host.innerHTML = rows.map(r => {
    const total = (r.current || 0) + (r.d30 || 0) + (r.d60 || 0) + (r.d90 || 0) + (r.d90p || 0);
    if (total <= 0) return '';
    const pct = v => total ? (v / total) * 100 : 0;
    return `
      <div class="aging-row">
        <div class="aging-label"><strong>${escapeHtml(r.entity_code)}</strong> <span class="muted">${escapeHtml(r.currency)} ${fmtMoney(total)}</span></div>
        <div class="aging-stack">
          <div class="seg s-current" style="width:${pct(r.current).toFixed(1)}%" title="Current ${fmtMoney(r.current)}"></div>
          <div class="seg s-d30"     style="width:${pct(r.d30).toFixed(1)}%"     title="1–30d ${fmtMoney(r.d30)}"></div>
          <div class="seg s-d60"     style="width:${pct(r.d60).toFixed(1)}%"     title="31–60d ${fmtMoney(r.d60)}"></div>
          <div class="seg s-d90"     style="width:${pct(r.d90).toFixed(1)}%"     title="61–90d ${fmtMoney(r.d90)}"></div>
          <div class="seg s-d90p"    style="width:${pct(r.d90p).toFixed(1)}%"    title="90+d ${fmtMoney(r.d90p)}"></div>
        </div>
      </div>
    `;
  }).join('') + `
    <div class="aging-legend">
      <span><span class="sw s-current"></span>Current</span>
      <span><span class="sw s-d30"></span>1–30d</span>
      <span><span class="sw s-d60"></span>31–60d</span>
      <span><span class="sw s-d90"></span>61–90d</span>
      <span><span class="sw s-d90p"></span>90+d</span>
    </div>
  `;
}

function renderConsolidated(c) {
  const card = document.getElementById('dash-consolidated');
  if (!c || (!c.cash && !c.ar && !c.ap && !c.revenue && !c.expense)) { card.hidden = true; return; }
  card.hidden = false;
  const ccy = c.reporting_currency || 'USD';
  card.innerHTML = `
    <div class="cons-head">
      <h3>Consolidated <span class="muted">in ${escapeHtml(ccy)}</span></h3>
      <span class="muted" style="font-size:11px">Across all active entities · edit FX rates in Ops &amp; Settings → Currencies</span>
    </div>
    <div class="cons-grid">
      <div class="cons-fig drillable" data-drill="banks"><div class="muted">Cash</div><div class="big">${escapeHtml(ccy)} ${fmtMoney(c.cash)}</div></div>
      <div class="cons-fig drillable" data-drill="ar-open"><div class="muted">AR open</div><div class="big">${escapeHtml(ccy)} ${fmtMoney(c.ar)}</div></div>
      <div class="cons-fig drillable" data-drill="ap-open"><div class="muted">AP open</div><div class="big">${escapeHtml(ccy)} ${fmtMoney(c.ap)}</div></div>
      <div class="cons-fig drillable" data-drill="rev-paid"><div class="muted">Revenue YTD</div><div class="big">${escapeHtml(ccy)} ${fmtMoney(c.revenue)}</div></div>
      <div class="cons-fig drillable" data-drill="exp-paid"><div class="muted">Expenses YTD</div><div class="big">${escapeHtml(ccy)} ${fmtMoney(c.expense)}</div></div>
      <div class="cons-fig"><div class="muted">Net YTD</div><div class="big ${c.net_ytd < 0 ? 'date-expired' : ''}">${escapeHtml(ccy)} ${fmtMoney(c.net_ytd)}</div></div>
    </div>
  `;
  card.querySelectorAll('.drillable').forEach(el => el.addEventListener('click', () => applyHeroDrill(el.dataset.drill)));
}

function applyHeroDrill(kind) {
  if (kind === 'banks') {
    document.querySelector('.tab[data-tab="banks"]')?.click();
    return;
  }
  document.querySelector('.tab[data-tab="invoices"]')?.click();
  setTimeout(() => {
    const ds = document.getElementById('invoice-filter-direction');
    const ss = document.getElementById('invoice-filter-status');
    if (!ds || !ss) return;
    ds.value = ''; ss.value = '';
    state.invFilterDirection = ''; state.invFilterStatus = '';
    const ytd = new Date().getFullYear() + '-01-01';
    if (kind === 'ar-open')  { ds.value = 'sales';    ss.value = 'sent';  state.invFilterDirection = 'sales';    state.invFilterStatus = 'sent'; }
    if (kind === 'ap-open')  { ds.value = 'purchase'; ss.value = 'sent';  state.invFilterDirection = 'purchase'; state.invFilterStatus = 'sent'; }
    if (kind === 'rev-paid') { ds.value = 'sales';    ss.value = 'paid';  state.invFilterDirection = 'sales';    state.invFilterStatus = 'paid'; }
    if (kind === 'exp-paid') { ds.value = 'purchase'; ss.value = 'paid';  state.invFilterDirection = 'purchase'; state.invFilterStatus = 'paid'; }
    loadInvoices().then(() => {
      // YTD filter applied client-side for the *-paid cases
      if (kind === 'rev-paid' || kind === 'exp-paid') {
        state.invoices = state.invoices.filter(i => (i.issue_date || '') >= ytd);
        renderInvoices();
      }
    });
  }, 50);
}

function renderDashTasks(tasks) {
  const el = document.getElementById('dash-tasks');
  if (!el) return;
  if (!tasks || !tasks.length) {
    el.innerHTML = `<div class="muted" style="padding:8px 0;font-size:11px">No open tasks. <a href="#" onclick="document.querySelector('.tab[data-tab=\\'tasks\\']').click();return false;">Add one →</a></div>`;
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  el.innerHTML = tasks.slice(0, 5).map(t => {
    const overdue = t.due_date && t.due_date < today;
    return `
      <div class="dash-row">
        <span>${escapeHtml(t.title)}</span>
        <span class="${overdue ? 'date-expired' : 'muted'}">${escapeHtml(t.due_date || 'no due')}</span>
      </div>
    `;
  }).join('');
}

function renderTopCounterparties(top) {
  function render(elId, rows, kind) {
    const el = document.getElementById(elId);
    if (!rows || !rows.length) {
      el.innerHTML = `<div class="muted" style="padding:8px 0;font-size:11px">No ${kind} activity in last 12 months.</div>`;
      return;
    }
    const max = Math.max(...rows.map(r => Number(r.total) || 0));
    el.innerHTML = rows.map(r => {
      const pct = ((Number(r.total) || 0) / max) * 100;
      return `
        <div class="top-row">
          <div class="top-row-head">
            <span class="top-name">${escapeHtml(r.display_name)}</span>
            <span class="top-total">${escapeHtml(r.currency)} ${fmtMoney(r.total)}</span>
          </div>
          <div class="top-bar"><div class="top-bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
          <div class="muted top-meta">${r.invoice_count} invoice${r.invoice_count === 1 ? '' : 's'}</div>
        </div>
      `;
    }).join('');
  }
  render('dash-top-customers', top.customers, 'customer');
  render('dash-top-suppliers', top.suppliers, 'supplier');
}

function renderTrend(trend) {
  const card = document.getElementById('dash-trend');
  const host = document.getElementById('dash-trend-charts');
  if (!trend || !trend.series.length || trend.series.every(s => s.points.every(p => !p.revenue && !p.expense))) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  host.innerHTML = trend.series.map(s => `
    <div class="trend-row">
      <div class="trend-label"><strong>${escapeHtml(s.code)}</strong> <span class="muted">${escapeHtml(s.base_currency)}</span></div>
      ${lineChartSVG(s.points, trend.months)}
    </div>
  `).join('');
}

function lineChartSVG(points, monthLabels) {
  const W = 600, H = 110, pad = { l: 8, r: 8, t: 10, b: 18 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const max = Math.max(1, ...points.flatMap(p => [p.revenue, p.expense]));
  const n = points.length;
  const xAt = i => pad.l + (n === 1 ? innerW / 2 : (innerW * i) / (n - 1));
  const yAt = v => pad.t + innerH - (v / max) * innerH;
  const path = (key) => points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i).toFixed(1)} ${yAt(p[key]).toFixed(1)}`).join(' ');
  const dots = (key, cls) => points.map((p, i) => `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(p[key]).toFixed(1)}" r="2.5" class="${cls}"><title>${escapeHtml(p.month)}: ${fmtMoney(p[key])}</title></circle>`).join('');
  const grid = [0, 0.25, 0.5, 0.75, 1].map(t => {
    const y = pad.t + innerH * (1 - t);
    return `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}" class="grid"/>`;
  }).join('');
  const xLabels = points.map((p, i) => {
    if (i % 2 !== 0) return '';
    return `<text x="${xAt(i).toFixed(1)}" y="${H - 4}" class="x-label">${escapeHtml(p.month.slice(5))}</text>`;
  }).join('');
  return `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="chart-svg">
      ${grid}
      <path d="${path('expense')}" class="line exp"/>
      <path d="${path('revenue')}" class="line rev"/>
      ${dots('expense', 'dot exp')}
      ${dots('revenue', 'dot rev')}
      ${xLabels}
    </svg>
  `;
}

function renderFirstRunIfEmpty(counts) {
  const id = 'first-run-banner';
  let el = document.getElementById(id);
  const isEmpty = counts && counts.contacts === 0 && counts.invoices === 0 && counts.bills === 0 && counts.contracts === 0;
  if (!isEmpty) {
    if (el) el.remove();
    return;
  }
  if (el) return; // already shown
  el = document.createElement('div');
  el.id = id;
  el.className = 'first-run';
  el.innerHTML = `
    <h2>Welcome to Carbon</h2>
    <p>Three quick steps to get going:</p>
    <div class="first-run-grid">
      <div class="first-run-step" data-go="contacts">
        <span class="step-num">1</span>
        <span class="step-title">Add your first contact</span>
        <span class="step-sub">A customer, supplier or bank counterparty.</span>
      </div>
      <div class="first-run-step" data-go="invoices">
        <span class="step-num">2</span>
        <span class="step-title">Issue your first invoice</span>
        <span class="step-sub">From HWG or Meridian, multi-line with tax.</span>
      </div>
      <div class="first-run-step" data-go="banks">
        <span class="step-num">3</span>
        <span class="step-title">Connect a bank account</span>
        <span class="step-sub">CSV import or Aspire live sync.</span>
      </div>
    </div>
  `;
  const dash = document.getElementById('tab-dashboard');
  dash.insertBefore(el, dash.querySelector('.quick-actions') || dash.firstChild);
  el.querySelectorAll('.first-run-step').forEach(step => {
    step.addEventListener('click', () => {
      const target = step.dataset.go;
      document.querySelector(`.tab[data-tab="${target}"]`)?.click();
    });
  });
}

function renderHero(rows) {
  const el = document.getElementById('dash-hero');
  if (!rows || !rows.length) { el.innerHTML = ''; return; }
  el.innerHTML = rows.map(e => {
    const net = e.ytd_revenue - e.ytd_expense;
    const netCls = net < 0 ? 'date-expired' : '';
    return `
      <div class="hero-card">
        <div class="hero-head">
          <div class="hero-title"><strong>${escapeHtml(e.code)}</strong> <span class="muted">${escapeHtml(e.base_currency)}</span></div>
          <div class="hero-sub muted">${escapeHtml(e.legal_name)}</div>
        </div>
        <div class="hero-figures">
          <div class="hero-fig">
            <div class="muted">Cash</div>
            <div class="big">${fmtMoney(e.cash_on_hand)}</div>
          </div>
          <div class="hero-fig">
            <div class="muted">Revenue YTD</div>
            <div class="big up">${fmtMoney(e.ytd_revenue)}</div>
          </div>
          <div class="hero-fig">
            <div class="muted">Expenses YTD</div>
            <div class="big down">${fmtMoney(e.ytd_expense)}</div>
          </div>
          <div class="hero-fig">
            <div class="muted">Net YTD</div>
            <div class="big ${netCls}">${fmtMoney(net)}</div>
          </div>
        </div>
        <div class="hero-sparkline" title="Revenue (green) vs Expenses (amber) — last 6 months">
          ${sparkline(e.monthly)}
        </div>
        <div class="hero-mini">
          <span>AR open: <strong>${fmtMoney(e.ar_open)}</strong></span>
          <span>AP open: <strong>${fmtMoney(e.ap_open)}</strong></span>
          ${runwayChip(e)}
        </div>
      </div>
    `;
  }).join('');
}

function runwayChip(e) {
  if (e.runway_months == null) {
    return '<span class="muted" title="Not burning — revenue ≥ expenses over last 90 days">Runway: <strong>∞</strong></span>';
  }
  const m = e.runway_months;
  const tone = m < 6 ? 'date-expired' : (m < 12 ? 'date-warning' : '');
  const tip = `Cash ÷ avg net daily burn (last 90d, ${fmtMoney(e.daily_burn)}/day)`;
  return `<span title="${tip}">Runway: <strong class="${tone}">${m.toFixed(1)}mo</strong></span>`;
}

function sparkline(months) {
  if (!months || !months.length) return '';
  const max = Math.max(1, ...months.flatMap(m => [m.revenue, m.expense]));
  return `<div class="spark">${months.map(m => {
    const rh = Math.max(2, Math.round((m.revenue / max) * 36));
    const eh = Math.max(2, Math.round((m.expense / max) * 36));
    return `
      <div class="spark-col" title="${m.month}: rev ${fmtMoney(m.revenue)} / exp ${fmtMoney(m.expense)}">
        <div class="spark-bar rev" style="height:${rh}px"></div>
        <div class="spark-bar exp" style="height:${eh}px"></div>
        <div class="spark-label">${m.month.slice(5)}</div>
      </div>
    `;
  }).join('')}</div>`;
}

function setCardClass(listElId, cls) {
  const card = document.getElementById(listElId)?.closest('.dash-card');
  if (!card) return;
  card.classList.remove('urgent', 'danger');
  if (cls) card.classList.add(cls);
}

function renderDashList(elId, rows, rowFn, emptyMsg) {
  const el = document.getElementById(elId);
  if (!rows || !rows.length) {
    el.innerHTML = `<div class="muted dash-empty">${escapeHtml(emptyMsg)}</div>`;
    return;
  }
  el.innerHTML = rows.map(r => `<div class="dash-row">${rowFn(r)}</div>`).join('');
}

// ---------- filter-aware CSV export ----------
document.getElementById('btn-contacts-export-csv')?.addEventListener('click', () => {
  const params = new URLSearchParams();
  if (state.filterType)   params.set('contact_type', state.filterType);
  if (state.filterText)   params.set('q', state.filterText);
  if (document.getElementById('contact-show-archived')?.checked) params.set('include_archived', '1');
  if (state.contactTagFilter) params.set('tag', state.contactTagFilter);
  window.open('/api/export/contacts.csv?' + params.toString());
});
document.getElementById('btn-invoices-export-csv')?.addEventListener('click', () => {
  const params = new URLSearchParams();
  if (state.invFilterEntity)    params.set('entity_id', state.invFilterEntity);
  if (state.invFilterDirection) params.set('direction', state.invFilterDirection);
  if (state.invFilterStatus)    params.set('status', state.invFilterStatus);
  if (state.invFilterText)      params.set('q', state.invFilterText);
  if (document.getElementById('invoice-show-void')?.checked) params.set('include_void', '1');
  window.open('/api/export/invoices.csv?' + params.toString());
});

// ---------- contacts table ----------
function renderContacts() {
  const tbody = document.querySelector('#contacts-table tbody');
  const text = state.filterText.toLowerCase();
  const type = state.filterType;
  const entity = state.filterEntity;
  const showArchived = document.getElementById('contact-show-archived')?.checked;
  const filtered = state.contacts.filter(c => {
    if (!showArchived && c.status === 'archived') return false;
    if (type && c.contact_type !== type) return false;
    if (entity) {
      const ids = (c.entity_ids_csv || '').split(',');
      if (!ids.includes(String(entity))) return false;
    }
    if (state.contactTagFilter) {
      const tags = (c.tags || '').toLowerCase().split(',').map(t => t.trim()).filter(Boolean);
      if (!tags.includes(state.contactTagFilter.toLowerCase())) return false;
    }
    if (text) {
      const blob = [
        c.display_name, c.legal_name, c.email, c.tax_id, c.tags, c.country
      ].filter(Boolean).join(' ').toLowerCase();
      if (!blob.includes(text)) return false;
    }
    return true;
  });
  // Render tag chip row (sorted distinct tags from all contacts)
  const chipsEl = document.getElementById('contact-tag-chips');
  if (chipsEl) {
    const allTags = new Set();
    state.contacts.forEach(c => (c.tags || '').split(',').map(t => t.trim()).filter(Boolean).forEach(t => allTags.add(t)));
    const sorted = [...allTags].sort((a, b) => a.localeCompare(b));
    chipsEl.innerHTML = sorted.length
      ? sorted.map(t => `<button class="tag-chip ${state.contactTagFilter === t ? 'active' : ''}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('') +
        (state.contactTagFilter ? `<button class="tag-chip tag-clear" data-tag="">× clear</button>` : '')
      : '';
    chipsEl.querySelectorAll('button.tag-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        state.contactTagFilter = btn.dataset.tag;
        renderContacts();
      });
    });
  }
  tbody.innerHTML = filtered.map(c => `
    <tr data-id="${c.id}">
      <td><strong>${escapeHtml(c.display_name)}</strong>${c.legal_name ? `<br><span class="muted">${escapeHtml(c.legal_name)}</span>` : ''}</td>
      <td><span class="pill type-${c.contact_type}">${c.contact_type}</span></td>
      <td>${(c.entity_codes || '').split(',').filter(Boolean).map(e => `<span class="pill">${escapeHtml(e)}</span>`).join('')}</td>
      <td>${c.jurisdiction_code ? c.jurisdiction_code.toUpperCase() : ''}</td>
      <td>${escapeHtml(c.tax_id || '')}</td>
      <td>${escapeHtml(c.email || '')}</td>
      <td><span class="muted">${c.status}</span></td>
      <td class="row-actions">
        <button data-act="edit">Edit</button>
        <button data-act="statement" title="Download statement PDF">Statement</button>
        <button data-act="archive" class="danger">Archive</button>
        <button data-act="del" class="danger" title="Delete permanently">Del</button>
      </td>
    </tr>
  `).join('');
  document.getElementById('contacts-empty').hidden = filtered.length > 0;

  tbody.querySelectorAll('button[data-act]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const tr = e.target.closest('tr');
      const id = Number(tr.dataset.id);
      if (btn.dataset.act === 'edit') openContactDialog(id);
      if (btn.dataset.act === 'statement') {
        btn.disabled = true; btn.textContent = '…';
        try {
          const r = await fetch('/api/contacts/' + id + '/statement.pdf');
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const blob = await r.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = (r.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'statement.pdf';
          a.click();
          URL.revokeObjectURL(url);
        } catch (err) { toast('Statement failed: ' + err.message, 'error'); }
        btn.disabled = false; btn.textContent = 'Statement';
      }
      if (btn.dataset.act === 'archive') {
        if (await uiConfirm('Archive this contact?')) {
          try { await api.archiveContact(id); await loadContacts(); }
          catch (err) { toast('Archive failed: ' + err.message, 'error'); }
        }
      }
      if (btn.dataset.act === 'del') {
        const c = state.contacts.find(x => x.id === id);
        await tryHardDelete('/api/contacts/' + id, c?.display_name || 'contact', loadContacts);
      }
    });
  });
}

async function loadContacts() {
  state.contacts = await api.contacts();
  await loadSavedViews('contacts');
  renderContacts();
}

document.getElementById('contact-search').addEventListener('input', (e) => {
  state.filterText = e.target.value;
  renderContacts();
});
document.getElementById('contact-filter-type').addEventListener('change', (e) => {
  state.filterType = e.target.value;
  renderContacts();
});
document.getElementById('contact-filter-entity').addEventListener('change', (e) => {
  state.filterEntity = e.target.value;
  renderContacts();
});
document.getElementById('contact-show-archived').addEventListener('change', renderContacts);
document.getElementById('invoice-show-void').addEventListener('change', renderInvoices);
document.getElementById('contract-show-terminated').addEventListener('change', renderContracts);

// ---------- contact dialog ----------
const dlg = document.getElementById('contact-dialog');
const form = document.getElementById('contact-form');

document.getElementById('btn-new-contact').addEventListener('click', () => openContactDialog(null));
document.getElementById('contact-cancel').addEventListener('click', () => dlg.close());
document.getElementById('contact-save').addEventListener('click', guardSave('contact-save', saveContact));

async function openContactDialog(id) {
  state.editingId = id;
  form.reset();

  // wire jurisdiction combobox
  setupJurisdictionCombobox();

  // populate entity checkboxes
  const checkbox = document.getElementById('entity-checkboxes');
  checkbox.innerHTML = state.entities.map(e => `
    <label><input type="checkbox" name="entity_${e.id}" value="${e.id}" /> ${escapeHtml(e.code)} — ${escapeHtml(e.legal_name)}</label>
  `).join('');

  document.getElementById('contact-form-title').textContent = id ? 'Edit contact' : 'New contact';

  if (id) {
    const c = await api.contact(id);
    trackRecent('contacts', id, c.display_name || '#' + id);
    for (const [k, v] of Object.entries(c)) {
      const el = form.elements[k];
      if (el && v != null) el.value = v;
    }
    if (c.jurisdiction_code) {
      setJurisdictionComboboxValue(c.jurisdiction_code);
    }
    (c.entity_ids || []).forEach(eid => {
      const cb = form.elements['entity_' + eid];
      if (cb) cb.checked = true;
    });
  } else {
    form.elements['contact_type'].value = 'customer';
    form.elements['status'].value = 'active';
  }

  if (id) attachActivityPanel(dlg, 'contacts', id);
  dlg.showModal();
}

// ---------- jurisdiction combobox ----------
function setupJurisdictionCombobox() {
  const root = form.querySelector('[data-combobox="jurisdiction"]');
  const input = root.querySelector('.combobox-input');
  const hidden = root.querySelector('input[name="jurisdiction_code"]');
  const listEl = root.querySelector('.combobox-list');

  input.value = '';
  hidden.value = '';
  listEl.hidden = true;
  let focusedIdx = -1;

  function existingByCode(code) {
    return state.jurisdictions.find(j => j.code === code.toLowerCase());
  }

  function buildItems(query) {
    const q = query.trim().toLowerCase();
    const all = window.COUNTRIES.map(c => {
      const code = c.code.toLowerCase();
      const existing = existingByCode(code);
      return {
        code,
        upper: c.code,
        name: existing ? existing.name : c.name,
        currency: existing ? existing.currency_default : c.currency,
        existing: !!existing,
      };
    });
    let filtered = all;
    if (q) {
      filtered = all.filter(x =>
        x.name.toLowerCase().includes(q) ||
        x.code.includes(q) ||
        (x.currency || '').toLowerCase().includes(q)
      );
    }
    // existing first, then alphabetic
    filtered.sort((a, b) => {
      if (a.existing !== b.existing) return a.existing ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return filtered.slice(0, 60);
  }

  function render(query) {
    const items = buildItems(query);
    if (items.length === 0) {
      listEl.innerHTML = '<div class="combobox-empty">No matching country</div>';
      listEl.hidden = false;
      return;
    }
    const hasExisting = items.some(x => x.existing);
    let html = '';
    let dividerDone = false;
    items.forEach((it, i) => {
      if (!it.existing && hasExisting && !dividerDone) {
        html += '<div class="combobox-divider" aria-hidden="true"></div>';
        dividerDone = true;
      }
      html += `
        <div class="combobox-item${i === focusedIdx ? ' focused' : ''}" data-code="${it.code}" data-currency="${it.currency || ''}" data-name="${escapeHtml(it.name)}">
          <span class="combobox-flag">${window.flagEmoji(it.upper)}</span>
          <span class="combobox-name">${escapeHtml(it.name)}</span>
          <span class="combobox-meta">${escapeHtml(it.currency || '')}</span>
        </div>
      `;
    });
    listEl.innerHTML = html;
    listEl.hidden = false;
    listEl.querySelectorAll('.combobox-item').forEach(el => {
      el.addEventListener('mousedown', async (e) => {
        e.preventDefault();
        await pick(el.dataset.code, el.dataset.name, el.dataset.currency);
      });
    });
  }

  async function pick(code, name, currency) {
    let jur = existingByCode(code);
    if (!jur) {
      jur = await api.createJurisdiction({
        code,
        name,
        currency_default: currency || 'USD',
        vat_default: 0,
        tax_id_label: 'Tax ID',
        record_retention_years: 7,
      });
      // refresh local cache
      state.jurisdictions = await api.jurisdictions();
    }
    hidden.value = code;
    input.value = `${window.flagEmoji(code.toUpperCase())}  ${jur.name}`;
    listEl.hidden = true;
    // fill currency default if empty
    const currField = form.elements['currency_default'];
    if (currField && !currField.value) currField.value = jur.currency_default;
  }

  input.addEventListener('focus', () => { focusedIdx = -1; render(input.value); });
  input.addEventListener('input',  () => { focusedIdx = -1; render(input.value); });
  input.addEventListener('keydown', (e) => {
    if (listEl.hidden) return;
    const items = listEl.querySelectorAll('.combobox-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusedIdx = Math.min(items.length - 1, focusedIdx + 1);
      render(input.value);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusedIdx = Math.max(0, focusedIdx - 1);
      render(input.value);
    } else if (e.key === 'Enter' && focusedIdx >= 0) {
      e.preventDefault();
      const el = items[focusedIdx];
      pick(el.dataset.code, el.dataset.name, el.dataset.currency);
    } else if (e.key === 'Escape') {
      listEl.hidden = true;
    }
  });
  document.addEventListener('mousedown', (e) => {
    if (!root.contains(e.target)) listEl.hidden = true;
  });
}

function setJurisdictionComboboxValue(code) {
  const root = form.querySelector('[data-combobox="jurisdiction"]');
  const input = root.querySelector('.combobox-input');
  const hidden = root.querySelector('input[name="jurisdiction_code"]');
  const jur = state.jurisdictions.find(j => j.code === code.toLowerCase());
  if (!jur) return;
  hidden.value = jur.code;
  input.value = `${window.flagEmoji(jur.code.toUpperCase())}  ${jur.name}`;
}

async function saveContact() {
  const data = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.name.startsWith('entity_')) continue;
    data[el.name] = el.value;
  }
  if (!data.display_name) { toast('Display name required', 'warn'); return; }
  data.entity_ids = state.entities
    .map(e => e.id)
    .filter(eid => form.elements['entity_' + eid]?.checked);

  try {
    if (state.editingId) {
      await api.updateContact(state.editingId, data);
    } else {
      await api.createContact(data);
    }
    dlg.close();
    await loadContacts();
  } catch (err) { toast('Save failed: ' + err.message, 'error'); }
}

// ---------- entities tab ----------
async function loadEntities() {
  const ents = state.entities.length ? state.entities : await api.entities();
  const tbody = document.querySelector('#entities-table tbody');
  tbody.innerHTML = ents.map(e => `
    <tr>
      <td><strong>${escapeHtml(e.code)}</strong></td>
      <td>${escapeHtml(e.legal_name)}</td>
      <td>${(e.jurisdiction_code || '').toUpperCase()}</td>
      <td>${escapeHtml(e.base_currency)}</td>
      <td>${escapeHtml(e.tax_id || '')}</td>
      <td><span class="muted">${e.status}</span></td>
    </tr>
  `).join('');
}

// ==================================================================
// Invoices
// ==================================================================

const invDlg = document.getElementById('invoice-dialog');
const invForm = document.getElementById('invoice-form');

document.getElementById('btn-new-invoice').addEventListener('click', () => openInvoiceDialog(null, 'sales'));
document.getElementById('btn-new-bill').addEventListener('click', () => openInvoiceDialog(null, 'purchase'));
// Bulk bills: queue several supplier files → file each as a draft bill (with its file pre-attached).
state.invBulkQueue = [];
document.getElementById('btn-bulk-bills').addEventListener('click', () => document.getElementById('bulk-bills-file').click());
document.getElementById('bulk-bills-file').addEventListener('change', (e) => { addBulkBills(e.target.files); e.target.value = ''; });
function addBulkBills(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  state.invBulkQueue.push(...files);
  renderBulkQueue();
  toast(`${files.length} file(s) queued — open each to file it as a bill`, 'ok');
}
function renderBulkQueue() {
  const tray = document.getElementById('bulk-bills-tray');
  if (!tray) return;
  const q = state.invBulkQueue || [];
  tray.hidden = q.length === 0;
  if (!q.length) { tray.innerHTML = ''; return; }
  tray.innerHTML = `<span class="muted">${q.length} bill(s) to file:</span> ` +
    q.map((f, i) => `<button type="button" data-idx="${i}" class="bulkq-open">📄 ${escapeHtml(f.name)}</button>`).join(' ') +
    ` <button type="button" id="bulkq-clear" class="danger">Clear</button>`;
  tray.querySelectorAll('.bulkq-open').forEach(btn => btn.addEventListener('click', () => processBulkBill(Number(btn.dataset.idx))));
  document.getElementById('bulkq-clear').addEventListener('click', () => { state.invBulkQueue = []; renderBulkQueue(); });
}
async function processBulkBill(idx) {
  const f = state.invBulkQueue[idx];
  if (!f) return;
  state.invBulkQueue.splice(idx, 1);
  renderBulkQueue();
  await openInvoiceDialog(null, 'purchase');
  state.invPendingAttachments = [f];
  renderInvoiceAttachments();
}
document.getElementById('invoice-filter-direction').addEventListener('change', async (e) => {
  state.invFilterDirection = e.target.value;
  await loadInvoices();
});
document.getElementById('inv-direction').addEventListener('change', (e) => {
  applyInvoiceDirectionUI(e.target.value);
});
document.getElementById('invoice-cancel').addEventListener('click', () => invDlg.close());
document.getElementById('invoice-save').addEventListener('click', guardSave('invoice-save', saveInvoice));
// Bill attachments: choose / drag-drop files onto the bill.
document.getElementById('invoice-attach-btn').addEventListener('click', () => document.getElementById('invoice-attach-input').click());
document.getElementById('invoice-attach-input').addEventListener('change', (e) => { addInvoiceFiles(e.target.files); e.target.value = ''; });
(() => {
  const drop = document.getElementById('invoice-attach-drop');
  if (!drop) return;
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.style.borderColor = 'var(--accent)'; });
  drop.addEventListener('dragleave', () => { drop.style.borderColor = 'var(--border)'; });
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.style.borderColor = 'var(--border)'; addInvoiceFiles(e.dataTransfer.files); });
})();
// Vendor-first prefill: picking a supplier on a NEW bill fills currency / FX / due date from their last bill.
document.getElementById('inv-contact').addEventListener('change', async (e) => {
  if (state.invEditingId || state.invEditingDirection !== 'purchase') return;
  const cid = Number(e.target.value);
  if (!cid) return;
  try {
    const d = await api.billDefaults(cid);
    if (!d) return;
    if (d.currency && !invForm.elements['currency'].value) invForm.elements['currency'].value = d.currency;
    if (d.fx_rate_to_base && (!invForm.elements['fx_rate_to_base'].value || invForm.elements['fx_rate_to_base'].value === '1')) invForm.elements['fx_rate_to_base'].value = d.fx_rate_to_base;
    if (d.term_days != null && !invForm.elements['due_date'].value && invForm.elements['issue_date'].value) {
      const due = new Date(invForm.elements['issue_date'].value); due.setDate(due.getDate() + d.term_days);
      invForm.elements['due_date'].value = due.toISOString().slice(0, 10);
    }
  } catch (_) {}
});
document.getElementById('invoice-print').addEventListener('click', () => {
  if (state.invEditingId) {
    window.open('/invoices/' + state.invEditingId + '/print', '_blank');
  }
});

document.getElementById('invoice-email').addEventListener('click', async () => {
  if (!state.invEditingId) return;
  const to = await uiPrompt('Email PDF to:', '');
  if (!to) return;
  try {
    await jsonReq('POST', '/api/invoices/' + state.invEditingId + '/email', { to });
    toast('Invoice emailed to ' + to, 'ok');
  } catch (err) { toast('Email failed: ' + err.message, 'error'); }
});

document.getElementById('inv-pay-add').addEventListener('click', async () => {
  if (!state.invEditingId) return;
  const amount = Number(document.getElementById('inv-pay-amount').value);
  if (!amount) { toast('Amount required', 'warn'); return; }
  const paid_on = document.getElementById('inv-pay-date').value || new Date().toISOString().slice(0, 10);
  const method = document.getElementById('inv-pay-method').value || null;
  try {
    await jsonReq('POST', '/api/invoices/' + state.invEditingId + '/payments', { amount, paid_on, method });
    document.getElementById('inv-pay-amount').value = '';
    document.getElementById('inv-pay-method').value = '';
    await loadInvoicePayments(state.invEditingId);
  } catch (err) { toast('Payment failed: ' + err.message, 'error'); }
});

async function loadInvoicePayments(invoiceId) {
  const rows = await fetch('/api/invoices/' + invoiceId + '/payments').then(r => r.json());
  const list = document.getElementById('inv-payments-list');
  const sum = rows.reduce((s, r) => s + Number(r.amount), 0);
  document.getElementById('inv-pay-summary').textContent = rows.length ? `· ${rows.length} payment(s), ${fmtMoney(sum)} received` : '';
  list.innerHTML = rows.length
    ? rows.map(r => `
        <div class="pay-row" data-id="${r.id}">
          <span>${escapeHtml(r.paid_on)}</span>
          <span class="muted">${escapeHtml(r.method || '')}</span>
          <span class="money" style="margin-left:auto">${fmtMoney(r.amount)}</span>
          <button type="button" data-act="rm-pay" class="danger" style="padding:1px 6px">×</button>
        </div>
      `).join('')
    : '<div class="muted" style="font-size:11px">No payments yet.</div>';
  list.querySelectorAll('button[data-act="rm-pay"]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const pid = Number(e.target.closest('.pay-row').dataset.id);
      if (!await uiConfirm('Remove this payment?')) return;
      await fetch('/api/invoices/payments/' + pid, { method: 'DELETE' });
      await loadInvoicePayments(invoiceId);
    });
  });
}

// Notes (generic per-entity)
async function loadInvoiceNotes(invoiceId) {
  return loadNotes('invoices', invoiceId, 'inv-notes-list');
}

async function loadNotes(entityTable, entityId, listElId) {
  const rows = await fetch(`/api/notes?entity_table=${entityTable}&entity_id=${entityId}`).then(r => r.json());
  const list = document.getElementById(listElId);
  list.innerHTML = rows.length
    ? rows.map(n => `
        <div class="note-row" data-id="${n.id}">
          <div class="note-head"><strong>${escapeHtml(n.author_name || n.author_email || 'unknown')}</strong> <span class="muted">${escapeHtml(n.created_at)}</span>
            <button type="button" data-act="rm-note" class="danger" style="padding:1px 6px;float:right">×</button>
          </div>
          <div class="note-body">${escapeHtml(n.body)}</div>
        </div>
      `).join('')
    : '<div class="muted" style="font-size:11px">No comments yet.</div>';
  list.querySelectorAll('button[data-act="rm-note"]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const nid = Number(e.target.closest('.note-row').dataset.id);
      if (!await uiConfirm('Delete this comment?')) return;
      await fetch('/api/notes/' + nid, { method: 'DELETE' });
      await loadNotes(entityTable, entityId, listElId);
    });
  });
}

document.getElementById('inv-note-add').addEventListener('click', async () => {
  if (!state.invEditingId) return;
  const input = document.getElementById('inv-note-input');
  const body = input.value.trim();
  if (!body) return;
  try {
    await jsonReq('POST', '/api/notes', { entity_table: 'invoices', entity_id: state.invEditingId, body });
    input.value = '';
    await loadInvoiceNotes(state.invEditingId);
  } catch (err) { toast(err.message, 'error'); }
});
document.getElementById('inv-add-line').addEventListener('click', () => {
  state.invDraftLines.push({ description: '', quantity: 1, unit_price: 0, tax_rate: defaultTaxRate() });
  renderInvoiceLines();
});

// Default tax rate from the selected entity's jurisdiction.
function defaultTaxRate() {
  const entSel = document.getElementById('inv-entity');
  if (!entSel) return 0;
  const entId = Number(entSel.value);
  const ent = state.entities.find(e => e.id === entId);
  if (!ent) return 0;
  const jur = state.jurisdictions.find(j => j.code === ent.jurisdiction_code);
  return jur ? Number(jur.vat_default) || 0 : 0;
}

document.getElementById('invoice-search').addEventListener('input', (e) => {
  state.invFilterText = e.target.value; renderInvoices();
});
document.getElementById('invoice-filter-entity').addEventListener('change', (e) => {
  state.invFilterEntity = e.target.value; renderInvoices();
});
document.getElementById('invoice-filter-status').addEventListener('change', (e) => {
  state.invFilterStatus = e.target.value; renderInvoices();
});

async function loadInvoices() {
  state.invoices = await api.invoices(state.invFilterDirection || null);
  // populate entity filter once
  const sel = document.getElementById('invoice-filter-entity');
  if (sel.options.length <= 1) {
    sel.innerHTML = '<option value="">All entities</option>' +
      state.entities.map(e => `<option value="${e.id}">${escapeHtml(e.code)}</option>`).join('');
  }
  await loadSavedViews('invoices');
  renderInvoices();
}

async function loadSavedViews(panel) {
  const selId = panel === 'contacts' ? 'contact-saved-views'
              : panel === 'contracts' ? 'contract-saved-views'
              : 'invoice-saved-views';
  const sel = document.getElementById(selId);
  if (!sel) return;
  const views = await fetch('/api/saved-views?panel=' + panel).then(r => r.json());
  sel.innerHTML = '<option value="">Saved views…</option>' +
    views.map(v => `<option value="${v.id}">${escapeHtml(v.name)}</option>`).join('') +
    (views.length ? `<option value="__delete__" style="color:var(--danger)">— Delete a view —</option>` : '');
  sel.dataset.views = JSON.stringify(views);
}

// Wire contact + contract saved-view dropdowns
function wireSavedViewControls(panel, captureQuery, applyQuery) {
  const selId  = panel === 'contacts' ? 'contact-saved-views' : 'contract-saved-views';
  const btnId  = panel === 'contacts' ? 'btn-save-contact-view' : 'btn-save-contract-view';
  const sel = document.getElementById(selId);
  const btn = document.getElementById(btnId);
  if (!sel || !btn) return;
  sel.addEventListener('change', async (e) => {
    const id = e.target.value;
    const views = JSON.parse(e.target.dataset.views || '[]');
    if (!id) return;
    if (id === '__delete__') {
      const name = await uiPrompt('Type the exact name of the view to delete:');
      if (!name) { e.target.value = ''; return; }
      const v = views.find(x => x.name === name);
      if (!v) { toast('No view named ' + name, 'warn'); e.target.value = ''; return; }
      await fetch('/api/saved-views/' + v.id, { method: 'DELETE' });
      toast('Deleted ' + name, 'ok');
      await loadSavedViews(panel);
      return;
    }
    const v = views.find(x => String(x.id) === id);
    if (v) { applyQuery(v.query); }
    e.target.value = '';
  });
  btn.addEventListener('click', async () => {
    const name = await uiPrompt('Name this view:');
    if (!name) return;
    try {
      await jsonReq('POST', '/api/saved-views', { panel, name, query: captureQuery() });
      toast('Saved view "' + name + '"', 'ok');
      await loadSavedViews(panel);
    } catch (err) { toast('Save failed: ' + err.message, 'error'); }
  });
}

wireSavedViewControls('contacts',
  () => ({ text: state.filterText, type: state.filterType, entity: state.filterEntity }),
  (q) => {
    state.filterText = q.text || ''; state.filterType = q.type || ''; state.filterEntity = q.entity || '';
    document.getElementById('contact-search').value = state.filterText;
    document.getElementById('contact-filter-type').value = state.filterType;
    document.getElementById('contact-filter-entity').value = state.filterEntity;
    renderContacts();
  }
);
wireSavedViewControls('contracts',
  () => ({ text: state.ctFilterText, entity: state.ctFilterEntity, status: state.ctFilterStatus }),
  (q) => {
    state.ctFilterText = q.text || ''; state.ctFilterEntity = q.entity || ''; state.ctFilterStatus = q.status || '';
    document.getElementById('contract-search').value = state.ctFilterText;
    document.getElementById('contract-filter-entity').value = state.ctFilterEntity;
    document.getElementById('contract-filter-status').value = state.ctFilterStatus;
    renderContracts();
  }
);

document.getElementById('invoice-saved-views').addEventListener('change', async (e) => {
  const id = e.target.value;
  const views = JSON.parse(e.target.dataset.views || '[]');
  if (!id) return;
  if (id === '__delete__') {
    const view = await uiPrompt('Type the exact name of the view to delete:');
    if (!view) { e.target.value = ''; return; }
    const v = views.find(x => x.name === view);
    if (!v) { toast('No view named ' + view, 'warn'); e.target.value = ''; return; }
    await fetch('/api/saved-views/' + v.id, { method: 'DELETE' });
    toast('Deleted ' + view, 'ok');
    await loadInvoices();
    return;
  }
  const v = views.find(x => String(x.id) === id);
  if (!v) return;
  state.invFilterText = v.query.text || '';
  state.invFilterEntity = v.query.entity || '';
  state.invFilterStatus = v.query.status || '';
  state.invFilterDirection = v.query.direction || '';
  document.getElementById('invoice-search').value = state.invFilterText;
  document.getElementById('invoice-filter-entity').value = state.invFilterEntity;
  document.getElementById('invoice-filter-status').value = state.invFilterStatus;
  document.getElementById('invoice-filter-direction').value = state.invFilterDirection;
  await loadInvoices();
  e.target.value = '';
});

document.getElementById('btn-save-view').addEventListener('click', async () => {
  const name = await uiPrompt('Name this view (e.g. "Overdue HWG sent"):');
  if (!name) return;
  try {
    await jsonReq('POST', '/api/saved-views', {
      panel: 'invoices',
      name,
      query: {
        text: state.invFilterText,
        entity: state.invFilterEntity,
        status: state.invFilterStatus,
        direction: state.invFilterDirection,
      },
    });
    toast('Saved view "' + name + '"', 'ok');
    await loadSavedViews('invoices');
  } catch (err) { toast('Save failed: ' + err.message, 'error'); }
});

document.getElementById('btn-bulk-import').addEventListener('click', () => {
  document.getElementById('bulk-import-file').click();
});

document.getElementById('bulk-import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const rows = parseBulkInvoiceCsv(text);
    if (!rows.length) { toast('No rows parsed', 'warn'); e.target.value = ''; return; }
    showCsvPreview(rows, 'invoice rows', async () => {
      const result = await jsonReq('POST', '/api/invoices/bulk-import', { rows });
      toast(`Created ${result.created.length} invoices, ${result.errors.length} errors`, result.errors.length ? 'warn' : 'ok');
      if (result.errors.length) console.warn('Bulk import errors:', result.errors);
      await loadInvoices();
    });
  } catch (err) { toast('Import failed: ' + err.message, 'error'); }
  e.target.value = '';
});

function showCsvPreview(rows, label, onConfirm) {
  const dlg = document.getElementById('csv-preview-dialog');
  document.getElementById('csv-preview-summary').textContent = `${rows.length} ${label} detected. Showing first 10:`;
  const headers = [...new Set(rows.flatMap(r => Object.keys(r)))];
  document.getElementById('csv-preview-table').innerHTML = `
    <table style="width:100%;border-collapse:collapse"><thead><tr>${headers.map(h => `<th style="padding:4px 6px;font-size:10px;color:var(--muted);text-align:left">${escapeHtml(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.slice(0, 10).map(r => `<tr>${headers.map(h => `<td style="padding:3px 6px;border-bottom:1px solid var(--divider);font-size:11px">${escapeHtml(String(r[h] ?? ''))}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>
  `;
  document.getElementById('csv-preview-confirm').onclick = async () => { dlg.close(); await onConfirm(); };
  document.getElementById('csv-preview-cancel').onclick = () => dlg.close();
  dlg.showModal();
}

function parseBulkInvoiceCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const header = splitCsvLine(lines[0]).map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    if (cols.every(c => c === '')) continue;
    const row = {};
    header.forEach((k, idx) => row[k] = cols[idx]);
    if (row.date) row.date = normaliseDate(row.date);
    if (row.due_date) row.due_date = normaliseDate(row.due_date);
    out.push(row);
  }
  return out;
}

function renderInvoices() {
  const tbody = document.querySelector('#invoices-table tbody');
  const text = state.invFilterText.toLowerCase();
  const showVoid = document.getElementById('invoice-show-void')?.checked;
  const filtered = state.invoices.filter(inv => {
    if (!showVoid && inv.status === 'void') return false;
    if (state.invFilterEntity && inv.entity_id !== Number(state.invFilterEntity)) return false;
    if (state.invFilterStatus && inv.status !== state.invFilterStatus) return false;
    if (text) {
      const blob = [inv.number, inv.contact_display_name, inv.po_reference, inv.currency]
        .filter(Boolean).join(' ').toLowerCase();
      if (!blob.includes(text)) return false;
    }
    return true;
  });
  tbody.innerHTML = filtered.map(inv => {
    const isBill = inv.direction === 'purchase';
    return `
    <tr data-id="${inv.id}">
      <td><input type="checkbox" class="row-check" data-id="${inv.id}" /></td>
      <td>
        <span class="dir-tag dir-${inv.direction || 'sales'}">${isBill ? 'Bill' : 'Sale'}</span>
        <strong>${escapeHtml(inv.number)}</strong>
        ${inv.recurrence_active ? `<span class="pill recurring-pill" title="Recurring ${escapeHtml(inv.recurrence_kind || '')} — next ${escapeHtml(inv.recurrence_next_run || '?')}">↻ ${escapeHtml(inv.recurrence_kind || 'recurring')}</span>` : ''}
        ${inv.external_number ? `<br><span class="muted">ref: ${escapeHtml(inv.external_number)}</span>` : ''}
      </td>
      <td>${escapeHtml(inv.issue_date)}</td>
      <td><span class="pill">${escapeHtml(inv.entity_code)}</span></td>
      <td>${escapeHtml(inv.contact_display_name)}</td>
      <td class="num">${escapeHtml(inv.currency)} ${fmtMoney(inv.total)}</td>
      <td><select class="inline-status status status-${inv.status}" data-id="${inv.id}" data-current="${inv.status}">
        ${['draft','sent','paid','void'].map(s => `<option value="${s}" ${s === inv.status ? 'selected' : ''}>${s}</option>`).join('')}
      </select></td>
      <td class="row-actions">
        <button data-act="edit">Edit</button>
        <button data-act="dup" title="Duplicate">Dup</button>
        <button data-act="pdf">PDF</button>
        <button data-act="share" title="Copy share link">Share</button>
        <button data-act="remind" title="Send reminder email">Remind</button>
        <button data-act="print">Print</button>
        <button data-act="void" class="danger">Void</button>
        <button data-act="del" class="danger" title="Delete permanently">Del</button>
      </td>
    </tr>
  `;}).join('');
  document.getElementById('invoices-empty').hidden = filtered.length > 0;

  tbody.querySelectorAll('button[data-act]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const tr = e.target.closest('tr');
      const id = Number(tr.dataset.id);
      if (btn.dataset.act === 'edit') openInvoiceDialog(id);
      if (btn.dataset.act === 'print') window.open('/invoices/' + id + '/print', '_blank');
      if (btn.dataset.act === 'pdf') {
        btn.disabled = true; btn.textContent = '…';
        try {
          const r = await fetch('/api/invoices/' + id + '/pdf');
          if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || ('HTTP ' + r.status)); }
          const blob = await r.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = (r.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'invoice.pdf';
          a.click();
          URL.revokeObjectURL(url);
        } catch (err) { toast('PDF failed: ' + err.message, 'error'); }
        btn.disabled = false; btn.textContent = 'PDF';
      }
      if (btn.dataset.act === 'void') {
        if (await uiConfirm('Mark this invoice as void?')) {
          try { await api.voidInvoice(id); await loadInvoices(); }
          catch (err) { toast('Void failed: ' + err.message, 'error'); }
        }
      }
      if (btn.dataset.act === 'del') {
        const inv = state.invoices.find(x => x.id === id);
        await tryHardDelete('/api/invoices/' + id, inv?.number || 'invoice', loadInvoices);
      }
      if (btn.dataset.act === 'dup') {
        try {
          const dup = await jsonReq('POST', '/api/invoices/' + id + '/duplicate', {});
          toast(`Duplicated as ${dup.number}`, 'ok');
          await loadInvoices();
        } catch (err) { toast('Duplicate failed: ' + err.message, 'error'); }
      }
      if (btn.dataset.act === 'remind') {
        try {
          const r = await jsonReq('POST', '/api/invoices/' + id + '/send-reminder', {});
          toast(`Reminder sent to ${r.sent_to}`, 'ok');
        } catch (err) { toast('Reminder failed: ' + err.message, 'error'); }
      }
      if (btn.dataset.act === 'share') {
        try {
          const r = await jsonReq('POST', '/api/invoices/' + id + '/share', {});
          const fullUrl = window.location.origin + r.url;
          await navigator.clipboard.writeText(fullUrl);
          toast(`Share URL copied: ${fullUrl}`, 'ok');
        } catch (err) { toast('Share failed: ' + err.message, 'error'); }
      }
    });
  });

  // bulk-select wiring
  tbody.querySelectorAll('.row-check').forEach(cb => cb.addEventListener('change', refreshInvoiceBulkBar));
  refreshInvoiceBulkBar();

}

// Delegated inline-status change handler: invoices, contracts, KYC
document.addEventListener('change', async (e) => {
  const sel = e.target.closest('select.inline-status');
  if (!sel) return;
  const id = Number(sel.dataset.id);
  const kind = sel.dataset.kind || 'invoice';
  const newStatus = sel.value;
  const prev = sel.dataset.current;
  const endpoints = {
    invoice:  ['/api/invoices/' + id, loadInvoices],
    contract: ['/api/contracts/' + id, loadContracts],
    kyc:      ['/api/kyc/' + id, loadKyc],
  };
  const [url, refresh] = endpoints[kind] || endpoints.invoice;
  try {
    await jsonReq('PUT', url, { status: newStatus });
    toast(`Status → ${newStatus.replace('_',' ')}`, 'ok');
    await refresh();
  } catch (err) {
    toast('Status update failed: ' + err.message, 'error');
    sel.value = prev;
  }
});
document.addEventListener('click', (e) => {
  const sel = e.target.closest('select.inline-status');
  if (sel) e.stopPropagation();
});

function refreshInvoiceBulkBar() {
  const checks = document.querySelectorAll('#invoices-table tbody .row-check:checked');
  const bar = document.getElementById('invoices-bulk-bar');
  bar.hidden = checks.length === 0;
  document.getElementById('bulk-count').textContent = checks.length + ' selected';
}

document.getElementById('invoices-select-all').addEventListener('change', (e) => {
  document.querySelectorAll('#invoices-table tbody .row-check').forEach(cb => cb.checked = e.target.checked);
  refreshInvoiceBulkBar();
});

document.getElementById('bulk-void').addEventListener('click', async () => {
  const ids = Array.from(document.querySelectorAll('#invoices-table tbody .row-check:checked')).map(c => Number(c.dataset.id));
  if (!ids.length) return;
  if (!await uiConfirm(`Mark ${ids.length} invoice(s) as void?`)) return;
  let ok = 0; const fails = [];
  for (const id of ids) {
    try { await api.voidInvoice(id); ok++; }
    catch (err) { fails.push(err.message); }
  }
  if (fails.length) toast(`Voided ${ok}/${ids.length}. ${fails.length} failed: ${fails[0]}`, ok ? 'warn' : 'error');
  else toast(`Voided ${ok} invoice(s)`, 'ok');
  await loadInvoices();
});

function fmtMoney(n) {
  return (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function applyInvoiceDirectionUI(direction) {
  state.invEditingDirection = direction;
  const isBill = direction === 'purchase';
  document.getElementById('inv-contact-label').firstChild.nodeValue =
    isBill ? 'Supplier *' : 'Customer *';
  document.getElementById('inv-external-number').closest('label').style.display =
    isBill ? '' : 'none';
  // repopulate contact dropdown with the right side
  const conSel = document.getElementById('inv-contact');
  const wantedType = isBill ? 'supplier' : 'customer';
  const pool = state.contacts.filter(c =>
    c.status === 'active' && (c.contact_type === wantedType || c.contact_type === 'other')
  );
  conSel.innerHTML = '<option value="">— select —</option>' +
    pool.map(c => `<option value="${c.id}">${escapeHtml(c.display_name)} (${c.contact_type})</option>`).join('');
}

// --- Bill / invoice attachments (the supplier's original file lives with the bill) ---
async function loadInvoiceAttachments(id) {
  state.invAttachments = id ? await api.invoiceAttachments(id).catch(() => []) : [];
  renderInvoiceAttachments();
}
function renderInvoiceAttachments() {
  const el = document.getElementById('invoice-attachments-list');
  if (!el) return;
  const saved = state.invAttachments || [];
  const pending = state.invPendingAttachments || [];
  if (!saved.length && !pending.length) { el.innerHTML = '<div class="muted">No files attached.</div>'; return; }
  el.innerHTML = '<ul class="doc-list">' +
    saved.map(a => `<li data-id="${a.id}">
      <a href="/api/invoices/attachments/${a.id}" target="_blank">${escapeHtml(a.file_name)}</a>
      <span class="muted">${((a.file_size || 0) / 1024).toFixed(1)} KB</span>
      <button type="button" class="danger" data-act="rm-att">×</button></li>`).join('') +
    pending.map((f, i) => `<li data-idx="${i}">
      <span>${escapeHtml(f.name)}</span>
      <span class="muted">pending · ${((f.size || 0) / 1024).toFixed(1)} KB</span>
      <button type="button" class="danger" data-act="rm-pending">×</button></li>`).join('') + '</ul>';
  el.querySelectorAll('button[data-act="rm-att"]').forEach(btn => btn.addEventListener('click', async (e) => {
    const attId = Number(e.target.closest('li').dataset.id);
    if (!await uiConfirm('Remove this file?')) return;
    try { await api.deleteInvoiceAttachment(attId); state.invAttachments = (state.invAttachments || []).filter(a => a.id !== attId); renderInvoiceAttachments(); }
    catch (err) { toast('Remove failed: ' + err.message, 'error'); }
  }));
  el.querySelectorAll('button[data-act="rm-pending"]').forEach(btn => btn.addEventListener('click', (e) => {
    state.invPendingAttachments.splice(Number(e.target.closest('li').dataset.idx), 1); renderInvoiceAttachments();
  }));
}
async function addInvoiceFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  if (state.invEditingId) {
    try {
      let latest;
      for (const f of files) latest = await api.uploadInvoiceAttachment(state.invEditingId, f);
      if (latest) state.invAttachments = latest;
      renderInvoiceAttachments();
      toast(`Attached ${files.length} file(s)`, 'ok');
    } catch (err) { toast('Upload failed: ' + err.message, 'error'); }
  } else {
    (state.invPendingAttachments = state.invPendingAttachments || []).push(...files);
    renderInvoiceAttachments();
  }
}

const DRAFT_KEY = 'carbon.invoice-draft';
function saveInvoiceDraft() {
  if (state.invEditingId) return; // only autosave for new invoices
  try {
    const data = {};
    for (const el of invForm.elements) if (el.name) data[el.name] = el.value;
    data.lines = state.invDraftLines;
    data.savedAt = Date.now();
    localStorage.setItem(DRAFT_KEY, JSON.stringify(data));
  } catch (_) {}
}
function loadInvoiceDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || !d.savedAt) return null;
    if (Date.now() - d.savedAt > 30 * 86400000) { localStorage.removeItem(DRAFT_KEY); return null; }
    return d;
  } catch (_) { return null; }
}
function clearInvoiceDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch (_) {} }

// Debounced draft save on any input in the invoice form
let _draftSaveTimer = null;
document.addEventListener('input', (e) => {
  if (e.target && e.target.closest('#invoice-form')) {
    clearTimeout(_draftSaveTimer);
    _draftSaveTimer = setTimeout(saveInvoiceDraft, 700);
  }
});

async function openInvoiceDialog(id, defaultDirection) {
  state.invEditingId = id;
  state.invEditingNumber = null;
  invForm.reset();

  // entity selector
  const entSel = document.getElementById('inv-entity');
  entSel.innerHTML = state.entities.map(e =>
    `<option value="${e.id}">${escapeHtml(e.code)} — ${escapeHtml(e.legal_name)}</option>`
  ).join('');

  applyInvoiceDirectionUI(defaultDirection || 'sales');
  document.getElementById('inv-direction').value = defaultDirection || 'sales';

  document.getElementById('invoice-form-title').textContent =
    id ? 'Edit ' + (state.invEditingDirection === 'purchase' ? 'bill' : 'invoice')
       : 'New ' + (state.invEditingDirection === 'purchase' ? 'bill' : 'invoice');
  document.getElementById('invoice-print').hidden = !id;
  state.invPendingAttachments = [];
  loadInvoiceAttachments(id);

  if (id) {
    const inv = await api.invoice(id);
    state.invEditingNumber = inv.number || null;
    trackRecent('invoices', id, inv.number || '#' + id);
    applyInvoiceDirectionUI(inv.direction || 'sales');
    document.getElementById('inv-direction').value = inv.direction || 'sales';
    entSel.value = inv.entity_id;
    document.getElementById('inv-contact').value = inv.contact_id;
    invForm.elements['issue_date'].value     = inv.issue_date || '';
    invForm.elements['due_date'].value       = inv.due_date || '';
    invForm.elements['currency'].value       = inv.currency || '';
    invForm.elements['fx_rate_to_base'].value= inv.fx_rate_to_base || 1;
    invForm.elements['status'].value         = inv.status || 'draft';
    invForm.elements['po_reference'].value   = inv.po_reference || '';
    invForm.elements['external_number'].value= inv.external_number || '';
    invForm.elements['notes'].value          = inv.notes || '';
    invForm.elements['recurrence_kind'].value     = inv.recurrence_kind || '';
    invForm.elements['recurrence_next_run'].value = inv.recurrence_next_run || '';
    invForm.elements['recurrence_active'].value   = inv.recurrence_active ? '1' : '0';
    loadInvoicePayments(id);
    loadInvoiceNotes(id);
    document.getElementById('invoice-payments-section').hidden = false;
    document.getElementById('invoice-notes-section').hidden    = false;
    document.getElementById('invoice-email').hidden            = false;
    document.getElementById('invoice-form-title').textContent =
      'Edit ' + (inv.direction === 'purchase' ? 'bill' : 'invoice') + ' ' + inv.number;
    state.invDraftLines = (inv.lines || []).map(l => ({
      description: l.description,
      quantity: l.quantity,
      unit_price: l.unit_price,
      tax_rate: l.tax_rate,
    }));
  } else {
    invForm.elements['issue_date'].value      = new Date().toISOString().slice(0, 10);
    invForm.elements['fx_rate_to_base'].value = 1;
    invForm.elements['status'].value          = 'draft';
    const ent = state.entities[0];
    if (ent) invForm.elements['currency'].value = ent.base_currency;
    state.invDraftLines = [{ description: '', quantity: 1, unit_price: 0, tax_rate: defaultTaxRate() }];
    document.getElementById('invoice-payments-section').hidden = true;
    document.getElementById('invoice-notes-section').hidden    = true;
    document.getElementById('invoice-email').hidden            = true;
    // Offer to recover an unsaved draft (only for brand-new invoices)
    const draft = loadInvoiceDraft();
    if (draft) {
      const mins = Math.round((Date.now() - draft.savedAt) / 60000);
      if (await uiConfirm(`Recover unsaved invoice draft from ${mins} min ago?`)) {
        for (const [k, v] of Object.entries(draft)) {
          if (k === 'lines')   { state.invDraftLines = Array.isArray(v) ? v : []; continue; }
          if (k === 'savedAt') continue;
          const el = invForm.elements[k];
          if (el && v != null) el.value = String(v);
        }
        applyInvoiceDirectionUI(invForm.elements['direction'].value || 'sales');
      } else {
        clearInvoiceDraft();
      }
    }
  }
  // re-default tax on entity change for empty new lines
  document.getElementById('inv-entity').onchange = () => {
    const r = defaultTaxRate();
    state.invDraftLines.forEach(l => {
      if (!l.tax_rate || l.tax_rate === 0) l.tax_rate = r;
    });
    renderInvoiceLines();
  };
  renderInvoiceLines();
  if (id) attachActivityPanel(invDlg, 'invoices', id);
  if (!invForm._previewWired) {
    invForm.addEventListener('input', renderInvoicePreview);
    invForm.addEventListener('change', renderInvoicePreview);
    invForm._previewWired = true;
  }
  renderInvoicePreview();
  invDlg.showModal();
}

function renderInvoiceLines() {
  const tbody = document.getElementById('inv-lines');
  tbody.innerHTML = state.invDraftLines.map((l, i) => {
    const sub = (Number(l.quantity) || 0) * (Number(l.unit_price) || 0);
    const total = sub * (1 + (Number(l.tax_rate) || 0));
    return `
      <tr data-idx="${i}">
        <td><input type="text" data-field="description" value="${escapeHtml(l.description)}" /></td>
        <td class="num"><input type="number" step="0.01" data-field="quantity" value="${l.quantity}" /></td>
        <td class="num"><input type="number" step="0.01" data-field="unit_price" value="${l.unit_price}" /></td>
        <td class="num"><input type="number" step="0.01" data-field="tax_rate" value="${l.tax_rate}" /></td>
        <td class="num">${fmtMoney(total)}</td>
        <td><button type="button" data-act="rm" class="danger">×</button></td>
      </tr>
    `;
  }).join('');
  tbody.querySelectorAll('input[data-field]').forEach(inp => {
    inp.addEventListener('input', (e) => {
      const tr = e.target.closest('tr');
      const idx = Number(tr.dataset.idx);
      const field = e.target.dataset.field;
      state.invDraftLines[idx][field] = field === 'description' ? e.target.value : Number(e.target.value);
      renderInvoiceTotals();
      // update only this line's total cell visually
      const sub = (Number(state.invDraftLines[idx].quantity) || 0) * (Number(state.invDraftLines[idx].unit_price) || 0);
      const total = sub * (1 + (Number(state.invDraftLines[idx].tax_rate) || 0));
      tr.children[4].textContent = fmtMoney(total);
    });
  });
  tbody.querySelectorAll('button[data-act="rm"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const tr = e.target.closest('tr');
      const idx = Number(tr.dataset.idx);
      state.invDraftLines.splice(idx, 1);
      renderInvoiceLines();
    });
  });
  renderInvoiceTotals();
}

function renderInvoiceTotals() {
  let sub = 0, tax = 0;
  for (const l of state.invDraftLines) {
    const s = (Number(l.quantity) || 0) * (Number(l.unit_price) || 0);
    sub += s;
    tax += s * (Number(l.tax_rate) || 0);
  }
  document.getElementById('inv-subtotal').textContent = fmtMoney(sub);
  document.getElementById('inv-tax').textContent      = fmtMoney(tax);
  document.getElementById('inv-total').textContent    = fmtMoney(sub + tax);
  renderInvoicePreview();
}

// Live invoice preview — mirrors the server-side PDF template (renderInvoiceHTML).
function renderInvoicePreview() {
  const el = document.getElementById('inv-preview');
  if (!el || !invForm) return;
  const f = invForm.elements;
  const ent = state.entities.find(e => e.id === Number(f['entity_id'] && f['entity_id'].value));
  const con = state.contacts.find(c => c.id === Number(f['contact_id'] && f['contact_id'].value));
  const dir = (f['direction'] && f['direction'].value) || 'sales';
  const ccy = ((f['currency'] && f['currency'].value) || (ent && ent.base_currency) || '').toUpperCase();
  const status = (f['status'] && f['status'].value) || 'draft';
  const val = (name) => (f[name] && f[name].value) || '';
  let sub = 0, tax = 0;
  const rows = (state.invDraftLines || [])
    .filter(l => l.description || l.unit_price || l.quantity)
    .map(l => {
      const q = Number(l.quantity) || 0, u = Number(l.unit_price) || 0, t = Number(l.tax_rate) || 0;
      sub += q * u; tax += q * u * t;
      return `<tr><td>${escapeHtml(l.description || '')}</td><td class="num">${q.toLocaleString()}</td><td class="num">${fmtMoney(u, ccy)}</td><td class="num">${(t * 100).toFixed(2)}%</td><td class="num">${fmtMoney(q * u * (1 + t), ccy)}</td></tr>`;
    }).join('');
  const number = state.invEditingId ? (state.invEditingNumber || '—') : 'DRAFT';
  el.innerHTML = `
    <div class="ip-head">
      <div class="ip-from">
        <h1>${escapeHtml((ent && (ent.legal_name || ent.code)) || 'Your entity')}</h1>
        ${ent && ent.registered_address ? `<div class="ip-small">${escapeHtml(ent.registered_address)}</div>` : ''}
        ${ent && ent.tax_id ? `<div class="ip-small">Tax ID: ${escapeHtml(ent.tax_id)}</div>` : ''}
      </div>
      <div class="ip-meta">
        <div class="ip-doctype">${dir === 'purchase' ? 'BILL' : 'INVOICE'}</div>
        <div class="ip-small"># ${escapeHtml(number)}${val('external_number') ? ` (ref ${escapeHtml(val('external_number'))})` : ''}</div>
        ${val('issue_date') ? `<div class="ip-small">Issued ${escapeHtml(val('issue_date'))}</div>` : ''}
        ${val('due_date') ? `<div class="ip-small">Due ${escapeHtml(val('due_date'))}</div>` : ''}
        <div><span class="ip-status ${escapeHtml(status)}">${escapeHtml(status)}</span></div>
      </div>
    </div>
    <div class="ip-billto">
      <h3>Bill to</h3>
      <div class="ip-name">${escapeHtml((con && (con.legal_name || con.display_name)) || '—')}</div>
      ${con && con.country ? `<div class="ip-small">${escapeHtml(con.country)}</div>` : ''}
      ${con && con.tax_id ? `<div class="ip-small">Tax ID: ${escapeHtml(con.tax_id)}</div>` : ''}
      ${con && con.email ? `<div class="ip-small">${escapeHtml(con.email)}</div>` : ''}
      ${val('po_reference') ? `<div class="ip-small">PO: ${escapeHtml(val('po_reference'))}</div>` : ''}
    </div>
    <table class="ip-lines">
      <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Tax</th><th class="num">Total</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="ip-empty">No line items yet</td></tr>'}</tbody>
    </table>
    <div class="ip-totals">
      <div class="ip-row"><span>Subtotal</span><span>${fmtMoney(sub, ccy)}</span></div>
      <div class="ip-row"><span>Tax</span><span>${fmtMoney(tax, ccy)}</span></div>
      <div class="ip-row grand"><span>Total</span><span>${fmtMoney(sub + tax, ccy)}</span></div>
    </div>
    ${val('notes') ? `<div style="margin-top:18px"><h3 style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.05em;margin:0 0 3px">Notes</h3><div style="color:#222;white-space:pre-wrap">${escapeHtml(val('notes'))}</div></div>` : ''}
  `;
}

async function saveInvoice() {
  const data = {
    entity_id: Number(invForm.elements['entity_id'].value),
    contact_id: Number(invForm.elements['contact_id'].value),
    issue_date: invForm.elements['issue_date'].value,
    due_date: invForm.elements['due_date'].value || null,
    currency: invForm.elements['currency'].value,
    fx_rate_to_base: Number(invForm.elements['fx_rate_to_base'].value) || 1,
    status: invForm.elements['status'].value,
    po_reference: invForm.elements['po_reference'].value || null,
    notes: invForm.elements['notes'].value || null,
    direction: invForm.elements['direction'].value,
    external_number: invForm.elements['external_number'].value || null,
    recurrence_kind:     invForm.elements['recurrence_kind']?.value || null,
    recurrence_next_run: invForm.elements['recurrence_next_run']?.value || null,
    recurrence_active:   invForm.elements['recurrence_active']?.value === '1' ? 1 : 0,
    lines: state.invDraftLines.filter(l => l.description || l.unit_price),
  };
  if (!data.entity_id)  { toast('Entity required', 'warn'); return; }
  if (!data.contact_id) { toast('Customer required', 'warn'); return; }
  if (!data.currency)   { toast('Currency required', 'warn'); return; }
  // Duplicate-bill guard (warn-only): same supplier + supplier number on a live bill.
  if (data.direction === 'purchase' && data.external_number && data.contact_id) {
    try {
      const dup = await api.checkBillDuplicate(data.contact_id, data.external_number, state.invEditingId || 0);
      if (dup && dup.duplicate) {
        const ok = await uiConfirm(`Looks like a duplicate of bill ${dup.number || '#' + dup.id} (${dup.currency || ''} ${fmtMoney(dup.total || 0)}). Save anyway?`);
        if (!ok) return;
      }
    } catch (_) { /* non-blocking */ }
  }
  try {
    if (state.invEditingId) {
      await api.updateInvoice(state.invEditingId, data);
    } else {
      const created = await api.createInvoice(data);
      if (created && created.id && (state.invPendingAttachments || []).length) {
        for (const f of state.invPendingAttachments) { try { await api.uploadInvoiceAttachment(created.id, f); } catch (_) {} }
      }
      state.invPendingAttachments = [];
      clearInvoiceDraft();
    }
    invDlg.close();
    await loadInvoices();
  } catch (err) { toast('Save failed: ' + err.message, 'error'); }
}

// ==================================================================
// Contracts
// ==================================================================

const ctDlg = document.getElementById('contract-dialog');
const ctForm = document.getElementById('contract-form');

document.getElementById('btn-new-contract').addEventListener('click', () => openContractDialog(null));
document.getElementById('contract-cancel').addEventListener('click', () => ctDlg.close());
document.getElementById('contract-save').addEventListener('click', guardSave('contract-save', saveContract));
document.getElementById('contract-search').addEventListener('input', (e) => { state.ctFilterText = e.target.value; renderContracts(); });
document.getElementById('contract-filter-entity').addEventListener('change', (e) => { state.ctFilterEntity = e.target.value; renderContracts(); });
document.getElementById('contract-filter-status').addEventListener('change', (e) => { state.ctFilterStatus = e.target.value; renderContracts(); });

async function loadContracts() {
  state.contracts = await api.contracts();
  const sel = document.getElementById('contract-filter-entity');
  if (sel.options.length <= 1) {
    sel.innerHTML = '<option value="">All entities</option>' +
      state.entities.map(e => `<option value="${e.id}">${escapeHtml(e.code)}</option>`).join('');
  }
  await loadSavedViews('contracts');
  renderContracts();
}

function renderContracts() {
  const tbody = document.querySelector('#contracts-table tbody');
  const text = state.ctFilterText.toLowerCase();
  const showTerminated = document.getElementById('contract-show-terminated')?.checked;
  const filtered = state.contracts.filter(c => {
    if (!showTerminated && c.status === 'terminated') return false;
    if (state.ctFilterEntity && c.entity_id !== Number(state.ctFilterEntity)) return false;
    if (state.ctFilterStatus && c.status !== state.ctFilterStatus) return false;
    if (text) {
      const blob = [c.title, c.counterparty_name, c.contract_type, c.reference]
        .filter(Boolean).join(' ').toLowerCase();
      if (!blob.includes(text)) return false;
    }
    return true;
  });
  tbody.innerHTML = filtered.map(c => `
    <tr data-id="${c.id}">
      <td><strong>${escapeHtml(c.title)}</strong>${c.reference ? `<br><span class="muted">${escapeHtml(c.reference)}</span>` : ''}</td>
      <td>${escapeHtml(c.contract_type || '')}</td>
      <td><span class="pill">${escapeHtml(c.entity_code)}</span></td>
      <td>${escapeHtml(c.counterparty_name)}</td>
      <td>${escapeHtml(c.start_date || '')}</td>
      <td>${renderEndDate(c)}</td>
      <td>${c.file_name ? `<a href="/api/contracts/${c.id}/file" target="_blank">${escapeHtml(c.file_name)}</a>` : '<span class="muted">—</span>'}</td>
      <td><select class="inline-status status status-${c.status}" data-id="${c.id}" data-current="${c.status}" data-kind="contract">
        ${['draft','active','expired','terminated'].map(s => `<option value="${s}" ${s === c.status ? 'selected' : ''}>${s}</option>`).join('')}
      </select></td>
      <td class="row-actions">
        <button data-act="edit">Edit</button>
        <button data-act="terminate" class="danger">End</button>
        <button data-act="del" class="danger" title="Delete permanently">Del</button>
      </td>
    </tr>
  `).join('');
  document.getElementById('contracts-empty').hidden = filtered.length > 0;
  tbody.querySelectorAll('button[data-act]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = Number(e.target.closest('tr').dataset.id);
      if (btn.dataset.act === 'edit') openContractDialog(id);
      if (btn.dataset.act === 'terminate') {
        if (await uiConfirm('Mark this contract as terminated?')) {
          try { await api.archiveContract(id); await loadContracts(); }
          catch (err) { toast('Terminate failed: ' + err.message, 'error'); }
        }
      }
      if (btn.dataset.act === 'del') {
        const c = state.contracts.find(x => x.id === id);
        await tryHardDelete('/api/contracts/' + id, c?.title || 'contract', loadContracts);
      }
    });
  });
}

function renderEndDate(c) {
  if (!c.end_date) return '<span class="muted">—</span>';
  const days = Math.round((new Date(c.end_date) - new Date()) / 86400000);
  let cls = '';
  if (days < 0) cls = 'date-expired';
  else if (days < 60) cls = 'date-warning';
  return `<span class="${cls}">${escapeHtml(c.end_date)}${days >= 0 && days < 90 ? ` <span class="muted">(${days}d)</span>` : ''}</span>`;
}

async function openContractDialog(id) {
  state.ctEditingId = id;
  ctForm.reset();
  document.getElementById('ct-entity').innerHTML = state.entities.map(e =>
    `<option value="${e.id}">${escapeHtml(e.code)} — ${escapeHtml(e.legal_name)}</option>`).join('');
  const cps = state.contacts.filter(c => c.status === 'active');
  document.getElementById('ct-counterparty').innerHTML = '<option value="">— select —</option>' +
    cps.map(c => `<option value="${c.id}">${escapeHtml(c.display_name)} (${c.contact_type})</option>`).join('');
  document.getElementById('contract-form-title').textContent = id ? 'Edit contract' : 'New contract';
  document.getElementById('contract-file-info').textContent = 'No file attached.';
  document.getElementById('contract-file-input').value = '';

  if (id) {
    const c = await api.contract(id);
    trackRecent('contracts', id, c.title || '#' + id);
    for (const [k, v] of Object.entries(c)) {
      const el = ctForm.elements[k];
      if (el && v != null) el.value = String(v);
    }
    ctForm.elements['auto_renew'].value = c.auto_renew ? '1' : '0';
    if (c.file_name) {
      document.getElementById('contract-file-info').innerHTML =
        `Current: <a href="/api/contracts/${id}/file" target="_blank">${escapeHtml(c.file_name)}</a> <span class="muted">(${(c.file_size/1024).toFixed(1)} KB)</span>`;
    }
    // load prior versions
    try {
      const versions = await fetch('/api/contracts/' + id + '/file-versions').then(r => r.json());
      const v = document.getElementById('contract-file-versions');
      v.innerHTML = versions.length
        ? `<div class="muted" style="margin-top:8px;font-size:11px">Previous versions:</div>` + versions.map(ver =>
            `<div class="version-row"><span class="muted">${escapeHtml(ver.archived_at)}</span> <a href="/api/contracts/${id}/file-version/${ver.id}" target="_blank">${escapeHtml(ver.file_name)}</a> <span class="muted">(${(ver.file_size/1024).toFixed(1)} KB)</span></div>`).join('')
        : '';
    } catch (_) {}
  } else {
    ctForm.elements['status'].value = 'active';
    ctForm.elements['auto_renew'].value = '0';
  }
  if (id) attachActivityPanel(ctDlg, 'contracts', id);
  ctDlg.showModal();
}

async function saveContract() {
  const data = {};
  for (const el of ctForm.elements) {
    if (!el.name) continue;
    data[el.name] = el.value;
  }
  data.entity_id = Number(data.entity_id);
  data.counterparty_id = Number(data.counterparty_id);
  data.auto_renew = data.auto_renew === '1' ? 1 : 0;
  data.renewal_notice_days = data.renewal_notice_days ? Number(data.renewal_notice_days) : null;
  data.value_amount = data.value_amount ? Number(data.value_amount) : null;
  if (!data.title) { toast('Title required', 'warn'); return; }
  if (!data.entity_id) { toast('Entity required', 'warn'); return; }
  if (!data.counterparty_id) { toast('Counterparty required', 'warn'); return; }
  let saved;
  try {
    saved = state.ctEditingId
      ? await api.updateContract(state.ctEditingId, data)
      : await api.createContract(data);
  } catch (e) { toast('Save failed: ' + e.message, 'error'); return; }
  const fileInput = document.getElementById('contract-file-input');
  if (fileInput.files && fileInput.files[0]) {
    try { await api.uploadContractFile(saved.id, fileInput.files[0]); }
    catch (e) { toast('File upload failed: ' + e.message, 'error'); }
  }
  ctDlg.close();
  await loadContracts();
}

// ==================================================================
// KYC
// ==================================================================

const kycDlg = document.getElementById('kyc-dialog');
const kycForm = document.getElementById('kyc-form');

document.getElementById('btn-new-kyc').addEventListener('click', () => openKycDialog(null));
document.getElementById('kyc-cancel').addEventListener('click', () => kycDlg.close());
document.getElementById('kyc-save').addEventListener('click', guardSave('kyc-save', saveKyc));
document.getElementById('kyc-search').addEventListener('input', (e) => { state.kycFilterText = e.target.value; renderKyc(); });
document.getElementById('kyc-filter-status').addEventListener('change', (e) => { state.kycFilterStatus = e.target.value; renderKyc(); });
document.getElementById('kyc-filter-risk').addEventListener('change', (e) => { state.kycFilterRisk = e.target.value; renderKyc(); });

document.getElementById('kyc-doc-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file || !state.kycEditingId) return;
  const docType = document.getElementById('kyc-doc-type').value;
  try {
    await api.uploadKycDoc(state.kycEditingId, file, docType);
    const fresh = await api.kyc(state.kycEditingId);
    renderKycDocsList(fresh.documents);
    e.target.value = '';
  } catch (err) { toast('Upload failed: ' + err.message, 'error'); }
});

async function loadKyc() {
  state.kyc = await api.kycList();
  renderKyc();
}

function renderKyc() {
  const tbody = document.querySelector('#kyc-table tbody');
  const text = state.kycFilterText.toLowerCase();
  const filtered = state.kyc.filter(k => {
    if (state.kycFilterStatus && k.status !== state.kycFilterStatus) return false;
    if (state.kycFilterRisk && k.risk_tier !== state.kycFilterRisk) return false;
    if (text && !(k.contact_display_name || '').toLowerCase().includes(text)) return false;
    return true;
  });
  tbody.innerHTML = filtered.map(k => `
    <tr data-id="${k.id}">
      <td><strong>${escapeHtml(k.contact_display_name)}</strong></td>
      <td><span class="pill type-${k.contact_type}">${escapeHtml(k.contact_type)}</span></td>
      <td><span class="risk risk-${k.risk_tier}">${k.risk_tier}</span></td>
      <td><select class="inline-status status status-${k.status}" data-id="${k.id}" data-current="${k.status}" data-kind="kyc">
        ${['pending','in_progress','approved','rejected','expired'].map(s => `<option value="${s}" ${s === k.status ? 'selected' : ''}>${s.replace('_',' ')}</option>`).join('')}
      </select></td>
      <td>${escapeHtml(k.verified_at || '')}</td>
      <td>${renderRefreshDate(k.refresh_due)}</td>
      <td>${k.doc_count}</td>
      <td class="row-actions">
        <button data-act="edit">Edit</button>
        <button data-act="delete" class="danger">×</button>
      </td>
    </tr>
  `).join('');
  document.getElementById('kyc-empty').hidden = filtered.length > 0;
  tbody.querySelectorAll('button[data-act]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = Number(e.target.closest('tr').dataset.id);
      if (btn.dataset.act === 'edit') openKycDialog(id);
      if (btn.dataset.act === 'delete') {
        if (await uiConfirm('Delete KYC record and all its documents?')) {
          try { await api.deleteKyc(id); await loadKyc(); }
          catch (err) { toast('Delete failed: ' + err.message, 'error'); }
        }
      }
    });
  });
}

function renderRefreshDate(d) {
  if (!d) return '<span class="muted">—</span>';
  const days = Math.round((new Date(d) - new Date()) / 86400000);
  let cls = '';
  if (days < 0) cls = 'date-expired';
  else if (days < 90) cls = 'date-warning';
  return `<span class="${cls}">${escapeHtml(d)}</span>`;
}

async function openKycDialog(id) {
  state.kycEditingId = id;
  kycForm.reset();
  const sel = document.getElementById('kyc-contact');
  sel.innerHTML = '<option value="">— select contact —</option>' +
    state.contacts.map(c => `<option value="${c.id}">${escapeHtml(c.display_name)} (${c.contact_type})</option>`).join('');
  document.getElementById('kyc-form-title').textContent = id ? 'Edit KYC record' : 'New KYC record';
  const docsList = document.getElementById('kyc-docs-list');
  docsList.innerHTML = '<div class="muted">Save the record before attaching documents.</div>';

  if (id) {
    const k = await api.kyc(id);
    trackRecent('kyc_records', id, k.contact_display_name || '#' + id);
    for (const [key, v] of Object.entries(k)) {
      const el = kycForm.elements[key];
      if (el && v != null) el.value = String(v);
    }
    kycForm.elements['pep_check'].value = k.pep_check ? '1' : '0';
    kycForm.elements['sanctions_check'].value = k.sanctions_check ? '1' : '0';
    sel.disabled = true;
    renderKycDocsList(k.documents);
  } else {
    sel.disabled = false;
  }
  if (id) attachActivityPanel(kycDlg, 'kyc_records', id);
  kycDlg.showModal();
}

function renderKycDocsList(docs) {
  const el = document.getElementById('kyc-docs-list');
  if (!docs || !docs.length) {
    el.innerHTML = '<div class="muted">No documents yet.</div>';
    return;
  }
  el.innerHTML = '<ul class="doc-list">' + docs.map(d => `
    <li data-id="${d.id}">
      <span class="pill">${escapeHtml(d.doc_type)}</span>
      <a href="/api/kyc/document/${d.id}" target="_blank">${escapeHtml(d.file_name)}</a>
      <span class="muted">${(d.file_size/1024).toFixed(1)} KB</span>
      <button type="button" class="danger" data-act="rm-doc">×</button>
    </li>
  `).join('') + '</ul>';
  el.querySelectorAll('button[data-act="rm-doc"]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const docId = Number(e.target.closest('li').dataset.id);
      if (!await uiConfirm('Delete this document?')) return;
      try {
        await api.deleteKycDoc(docId);
        const fresh = await api.kyc(state.kycEditingId);
        renderKycDocsList(fresh.documents);
      } catch (err) { toast('Delete failed: ' + err.message, 'error'); }
    });
  });
}

async function saveKyc() {
  const data = {};
  for (const el of kycForm.elements) {
    if (!el.name) continue;
    data[el.name] = el.value;
  }
  data.contact_id = Number(data.contact_id);
  data.pep_check = data.pep_check === '1' ? 1 : 0;
  data.sanctions_check = data.sanctions_check === '1' ? 1 : 0;
  if (!data.contact_id) { toast('Contact required', 'warn'); return; }
  try {
    if (state.kycEditingId) {
      await api.updateKyc(state.kycEditingId, data);
    } else {
      const created = await api.createKyc(data);
      state.kycEditingId = created.id;
      // re-open to enable document upload
      document.getElementById('kyc-contact').disabled = true;
      renderKycDocsList(created.documents);
      await loadKyc();
      return;
    }
  } catch (e) { toast('Save failed: ' + e.message, 'error'); return; }
  kycDlg.close();
  await loadKyc();
}

// ==================================================================
// Banks
// ==================================================================

const baDlg = document.getElementById('bank-acct-dialog');
const baForm = document.getElementById('bank-acct-form');

document.getElementById('btn-new-bank-account').addEventListener('click', () => openBankAcctDialog(null));
document.getElementById('bank-acct-cancel').addEventListener('click', () => baDlg.close());
document.getElementById('bank-acct-save').addEventListener('click', guardSave('bank-acct-save', saveBankAcct));

document.getElementById('btn-import-csv').addEventListener('click', () => {
  if (!state.bankCurrentAccountId) { toast('Select an account first', 'warn'); return; }
  document.getElementById('csv-file-input').click();
});

document.getElementById('csv-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const txns = parseBankCsv(text);
    if (!txns.length) { toast('No rows parsed from CSV', 'warn'); return; }
    const result = await api.importTransactions(state.bankCurrentAccountId, txns);
    toast(`Imported ${result.inserted}, skipped ${result.skipped} duplicate(s).`, result.skipped ? 'warn' : 'ok');
    await loadBankTransactions(state.bankCurrentAccountId);
    await loadBanks();   // refresh account counts
  } catch (err) { toast('Import failed: ' + err.message, 'error'); }
  e.target.value = '';
});

// Header alias resolver — robust against bank-specific column names.
const CSV_ALIASES = {
  date:        ['date', 'transaction date', 'posting date', 'value date', 'trans date', 'trans. date', 'booking date', 'txn date', 'effective date'],
  description: ['description', 'narrative', 'memo', 'details', 'particulars', 'transaction details', 'narration', 'remark', 'remarks'],
  amount:      ['amount', 'transaction amount', 'value', 'amt', 'txn amount'],
  debit:       ['debit', 'debit amount', 'withdrawal', 'withdrawals', 'money out', 'paid out', 'dr'],
  credit:      ['credit', 'credit amount', 'deposit', 'deposits', 'money in', 'paid in', 'cr'],
  reference:   ['reference', 'ref', 'ref.', 'reference number', 'transaction reference', 'cheque number', 'check number', 'txn ref'],
  currency:    ['currency', 'ccy', 'curr', 'currency code'],
  category:    ['category', 'type', 'transaction type'],
  notes:       ['notes', 'note', 'comments'],
  balance:     ['balance', 'running balance', 'closing balance'],
};

function findColumn(header, aliases) {
  for (const a of aliases) {
    const i = header.indexOf(a);
    if (i >= 0) return i;
  }
  return -1;
}

function parseAmount(raw) {
  if (raw == null || raw === '') return 0;
  let s = String(raw).trim();
  // strip currency symbols, thousand separators
  s = s.replace(/[^\d.,()\-+]/g, '');
  // handle parentheses for negative
  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1);
  }
  // detect EU format: 1.234,56 → 1234.56
  if (/,\d{2}$/.test(s) && /\./.test(s) && s.indexOf('.') < s.lastIndexOf(',')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    s = s.replace(/,/g, '');
  }
  const n = Number(s);
  if (Number.isNaN(n)) return 0;
  return negative ? -n : n;
}

function parseBankCsv(text) {
  // Robust CSV parser: handles header aliases + debit/credit-split formats.
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const header = splitCsvLine(lines[0]).map(h => h.trim().toLowerCase());

  const idx = {
    date:        findColumn(header, CSV_ALIASES.date),
    description: findColumn(header, CSV_ALIASES.description),
    amount:      findColumn(header, CSV_ALIASES.amount),
    debit:       findColumn(header, CSV_ALIASES.debit),
    credit:      findColumn(header, CSV_ALIASES.credit),
    reference:   findColumn(header, CSV_ALIASES.reference),
    currency:    findColumn(header, CSV_ALIASES.currency),
    category:    findColumn(header, CSV_ALIASES.category),
    notes:       findColumn(header, CSV_ALIASES.notes),
  };

  if (idx.date < 0) throw new Error('CSV must include a date column (Date / Transaction Date / Posting Date / Value Date / Booking Date).');
  if (idx.amount < 0 && idx.debit < 0 && idx.credit < 0) {
    throw new Error('CSV must include an amount column (Amount) or Debit + Credit columns.');
  }

  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    if (cols.every(c => c === '')) continue;

    let amount;
    if (idx.amount >= 0) {
      amount = parseAmount(cols[idx.amount]);
    } else {
      const debit  = idx.debit  >= 0 ? parseAmount(cols[idx.debit])  : 0;
      const credit = idx.credit >= 0 ? parseAmount(cols[idx.credit]) : 0;
      // Debit reduces balance (negative); Credit increases (positive)
      amount = credit - Math.abs(debit);
    }
    if (!amount && !cols[idx.description]) continue;

    out.push({
      txn_date:    normaliseDate(cols[idx.date]),
      description: idx.description >= 0 ? cols[idx.description] : null,
      amount,
      reference:   idx.reference >= 0 ? cols[idx.reference] : null,
      currency:    idx.currency  >= 0 ? cols[idx.currency]  : null,
      category:    idx.category  >= 0 ? cols[idx.category]  : null,
      notes:       idx.notes     >= 0 ? cols[idx.notes]     : null,
    });
  }
  return out;
}

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i+1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else {
      if (ch === ',') { out.push(cur); cur = ''; }
      else if (ch === '"') inQ = true;
      else cur += ch;
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function normaliseDate(s) {
  if (!s) return null;
  // accept YYYY-MM-DD, DD/MM/YYYY, MM/DD/YYYY (assume DD/MM if first part > 12)
  s = s.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (!m) return s;
  let [_, a, b, y] = m;
  a = Number(a); b = Number(b);
  if (y.length === 2) y = '20' + y;
  const dd = a > 12 ? a : b;
  const mm = a > 12 ? b : a;
  return `${y}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
}

async function loadBanks() {
  state.bankAccounts = await api.bankAccounts();
  renderBankAccounts();
  if (state.bankCurrentAccountId) {
    await loadBankTransactions(state.bankCurrentAccountId);
  }
}

function renderBankAccounts() {
  const ul = document.getElementById('bank-accounts-list');
  if (!state.bankAccounts.length) {
    ul.innerHTML = '<li class="muted" style="padding:12px">No accounts yet.</li>';
    return;
  }
  ul.innerHTML = state.bankAccounts.map(a => `
    <li data-id="${a.id}" class="${state.bankCurrentAccountId === a.id ? 'active' : ''}">
      <div class="ba-label"><strong>${escapeHtml(a.bank_name)}</strong> <span class="muted">${escapeHtml(a.currency)}</span></div>
      <div class="ba-sub">${escapeHtml(a.account_label)} · <span class="pill">${escapeHtml(a.entity_code)}</span></div>
      <div class="ba-balance">${escapeHtml(a.currency)} ${fmtMoney(a.current_balance)}</div>
      <div class="ba-meta muted">${a.tx_count} txn${a.tx_count === 1 ? '' : 's'} · ${a.unreconciled_count} unreconciled</div>
      <div class="ba-actions">
        <button data-act="edit" title="Edit account">Edit</button>
        ${a.provider === 'aspire' ? `<button data-act="sync" title="Sync from Aspire">Sync</button>` : ''}
        <button data-act="archive" class="danger" title="Archive">×</button>
        <button data-act="del" class="danger" title="Delete permanently">Del</button>
      </div>
    </li>
  `).join('');
  ul.querySelectorAll('li[data-id]').forEach(li => {
    li.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      state.bankCurrentAccountId = Number(li.dataset.id);
      renderBankAccounts();
      loadBankTransactions(state.bankCurrentAccountId);
    });
  });
  ul.querySelectorAll('button[data-act]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = Number(btn.closest('li').dataset.id);
      if (btn.dataset.act === 'edit') openBankAcctDialog(id);
      if (btn.dataset.act === 'archive') {
        if (await uiConfirm('Archive this account?')) {
          try { await api.archiveBankAccount(id); await loadBanks(); }
          catch (err) { toast('Archive failed: ' + err.message, 'error'); }
        }
      }
      if (btn.dataset.act === 'del') {
        const a = state.bankAccounts.find(x => x.id === id);
        await tryHardDelete('/api/bank-accounts/' + id, a ? `${a.bank_name} / ${a.account_label}` : 'account', loadBanks);
      }
      if (btn.dataset.act === 'sync') {
        btn.disabled = true; btn.textContent = 'Syncing…';
        try {
          const r = await api.syncAspire(id);
          toast(`Aspire sync: ${r.inserted} new, ${r.skipped} skipped.`, 'ok');
        } catch (err) {
          toast('Sync failed: ' + err.message, 'error');
        }
        await loadBanks();
        if (state.bankCurrentAccountId === id) await loadBankTransactions(id);
      }
    });
  });
}

async function loadBankTransactions(accountId) {
  state.bankTransactions = await api.bankTransactions(accountId);
  const acct = state.bankAccounts.find(a => a.id === accountId);
  document.getElementById('bank-current-account').textContent =
    acct ? `${acct.bank_name} — ${acct.account_label} (${acct.currency})` : '';
  renderBankTransactions();
}

function renderBankTransactions() {
  const tbody = document.querySelector('#bank-tx-table tbody');
  if (!state.bankTransactions.length) {
    tbody.innerHTML = '';
    document.getElementById('bank-tx-empty').hidden = false;
    return;
  }
  document.getElementById('bank-tx-empty').hidden = true;
  const invs = state.invoices.length ? state.invoices : [];
  const invOptions = invs.map(i => `<option value="${i.id}">${escapeHtml(i.number)} — ${escapeHtml(i.contact_display_name)} — ${fmtMoney(i.total)}</option>`).join('');
  tbody.innerHTML = state.bankTransactions.map(t => `
    <tr data-id="${t.id}" class="${t.reconciled ? 'matched' : ''}">
      <td>${escapeHtml(t.txn_date)}</td>
      <td>${escapeHtml(t.description || '')}</td>
      <td>${escapeHtml(t.reference || '')}</td>
      <td class="num ${t.amount < 0 ? 'debit' : 'credit'}">${escapeHtml(t.currency)} ${fmtMoney(t.amount)}</td>
      <td>
        ${t.invoice_number
          ? `<span class="pill">${escapeHtml(t.invoice_number)}</span> <button data-act="unmatch" class="danger">unlink</button>`
          : `<select data-act="match"><option value="">— match invoice —</option>${invOptions}</select>`}
      </td>
      <td class="row-actions">
        <button data-act="edit">Edit</button>
        <button data-act="delete" class="danger">×</button>
      </td>
    </tr>
  `).join('');
  tbody.querySelectorAll('button[data-act="edit"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = Number(e.target.closest('tr').dataset.id);
      openBankTxDialog(id);
    });
  });
  tbody.querySelectorAll('select[data-act="match"]').forEach(sel => {
    sel.addEventListener('change', async (e) => {
      const id = Number(e.target.closest('tr').dataset.id);
      const invId = Number(e.target.value);
      if (!invId) return;
      await api.matchTransaction(id, invId);
      await loadBankTransactions(state.bankCurrentAccountId);
      await loadBanks();
    });
  });
  tbody.querySelectorAll('button[data-act="unmatch"]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = Number(e.target.closest('tr').dataset.id);
      await api.matchTransaction(id, null);
      await loadBankTransactions(state.bankCurrentAccountId);
    });
  });
  tbody.querySelectorAll('button[data-act="delete"]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = Number(e.target.closest('tr').dataset.id);
      if (!await uiConfirm('Delete this transaction?')) return;
      await fetch('/api/bank-transactions/' + id, { method: 'DELETE' });
      await loadBankTransactions(state.bankCurrentAccountId);
      await loadBanks();
    });
  });
}

let bankAcctEditingId = null;

async function openBankAcctDialog(id) {
  bankAcctEditingId = id;
  baForm.reset();
  document.getElementById('ba-entity').innerHTML =
    state.entities.map(e => `<option value="${e.id}">${escapeHtml(e.code)} — ${escapeHtml(e.legal_name)}</option>`).join('');
  baForm.elements['opening_balance'].value = 0;
  baForm.elements['provider'].value = 'csv';
  // populate credential picker (refresh from server so newly added creds show up)
  const creds = await api.credentials();
  state.credentials = creds;
  document.getElementById('ba-credential').innerHTML =
    '<option value="">— none —</option>' +
    creds.map(c => `<option value="${c.id}">${escapeHtml(c.provider)} · ${escapeHtml(c.label || c.client_id || '')}</option>`).join('');
  document.querySelector('#bank-acct-form h2').textContent = id ? 'Edit bank account' : 'New bank account';
  if (id) {
    const a = state.bankAccounts.find(x => x.id === id);
    if (a) {
      for (const [k, v] of Object.entries(a)) {
        const el = baForm.elements[k];
        if (el && v != null) el.value = String(v);
      }
    }
  }
  baDlg.showModal();
}

async function saveBankAcct() {
  const data = {};
  for (const el of baForm.elements) {
    if (!el.name) continue;
    data[el.name] = el.value;
  }
  data.entity_id = Number(data.entity_id);
  data.opening_balance = Number(data.opening_balance) || 0;
  data.currency = (data.currency || '').toUpperCase();
  data.credential_id = data.credential_id ? Number(data.credential_id) : null;
  if (!data.entity_id || !data.bank_name || !data.account_label || !data.currency) {
    toast('Entity, bank, label and currency are required', 'warn'); return;
  }
  try {
    if (bankAcctEditingId) await api.updateBankAccount(bankAcctEditingId, data);
    else await api.createBankAccount(data);
  } catch (e) { toast('Save failed: ' + e.message, 'error'); return; }
  baDlg.close();
  await loadBanks();
}

// ==================================================================
// Money flows
// ==================================================================

const flowDlg = document.getElementById('flow-dialog');
const flowForm = document.getElementById('flow-form');

document.getElementById('btn-new-flow').addEventListener('click', () => openFlowDialog(null));
document.getElementById('flow-cancel').addEventListener('click', () => flowDlg.close());
document.getElementById('flow-save').addEventListener('click', guardSave('flow-save', saveFlow));

async function loadFlows() {
  const [list, summary] = await Promise.all([api.flows(), api.flowSummary()]);
  state.flows = list;
  state.flowSummary = summary;
  renderFlows();
}

function sankeyFlowSVG(summary) {
  const entities = summary.entities;
  const edges = summary.edges;
  if (!entities.length || !edges.length) return '';
  const W = 720, H = 280, padX = 80, padY = 36;
  const colH = H - padY * 2;
  const nodeW = 90;
  const cols = { left: padX, right: W - padX - nodeW };
  const maxUsd = Math.max(1, ...edges.map(e => Math.abs(e.total_usd) || 0));
  // Lay out entities vertically twice (left = source, right = target)
  const yFor = (i, total) => padY + colH * ((i + 0.5) / Math.max(1, total));
  const leftY  = new Map(entities.map((e, i) => [e.id, yFor(i, entities.length)]));
  const rightY = new Map(entities.map((e, i) => [e.id, yFor(i, entities.length)]));
  // Build paths
  const ribbons = edges.map(e => {
    const y1 = leftY.get(e.from_entity_id);
    const y2 = rightY.get(e.to_entity_id);
    if (y1 == null || y2 == null) return '';
    const thickness = Math.max(2, Math.min(32, (Math.abs(e.total_usd) / maxUsd) * 32));
    const x1 = cols.left + nodeW, x2 = cols.right;
    const midX = (x1 + x2) / 2;
    return `<path d="M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}" stroke="var(--accent)" stroke-width="${thickness}" fill="none" opacity="0.55" stroke-linecap="round">
      <title>${e.currency} ${fmtMoney(e.total)} (~$${fmtMoney(e.total_usd)} USD, ${e.count} flow${e.count === 1 ? '' : 's'})</title>
    </path>`;
  }).join('');
  const nodes = entities.map(e => {
    const ly = leftY.get(e.id), ry = rightY.get(e.id);
    return `
      <g>
        <rect x="${cols.left}" y="${ly - 14}" width="${nodeW}" height="28" rx="6" fill="var(--panel-2)" stroke="var(--border)"/>
        <text x="${cols.left + nodeW/2}" y="${ly + 4}" text-anchor="middle" class="sankey-label">${escapeHtml(e.code)}</text>
        <rect x="${cols.right}" y="${ry - 14}" width="${nodeW}" height="28" rx="6" fill="var(--panel-2)" stroke="var(--border)"/>
        <text x="${cols.right + nodeW/2}" y="${ry + 4}" text-anchor="middle" class="sankey-label">${escapeHtml(e.code)}</text>
      </g>
    `;
  }).join('');
  return `
    <div class="sankey-card">
      <div class="sankey-head">
        <h3>Flow visualisation</h3>
        <span class="muted" style="font-size:11px">From (left) → To (right) · ribbon width ≈ USD-equivalent</span>
      </div>
      <svg viewBox="0 0 ${W} ${H}" class="sankey-svg" preserveAspectRatio="xMidYMid meet">
        ${ribbons}
        ${nodes}
      </svg>
    </div>
  `;
}

function renderFlows() {
  const sumEl = document.getElementById('flows-summary');
  if (state.flowSummary && state.flowSummary.edges.length) {
    sumEl.innerHTML = sankeyFlowSVG(state.flowSummary) + state.flowSummary.edges.map(e => {
      const from = state.flowSummary.entities.find(x => x.id === e.from_entity_id);
      const to   = state.flowSummary.entities.find(x => x.id === e.to_entity_id);
      return `
        <div class="flow-card">
          <div class="flow-arrow"><strong>${escapeHtml(from ? from.code : '?')}</strong> → <strong>${escapeHtml(to ? to.code : '?')}</strong></div>
          <div class="flow-amount">${escapeHtml(e.currency)} ${fmtMoney(e.total)}</div>
          <div class="muted">${e.count} flow${e.count === 1 ? '' : 's'} · ~$${fmtMoney(e.total_usd)} USD</div>
        </div>
      `;
    }).join('');
  } else {
    sumEl.innerHTML = '';
  }

  const tbody = document.querySelector('#flows-table tbody');
  tbody.innerHTML = state.flows.map(f => {
    const fromLabel = f.from_entity_code ? `<span class="pill">${escapeHtml(f.from_entity_code)}</span>` :
                     f.from_contact_name ? escapeHtml(f.from_contact_name) : '<span class="muted">—</span>';
    const toLabel = f.to_entity_code ? `<span class="pill">${escapeHtml(f.to_entity_code)}</span>` :
                   f.to_contact_name ? escapeHtml(f.to_contact_name) : '<span class="muted">—</span>';
    return `
      <tr data-id="${f.id}">
        <td>${escapeHtml(f.flow_date)}</td>
        <td>${fromLabel}</td>
        <td>${toLabel}</td>
        <td><span class="pill">${escapeHtml(f.kind)}</span></td>
        <td class="num">${escapeHtml(f.currency)} ${fmtMoney(f.amount)}</td>
        <td>${escapeHtml(f.reference || '')}</td>
        <td class="row-actions">
          <button data-act="edit">Edit</button>
          <button data-act="delete" class="danger">×</button>
        </td>
      </tr>
    `;
  }).join('');
  document.getElementById('flows-empty').hidden = state.flows.length > 0;
  tbody.querySelectorAll('button[data-act]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = Number(e.target.closest('tr').dataset.id);
      if (btn.dataset.act === 'edit') openFlowDialog(id);
      if (btn.dataset.act === 'delete') {
        if (await uiConfirm('Delete this flow?')) {
          try { await api.deleteFlow(id); await loadFlows(); }
          catch (err) { toast('Delete failed: ' + err.message, 'error'); }
        }
      }
    });
  });
}

function openFlowDialog(id) {
  state.flowEditingId = id;
  flowForm.reset();
  const optEnts = '<option value="">—</option>' +
    state.entities.map(e => `<option value="${e.id}">${escapeHtml(e.code)}</option>`).join('');
  const optCons = '<option value="">—</option>' +
    state.contacts.map(c => `<option value="${c.id}">${escapeHtml(c.display_name)}</option>`).join('');
  document.getElementById('flow-from-e').innerHTML = optEnts;
  document.getElementById('flow-from-c').innerHTML = optCons;
  document.getElementById('flow-to-e').innerHTML   = optEnts;
  document.getElementById('flow-to-c').innerHTML   = optCons;

  if (id) {
    const f = state.flows.find(x => x.id === id);
    if (f) {
      for (const [k, v] of Object.entries(f)) {
        const el = flowForm.elements[k];
        if (el && v != null) el.value = String(v);
      }
    }
  } else {
    flowForm.elements['flow_date'].value = new Date().toISOString().slice(0, 10);
    flowForm.elements['kind'].value = 'transfer';
    flowForm.elements['fx_rate_to_usd'].value = 1;
  }
  flowDlg.showModal();
}

async function saveFlow() {
  const data = {};
  for (const el of flowForm.elements) {
    if (!el.name) continue;
    data[el.name] = el.value === '' ? null : el.value;
  }
  for (const k of ['from_entity_id','from_contact_id','to_entity_id','to_contact_id']) {
    if (data[k]) data[k] = Number(data[k]);
  }
  data.amount = Number(data.amount);
  data.fx_rate_to_usd = Number(data.fx_rate_to_usd) || 1;
  data.currency = (data.currency || '').toUpperCase();
  if (!data.flow_date || !data.amount || !data.currency) {
    toast('Date, amount and currency required', 'warn'); return;
  }
  try {
    if (state.flowEditingId) await api.updateFlow(state.flowEditingId, data);
    else await api.createFlow(data);
  } catch (e) { toast('Save failed: ' + e.message, 'error'); return; }
  flowDlg.close();
  await loadFlows();
}

// ==================================================================
// Ops & Settings — sub-tabs, credentials, sync runs, system info,
// bank transaction edit
// ==================================================================

document.querySelectorAll('.subtab').forEach(btn => {
  btn.addEventListener('click', () => {
    const sub = btn.dataset.sub;
    state.settingsSub = sub;
    document.querySelectorAll('.subtab').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.subpanel').forEach(p => p.hidden = p.dataset.sub !== sub);
    if (sub === 'credentials') loadCredentials();
    if (sub === 'sync') loadSyncRuns();
    if (sub === 'ops') { loadSystemInfo(); loadBackupList(); }
    if (sub === 'currencies') loadCurrencies();
    if (sub === 'users') loadUsers();
  });
});

// --- Auth chip + sign out ---
async function loadMe() {
  try {
    const u = await api.me();
    state.me = u;
    const chip = document.getElementById('user-chip');
    document.getElementById('user-chip-name').textContent = u.display_name || u.email;
    document.getElementById('user-chip-role').textContent = u.role;
    chip.hidden = false;
    // hide Users sub-tab if not admin
    const usersSub = document.querySelector('.subtab[data-sub="users"]');
    if (usersSub) usersSub.hidden = u.role !== 'admin';
  } catch (_) { window.location.href = '/'; }
}

document.getElementById('btn-logout').addEventListener('click', async () => {
  await api.logout();
  window.location.href = '/';
});

// --- Self-service password change ---
const accountDlg = document.getElementById('password-dialog');
document.getElementById('user-meta-clickable').addEventListener('click', () => {
  document.getElementById('account-form').reset();
  accountDlg.showModal();
});
document.getElementById('account-cancel').addEventListener('click', () => accountDlg.close());
document.getElementById('account-save').addEventListener('click', async () => {
  const form = document.getElementById('account-form');
  const d = Object.fromEntries(new FormData(form));
  if (d.new_password !== d.confirm_password) { toast('Passwords do not match', 'warn'); return; }
  try {
    await jsonReq('POST', '/api/auth/change-password', { current_password: d.current_password, new_password: d.new_password });
    accountDlg.close();
    toast('Password updated', 'ok');
  } catch (err) { toast(err.message, 'error'); }
});

// --- Users CRUD ---
const userDlg  = document.getElementById('user-dialog');
const userForm = document.getElementById('user-form');

document.getElementById('btn-new-user').addEventListener('click', () => openUserDialog(null));
document.getElementById('user-cancel').addEventListener('click', () => userDlg.close());
document.getElementById('user-save').addEventListener('click', saveUser);

async function loadUsers() {
  try {
    state.users = await api.users();
  } catch (e) {
    state.users = [];
  }
  renderUsers();
}

function renderUsers() {
  const tbody = document.querySelector('#users-table tbody');
  tbody.innerHTML = state.users.map(u => `
    <tr data-id="${u.id}">
      <td><strong>${escapeHtml(u.email)}</strong></td>
      <td>${escapeHtml(u.display_name || '')}</td>
      <td><span class="pill">${escapeHtml(u.role)}</span></td>
      <td><span class="status status-${u.status === 'active' ? 'active' : 'terminated'}">${escapeHtml(u.status)}</span></td>
      <td><span class="muted">${escapeHtml(u.last_login_at || 'never')}</span></td>
      <td class="row-actions">
        <button data-act="edit">Edit</button>
        ${state.me && u.id === state.me.id ? '' : '<button data-act="delete" class="danger">×</button>'}
      </td>
    </tr>
  `).join('');
  tbody.querySelectorAll('button[data-act]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = Number(e.target.closest('tr').dataset.id);
      if (btn.dataset.act === 'edit') openUserDialog(id);
      if (btn.dataset.act === 'delete') {
        if (await uiConfirm('Delete this user? Their sessions will be revoked.')) {
          try { await api.deleteUser(id); } catch (err) { toast(err.message, 'error'); }
          await loadUsers();
        }
      }
    });
  });
}

function openUserDialog(id) {
  state.userEditingId = id;
  userForm.reset();
  document.getElementById('user-form-title').textContent = id ? 'Edit user' : 'Add user';
  if (id) {
    const u = state.users.find(x => x.id === id);
    if (u) {
      userForm.elements['email'].value = u.email;
      userForm.elements['email'].disabled = true;
      userForm.elements['display_name'].value = u.display_name || '';
      userForm.elements['role'].value = u.role;
      userForm.elements['status'].value = u.status;
    }
  } else {
    userForm.elements['email'].disabled = false;
  }
  userDlg.showModal();
}

async function saveUser() {
  const data = {};
  for (const el of userForm.elements) {
    if (!el.name) continue;
    if (el.value !== '') data[el.name] = el.value;
  }
  try {
    if (state.userEditingId) await api.updateUser(state.userEditingId, data);
    else await api.createUser(data);
  } catch (e) { toast('Save failed: ' + e.message, 'error'); return; }
  userDlg.close();
  await loadUsers();
}

// --- Credentials ---
const credDlg  = document.getElementById('credential-dialog');
const credForm = document.getElementById('credential-form');

document.getElementById('btn-new-credential').addEventListener('click', () => openCredentialDialog(null));
document.getElementById('credential-cancel').addEventListener('click', () => credDlg.close());
document.getElementById('credential-save').addEventListener('click', saveCredential);

async function loadCredentials() {
  state.credentials = await api.credentials();
  renderCredentials();
  await loadApiTokens();
  await loadCalTokens();
  await loadWebhooks();
}

async function loadCalTokens() {
  try {
    const rows = await fetch('/api/calendar-tokens').then(r => r.json());
    const tbody = document.querySelector('#caltokens-table tbody');
    if (!Array.isArray(rows)) { tbody.innerHTML = ''; return; }
    tbody.innerHTML = rows.length ? rows.map(t => {
      const url = `${window.location.origin}/api/calendar/${t.token}.ics`;
      return `
        <tr data-token="${t.token}">
          <td><strong>${escapeHtml(t.label || '')}</strong></td>
          <td><input type="text" value="${url}" readonly style="width:100%;font-family:var(--mono);font-size:11px" onclick="this.select()"/></td>
          <td><span class="muted">${escapeHtml(t.last_used_at || 'never')}</span></td>
          <td class="row-actions"><button data-act="revoke-cal" class="danger">Revoke</button></td>
        </tr>
      `;
    }).join('') : '<tr><td colspan="4" class="muted" style="padding:12px;text-align:center">No calendar URLs yet.</td></tr>';
    tbody.querySelectorAll('button[data-act="revoke-cal"]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const tok = e.target.closest('tr').dataset.token;
        if (!await uiConfirm('Revoke this calendar URL?')) return;
        await fetch('/api/calendar-tokens/' + tok, { method: 'DELETE' });
        toast('Revoked', 'ok');
        await loadCalTokens();
      });
    });
  } catch (_) {}
}
document.getElementById('caltoken-add').addEventListener('click', async () => {
  const label = document.getElementById('caltoken-label').value.trim() || 'Calendar';
  try {
    await jsonReq('POST', '/api/calendar-tokens', { label });
    document.getElementById('caltoken-label').value = '';
    toast('Calendar URL created', 'ok');
    await loadCalTokens();
  } catch (err) { toast('Mint failed: ' + err.message, 'error'); }
});

async function loadWebhooks() {
  try {
    const data = await fetch('/api/webhooks').then(r => r.json());
    const rows = data.webhooks || [];
    const tbody = document.querySelector('#webhooks-table tbody');
    tbody.innerHTML = rows.length ? rows.map(w => `
      <tr data-id="${w.id}">
        <td><code style="font-size:11px">${escapeHtml(w.url)}</code></td>
        <td><span class="muted">${escapeHtml(w.events)}</span></td>
        <td>${w.active ? '✓' : '—'}</td>
        <td>${w.deliveries}</td>
        <td class="row-actions">
          <button data-act="test">Test</button>
          <button data-act="revoke-wh" class="danger">×</button>
        </td>
      </tr>
    `).join('') : '<tr><td colspan="5" class="muted" style="padding:12px;text-align:center">No webhooks configured.</td></tr>';
    tbody.querySelectorAll('button[data-act="test"]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = Number(e.target.closest('tr').dataset.id);
        try { await jsonReq('POST', '/api/webhooks/' + id + '/test', {}); toast('Test ping sent', 'ok'); }
        catch (err) { toast('Test failed: ' + err.message, 'error'); }
      });
    });
    tbody.querySelectorAll('button[data-act="revoke-wh"]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = Number(e.target.closest('tr').dataset.id);
        if (!await uiConfirm('Delete this webhook?')) return;
        await fetch('/api/webhooks/' + id, { method: 'DELETE' });
        await loadWebhooks();
      });
    });
  } catch (_) {}
}
document.getElementById('webhook-add').addEventListener('click', async () => {
  const url = document.getElementById('webhook-url').value.trim();
  const events = document.getElementById('webhook-events').value.trim() || '*';
  if (!url) { toast('URL required', 'warn'); return; }
  try {
    const r = await jsonReq('POST', '/api/webhooks', { url, events });
    document.getElementById('webhook-url').value = '';
    document.getElementById('webhook-events').value = '';
    await uiAlert(`Webhook added.\n\nSigning secret (save it):\n${r.secret}\n\nVerify each delivery via X-Carbon-Signature header (HMAC-SHA256).`);
    await loadWebhooks();
  } catch (err) { toast('Add failed: ' + err.message, 'error'); }
});

async function loadApiTokens() {
  try {
    const rows = await fetch('/api/tokens').then(r => r.json());
    const tbody = document.querySelector('#tokens-table tbody');
    if (!Array.isArray(rows)) { tbody.innerHTML = ''; return; }
    tbody.innerHTML = rows.length ? rows.map(t => `
      <tr data-id="${t.id}">
        <td><strong>${escapeHtml(t.label)}</strong></td>
        <td><span class="pill">${escapeHtml(t.scope)}</span></td>
        <td><span class="muted">${escapeHtml(t.last_used_at || 'never')}</span></td>
        <td><span class="muted">${escapeHtml(t.created_at)}</span></td>
        <td class="row-actions"><button data-act="revoke" class="danger">Revoke</button></td>
      </tr>
    `).join('') : '<tr><td colspan="5" class="muted" style="padding:12px;text-align:center">No tokens yet.</td></tr>';
    tbody.querySelectorAll('button[data-act="revoke"]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = Number(e.target.closest('tr').dataset.id);
        if (!await uiConfirm('Revoke this token? Scripts using it will stop working.')) return;
        await fetch('/api/tokens/' + id, { method: 'DELETE' });
        toast('Token revoked', 'ok');
        await loadApiTokens();
      });
    });
  } catch (_) {}
}

document.getElementById('token-new-add').addEventListener('click', async () => {
  const label = document.getElementById('token-new-label').value.trim();
  const scope = document.getElementById('token-new-scope').value;
  if (!label) { toast('Label required', 'warn'); return; }
  try {
    const r = await jsonReq('POST', '/api/tokens', { label, scope });
    document.getElementById('token-new-label').value = '';
    await navigator.clipboard.writeText(r.token).catch(() => {});
    await uiAlert(`Token created and copied to clipboard.\n\n${r.token}\n\nSave it now — it cannot be retrieved later.`);
    await loadApiTokens();
  } catch (err) { toast('Mint failed: ' + err.message, 'error'); }
});

// Contacts CSV bulk-import
document.getElementById('btn-contact-import').addEventListener('click', () => {
  document.getElementById('contact-import-file').click();
});
document.getElementById('contact-import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) { toast('Empty file', 'warn'); return; }
    const header = splitCsvLine(lines[0]).map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = splitCsvLine(lines[i]);
      if (cols.every(c => c === '')) continue;
      const row = {};
      header.forEach((k, idx) => row[k] = cols[idx]);
      rows.push(row);
    }
    if (!rows.length) { toast('No rows', 'warn'); return; }
    showCsvPreview(rows, 'contact rows', async () => {
      const r = await jsonReq('POST', '/api/contacts/bulk-import', { rows });
      toast(`Created ${r.created.length} contacts, ${r.errors.length} errors`, r.errors.length ? 'warn' : 'ok');
      if (r.errors.length) console.warn('Contact import errors:', r.errors);
      await loadContacts();
    });
  } catch (err) { toast('Import failed: ' + err.message, 'error'); }
  e.target.value = '';
});

function renderCredentials() {
  const tbody = document.querySelector('#credentials-table tbody');
  tbody.innerHTML = state.credentials.map(c => `
    <tr data-id="${c.id}">
      <td><strong>${escapeHtml(c.provider)}</strong></td>
      <td>${escapeHtml(c.label || '')}</td>
      <td>${[c.entity_code, c.bank_name && (c.bank_name + ' / ' + c.account_label)].filter(Boolean).map(escapeHtml).join(' · ') || '<span class="muted">—</span>'}</td>
      <td><span class="pill">${escapeHtml(c.environment)}</span></td>
      <td><code>${escapeHtml(c.client_id || '')}</code></td>
      <td><span class="status status-${c.status}">${c.status}</span></td>
      <td class="row-actions">
        <button data-act="edit">Edit</button>
        <button data-act="delete" class="danger">×</button>
      </td>
    </tr>
  `).join('');
  document.getElementById('credentials-empty').hidden = state.credentials.length > 0;
  tbody.querySelectorAll('button[data-act]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = Number(e.target.closest('tr').dataset.id);
      if (btn.dataset.act === 'edit') openCredentialDialog(id);
      if (btn.dataset.act === 'delete') {
        if (await uiConfirm('Delete this credential? Live sync will stop.')) {
          await api.deleteCredential(id);
          await loadCredentials();
        }
      }
    });
  });
}

async function openCredentialDialog(id) {
  state.credEditingId = id;
  credForm.reset();
  document.getElementById('cred-entity').innerHTML =
    '<option value="">—</option>' +
    state.entities.map(e => `<option value="${e.id}">${escapeHtml(e.code)}</option>`).join('');
  const accts = state.bankAccounts.length ? state.bankAccounts : await api.bankAccounts();
  state.bankAccounts = accts;
  document.getElementById('cred-account').innerHTML =
    '<option value="">— any —</option>' +
    accts.map(a => `<option value="${a.id}">${escapeHtml(a.bank_name)} / ${escapeHtml(a.account_label)}</option>`).join('');

  if (id) {
    const c = state.credentials.find(x => x.id === id);
    if (c) {
      for (const [k, v] of Object.entries(c)) {
        const el = credForm.elements[k];
        if (el && v != null) {
          // never put masked values back in password fields
          if ((k === 'client_secret' || k === 'api_key' || k === 'access_token' || k === 'refresh_token')
              && String(v).startsWith('••••')) continue;
          el.value = String(v);
        }
      }
    }
    document.getElementById('credential-form-title').textContent = 'Edit credential';
  } else {
    document.getElementById('credential-form-title').textContent = 'Add API credential';
    credForm.elements['environment'].value = 'sandbox';
  }
  credDlg.showModal();
}

async function saveCredential() {
  const data = {};
  for (const el of credForm.elements) {
    if (!el.name) continue;
    data[el.name] = el.value === '' ? null : el.value;
  }
  for (const k of ['entity_id', 'bank_account_id']) if (data[k]) data[k] = Number(data[k]);
  if (!data.provider) { toast('Provider required', 'warn'); return; }
  try {
    if (state.credEditingId) await api.updateCredential(state.credEditingId, data);
    else await api.createCredential(data);
  } catch (e) { toast('Save failed: ' + e.message, 'error'); return; }
  credDlg.close();
  await loadCredentials();
}

// --- Sync runs ---
async function loadSyncRuns() {
  const rows = await api.syncRuns();
  const tbody = document.querySelector('#sync-runs-table tbody');
  if (!rows.length) {
    tbody.innerHTML = '';
    document.getElementById('sync-empty').hidden = false;
    return;
  }
  document.getElementById('sync-empty').hidden = true;
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td><span class="muted">${escapeHtml(r.started_at)}</span></td>
      <td><strong>${escapeHtml(r.provider)}</strong></td>
      <td>${r.bank_name ? escapeHtml(r.bank_name + ' / ' + r.account_label) : '<span class="muted">—</span>'}</td>
      <td><span class="status status-${r.status === 'ok' ? 'paid' : r.status === 'error' ? 'rejected' : 'in_progress'}">${escapeHtml(r.status)}</span></td>
      <td class="num">${r.inserted}</td>
      <td class="num">${r.skipped}</td>
      <td>${r.error_message ? `<span class="date-expired">${escapeHtml(r.error_message)}</span>` : ''}</td>
    </tr>
  `).join('');
}

// --- Currencies sub-tab (FX rates + reporting currency) ---
async function loadCurrencies() {
  const [rates, current] = await Promise.all([api.fxRates(), api.getSetting('reporting_currency')]);
  const sel = document.getElementById('reporting-currency-select');
  sel.innerHTML = rates.map(r => `<option value="${r.currency}" ${r.currency === current.value ? 'selected' : ''}>${escapeHtml(r.currency)}</option>`).join('');
  sel.onchange = async () => {
    await api.setSetting('reporting_currency', sel.value);
    toast('Reporting currency: ' + sel.value, 'ok');
  };
  const tbody = document.querySelector('#fx-rates-table tbody');
  tbody.innerHTML = rates.map(r => `
    <tr data-ccy="${r.currency}">
      <td><strong>${escapeHtml(r.currency)}</strong></td>
      <td class="num"><input type="number" step="0.000001" value="${r.rate_to_usd}" data-field="rate_to_usd" style="width:130px;text-align:right" /></td>
      <td><input type="text" value="${escapeHtml(r.source || '')}" data-field="source" style="width:120px" /></td>
      <td><span class="muted">${escapeHtml(r.updated_at || '')}</span></td>
      <td class="row-actions">
        <button data-act="save-rate">Save</button>
        ${r.currency === 'USD' ? '' : '<button data-act="del-rate" class="danger">×</button>'}
      </td>
    </tr>
  `).join('');
  tbody.querySelectorAll('button[data-act="save-rate"]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const tr = e.target.closest('tr');
      const ccy = tr.dataset.ccy;
      const rate = Number(tr.querySelector('[data-field="rate_to_usd"]').value);
      const source = tr.querySelector('[data-field="source"]').value || 'manual';
      try { await api.putFxRate(ccy, { rate_to_usd: rate, source }); toast(`${ccy} rate updated`, 'ok'); await loadCurrencies(); }
      catch (err) { toast('Save failed: ' + err.message, 'error'); }
    });
  });
  tbody.querySelectorAll('button[data-act="del-rate"]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const ccy = e.target.closest('tr').dataset.ccy;
      if (!await uiConfirm(`Delete FX rate for ${ccy}?`)) return;
      await api.deleteFxRate(ccy); await loadCurrencies();
    });
  });
}

document.getElementById('btn-fx-refresh').addEventListener('click', async () => {
  const btn = document.getElementById('btn-fx-refresh');
  btn.disabled = true; btn.textContent = 'Fetching ECB…';
  try {
    const r = await jsonReq('POST', '/api/fx-rates/refresh', {});
    toast(`Refreshed ${r.updated.length} rates from ECB`, 'ok');
    await loadCurrencies();
  } catch (err) { toast('ECB refresh failed: ' + err.message, 'error'); }
  btn.disabled = false; btn.textContent = 'Refresh from ECB';
});

document.getElementById('btn-calendar-ics').addEventListener('click', () => {
  window.open('/api/calendar.ics', '_blank');
});

document.getElementById('fx-new-add').addEventListener('click', async () => {
  const code = document.getElementById('fx-new-code').value.toUpperCase().trim();
  const rate = Number(document.getElementById('fx-new-rate').value);
  if (!code || !rate) { toast('Code + rate required', 'warn'); return; }
  try {
    await api.putFxRate(code, { rate_to_usd: rate, source: 'manual' });
    document.getElementById('fx-new-code').value = '';
    document.getElementById('fx-new-rate').value = '';
    toast(`Added ${code}`, 'ok');
    await loadCurrencies();
  } catch (err) { toast('Add failed: ' + err.message, 'error'); }
});

// --- Auto-backup list + launchd + run-now ---
document.getElementById('btn-run-nightly').addEventListener('click', async () => {
  try {
    await jsonReq('POST', '/api/system/backup-now', {});
    toast('Nightly backup written', 'ok');
    await loadBackupList();
  } catch (err) { toast('Backup failed: ' + err.message, 'error'); }
});
document.getElementById('btn-launchd').addEventListener('click', () => {
  window.open('/api/system/launchd-plist', '_blank');
});

document.getElementById('btn-backup-encrypted')?.addEventListener('click', async () => {
  const passphrase = await uiPrompt('Passphrase for AES-256-GCM encryption (save this — without it the backup is unrecoverable):');
  if (!passphrase) return;
  if (passphrase.length < 8) { toast('Passphrase must be 8+ chars', 'warn'); return; }
  const confirmText = await uiPrompt('Re-type the passphrase to confirm:');
  if (confirmText !== passphrase) { toast('Passphrases do not match', 'error'); return; }
  window.location.href = '/api/backup?encrypt=1&passphrase=' + encodeURIComponent(passphrase);
  toast('Encrypted backup downloading. Keep your passphrase safe — no recovery without it.', 'ok');
});

async function loadBackupList() {
  const data = await fetch('/api/system/backups').then(r => r.json());
  const host = document.getElementById('backup-list');
  if (!data.files.length) { host.innerHTML = '<div class="muted" style="font-size:11px">No nightly backups yet.</div>'; return; }
  host.innerHTML = `
    <div class="muted" style="font-size:11px;margin-bottom:6px">Retaining last ${data.retention} backups in ${escapeHtml(data.dir.replace(/^.+\//, '…/'))}</div>
    <table style="font-size:12px"><thead><tr><th>File</th><th>Size</th><th>Created</th></tr></thead><tbody>
      ${data.files.slice(0, 10).map(f => `<tr><td><code>${escapeHtml(f.name)}</code></td><td>${(f.size/1024).toFixed(1)} KB</td><td><span class="muted">${escapeHtml(f.mtime)}</span></td></tr>`).join('')}
    </tbody></table>
  `;
}

// --- System info ---
async function loadSystemInfo() {
  const s = await api.system();
  const el = document.getElementById('system-info');
  const kb = b => (b / 1024).toFixed(1) + ' KB';
  const mb = b => (b / 1024 / 1024).toFixed(2) + ' MB';
  el.innerHTML = `
    <div class="dash-card"><h3>Database</h3>
      <div class="dash-row"><span>Size</span><span class="dash-amount">${mb(s.db_size_bytes)}</span></div>
      <div class="dash-row"><span>Path</span><span class="muted">${escapeHtml(s.db_path.replace(/^.+\//, '…/'))}</span></div>
    </div>
    <div class="dash-card"><h3>Attachments</h3>
      <div class="dash-row"><span>Files</span><span class="dash-amount">${s.attachments_count}</span></div>
      <div class="dash-row"><span>Total size</span><span class="dash-amount">${mb(s.attachments_size_bytes)}</span></div>
    </div>
    <div class="dash-card"><h3>Runtime</h3>
      <div class="dash-row"><span>Node</span><span class="dash-amount">${escapeHtml(s.node_version)}</span></div>
      <div class="dash-row"><span>Uptime</span><span class="dash-amount">${(s.uptime_seconds / 60).toFixed(1)} min</span></div>
      <div class="dash-row"><span>Last sync</span><span class="muted">${escapeHtml(s.last_sync || 'never')}</span></div>
    </div>
  `;
}

// --- Bank transaction edit ---
const btxDlg  = document.getElementById('bank-tx-dialog');
const btxForm = document.getElementById('bank-tx-form');

document.getElementById('bank-tx-cancel').addEventListener('click', () => btxDlg.close());
document.getElementById('bank-tx-save').addEventListener('click', saveBankTx);

function openBankTxDialog(id) {
  state.bankTxEditingId = id;
  btxForm.reset();
  const t = state.bankTransactions.find(x => x.id === id);
  if (!t) return;
  for (const [k, v] of Object.entries(t)) {
    const el = btxForm.elements[k];
    if (el && v != null) el.value = String(v);
  }
  btxDlg.showModal();
}

async function saveBankTx() {
  if (!state.bankTxEditingId) return;
  const data = {};
  for (const el of btxForm.elements) {
    if (!el.name) continue;
    data[el.name] = el.value === '' ? null : el.value;
  }
  data.amount = Number(data.amount);
  try { await api.updateBankTx(state.bankTxEditingId, data); }
  catch (e) { toast('Save failed: ' + e.message, 'error'); return; }
  btxDlg.close();
  await loadBankTransactions(state.bankCurrentAccountId);
}

// ---------- ledger tab ----------
// ---------- CSV export (client-side, from the exact figures on screen) ----------
function csvCell(v) { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function buildCSV(header, rows) { return [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n'); }
function downloadCSV(filename, header, rows) {
  const blob = new Blob([buildCSV(header, rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename.replace(/[^\w.-]+/g, '-');
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
if (typeof window !== 'undefined') window.__buildCSV = buildCSV; // smoke hook

// Prior comparable period for a given period mode (calendar-aligned). Pure → unit-tested.
function priorWindow(mode, now) {
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const Y = now.getFullYear(), M = now.getMonth(), D = now.getDate();
  if (mode === 'month')    { const s = new Date(Y, M - 1, 1); return { from: iso(s), to: iso(new Date(Y, M, 0)), label: 'prev month' }; }
  if (mode === 'quarter')  { const qs = Math.floor(M / 3) * 3; const s = new Date(Y, qs - 3, 1); return { from: iso(s), to: iso(new Date(s.getFullYear(), s.getMonth() + 3, 0)), label: 'prev quarter' }; }
  if (mode === 'ytd')      { return { from: iso(new Date(Y - 1, 0, 1)), to: iso(new Date(Y - 1, M, D)), label: 'prior YTD' }; }
  if (mode === 'lastyear') { return { from: iso(new Date(Y - 2, 0, 1)), to: iso(new Date(Y - 2, 11, 31)), label: String(Y - 2) }; }
  return null;
}
if (typeof window !== 'undefined') window.__priorWindow = (mode, isoNow) => priorWindow(mode, new Date(isoNow + 'T12:00:00'));

function renderLedgerAging(elId, data, peopleLabel) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!data || !data.buckets || !(data.total > 0)) { el.innerHTML = '<div class="muted dash-empty">Nothing outstanding.</div>'; return; }
  const fmt = n => (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const b = data.buckets;
  const buckets = [['Current', 'current'], ['1–30 days', 'd1_30'], ['31–60 days', 'd31_60'], ['61–90 days', 'd61_90'], ['90+ days', 'd90_plus']]
    .map(([lbl, k]) => `<tr><td>${lbl}</td><td class="num">${fmt(b[k])}</td></tr>`).join('');
  const top = (data.contacts || []).slice(0, 4).map(c => `<tr><td class="muted">${escapeHtml(c.name)}</td><td class="num">${fmt(c.total)}</td></tr>`).join('');
  el.innerHTML = `<table><tbody>${buckets}<tr style="border-top:2px solid var(--border)"><td><strong>Total outstanding</strong></td><td class="num"><strong>${fmt(b.total)}</strong></td></tr></tbody></table>`
    + (top ? `<div class="muted" style="font-size:11px;margin:10px 0 4px">By ${peopleLabel}</div><table><tbody>${top}</tbody></table>` : '');
}

function renderGroup(data) {
  const el = document.getElementById('ledger-group');
  if (!el) return;
  if (!data || data.__error) { el.innerHTML = '<div class="muted dash-empty">Couldn\'t load group overview.</div>'; return; }
  if (!data.rows || !data.rows.length) { el.innerHTML = '<div class="muted dash-empty">No entities.</div>'; return; }
  const fmt = n => n == null ? '—' : (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  el.innerHTML = `<table><thead><tr><th>Entity</th><th class="num">Net profit</th><th class="num">Cash</th><th class="num">Net (USD)</th><th class="num">Cash (USD)</th></tr></thead><tbody>`
    + data.rows.map(r => `<tr><td>${escapeHtml(r.code)} <span class="muted">${escapeHtml(r.base_currency || '')}</span></td><td class="num">${fmt(r.net)}</td><td class="num">${fmt(r.cash)}</td><td class="num">${fmt(r.net_usd)}</td><td class="num">${fmt(r.cash_usd)}</td></tr>`).join('')
    + `<tr style="border-top:2px solid var(--border)"><td><strong>Group (USD)</strong></td><td></td><td></td><td class="num"><strong>${fmt(data.group.net_usd)}</strong></td><td class="num"><strong>${fmt(data.group.cash_usd)}</strong></td></tr></tbody></table>`
    + (data.group.fx_missing ? '<div class="muted" style="font-size:11px;margin-top:6px">Some currencies have no USD rate — group total excludes them.</div>' : '');
}

function renderCashflow(elId, data) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!data || data.__error) { el.innerHTML = '<div class="muted dash-empty">Couldn\'t load cash flow.</div>'; return; }
  if (!data.accounts || !data.accounts.length) { el.innerHTML = '<div class="muted dash-empty">No cash accounts with activity.</div>'; return; }
  const fmt = n => (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const t = data.total;
  el.innerHTML = `<div class="muted" style="font-size:12px;margin-bottom:8px">${data.from ? data.from + ' → ' + data.to : 'All time'}</div>`
    + `<table><thead><tr><th>Account</th><th class="num">Opening</th><th class="num">Cash in</th><th class="num">Cash out</th><th class="num">Closing</th></tr></thead><tbody>`
    + data.accounts.map(a => `<tr><td>${escapeHtml(a.code)} <span class="muted">${escapeHtml(a.name || '')}</span></td><td class="num">${fmt(a.opening)}</td><td class="num">${fmt(a.cash_in)}</td><td class="num">${fmt(a.cash_out)}</td><td class="num">${fmt(a.closing)}</td></tr>`).join('')
    + `<tr style="border-top:2px solid var(--border)"><td><strong>Total</strong></td><td class="num"><strong>${fmt(t.opening)}</strong></td><td class="num"><strong>${fmt(t.cash_in)}</strong></td><td class="num"><strong>${fmt(t.cash_out)}</strong></td><td class="num"><strong>${fmt(t.closing)}</strong></td></tr></tbody></table>`
    + `<div style="font-size:12px;margin-top:6px">Net change <strong>${fmt(t.net_change)}</strong></div>`;
}

async function loadLedger() {
  const sel = document.getElementById('ledger-entity');
  if (sel && !sel.options.length) {
    sel.innerHTML = (state.entities || []).map(e => `<option value="${e.id}">${escapeHtml(e.code)} — ${escapeHtml(e.legal_name)}</option>`).join('');
    sel.addEventListener('change', loadLedger);
  }
  wireJournalDialog();
  const eid = sel && sel.value ? sel.value : ((state.entities || [])[0] || {}).id;
  const trialEl = document.getElementById('ledger-trial');
  const jrnlEl = document.getElementById('ledger-journal');
  const badge = document.getElementById('ledger-balance-badge');
  if (!eid) { if (trialEl) trialEl.innerHTML = '<div class="muted dash-empty">No entities yet.</div>'; return; }
  const fmt = n => (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const CAT = { A: 'Assets', L: 'Liabilities', Eq: 'Equity', I: 'Income', E: 'Expenses' };

  // period selector → from/to date window (balance sheet is "as of" the `to` date)
  const per = document.getElementById('ledger-period');
  if (per && !per._wired) { per._wired = true; per.addEventListener('change', loadLedger); }
  const mgmtBtn = document.getElementById('btn-manage-accounts');
  if (mgmtBtn && !mgmtBtn._wired) { mgmtBtn._wired = true; mgmtBtn.addEventListener('click', openAccountsDialog); }
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const now = new Date(); let from = null, to = null;
  switch (per && per.value) {
    case 'month':    from = iso(new Date(now.getFullYear(), now.getMonth(), 1)); to = iso(now); break;
    case 'quarter':  from = iso(new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1)); to = iso(now); break;
    case 'ytd':      from = iso(new Date(now.getFullYear(), 0, 1)); to = iso(now); break;
    case 'lastyear': from = iso(new Date(now.getFullYear() - 1, 0, 1)); to = iso(new Date(now.getFullYear() - 1, 11, 31)); break;
  }
  const plPeriodLabel = from ? `${from} → ${to}` : 'All time';
  const bsAsOfLabel = to || 'today';
  const prior = priorWindow(per && per.value, now); // null for "All time"

  const agingP = api.ledgerAging(eid, to || iso(now)).catch(() => ({ __error: true })); // isolated: aging failure won't blank the statements
  const cashflowP = api.cashflow(eid, from, to).catch(() => ({ __error: true }));
  const groupP = api.ledgerGroup(from, to).catch(() => ({ __error: true })); // cross-entity, ignores the entity selector
  const fetches = [api.ledgerTrialBalance(eid, to), api.ledgerEntries(eid, from, to), api.ledgerStatements(eid, from, to)];
  if (prior) fetches.push(api.ledgerStatements(eid, prior.from, prior.to));
  const [tb, entries, st, stPrior] = await Promise.all(fetches);

  if (badge) badge.innerHTML = tb.balanced
    ? '<span style="color:var(--accent-2);font-weight:600">✓ balanced</span>'
    : '<span style="color:var(--danger);font-weight:600">✗ out of balance</span>';

  // each per-account row is clickable → drill into its entries over the figure's own window
  const dataAttrs = (code, name, cat, since, until) => `data-acct="${escapeHtml(code)}" data-name="${escapeHtml(name || '')}" data-cat="${cat || ''}"${since ? ` data-since="${since}"` : ''}${until ? ` data-until="${until}"` : ''}`;

  // P&L (income statement) — flows over [from, to]; vs prior period when one is selected
  const plEl = document.getElementById('ledger-pl');
  const plHead = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><span class="muted" style="font-size:12px">${plPeriodLabel}</span><button data-export="pl" style="font-size:11px;padding:4px 10px">Export CSV</button></div>`;
  if (plEl && stPrior) {
    const cur = new Map(st.pl.rows.map(r => [r.code, r])), pri = new Map(stPrior.pl.rows.map(r => [r.code, r]));
    const codes = [...new Set([...cur.keys(), ...pri.keys()])];
    const cell = (m, c) => m.get(c) ? fmt(m.get(c).amount) : '—';
    plEl.innerHTML = plHead
      + `<table><thead><tr><th>Account</th><th class="num">Current</th><th class="num">${escapeHtml(prior.label)}</th></tr></thead><tbody>`
      + (codes.length ? codes.map(c => { const r = cur.get(c) || pri.get(c); return `<tr class="acct-row" ${dataAttrs(c, r.name, r.category, from, to)}><td>${escapeHtml(r.name || c)} <span class="muted">${r.category === 'I' ? 'income' : 'expense'}</span></td><td class="num">${cell(cur, c)}</td><td class="num muted">${cell(pri, c)}</td></tr>`; }).join('') : '<tr><td class="muted">No income or expenses.</td><td></td><td></td></tr>')
      + `<tr style="border-top:1px solid var(--border)"><td>Income</td><td class="num">${fmt(st.pl.income)}</td><td class="num muted">${fmt(stPrior.pl.income)}</td></tr>`
      + `<tr><td>Expenses</td><td class="num">(${fmt(st.pl.expenses)})</td><td class="num muted">(${fmt(stPrior.pl.expenses)})</td></tr>`
      + `<tr style="border-top:2px solid var(--border)"><td><strong>Net ${st.pl.net >= 0 ? 'profit' : 'loss'}</strong></td><td class="num"><strong>${fmt(st.pl.net)}</strong></td><td class="num muted">${fmt(stPrior.pl.net)}</td></tr></tbody></table>`;
  } else if (plEl) {
    plEl.innerHTML = plHead + `<table><tbody>`
      + (st.pl.rows.length ? st.pl.rows.map(r => `<tr class="acct-row" ${dataAttrs(r.code, r.name, r.category, from, to)}><td>${escapeHtml(r.name || r.code)} <span class="muted">${r.category === 'I' ? 'income' : 'expense'}</span></td><td class="num">${fmt(r.amount)}</td></tr>`).join('') : '<tr><td class="muted">No income or expenses yet.</td><td></td></tr>')
      + `<tr style="border-top:1px solid var(--border)"><td>Income</td><td class="num">${fmt(st.pl.income)}</td></tr>`
      + `<tr><td>Expenses</td><td class="num">(${fmt(st.pl.expenses)})</td></tr>`
      + `<tr style="border-top:2px solid var(--border)"><td><strong>Net ${st.pl.net >= 0 ? 'profit' : 'loss'}</strong></td><td class="num"><strong>${fmt(st.pl.net)}</strong></td></tr></tbody></table>`;
  }

  // Balance sheet
  const bsEl = document.getElementById('ledger-bs');
  const section = (label, cat, total) => `<tr><td><strong>${label}</strong></td><td class="num"><strong>${fmt(total)}</strong></td></tr>`
    + st.bs.rows.filter(r => r.category === cat).map(r => `<tr class="acct-row" ${dataAttrs(r.code, r.name, r.category, null, to)}><td class="muted">${escapeHtml(r.name)}</td><td class="num">${fmt(r.amount)}</td></tr>`).join('');
  if (bsEl) bsEl.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><span class="muted" style="font-size:12px">As of ${bsAsOfLabel}</span><button data-export="bs" style="font-size:11px;padding:4px 10px">Export CSV</button></div><table><tbody>`
    + section('Assets', 'A', st.bs.assets)
    + section('Liabilities', 'L', st.bs.liabilities)
    + section('Equity', 'Eq', st.bs.equity)
    + `<tr><td class="muted">Net income (retained)</td><td class="num">${fmt(st.bs.netIncome)}</td></tr>`
    + `<tr style="border-top:2px solid var(--border)"><td>Liabilities + Equity + Net</td><td class="num">${fmt(st.bs.liabilities + st.bs.equity + st.bs.netIncome)}</td></tr></tbody></table>`
    + (st.bs.balanced ? '<div style="color:var(--accent-2);font-size:12px;margin-top:6px">✓ Assets = Liabilities + Equity</div>' : '<div style="color:var(--danger);font-size:12px;margin-top:6px">✗ does not balance</div>');

  // AR / AP aging (outstanding invoices as of the period end date)
  const ag = await agingP;
  if (ag && ag.__error) {
    const msg = '<div class="muted dash-empty">Couldn\'t load aging.</div>';
    const arEl = document.getElementById('ledger-ar-aging'), apEl = document.getElementById('ledger-ap-aging');
    if (arEl) arEl.innerHTML = msg; if (apEl) apEl.innerHTML = msg;
  } else {
    renderLedgerAging('ledger-ar-aging', ag && ag.ar, 'customer');
    renderLedgerAging('ledger-ap-aging', ag && ag.ap, 'supplier');
  }
  renderCashflow('ledger-cashflow', await cashflowP);
  renderGroup(await groupP);

  if (!tb.rows.length) {
    trialEl.innerHTML = '<div class="muted dash-empty">No postings yet — issue an invoice and it appears here.</div>';
  } else {
    trialEl.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><span class="muted" style="font-size:12px">As of ${bsAsOfLabel}</span><button data-export="trial" style="font-size:11px;padding:4px 10px">Export CSV</button></div><table><thead><tr><th>Code</th><th>Account</th><th>Type</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead><tbody>`
      + tb.rows.map(r => `<tr class="acct-row" ${dataAttrs(r.account_code, r.account_name, r.category, null, to)}><td>${escapeHtml(r.account_code)}</td><td>${escapeHtml(r.account_name || '')}</td><td class="muted">${escapeHtml(CAT[r.category] || '')}</td><td class="num">${r.debit ? fmt(r.debit) : ''}</td><td class="num">${r.credit ? fmt(r.credit) : ''}</td></tr>`).join('')
      + `<tr style="border-top:2px solid var(--border)"><td colspan="3"><strong>Totals</strong></td><td class="num"><strong>${fmt(tb.totalDebit)}</strong></td><td class="num"><strong>${fmt(tb.totalCredit)}</strong></td></tr></tbody></table>`;
  }

  if (!entries.length) {
    jrnlEl.innerHTML = from ? '<div class="muted dash-empty">No entries in this period.</div>' : '<div class="muted dash-empty">No journal entries.</div>';
  } else {
    jrnlEl.innerHTML = (from ? `<div class="muted" style="font-size:12px;margin-bottom:8px">${plPeriodLabel}</div>` : '')
      + `<table><thead><tr><th>Date</th><th>Account</th><th>Description</th><th class="num">Debit</th><th class="num">Credit</th><th></th></tr></thead><tbody>`
      + entries.map(e => { const man = e.source_table === 'manual'; return `<tr><td>${escapeHtml(e.event_date || '')}</td><td>${escapeHtml(e.account_code)} <span class="muted">${escapeHtml(e.account_name || '')}</span></td><td>${escapeHtml(e.description || '')}</td><td class="num">${e.direction === 'debit' ? fmt(e.amount) : ''}</td><td class="num">${e.direction === 'credit' ? fmt(e.amount) : ''}</td><td class="row-actions">${man ? `<button data-je="${escapeHtml(e.txn_id)}" class="danger" title="Delete this manual entry">×</button>` : ''}</td></tr>`; }).join('')
      + `</tbody></table>`;
    jrnlEl.querySelectorAll('button[data-je]').forEach(b => b.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!await uiConfirm('Delete this manual journal entry?')) return;
      try { await api.deleteJournal(b.dataset.je); toast('Entry deleted', 'ok'); loadLedger(); } catch (e) { toast(e.message, 'error'); }
    }));
  }

  // drill-down: click any account row → its entries with a running balance
  document.querySelectorAll('#tab-ledger tr.acct-row').forEach(tr => tr.addEventListener('click', () => {
    const d = tr.dataset;
    openAccountDialog(eid, d.acct, d.name, d.cat, d.since || null, d.until || null);
  }));

  // CSV export buttons — built from the exact figures rendered above
  const stamp = `${eid}-${from || 'all'}-${to || iso(now)}`;
  const SEC = { A: 'Assets', L: 'Liabilities', Eq: 'Equity' };
  const exporters = {
    pl: () => downloadCSV(`carbon-pl-${stamp}.csv`, ['Account', 'Type', 'Amount'],
      st.pl.rows.map(r => [r.name || r.code, r.category === 'I' ? 'Income' : 'Expense', r.amount])
        .concat([['Income', '', st.pl.income], ['Expenses', '', st.pl.expenses], ['Net', '', st.pl.net]])),
    bs: () => downloadCSV(`carbon-balance-sheet-${eid}-${to || iso(now)}.csv`, ['Account', 'Section', 'Amount'],
      st.bs.rows.map(r => [r.name, SEC[r.category] || '', r.amount])
        .concat([['Net income (retained)', 'Equity', st.bs.netIncome], ['Assets total', '', st.bs.assets], ['Liabilities total', '', st.bs.liabilities], ['Equity total', '', st.bs.equity]])),
    trial: () => downloadCSV(`carbon-trial-balance-${eid}.csv`, ['Code', 'Account', 'Type', 'Debit', 'Credit'],
      tb.rows.map(r => [r.account_code, r.account_name || '', CAT[r.category] || '', r.debit || 0, r.credit || 0])
        .concat([['', 'Totals', '', tb.totalDebit, tb.totalCredit]])),
  };
  document.querySelectorAll('#tab-ledger [data-export]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); (exporters[b.dataset.export] || (() => {}))(); }));
}

// ---------- account drill-down dialog ----------
let _adWired = false, _adExport = null;
async function openAccountDialog(eid, code, name, category, from, to) {
  const dlg = document.getElementById('account-dialog');
  if (!dlg) return;
  if (!_adWired) {
    _adWired = true;
    document.getElementById('ad-close').addEventListener('click', () => dlg.close());
    document.getElementById('ad-export').addEventListener('click', () => { if (_adExport) _adExport(); });
  }
  document.getElementById('ad-title').textContent = `${code} — ${name || ''}`;
  document.getElementById('ad-period').textContent = from ? `${from} → ${to}` : (to ? `As of ${to}` : 'All time');
  const body = document.getElementById('ad-body');
  body.innerHTML = '<div class="muted dash-empty">Loading…</div>';
  if (typeof dlg.showModal === 'function' && !dlg.open) dlg.showModal();
  let rows = [];
  try { rows = await api.ledgerAccount(eid, code, from, to); }
  catch (e) { body.innerHTML = `<div class="muted">${escapeHtml(e.message || 'Failed to load')}</div>`; return; }
  const fmt = n => (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const debitNormal = category === 'A' || category === 'E';
  rows = rows.slice().reverse(); // API returns newest-first → oldest-first for a running balance
  let bal = 0; const csvRows = [];
  const trs = rows.map(e => {
    const amt = Number(e.amount_base) || 0;
    bal += (e.direction === 'debit' ? amt : -amt) * (debitNormal ? 1 : -1);
    csvRows.push([e.event_date || '', e.description || '', e.direction === 'debit' ? amt : '', e.direction === 'credit' ? amt : '', bal]);
    return `<tr><td>${escapeHtml(e.event_date || '')}</td><td>${escapeHtml(e.description || '')}</td><td class="num">${e.direction === 'debit' ? fmt(amt) : ''}</td><td class="num">${e.direction === 'credit' ? fmt(amt) : ''}</td><td class="num">${fmt(bal)}</td></tr>`;
  }).join('');
  body.innerHTML = rows.length
    ? `<table class="line-table"><thead><tr><th>Date</th><th>Description</th><th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th></tr></thead><tbody>${trs}</tbody></table>`
    : '<div class="muted dash-empty">No entries in this period.</div>';
  _adExport = rows.length ? () => downloadCSV(`carbon-account-${code}-${from || 'all'}-${to || 'all'}.csv`, ['Date', 'Description', 'Debit', 'Credit', 'Balance'], csvRows) : null;
  document.getElementById('ad-export').style.display = rows.length ? '' : 'none';
}

// ---------- chart of accounts management ----------
const ACC_CAT = { A: 'Asset', L: 'Liability', Eq: 'Equity', I: 'Income', E: 'Expense' };
let _accWired = false;
async function openAccountsDialog() {
  const sel = document.getElementById('ledger-entity');
  if (!sel || !sel.value) { toast('Pick an entity first', 'warn'); return; }
  const dlg = document.getElementById('accounts-dialog');
  if (!_accWired) {
    _accWired = true;
    document.getElementById('acc-close').addEventListener('click', () => dlg.close());
    document.getElementById('acc-add').addEventListener('click', addAccount);
  }
  if (typeof dlg.showModal === 'function' && !dlg.open) dlg.showModal();
  await renderAccountsList();
}
async function renderAccountsList() {
  const eid = document.getElementById('ledger-entity').value;
  const list = document.getElementById('acc-list');
  list.innerHTML = '<div class="muted dash-empty">Loading…</div>';
  let accts = [];
  try { accts = await api.ledgerAccounts(eid); } catch (e) { list.innerHTML = `<div class="muted">${escapeHtml(e.message)}</div>`; return; }
  const byCode = new Map(accts.map(a => [a.code, a]));
  list.innerHTML = `<table class="line-table"><thead><tr><th>Code</th><th>Name</th><th>Type</th><th></th></tr></thead><tbody>`
    + accts.map(a => `<tr>
        <td>${escapeHtml(a.code)}</td>
        <td><input class="acc-name" data-code="${escapeHtml(a.code)}" value="${escapeHtml(a.name)}" style="width:100%"></td>
        <td class="muted">${ACC_CAT[a.category] || a.category}</td>
        <td class="row-actions"><button class="acc-del danger" data-code="${escapeHtml(a.code)}" title="Archive or delete">×</button></td>
      </tr>`).join('')
    + `</tbody></table>`;
  list.querySelectorAll('.acc-name').forEach(inp => {
    const save = async () => {
      const code = inp.dataset.code, name = inp.value.trim();
      if (!name || name === byCode.get(code)?.name) return;
      try { await api.updateAccount(eid, code, { name }); toast('Renamed', 'ok'); byCode.get(code).name = name; }
      catch (e) { toast(e.message, 'error'); renderAccountsList(); }
    };
    inp.addEventListener('blur', save);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
  });
  list.querySelectorAll('.acc-del').forEach(btn => btn.addEventListener('click', async () => {
    const code = btn.dataset.code;
    try { await api.deleteAccount(eid, code); toast('Account deleted', 'ok'); renderAccountsList(); }
    catch (e) {
      if (/postings/.test(e.message)) {
        if (await uiConfirm(`${code} has postings, so it can't be deleted. Hide it from pickers (kept in history)?`)) {
          try { await api.updateAccount(eid, code, { archived: 1 }); toast('Account archived', 'ok'); renderAccountsList(); }
          catch (e2) { toast(e2.message, 'error'); }
        }
      } else { toast(e.message, 'error'); }
    }
  }));
}
async function addAccount() {
  const eid = document.getElementById('ledger-entity').value;
  const body = {
    entity_id: Number(eid),
    code: document.getElementById('acc-new-code').value.trim(),
    name: document.getElementById('acc-new-name').value.trim(),
    category: document.getElementById('acc-new-cat').value,
  };
  try {
    await api.createAccount(body);
    document.getElementById('acc-new-code').value = '';
    document.getElementById('acc-new-name').value = '';
    toast('Account added', 'ok');
    renderAccountsList();
  } catch (e) { toast(e.message, 'error'); }
}

// ---------- manual journal entry dialog ----------
let _jeWired = false;
function jeOptions() { return '<option value="">— account —</option>' + (window._jeAccts || []).map(a => `<option value="${a.code}">${escapeHtml(a.code)} — ${escapeHtml(a.name)}</option>`).join(''); }
function addJeLine() {
  const tbody = document.querySelector('#je-lines tbody');
  const tr = document.createElement('tr');
  tr.innerHTML = `<td><select class="je-acct">${jeOptions()}</select></td>
    <td class="num"><input type="number" step="0.01" min="0" class="je-debit" style="width:110px"></td>
    <td class="num"><input type="number" step="0.01" min="0" class="je-credit" style="width:110px"></td>
    <td><button type="button" class="je-rm danger">×</button></td>`;
  tbody.appendChild(tr);
  tr.querySelector('.je-rm').addEventListener('click', () => { tr.remove(); updateJeBalance(); });
  tr.querySelector('.je-debit').addEventListener('input', (e) => { if (e.target.value) tr.querySelector('.je-credit').value = ''; updateJeBalance(); });
  tr.querySelector('.je-credit').addEventListener('input', (e) => { if (e.target.value) tr.querySelector('.je-debit').value = ''; updateJeBalance(); });
}
function updateJeBalance() {
  let d = 0, c = 0;
  document.querySelectorAll('#je-lines tbody tr').forEach(tr => { d += Number(tr.querySelector('.je-debit').value) || 0; c += Number(tr.querySelector('.je-credit').value) || 0; });
  const diff = Math.round((d - c) * 100) / 100;
  const el = document.getElementById('je-balance'), save = document.getElementById('je-save');
  if (diff === 0 && d > 0) { el.innerHTML = `<span style="color:var(--accent-2);font-weight:600">✓ balanced — ${d.toFixed(2)}</span>`; save.disabled = false; }
  else { el.innerHTML = `<span style="color:var(--danger)">Debits ${d.toFixed(2)} vs credits ${c.toFixed(2)} — off by ${Math.abs(diff).toFixed(2)}</span>`; save.disabled = true; }
}
function openJournalDialog() {
  const sel = document.getElementById('ledger-entity');
  if (!sel || !sel.value) { toast('Pick an entity first', 'warn'); return; }
  document.getElementById('je-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('je-desc').value = '';
  document.querySelector('#je-lines tbody').innerHTML = '';
  api.ledgerAccounts(sel.value).then(accts => {
    window._jeAccts = accts;
    addJeLine(); addJeLine();
    updateJeBalance();
    document.getElementById('journal-dialog').showModal();
  });
}
async function saveJournal() {
  const sel = document.getElementById('ledger-entity');
  const lines = [];
  document.querySelectorAll('#je-lines tbody tr').forEach(tr => {
    const code = tr.querySelector('.je-acct').value;
    const deb = Number(tr.querySelector('.je-debit').value) || 0;
    const cr = Number(tr.querySelector('.je-credit').value) || 0;
    if (code && (deb > 0 || cr > 0)) lines.push({ account_code: code, direction: deb > 0 ? 'debit' : 'credit', amount: deb > 0 ? deb : cr });
  });
  const saveBtn = document.getElementById('je-save');
  if (saveBtn) saveBtn.disabled = true; // guard against double-click double-posting
  try {
    await api.postJournal({ entity_id: Number(sel.value), event_date: document.getElementById('je-date').value, description: document.getElementById('je-desc').value, lines });
    document.getElementById('journal-dialog').close();
    toast('Journal entry posted', 'ok');
    loadLedger();
  } catch (e) { toast(e.message, 'error'); if (saveBtn) saveBtn.disabled = false; }
}
function wireJournalDialog() {
  if (_jeWired) return; _jeWired = true;
  document.getElementById('btn-new-journal')?.addEventListener('click', openJournalDialog);
  document.getElementById('je-add-line')?.addEventListener('click', addJeLine);
  document.getElementById('je-cancel')?.addEventListener('click', () => document.getElementById('journal-dialog').close());
  document.getElementById('je-save')?.addEventListener('click', saveJournal);
}

// ---------- audit tab ----------
async function loadAudit() {
  // populate facets once
  const facetTable = document.getElementById('audit-filter-table');
  if (facetTable && facetTable.options.length <= 1) {
    const f = await fetch('/api/audit/facets').then(r => r.json());
    facetTable.innerHTML  = '<option value="">All tables</option>'  + f.tables.map(t  => `<option>${escapeHtml(t)}</option>`).join('');
    document.getElementById('audit-filter-action').innerHTML = '<option value="">All actions</option>' + f.actions.map(a => `<option>${escapeHtml(a)}</option>`).join('');
    document.getElementById('audit-filter-actor').innerHTML  = '<option value="">All actors</option>'  + f.actors.map(a  => `<option>${escapeHtml(a)}</option>`).join('');
  }
  const params = new URLSearchParams();
  const t  = document.getElementById('audit-filter-table').value;
  const a  = document.getElementById('audit-filter-action').value;
  const ac = document.getElementById('audit-filter-actor').value;
  const s  = document.getElementById('audit-filter-since').value;
  const u  = document.getElementById('audit-filter-until').value;
  if (t)  params.set('table', t);
  if (a)  params.set('action', a);
  if (ac) params.set('actor', ac);
  if (s)  params.set('since', s);
  if (u)  params.set('until', u);
  const rows = await fetch('/api/audit?' + params).then(r => r.json());
  const list = document.getElementById('audit-list');
  const pane = document.getElementById('audit-detail-pane');
  if (!rows.length) {
    list.innerHTML = '<div class="muted" style="padding:24px;text-align:center">No audit events.</div>';
    pane.innerHTML = '<div class="dp-placeholder muted">No event selected.</div>';
    return;
  }
  let html = '', lastDay = '';
  rows.forEach((r, i) => {
    const day = (r.ts || '').slice(0, 10);
    if (day !== lastDay) { html += `<div class="audit-day">${escapeHtml(auditDayLabel(day))}</div>`; lastDay = day; }
    html += `
      <button class="al-row ${auditActionClass(r.action)}" data-i="${i}">
        <span class="audit-dot"></span>
        <span class="al-line">${auditSentence(r)}</span>
        <span class="al-meta">${escapeHtml(r.actor || 'system')} · ${escapeHtml(auditRelTime(r.ts))}</span>
      </button>`;
  });
  list.innerHTML = html;

  const selectRow = (i) => {
    list.querySelectorAll('.al-row').forEach(el => el.classList.toggle('selected', el.dataset.i === String(i)));
    pane.innerHTML = renderAuditDetail(rows[i]);
    pane.scrollTop = 0;
    const ob = pane.querySelector('.dp-open');
    if (ob) ob.addEventListener('click', () => {
      const tab = ob.dataset.drillTab, nid = Number(ob.dataset.drillId);
      document.querySelector(`.tab[data-tab="${tab}"]`)?.click();
      setTimeout(() => {
        if (tab === 'contacts') openContactDialog(nid);
        else if (tab === 'invoices') openInvoiceDialog(nid);
        else if (tab === 'contracts') openContractDialog(nid);
        else if (tab === 'kyc') openKycDialog(nid);
      }, 120);
    });
  };
  list.querySelectorAll('.al-row').forEach(el => el.addEventListener('click', () => selectRow(Number(el.dataset.i))));
  selectRow(0);
}

function auditFmtVal(v) {
  if (v == null || v === '') return '<span class="dp-dim">—</span>';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return escapeHtml(s);
}

function renderAuditDetail(row) {
  const before = _auditParse(row.before_json) || {};
  const after  = _auditParse(row.after_json)  || {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const cls = auditActionClass(row.action);
  const drillable = { contacts: 'contacts', invoices: 'invoices', contracts: 'contracts', kyc_records: 'kyc' };
  const tab = drillable[row.table_name];
  const openBtn = (tab && row.row_id) ? `<button class="dp-open" data-drill-tab="${tab}" data-drill-id="${row.row_id}">Open ↗</button>` : '';
  const kvRow = (k, val, extra = '') => `<div class="kv ${extra}"><span class="k">${escapeHtml(k)}</span><span class="v">${val}</span></div>`;

  let html = `<div class="dp-head"><span class="audit-dot ${cls}"></span>
    <div class="dp-head-main"><div class="dp-title">${auditSentence(row)}</div>
    <div class="dp-sub">${escapeHtml(auditHumanTable(row.table_name))} · ${escapeHtml(row.actor || 'system')} · ${escapeHtml((row.ts || '').slice(0, 16))}</div></div>
    ${openBtn}</div>`;

  if (row.action === 'update') {
    const changed = keys.filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    const rest = keys.filter(k => !changed.includes(k));
    if (changed.length) {
      html += `<div class="dp-banner upd">${changed.length} field${changed.length > 1 ? 's' : ''} changed</div>`;
      html += `<div class="dp-section-label">Changes</div><div class="kv-list">`;
      html += changed.map(k => kvRow(k, `<span class="dp-was">${auditFmtVal(before[k])}</span><span class="dp-arrow">→</span><span class="dp-now">${auditFmtVal(after[k])}</span>`, 'changed')).join('');
      html += `</div>`;
    } else {
      html += `<div class="dp-empty-detail muted">No fields changed.</div>`;
    }
    if (rest.length) html += `<details class="dp-more"><summary>${rest.length} unchanged field${rest.length > 1 ? 's' : ''}</summary><div class="kv-list">` + rest.map(k => kvRow(k, auditFmtVal(after[k]), 'dimrow')).join('') + `</div></details>`;
  } else if (['insert', 'create', 'delete', 'setup'].includes(row.action)) {
    const rec = row.action === 'delete' ? before : after;
    const recKeys = Object.keys(rec);
    const nonNull = recKeys.filter(k => rec[k] != null && rec[k] !== '');
    const nulls = recKeys.filter(k => !(rec[k] != null && rec[k] !== ''));
    const bcls = row.action === 'delete' ? 'del' : 'ins';
    const verb = row.action === 'delete' ? 'Record deleted' : 'Record created';
    if (recKeys.length) {
      html += `<div class="dp-banner ${bcls}">${verb} · ${recKeys.length} fields</div>`;
      html += `<div class="dp-section-label">Fields</div><div class="kv-list">` + (nonNull.length ? nonNull : recKeys).map(k => kvRow(k, auditFmtVal(rec[k]))).join('') + `</div>`;
      if (nonNull.length && nulls.length) html += `<details class="dp-more"><summary>${nulls.length} empty field${nulls.length > 1 ? 's' : ''}</summary><div class="kv-list">` + nulls.map(k => kvRow(k, auditFmtVal(rec[k]), 'dimrow')).join('') + `</div></details>`;
    } else {
      html += `<div class="dp-empty-detail muted">No field payload recorded.</div>`;
    }
  } else {
    const rec = Object.keys(after).length ? after : before;
    const recKeys = Object.keys(rec);
    if (recKeys.length) {
      html += `<div class="dp-section-label">Details</div><div class="kv-list">` + recKeys.map(k => kvRow(k, auditFmtVal(rec[k]))).join('') + `</div>`;
    } else {
      html += `<div class="dp-empty-detail muted">No additional detail for this event.</div>`;
    }
  }
  return html;
}

function auditActionClass(action) {
  if (['insert', 'create', 'setup', 'bulk-import'].includes(action)) return 'act-create';
  if (['update', 'password-change'].includes(action)) return 'act-update';
  if (action === 'delete') return 'act-delete';
  if (['login', 'logout'].includes(action)) return 'act-auth';
  if (action === 'login-failed') return 'act-fail';
  return 'act-other';
}
function auditDayLabel(day) {
  if (!day) return '';
  const today = new Date().toISOString().slice(0, 10);
  const yest  = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (day === today) return 'Today';
  if (day === yest)  return 'Yesterday';
  return day;
}
function auditRelTime(ts) {
  if (!ts) return '';
  const t = new Date(ts.replace(' ', 'T') + 'Z').getTime();
  if (isNaN(t)) return ts.slice(11, 16);
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h ago';
  return ts.slice(5, 16);
}
function _auditParse(s) { try { return JSON.parse(s); } catch (_) { return null; } }
function auditRecordLabel(row) {
  const a = _auditParse(row.after_json) || _auditParse(row.before_json) || {};
  const v = a.number || a.display_name || a.legal_name || a.email || a.title || a.name || a.code;
  return v ? String(v) : (row.row_id ? '#' + row.row_id : '');
}
function auditHumanTable(t) {
  const map = { money_flows: 'money flow', calendar_tokens: 'calendar token', api_tokens: 'API token', tokens: 'API token', kyc_records: 'KYC record', kyc_documents: 'KYC document', bank_accounts: 'bank account', bank_transactions: 'bank transaction', invoice_payments: 'payment', saved_views: 'saved view', webhooks: 'webhook', fx_rates: 'FX rate', users: 'user', contacts: 'contact', invoices: 'invoice', contracts: 'contract', tasks: 'task', entities: 'entity', jurisdictions: 'jurisdiction', settings: 'setting', flows: 'flow', credentials: 'credential', notes: 'comment', auth: 'sign-in' };
  return map[t] || (t || '').replace(/_/g, ' ');
}
function auditSentence(row) {
  const T = auditHumanTable(row.table_name);
  const label = auditRecordLabel(row);
  const tail = label ? ` <strong>${escapeHtml(label)}</strong>` : '';
  switch (row.action) {
    case 'insert': case 'create': return `Created ${T}${tail}`;
    case 'update': return `Updated ${T}${tail}`;
    case 'delete': return `Deleted ${T}${tail}`;
    case 'login': return 'Signed in';
    case 'logout': return 'Signed out';
    case 'login-failed': { const a = _auditParse(row.before_json) || {}; return `Failed sign-in <strong>${escapeHtml(a.email || '?')}</strong>`; }
    case 'password-change': return 'Changed password';
    case 'bulk-import': return `Imported ${T}s`;
    case 'share-link-created': return `Shared ${T}${tail}`;
    case 'restore-queued': return 'Queued data restore';
    case 'setup': return 'Created first admin';
    default: return `${escapeHtml(row.action)} ${T}${tail}`;
  }
}
function _auditChipVal(v) {
  if (v == null) return '∅';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return escapeHtml(s.length > 18 ? s.slice(0, 18) + '…' : s);
}
function auditChips(row) {
  if (row.action !== 'update') return '';
  const b = _auditParse(row.before_json), a = _auditParse(row.after_json);
  if (!b || !a) return '';
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  const changed = keys.filter(k => JSON.stringify(b[k]) !== JSON.stringify(a[k]));
  if (!changed.length) return '';
  return changed.slice(0, 4).map(k => `<span class="audit-chip">${escapeHtml(k)}: ${_auditChipVal(b[k])}→${_auditChipVal(a[k])}</span>`).join('')
    + (changed.length > 4 ? `<span class="audit-chip muted">+${changed.length - 4}</span>` : '');
}

function renderAuditDiff(row) {
  const parse = s => { try { return JSON.parse(s); } catch (_) { return null; } };
  const before = parse(row.before_json) || {};
  const after  = parse(row.after_json)  || {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  if (!keys.length) return '<div class="muted" style="padding:8px 0;font-size:11px">No diff payload recorded.</div>';
  const fmtVal = v => v == null ? '<span class="muted">null</span>' : `<code style="font-size:11px">${escapeHtml(typeof v === 'object' ? JSON.stringify(v) : String(v))}</code>`;
  return `
    <table class="audit-diff" style="width:100%;font-size:11px;background:var(--panel-2);border-radius:6px;margin:6px 0">
      <thead><tr><th style="width:25%">Field</th><th>Before</th><th>After</th></tr></thead>
      <tbody>
        ${keys.map(k => {
          const a = before[k], b = after[k];
          const changed = JSON.stringify(a) !== JSON.stringify(b);
          return `<tr class="${changed ? 'audit-diff-changed' : ''}">
            <td><strong>${escapeHtml(k)}</strong></td>
            <td>${fmtVal(a)}</td>
            <td>${fmtVal(b)}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
}

['audit-filter-table','audit-filter-action','audit-filter-actor','audit-filter-since','audit-filter-until'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', loadAudit);
});
document.getElementById('audit-filter-clear')?.addEventListener('click', () => {
  ['audit-filter-table','audit-filter-action','audit-filter-actor','audit-filter-since','audit-filter-until'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  loadAudit();
});

// ---------- helpers ----------
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// ---------- Notifications inbox ----------
// Routine, auto-generated kinds the user doesn't need to see in the inbox.
const NOTIF_HIDDEN_KINDS = new Set(['backup', 'fx']);
const NOTIF_KIND_LABELS = { error: 'Errors', dunning: 'Reminders', webhook: 'Webhooks', fx: 'FX', backup: 'Backups' };
const NOTIF_KIND_ORDER = ['error', 'dunning', 'webhook'];

async function refreshNotifications() {
  try {
    const data = await fetch('/api/notifications').then(r => r.json());
    const items = (data.items || []).filter(n => !NOTIF_HIDDEN_KINDS.has(n.kind));
    const badge = document.getElementById('notif-count');
    const unread = items.filter(n => !n.is_read).length;
    if (unread > 0) { badge.hidden = false; badge.textContent = String(unread); }
    else { badge.hidden = true; }
    const list = document.getElementById('notif-list');
    if (!items.length) {
      list.innerHTML = '<li class="muted" style="padding:14px;text-align:center">No notifications.</li>';
      return;
    }
    const groups = {};
    for (const n of items) (groups[n.kind] = groups[n.kind] || []).push(n);
    const kinds = Object.keys(groups).sort((a, b) => {
      const ia = NOTIF_KIND_ORDER.indexOf(a), ib = NOTIF_KIND_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    list.innerHTML = kinds.map(k => `
      <li class="notif-group-head"><span class="kind kind-${k}">${escapeHtml(NOTIF_KIND_LABELS[k] || k)}</span><span class="muted">${groups[k].length}</span></li>
      ${groups[k].map(n => `<li class="${n.is_read ? '' : 'unread'}"><span class="ts">${escapeHtml(n.ts)}</span><span>${escapeHtml(n.message)}</span></li>`).join('')}
    `).join('');
  } catch (_) {}
}

document.getElementById('notif-bell').addEventListener('click', async () => {
  const panel = document.getElementById('notif-panel');
  if (panel.hidden) {
    await refreshNotifications();
    panel.hidden = false;
    await fetch('/api/notifications/mark-read', { method: 'POST' });
    setTimeout(refreshNotifications, 200);
  } else {
    panel.hidden = true;
  }
});
document.getElementById('notif-close').addEventListener('click', () => {
  document.getElementById('notif-panel').hidden = true;
});
document.getElementById('notif-clear').addEventListener('click', async () => {
  if (!await uiConfirm('Clear all notifications?')) return;
  await fetch('/api/notifications', { method: 'DELETE' });
  await refreshNotifications();
});
document.addEventListener('click', (e) => {
  const panel = document.getElementById('notif-panel');
  const bell  = document.getElementById('notif-bell');
  if (!panel || panel.hidden) return;
  if (!panel.contains(e.target) && !bell.contains(e.target)) panel.hidden = true;
});

// poll every 60s
setInterval(refreshNotifications, 60_000);

// ---------- Dashboard quick-filter chips ----------
document.querySelectorAll('.dash-chip').forEach(btn => {
  btn.addEventListener('click', () => {
    const k = btn.dataset.chip;
    const today = new Date().toISOString().slice(0, 10);
    document.querySelector('.tab[data-tab="invoices"]').click();
    setTimeout(() => {
      const search = document.getElementById('invoice-search');
      const statusSel = document.getElementById('invoice-filter-status');
      const dirSel = document.getElementById('invoice-filter-direction');
      // reset
      search.value = ''; state.invFilterText = '';
      statusSel.value = ''; state.invFilterStatus = '';
      dirSel.value = ''; state.invFilterDirection = '';
      if (k === 'overdue') {
        statusSel.value = 'sent'; state.invFilterStatus = 'sent';
        dirSel.value = 'sales';   state.invFilterDirection = 'sales';
        loadInvoices().then(() => {
          // filter further: in renderInvoices, also apply due_date<today
          state.invoices = state.invoices.filter(i => i.due_date && i.due_date < today);
          renderInvoices();
        });
        return;
      }
      if (k === 'due-week') {
        const in7 = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
        dirSel.value = 'sales';   state.invFilterDirection = 'sales';
        loadInvoices().then(() => {
          state.invoices = state.invoices.filter(i => i.due_date && i.due_date >= today && i.due_date <= in7);
          renderInvoices();
        });
        return;
      }
      if (k === 'paid-month') {
        const ym = today.slice(0, 7);
        statusSel.value = 'paid'; state.invFilterStatus = 'paid';
        loadInvoices().then(() => {
          state.invoices = state.invoices.filter(i => (i.issue_date || '').startsWith(ym));
          renderInvoices();
        });
        return;
      }
      if (k === 'open-ar') {
        statusSel.value = 'sent'; state.invFilterStatus = 'sent';
        dirSel.value = 'sales';   state.invFilterDirection = 'sales';
        loadInvoices();
        return;
      }
      if (k === 'open-ap') {
        statusSel.value = 'sent'; state.invFilterStatus = 'sent';
        dirSel.value = 'purchase';state.invFilterDirection = 'purchase';
        loadInvoices();
        return;
      }
    }, 50);
  });
});

// ---------- Recent items tracker ----------
const RECENT_KEY = 'carbon.recent';
function trackRecent(table, id, title) {
  if (!table || !id || !title) return;
  try {
    let arr = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    arr = arr.filter(x => !(x.table === table && x.id === id));
    arr.unshift({ table, id, title, ts: Date.now() });
    arr = arr.slice(0, 10);
    localStorage.setItem(RECENT_KEY, JSON.stringify(arr));
  } catch (_) {}
}
function getRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); }
  catch (_) { return []; }
}
function renderRecent() {
  const el = document.getElementById('dash-recent');
  if (!el) return;
  const items = getRecent().slice(0, 5);
  if (!items.length) {
    el.innerHTML = '<div class="muted" style="padding:8px 0;font-size:11px">Open something — it appears here for quick re-access.</div>';
    return;
  }
  const tabMap = { contacts: 'contacts', invoices: 'invoices', contracts: 'contracts', kyc_records: 'kyc' };
  el.innerHTML = items.map(it => `
    <div class="recent-row" data-table="${it.table}" data-id="${it.id}">
      <span><span class="kind">${escapeHtml(it.table.replace('_records', ''))}</span> ${escapeHtml(it.title)}</span>
    </div>
  `).join('');
  el.querySelectorAll('.recent-row').forEach(row => {
    row.addEventListener('click', () => {
      const t = row.dataset.table, id = Number(row.dataset.id);
      const tab = tabMap[t];
      if (tab) document.querySelector(`.tab[data-tab="${tab}"]`)?.click();
      setTimeout(() => {
        if (t === 'contacts') openContactDialog(id);
        else if (t === 'invoices') openInvoiceDialog(id);
        else if (t === 'contracts') openContractDialog(id);
        else if (t === 'kyc_records') openKycDialog(id);
      }, 100);
    });
  });
}

// ---------- Per-record activity panel ----------
async function attachActivityPanel(dialog, table, rowId) {
  if (!dialog || !rowId) return;
  const form = dialog.querySelector('form');
  if (!form) return;
  form.querySelectorAll('.record-activity').forEach(el => el.remove());
  let rows = [];
  try {
    rows = await fetch(`/api/audit?table=${encodeURIComponent(table)}&row_id=${rowId}`).then(r => r.json());
  } catch (_) {}
  const det = document.createElement('details');
  det.className = 'record-activity';
  det.innerHTML = `
    <summary>Activity (${rows.length})</summary>
    <ul>
      ${rows.length ? rows.map(r => `<li><span class="ts">${escapeHtml(r.ts)}</span><span>${escapeHtml(r.action)}</span><span class="muted">${escapeHtml(r.actor)}</span></li>`).join('')
                    : '<li class="muted">No activity recorded yet.</li>'}
    </ul>
  `;
  // insert just before .actions
  const actions = form.querySelector('.actions');
  if (actions) form.insertBefore(det, actions); else form.appendChild(det);
}

// ---------- Tax-ID validation buttons ----------
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.taxid-validate');
  if (!btn) return;
  const ctx = btn.dataset.context;
  const wrapper = btn.closest('label');
  const taxInput = wrapper.querySelector('input[name="tax_id"]');
  const resultEl = wrapper.parentElement.querySelector(`.taxid-result[data-context="${ctx}"]`);

  // Find country code from the open dialog
  let country = '';
  const dlg = btn.closest('dialog');
  if (dlg) {
    const hiddenCode = dlg.querySelector('input[name="jurisdiction_code"]');
    const select = dlg.querySelector('select[name="jurisdiction_code"]');
    country = (hiddenCode?.value || select?.value || '').toUpperCase();
  }
  const number = (taxInput.value || '').trim();
  if (!country || !number) {
    resultEl.hidden = false;
    resultEl.textContent = 'Pick a jurisdiction and enter a tax ID first.';
    return;
  }
  btn.disabled = true; btn.textContent = '…';
  try {
    const r = await fetch(`/api/validate/tax-id?country=${encodeURIComponent(country)}&number=${encodeURIComponent(number)}`);
    const data = await r.json();
    resultEl.hidden = false;
    resultEl.className = 'taxid-result ' + (data.valid === true ? 'ok' : data.valid === false ? 'bad' : 'warn');
    if (data.source === 'VIES' && data.valid) {
      resultEl.innerHTML = `✓ <strong>${escapeHtml(data.name || 'Valid')}</strong>${data.address ? ' — ' + escapeHtml(data.address.replace(/\s+/g, ' ').trim()) : ''} <span class="muted">(VIES)</span>`;
    } else if (data.source === 'VIES' && !data.valid) {
      resultEl.innerHTML = `✗ VIES says this VAT number is not valid.`;
    } else if (data.source === 'format' && data.valid) {
      resultEl.innerHTML = `✓ ${escapeHtml(data.label)} format OK. <a href="${data.deeplink}" target="_blank">Verify identity →</a>`;
    } else if (data.source === 'format' && !data.valid) {
      resultEl.innerHTML = `✗ Doesn't match ${escapeHtml(data.label)} format. <a href="${data.deeplink}" target="_blank">Manual lookup →</a>`;
    } else {
      resultEl.textContent = data.message || 'No validator available.';
    }
  } catch (err) {
    resultEl.hidden = false;
    resultEl.className = 'taxid-result bad';
    resultEl.textContent = 'Validation failed: ' + err.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Validate';
  }
});

// ---------- sortable table columns (click any TH) ----------
const SORT_STATE = new WeakMap();
function makeSortable(table) {
  if (!table || table.dataset.sortableWired) return;
  table.dataset.sortableWired = '1';
  const ths = table.querySelectorAll('thead th');
  ths.forEach((th, idx) => {
    // skip pure-action columns (no header text)
    if (!th.textContent.trim()) return;
    th.classList.add('sortable');
    th.addEventListener('click', () => sortColumn(table, idx, th));
  });
}
function sortColumn(table, idx, th) {
  const state = SORT_STATE.get(table) || { col: -1, dir: 0 };
  let dir;
  if (state.col === idx) dir = state.dir === 1 ? -1 : state.dir === -1 ? 0 : 1;
  else dir = 1;
  SORT_STATE.set(table, { col: idx, dir });
  table.querySelectorAll('thead th').forEach(t => t.classList.remove('sort-asc', 'sort-desc'));
  if (dir === 1) th.classList.add('sort-asc');
  if (dir === -1) th.classList.add('sort-desc');
  const tbody = table.querySelector('tbody');
  const rows = Array.from(tbody.rows);
  if (dir === 0) { rows.sort((a, b) => Number(a.dataset.origOrder || 0) - Number(b.dataset.origOrder || 0)); }
  else {
    if (!rows[0]?.dataset.origOrder) rows.forEach((r, i) => r.dataset.origOrder = i);
    const vals = rows.map(r => (r.cells[idx]?.textContent || '').trim());
    const numericish = vals.every(v => v === '' || /^[\-+(]?[\d,.\s]+[)%]?$/.test(v));
    const parse = v => {
      if (!v) return numericish ? -Infinity : '';
      if (numericish) {
        const n = Number(v.replace(/[(,)\s]/g, '').replace(/[%]/g, ''));
        return isNaN(n) ? -Infinity : n;
      }
      return v.toLowerCase();
    };
    rows.sort((a, b) => {
      const av = parse(a.cells[idx]?.textContent || '');
      const bv = parse(b.cells[idx]?.textContent || '');
      if (av < bv) return -1 * dir;
      if (av > bv) return  1 * dir;
      return 0;
    });
  }
  rows.forEach(r => tbody.appendChild(r));
}

// Re-wire sortable on any table after each render
const _origRender = HTMLElement.prototype.appendChild;  // sentinel — we'll wire via MutationObserver instead
const _sortObserver = new MutationObserver(() => {
  document.querySelectorAll('table').forEach(makeSortable);
});
_sortObserver.observe(document.body, { childList: true, subtree: true });

// ---------- drag-drop on file inputs ----------
function makeDropzone(inputEl) {
  const parent = inputEl.closest('fieldset, label, .subpanel, .toolbar') || inputEl.parentElement;
  if (!parent || parent.dataset.dropzoneWired) return;
  parent.dataset.dropzoneWired = '1';
  parent.classList.add('dropzone');
  parent.addEventListener('dragover', e => { e.preventDefault(); parent.classList.add('drag-over'); });
  parent.addEventListener('dragleave', () => parent.classList.remove('drag-over'));
  parent.addEventListener('drop', e => {
    e.preventDefault();
    parent.classList.remove('drag-over');
    if (e.dataTransfer.files.length) {
      try {
        const dt = new DataTransfer();
        for (const f of e.dataTransfer.files) dt.items.add(f);
        inputEl.files = dt.files;
      } catch (_) {
        inputEl.files = e.dataTransfer.files;
      }
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
}

function wireDropzones() {
  document.querySelectorAll('input[type="file"]').forEach(makeDropzone);
}

// ---------- global keyboard shortcuts ----------
document.addEventListener('keydown', (e) => {
  const isCmd = e.metaKey || e.ctrlKey;
  if (isCmd && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    openGlobalSearch();
  }
  if (isCmd && (e.key === 's' || e.key === 'S')) {
    const dlg = document.querySelector('dialog[open]');
    if (dlg) {
      const primary = dlg.querySelector('button.primary');
      if (primary) { e.preventDefault(); primary.click(); }
    }
  }
  if (e.key === '/' && document.activeElement === document.body) {
    const search = document.querySelector('.panel:not([hidden]) input[type="search"]');
    if (search) { e.preventDefault(); search.focus(); }
  }
});

// ---------- global search overlay (cmd+k) ----------
let _searchOverlay = null;
function openGlobalSearch() {
  if (_searchOverlay) { _searchOverlay.querySelector('input').focus(); return; }
  const overlay = document.createElement('div');
  overlay.className = 'search-overlay';
  overlay.innerHTML = `
    <div class="search-box">
      <input type="text" placeholder="Search contacts, invoices, contracts, bank txns…" autofocus />
      <div class="search-results"></div>
      <div class="search-hint muted">Esc to close · ↑↓ to navigate · Enter to open</div>
    </div>
  `;
  document.body.appendChild(overlay);
  _searchOverlay = overlay;
  const input = overlay.querySelector('input');
  const list  = overlay.querySelector('.search-results');
  let focused = 0;
  let hits = [];

  function render() {
    list.innerHTML = hits.length
      ? hits.map((h, i) => `<div class="search-hit ${i === focused ? 'focused' : ''}" data-i="${i}"><span class="search-kind">${escapeHtml(h.kind)}</span> ${escapeHtml(h.label)}</div>`).join('')
      : (input.value ? '<div class="search-empty">No matches</div>' : '');
    list.querySelectorAll('.search-hit').forEach(el => {
      el.addEventListener('click', () => pick(Number(el.dataset.i)));
    });
  }

  // Action commands — keyboard-driven shortcuts.
  const ACTIONS = [
    { kind: 'Action', label: 'New invoice', run: () => { document.querySelector('.tab[data-tab="invoices"]').click(); setTimeout(() => document.getElementById('btn-new-invoice').click(), 50); } },
    { kind: 'Action', label: 'New bill',    run: () => { document.querySelector('.tab[data-tab="invoices"]').click(); setTimeout(() => document.getElementById('btn-new-bill').click(), 50); } },
    { kind: 'Action', label: 'New contact', run: () => { document.querySelector('.tab[data-tab="contacts"]').click(); setTimeout(() => document.getElementById('btn-new-contact').click(), 50); } },
    { kind: 'Action', label: 'New contract',run: () => { document.querySelector('.tab[data-tab="contracts"]').click(); setTimeout(() => document.getElementById('btn-new-contract').click(), 50); } },
    { kind: 'Action', label: 'New flow',    run: () => { document.querySelector('.tab[data-tab="flows"]').click();    setTimeout(() => document.getElementById('btn-new-flow').click(), 50); } },
    { kind: 'Action', label: 'Go to Dashboard', run: () => document.querySelector('.tab[data-tab="dashboard"]').click() },
    { kind: 'Action', label: 'Go to Contacts',  run: () => document.querySelector('.tab[data-tab="contacts"]').click() },
    { kind: 'Action', label: 'Go to Invoices',  run: () => document.querySelector('.tab[data-tab="invoices"]').click() },
    { kind: 'Action', label: 'Go to Banks',     run: () => document.querySelector('.tab[data-tab="banks"]').click() },
    { kind: 'Action', label: 'Go to Flows',     run: () => document.querySelector('.tab[data-tab="flows"]').click() },
    { kind: 'Action', label: 'Go to Contracts', run: () => document.querySelector('.tab[data-tab="contracts"]').click() },
    { kind: 'Action', label: 'Go to KYC',       run: () => document.querySelector('.tab[data-tab="kyc"]').click() },
    { kind: 'Action', label: 'Go to Reports',   run: () => document.querySelector('.tab[data-tab="reports"]').click() },
    { kind: 'Action', label: 'Go to Audit',     run: () => document.querySelector('.tab[data-tab="audit"]').click() },
    { kind: 'Action', label: 'Go to Ops & Settings', run: () => document.querySelector('.tab[data-tab="settings"]').click() },
    { kind: 'Action', label: 'Toggle theme (light/dark)', run: () => document.getElementById('btn-theme-toggle').click() },
    { kind: 'Action', label: 'Download backup now', run: async () => { await jsonReq('POST', '/api/system/backup-now', {}); toast('Backup written', 'ok'); } },
    { kind: 'Action', label: 'Refresh FX from ECB', run: async () => { try { await jsonReq('POST', '/api/fx-rates/refresh', {}); toast('FX refreshed', 'ok'); } catch (e) { toast('Refresh failed', 'error'); } } },
    { kind: 'Action', label: 'Sign out', run: async () => { await api.logout(); window.location.href = '/'; } },
  ];

  function search(q) {
    const text = q.toLowerCase().trim();
    if (!text) { hits = []; render(); return; }
    const out = [];
    // actions first
    for (const a of ACTIONS) {
      if (a.label.toLowerCase().includes(text)) out.push(a);
    }
    for (const c of state.contacts) {
      if ((c.display_name || '').toLowerCase().includes(text)) {
        out.push({ kind: 'Contact', label: c.display_name, tab: 'contacts', id: c.id });
      }
    }
    for (const i of (state.invoices || [])) {
      const s = `${i.number} ${i.contact_display_name || ''}`.toLowerCase();
      if (s.includes(text)) out.push({ kind: i.direction === 'purchase' ? 'Bill' : 'Invoice', label: `${i.number} — ${i.contact_display_name || ''}`, tab: 'invoices', id: i.id });
    }
    for (const c of (state.contracts || [])) {
      if ((c.title || '').toLowerCase().includes(text)) {
        out.push({ kind: 'Contract', label: c.title, tab: 'contracts', id: c.id });
      }
    }
    for (const t of (state.bankTransactions || [])) {
      if ((t.description || '').toLowerCase().includes(text)) {
        out.push({ kind: 'Bank tx', label: `${t.txn_date} — ${t.description}`, tab: 'banks', id: t.id });
      }
    }
    hits = out.slice(0, 20);
    focused = 0;
    render();
  }

  function pick(i) {
    const h = hits[i];
    if (!h) return;
    close();
    if (typeof h.run === 'function') { h.run(); return; }
    const tab = document.querySelector(`.tab[data-tab="${h.tab}"]`);
    if (tab) tab.click();
  }

  function close() {
    overlay.remove();
    _searchOverlay = null;
  }

  input.addEventListener('input', e => search(e.target.value));
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); focused = Math.min(hits.length - 1, focused + 1); render(); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); focused = Math.max(0, focused - 1); render(); }
    if (e.key === 'Enter')     { e.preventDefault(); pick(focused); }
  });
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
}

// ---------- boot ----------
(async function init() {
  try {
  await loadMe();
  const [j, e, c] = await Promise.all([api.jurisdictions(), api.entities(), api.contacts()]);
  state.jurisdictions = j;
  state.entities = e;
  state.contacts = c;
  const filterSel = document.getElementById('contact-filter-entity');
  filterSel.innerHTML = '<option value="">All entities</option>' +
    e.map(x => `<option value="${x.id}">${escapeHtml(x.code)}</option>`).join('');
  refreshNotifications();

  // Tasks module wiring
  const taskDlg = document.getElementById('task-dialog');
  const taskForm = document.getElementById('task-form');
  let taskEditingId = null;
  document.getElementById('btn-new-task')?.addEventListener('click', () => { taskEditingId = null; taskForm.reset(); document.getElementById('task-form-title').textContent = 'New task'; taskDlg.showModal(); });
  document.getElementById('task-cancel')?.addEventListener('click', () => taskDlg.close());
  document.getElementById('task-save')?.addEventListener('click', async () => {
    const data = Object.fromEntries(new FormData(taskForm));
    if (!data.title) { toast('Title required', 'warn'); return; }
    try {
      if (taskEditingId) await api.updateTask(taskEditingId, data);
      else await api.createTask(data);
      taskDlg.close();
      await loadTasks();
    } catch (err) { toast('Save failed: ' + err.message, 'error'); }
  });
  loadTasks = async function () {
    const status = document.getElementById('tasks-filter-status')?.value || '';
    const rows = await api.tasks(status);
    const tbody = document.querySelector('#tasks-table tbody');
    document.getElementById('tasks-empty').hidden = rows.length > 0;
    tbody.innerHTML = rows.map(t => `
      <tr data-id="${t.id}">
        <td><input type="checkbox" class="task-done" ${t.status === 'done' ? 'checked' : ''} /></td>
        <td><strong>${escapeHtml(t.title)}</strong>${t.notes ? `<br><span class="muted">${escapeHtml(t.notes)}</span>` : ''}</td>
        <td>${escapeHtml(t.due_date || '')}</td>
        <td><span class="status status-${t.status === 'done' ? 'paid' : 'pending'}">${t.status}</span></td>
        <td>${t.ref_table ? escapeHtml(t.ref_table + ' #' + t.ref_id) : '<span class="muted">—</span>'}</td>
        <td class="row-actions">
          <button data-act="edit">Edit</button>
          <button data-act="delete" class="danger">×</button>
        </td>
      </tr>
    `).join('');
    tbody.querySelectorAll('.task-done').forEach(cb => cb.addEventListener('change', async (e) => {
      const id = Number(e.target.closest('tr').dataset.id);
      await api.updateTask(id, { status: e.target.checked ? 'done' : 'open' });
      await loadTasks();
    }));
    tbody.querySelectorAll('button[data-act]').forEach(btn => btn.addEventListener('click', async (e) => {
      const id = Number(e.target.closest('tr').dataset.id);
      if (btn.dataset.act === 'edit') {
        const t = rows.find(x => x.id === id);
        taskEditingId = id; taskForm.reset();
        for (const [k, v] of Object.entries(t)) {
          if (taskForm.elements[k] && v != null) taskForm.elements[k].value = String(v);
        }
        document.getElementById('task-form-title').textContent = 'Edit task';
        taskDlg.showModal();
      }
      if (btn.dataset.act === 'delete') {
        if (!await uiConfirm('Delete this task?')) return;
        await api.deleteTask(id); await loadTasks();
      }
    }));
  };
  // Attach AFTER loadTasks is defined — referencing it earlier threw a boot-time
  // ReferenceError that aborted init() before loadDashboard() ever ran.
  document.getElementById('tasks-filter-status')?.addEventListener('change', loadTasks);

  // Bulk-email selected invoices
  document.getElementById('bulk-email')?.addEventListener('click', async () => {
    const ids = Array.from(document.querySelectorAll('#invoices-table tbody .row-check:checked')).map(c => Number(c.dataset.id));
    if (!ids.length) return;
    if (!await uiConfirm(`Email ${ids.length} invoice(s) to their contact emails?`)) return;
    const btn = document.getElementById('bulk-email');
    btn.disabled = true;
    let sent = 0, failed = 0;
    for (let i = 0; i < ids.length; i++) {
      btn.textContent = `Sending ${i + 1}/${ids.length}…`;
      try { await jsonReq('POST', '/api/invoices/' + ids[i] + '/email', {}); sent++; }
      catch (_) { failed++; }
      // throttle to avoid SMTP rate limits
      if (i < ids.length - 1) await new Promise(r => setTimeout(r, 250));
    }
    btn.disabled = false;
    btn.textContent = 'Email selected';
    toast(`Emailed ${sent}/${ids.length} (${failed} failed)`, failed ? 'warn' : 'ok');
    await loadInvoices();
  });

  // CSV import preview wrapper — intercept the existing bulk-import handler
  function wrapCsvPreview(fileInputId, parser, doImport) {
    const input = document.getElementById(fileInputId);
    if (!input) return;
    const original = input._origChange;
    input.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const rows = parser(text);
        if (!rows.length) { toast('No rows parsed', 'warn'); return; }
        const dlg = document.getElementById('csv-preview-dialog');
        document.getElementById('csv-preview-summary').textContent = `${rows.length} row(s) detected. Showing first 10.`;
        const headers = [...new Set(rows.flatMap(r => Object.keys(r)))];
        const preview = `
          <table style="width:100%;border-collapse:collapse"><thead><tr>${headers.map(h => `<th style="padding:4px 6px;font-size:10px;color:var(--muted)">${escapeHtml(h)}</th>`).join('')}</tr></thead>
          <tbody>${rows.slice(0, 10).map(r => `<tr>${headers.map(h => `<td style="padding:3px 6px;border-bottom:1px solid var(--divider)">${escapeHtml(r[h] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody>
          </table>
        `;
        document.getElementById('csv-preview-table').innerHTML = preview;
        document.getElementById('csv-preview-confirm').onclick = async () => {
          dlg.close();
          await doImport(rows);
        };
        document.getElementById('csv-preview-cancel').onclick = () => dlg.close();
        dlg.showModal();
      } catch (err) { toast('Preview failed: ' + err.message, 'error'); }
      e.target.value = '';
    }, { capture: true });
  }
  // Re-wire bulk-import-file with preview
  // (Note: the original handler still exists; we add a preview-first listener.)
  // For invoices and contacts CSV inputs:

  // Restore last-active tab (or stay on dashboard)
  const lastTab = localStorage.getItem('carbon.lastTab');
  if (lastTab && lastTab !== 'dashboard') {
    const tab = document.querySelector(`.tab[data-tab="${lastTab}"]`);
    if (tab) tab.click();
    else await loadDashboard();
  } else {
    await loadDashboard();
  }
  wireDropzones();
  } catch (err) {
    console.error('init() failed to complete:', err);
    showAppError('Carbon did not finish loading: ' + ((err && err.message) || err));
  }
})();

// ---------- styled in-app dialogs (replace native confirm/alert/prompt) ----------
// Promise-based so callers `await uiConfirm(...)` / `await uiPrompt(...)`.
function _uiDialog({ title = '', message = '', okText = 'OK', cancelText = 'Cancel', danger = false, isPrompt = false, defaultValue = '' }) {
  return new Promise((resolve) => {
    let dlg = document.getElementById('ui-dialog');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'ui-dialog';
      dlg.className = 'ui-dialog';
      document.body.appendChild(dlg);
    }
    const form = document.createElement('form');
    form.method = 'dialog';
    if (title) {
      const h = document.createElement('h2');
      h.textContent = title;
      form.appendChild(h);
    }
    const msg = document.createElement('p');
    msg.className = 'ui-dialog-msg';
    msg.textContent = message;
    form.appendChild(msg);
    let input = null;
    if (isPrompt) {
      input = document.createElement('input');
      input.type = 'text';
      input.className = 'ui-dialog-input';
      input.value = defaultValue;
      form.appendChild(input);
    }
    const actions = document.createElement('div');
    actions.className = 'actions';
    let cancelBtn = null;
    if (cancelText !== null) {
      cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.textContent = cancelText;
      actions.appendChild(cancelBtn);
    }
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = danger ? 'danger' : 'primary';
    okBtn.textContent = okText;
    actions.appendChild(okBtn);
    form.appendChild(actions);
    dlg.replaceChildren(form);

    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      try { dlg.close(); } catch (_) {}
      resolve(val);
    };
    okBtn.addEventListener('click', () => finish(isPrompt ? (input ? input.value : '') : true));
    if (cancelBtn) cancelBtn.addEventListener('click', () => finish(isPrompt ? null : false));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(isPrompt ? null : false); }, { once: true });
    if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(input.value); } });
    dlg.showModal();
    (input || okBtn).focus();
    if (input) input.select();
  });
}
function uiConfirm(message, opts = {}) {
  const danger = /\b(delete|remove|revoke|void|terminate|permanent|discard|wipe|reset)\b|clear all/i.test(String(message));
  return _uiDialog({ message, danger, ...opts });
}
function uiAlert(message, opts = {}) {
  return _uiDialog({ message, cancelText: null, ...opts });
}
function uiPrompt(message, defaultValue = '', opts = {}) {
  return _uiDialog({ message, isPrompt: true, defaultValue, ...opts });
}
