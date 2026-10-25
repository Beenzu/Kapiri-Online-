'use strict';
// Administrator console at /admin. Every screen calls the /api/admin routes, which check the administrator role on the server.
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const money = n => 'K' + Number(n || 0).toLocaleString('en-ZM', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = ts => ts ? new Date(ts).toLocaleString('en-ZM', { timeZone: 'Africa/Lusaka', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const ORDER_STATUSES = ['pending', 'confirmed', 'processing', 'ready', 'shipped', 'completed', 'cancelled'];
const SELLER_STATUSES = ['pending', 'approved', 'rejected', 'suspended'];
const FEATURE_LABELS = { crm: 'Customer CRM', promos: 'Promo codes', discounts: 'Product discounts', seller_emails: 'Order email alerts' };
const FEATURES = Object.keys(FEATURE_LABELS);
const KIND_LABELS = {
  order_placed_buyer: 'Buyer: order confirmation',
  order_placed_seller: 'Seller: new order alert',
  order_status_buyer: 'Buyer: shop status updates',
  order_cancelled_seller: 'Seller: order cancelled by buyer',
  seller_status: 'Seller: account approved, rejected or suspended',
  plan_changed: 'Seller: plan changed',
  invoice_paid: 'Seller: payment received'
};
let me = null;

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

async function api(url, options = {}) {
  const res = await fetch(url, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await res.json().catch(() => ({ error: 'The server returned an unexpected response.' }));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

const setView = html => { $('#view').innerHTML = html; };
const stat = (label, value) => `<div class="stat"><small>${esc(label)}</small><strong>${value}</strong></div>`;
const pill = (text, cls = '') => `<span class="pill ${cls}">${esc(text)}</span>`;

// ---------- sign in ----------
function showAuth(message = '') {
  $('#pageArea').classList.add('hidden');
  $('#signOutBtn').classList.add('hidden');
  $('#whoami').textContent = '';
  const panel = $('#authPanel');
  panel.classList.remove('hidden');
  panel.innerHTML = `<div class="seller-card auth-card">
    <h1>Administrator sign in</h1>
    <p class="muted">Manage sellers, plans, invoices, orders, products and email for Kapiri Online.</p>
    ${message ? `<div class="notice error">${esc(message)}</div>` : ''}
    <form id="authForm" class="stack">
      <div class="field"><label for="f_email">Email address *</label><input id="f_email" name="email" type="email" required autocomplete="username"></div>
      <div class="field"><label for="f_password">Password *</label><input id="f_password" name="password" type="password" required autocomplete="current-password"></div>
      <button class="btn primary" type="submit">Sign in</button>
    </form>
  </div>`;
  $('#authForm').addEventListener('submit', async e => {
    e.preventDefault();
    const payload = Object.fromEntries(new FormData(e.currentTarget).entries());
    try {
      me = (await api('/api/auth/login', { method: 'POST', body: JSON.stringify(payload) })).user;
      await boot();
    } catch (err) {
      showAuth(err.message);
    }
  });
}

async function boot() {
  try { me = (await api('/api/me')).user; } catch (e) { me = null; }
  if (!me) return showAuth();
  if (me.role !== 'admin') return showAuth('This console is for marketplace administrators only.');
  $('#authPanel').innerHTML = '';
  $('#authPanel').classList.add('hidden');
  $('#pageArea').classList.remove('hidden');
  $('#signOutBtn').classList.remove('hidden');
  $('#whoami').textContent = 'Administrator';
  route();
}

$('#signOutBtn').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  me = null;
  location.hash = '';
  showAuth();
});

// ---------- router ----------
const PAGES = {
  overview: viewOverview, sellers: parts => parts[0] ? viewSeller(parts[0]) : viewSellers(), plans: viewPlans,
  invoices: viewInvoices, orders: viewOrders, products: viewProducts, emails: viewEmails, settings: viewSettings
};
async function route() {
  if (!me) return;
  const parts = (location.hash || '#/overview').replace(/^#\/?/, '').split('/').filter(Boolean);
  const page = PAGES[parts[0]] ? parts[0] : 'overview';
  $$('#adminNav a').forEach(a => a.classList.toggle('active', a.dataset.nav === page));
  try {
    await PAGES[page](parts.slice(1));
  } catch (e) {
    setView(`<div class="notice error">${esc(e.message)}</div>`);
  }
}
window.addEventListener('hashchange', route);

// ---------- overview ----------
async function viewOverview() {
  setView(`<h1>Overview</h1>
    <div id="stats" class="stats"><div class="muted">Loading…</div></div>
    <h2>Seller applications waiting</h2>
    <div id="pending" class="list"></div>`);
  const o = await api('/api/admin/overview');
  const b = o.sellersByStatus;
  $('#stats').innerHTML = [
    stat('Approved sellers', b.approved), stat('Awaiting approval', b.pending), stat('Suspended', b.suspended),
    stat('Products', o.products), stat('Orders', o.orders), stat('Users', o.users),
    stat('Gross sales (excl. cancelled)', money(o.grossSales)), stat('Platform fees earned', money(o.platformFees)),
    stat('Subscriptions paid', money(o.subscriptionsPaid)), stat('Monthly recurring', money(o.monthlyRecurring))
  ].join('');
  $('#pending').innerHTML = o.pendingSellers.map(s => `<div class="card product-row">
      <div class="grow"><strong>${esc(s.business_name || s.name)}</strong>
        <div class="small muted">${esc(s.email)} · ${esc(s.location || 'Location not set')} · applied ${fmtDate(s.created_at)}</div></div>
      <div class="row-actions">
        <button class="btn primary small" type="button" data-quick="approved" data-id="${s.id}">Approve</button>
        <button class="btn ghost small" type="button" data-quick="rejected" data-id="${s.id}">Reject</button>
      </div></div>`).join('') || '<div class="empty">No seller applications are waiting.</div>';
  $$('[data-quick]').forEach(btn => btn.addEventListener('click', async () => {
    try {
      await api(`/api/admin/sellers/${btn.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ status: btn.dataset.quick }) });
      toast('Seller updated.');
      route();
    } catch (e) { toast(e.message); }
  }));
}

// ---------- sellers ----------
async function viewSellers() {
  setView(`<h1>Sellers &amp; plans</h1>
    <div class="card filters">
      <div class="field"><label for="fStatus">Status</label>
        <select id="fStatus"><option value="">All</option>${SELLER_STATUSES.map(s => `<option value="${s}">${s}</option>`).join('')}</select></div>
      <div class="field"><label for="fQ">Search</label><input id="fQ" placeholder="Name, shop or email"></div>
    </div>
    <div id="sList" class="list"><div class="muted">Loading…</div></div>`);
  const draw = async () => {
    const qs = new URLSearchParams({ status: $('#fStatus').value, q: $('#fQ').value.trim() });
    const { sellers } = await api('/api/admin/sellers?' + qs.toString());
    $('#sList').innerHTML = sellers.map(s => `<a class="card product-row" href="#/sellers/${s.id}">
        <div class="grow"><strong>${esc(s.business_name || s.name)}</strong> ${pill(s.seller_status)} ${pill(s.plan_code)}
          <div class="small muted">${esc(s.email)} · ${Number(s.products)} products · sales ${money(s.sales)} · platform fees ${money(s.platform_fees)}</div></div>
        <span class="small">Manage →</span></a>`).join('') || '<div class="empty">No sellers match.</div>';
  };
  $('#fStatus').addEventListener('change', draw);
  let timer;
  $('#fQ').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => draw().catch(e => toast(e.message)), 250); });
  await draw();
}

async function viewSeller(id) {
  const [{ sellers }, { plans }] = await Promise.all([api('/api/admin/sellers'), api('/api/admin/plans')]);
  const s = sellers.find(x => Number(x.id) === Number(id));
  if (!s) return setView('<a href="#/sellers" class="back">← Back to sellers</a><div class="notice error">Seller not found.</div>');
  const fo = s.feature_overrides || {};
  const tri = f => fo[f] === true ? 'on' : fo[f] === false ? 'off' : '';
  const triSelect = f => `<select id="ov_${f}">
      <option value="" ${tri(f) === '' ? 'selected' : ''}>Plan default</option>
      <option value="on" ${tri(f) === 'on' ? 'selected' : ''}>On</option>
      <option value="off" ${tri(f) === 'off' ? 'selected' : ''}>Off</option></select>`;
  setView(`<a href="#/sellers" class="back">← Back to sellers</a>
    <h1>${esc(s.business_name || s.name)}</h1>
    <p class="muted">${esc(s.name)} · ${esc(s.email)} · ${esc(s.phone || 'no phone')} · ${esc(s.location || 'no location')}</p>
    <div class="grid2">
      <form id="statusForm" class="card stack">
        <h2>Account status</h2>
        <div class="field"><label for="sStatus">Status</label>
          <select id="sStatus">${SELLER_STATUSES.map(x => `<option value="${x}" ${x === s.seller_status ? 'selected' : ''}>${x}</option>`).join('')}</select>
          <small class="muted">Suspended shops are hidden from buyers. Their existing orders are kept.</small></div>
        <div class="field"><label for="sNotes">Internal notes (not shown to the seller)</label>
          <textarea id="sNotes" rows="4" maxlength="2000">${esc(s.admin_notes || '')}</textarea></div>
        <div id="statusMsg"></div>
        <button class="btn primary" type="submit">Save status and notes</button>
      </form>
      <form id="planForm" class="card stack">
        <h2>Plan</h2>
        <p>Current plan: <strong>${esc(s.plan_code)}</strong>${s.plan_expires_at ? ` · valid until ${fmtDate(s.plan_expires_at)}` : ''}</p>
        <div class="field"><label for="pPlan">Assign plan</label>
          <select id="pPlan">${plans.filter(p => p.active || p.code === s.plan_code).map(p => `<option value="${esc(p.code)}" ${p.code === s.plan_code ? 'selected' : ''}>${esc(p.name)} — ${Number(p.price_monthly) === 0 ? 'Free' : money(p.price_monthly) + ' / month'}</option>`).join('')}</select></div>
        <div class="field"><label for="pMonths">Months</label><input id="pMonths" type="number" min="1" max="12" step="1" value="1"></div>
        <label class="checks"><input type="checkbox" id="pPaid"> Payment has been received</label>
        <div id="planMsg"></div>
        <button class="btn primary" type="submit">Assign plan</button>
        <small class="muted">Access changes straight away and an invoice is created. Leave payment unticked to record it as awaiting payment.</small>
      </form>
    </div>
    <form id="overrideForm" class="card stack">
      <h2>Overrides for this seller</h2>
      <p class="small muted">Overrides take priority over the plan. Leave a setting on "Plan default" to follow the plan.</p>
      <div class="grid2">
        ${FEATURES.map(f => `<div class="field"><label for="ov_${f}">${esc(FEATURE_LABELS[f])}</label>${triSelect(f)}</div>`).join('')}
        <div class="field"><label for="ov_max">Product limit</label>
          <input id="ov_max" type="number" min="0" step="1" value="${fo.max_products ?? ''}" placeholder="Plan default">
          <small class="muted">Leave blank to follow the plan. 0 means no products.</small></div>
        <div class="field"><label for="ov_comm">Platform fee %</label>
          <input id="ov_comm" type="number" min="0" max="50" step="0.1" value="${fo.commission ?? ''}" placeholder="Plan default"></div>
      </div>
      <div id="ovMsg"></div>
      <button class="btn primary" type="submit">Save overrides</button>
    </form>`);

  $('#statusForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api(`/api/admin/sellers/${s.id}`, { method: 'PATCH', body: JSON.stringify({ status: $('#sStatus').value, adminNotes: $('#sNotes').value }) });
      toast('Seller saved.');
      route();
    } catch (err) { $('#statusMsg').innerHTML = `<div class="notice error">${esc(err.message)}</div>`; }
  });

  $('#planForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api(`/api/admin/sellers/${s.id}/plan`, { method: 'POST', body: JSON.stringify({
        planCode: $('#pPlan').value, months: $('#pMonths').value, markPaid: $('#pPaid').checked }) });
      toast('Plan assigned.');
      route();
    } catch (err) { $('#planMsg').innerHTML = `<div class="notice error">${esc(err.message)}</div>`; }
  });

  $('#overrideForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fo2 = {};
    for (const f of FEATURES) {
      const v = $(`#ov_${f}`).value;
      fo2[f] = v === 'on' ? true : v === 'off' ? false : null;
    }
    const mp = $('#ov_max').value, cm = $('#ov_comm').value;
    fo2.max_products = mp === '' ? null : Number(mp);
    fo2.commission = cm === '' ? null : Number(cm);
    try {
      await api(`/api/admin/sellers/${s.id}`, { method: 'PATCH', body: JSON.stringify({ featureOverrides: fo2 }) });
      toast('Overrides saved.');
      route();
    } catch (err) { $('#ovMsg').innerHTML = `<div class="notice error">${esc(err.message)}</div>`; }
  });
}

// ---------- plans ----------
function planEditor(p, isNew = false) {
  const k = isNew ? 'new' : p.code;
  const f = p.features || {};
  return `<div class="card stack plan-card">
    <div class="grid2">
      <div class="field"><label for="pc_${k}">Code</label><input id="pc_${k}" value="${esc(p.code)}" maxlength="30" ${isNew ? '' : 'disabled'} placeholder="e.g. growth"></div>
      <div class="field"><label for="pn_${k}">Name</label><input id="pn_${k}" value="${esc(p.name)}" maxlength="80"></div>
      <div class="field"><label for="pp_${k}">Price per month (K)</label><input id="pp_${k}" type="number" min="0" step="1" value="${Number(p.price_monthly)}"></div>
      <div class="field"><label for="pm_${k}">Product limit</label><input id="pm_${k}" type="number" min="0" step="1" value="${p.max_products ?? ''}" placeholder="Blank = unlimited"></div>
      <div class="field"><label for="pf_${k}">Platform fee %</label><input id="pf_${k}" type="number" min="0" max="50" step="0.1" value="${Number(p.commission_percent)}"></div>
      <div class="field"><label for="ps_${k}">Sort order</label><input id="ps_${k}" type="number" step="1" value="${Number(p.sort_order || 0)}"></div>
    </div>
    <div class="checks">
      ${FEATURES.map(x => `<label><input type="checkbox" id="pk_${k}_${x}" ${f[x] ? 'checked' : ''}> ${esc(FEATURE_LABELS[x])}</label>`).join('')}
      <label><input type="checkbox" id="pa_${k}" ${p.active !== false ? 'checked' : ''}> Available to choose</label>
    </div>
    <div><button class="btn primary small" type="button" data-save-plan="${esc(p.code)}" data-new="${isNew}" data-k="${k}">${isNew ? 'Create plan' : 'Save plan'}</button></div>
  </div>`;
}

async function viewPlans() {
  const { plans } = await api('/api/admin/plans');
  setView(`<h1>Plans</h1>
    <p class="muted">A plan sets which tools a seller can use, how many products they can list, and the platform fee on their sales. Changes apply to every seller on that plan unless they have an override.</p>
    <div class="list">${plans.map(p => planEditor(p)).join('')}</div>
    <h2>New plan</h2>
    ${planEditor({ code: '', name: '', price_monthly: 0, max_products: null, features: {}, commission_percent: 10, active: true, sort_order: plans.length + 1 }, true)}`);
  $$('[data-save-plan]').forEach(btn => btn.addEventListener('click', async () => {
    const k = btn.dataset.k, isNew = btn.dataset.new === 'true';
    const features = Object.fromEntries(FEATURES.map(x => [x, $(`#pk_${k}_${x}`).checked]));
    const body = {
      name: $(`#pn_${k}`).value, pricePerMonth: $(`#pp_${k}`).value, maxProducts: $(`#pm_${k}`).value,
      commissionPercent: $(`#pf_${k}`).value, sortOrder: $(`#ps_${k}`).value, features, active: $(`#pa_${k}`).checked
    };
    try {
      if (isNew) await api('/api/admin/plans', { method: 'POST', body: JSON.stringify({ ...body, code: $(`#pc_${k}`).value }) });
      else await api(`/api/admin/plans/${encodeURIComponent(btn.dataset.savePlan)}`, { method: 'PATCH', body: JSON.stringify(body) });
      toast('Plan saved.');
      route();
    } catch (e) { toast(e.message); }
  }));
}

// ---------- invoices ----------
async function viewInvoices() {
  const { invoices } = await api('/api/admin/invoices');
  setView(`<h1>Invoices</h1>
    <p class="muted">There is no payment provider connected yet. Record payments here once the money has been received.</p>
    <div class="table-wrap"><table class="admin-table">
      <thead><tr><th>Date</th><th>Shop</th><th>Plan</th><th>Amount</th><th>Status</th><th></th></tr></thead>
      <tbody>${invoices.map(i => `<tr>
        <td>${fmtDate(i.created_at)}</td>
        <td>${esc(i.shop_name)}<div class="small muted">${esc(i.seller_email)}</div></td>
        <td>${esc(i.plan_code)} · ${Number(i.months)} mo</td>
        <td>${money(i.amount)}</td>
        <td>${pill(i.status, i.status === 'paid' ? 'ok' : '')}</td>
        <td>${i.status === 'open' ? `<button class="btn primary small" type="button" data-inv="${i.id}" data-to="paid">Mark paid</button> <button class="btn ghost small" type="button" data-inv="${i.id}" data-to="void">Void</button>` : ''}</td>
      </tr>`).join('') || '<tr><td colspan="6">No invoices yet.</td></tr>'}</tbody></table></div>`);
  $$('[data-inv]').forEach(btn => btn.addEventListener('click', async () => {
    try {
      await api(`/api/admin/invoices/${btn.dataset.inv}`, { method: 'PATCH', body: JSON.stringify({ status: btn.dataset.to }) });
      toast('Invoice updated.');
      route();
    } catch (e) { toast(e.message); }
  }));
}

// ---------- orders ----------
async function viewOrders() {
  const { orders } = await api('/api/admin/orders');
  setView(`<h1>Orders</h1>
    <p class="muted">Each shop's part of an order is managed separately. Changes made here notify the buyer.</p>
    <div class="list">${orders.map(o => `<div class="card stack">
      <div class="order-head"><strong>Order #${o.id}</strong><span class="small muted">${fmtDate(o.created_at)} · ${esc(o.buyer_name)} · ${money(o.total)}</span>${pill(o.status)}</div>
      ${o.sellers.map(s => `<div class="product-row">
        <div class="grow"><strong>${esc(s.shop_name)}</strong> ${pill(s.status)} ${pill(s.payment_status, s.payment_status === 'paid' ? 'ok' : '')}
          <div class="small muted">Subtotal ${money(s.subtotal)} · platform fee ${money(s.commission_amount)}</div></div>
        <div class="row-actions">
          <select data-order="${o.id}" data-seller="${s.seller_id}" aria-label="Status for ${esc(s.shop_name)}">${ORDER_STATUSES.map(x => `<option value="${x}" ${x === s.status ? 'selected' : ''}>${x}</option>`).join('')}</select>
          <button class="btn ghost small" type="button" data-pay-order="${o.id}" data-seller="${s.seller_id}" data-next="${s.payment_status === 'paid' ? 'unpaid' : 'paid'}">Mark ${s.payment_status === 'paid' ? 'unpaid' : 'paid'}</button>
        </div></div>`).join('')}
    </div>`).join('') || '<div class="empty">No orders yet.</div>'}</div>`);
  $$('select[data-order]').forEach(sel => sel.addEventListener('change', async () => {
    try {
      await api(`/api/admin/orders/${sel.dataset.order}/sellers/${sel.dataset.seller}`, { method: 'PATCH', body: JSON.stringify({ status: sel.value }) });
      toast('Shop status updated.');
      route();
    } catch (e) { toast(e.message); }
  }));
  $$('[data-pay-order]').forEach(btn => btn.addEventListener('click', async () => {
    try {
      await api(`/api/admin/orders/${btn.dataset.payOrder}/sellers/${btn.dataset.seller}`, { method: 'PATCH', body: JSON.stringify({ paymentStatus: btn.dataset.next }) });
      toast('Payment status updated.');
      route();
    } catch (e) { toast(e.message); }
  }));
}

// ---------- products ----------
async function viewProducts() {
  const { products } = await api('/api/admin/products');
  setView(`<h1>Products</h1>
    <p class="muted">Hide a product to take it off the marketplace. The seller keeps it in their catalogue.</p>
    <div class="table-wrap"><table class="admin-table">
      <thead><tr><th>Product</th><th>Shop</th><th>Price</th><th>Stock</th><th>Visibility</th><th></th></tr></thead>
      <tbody>${products.map(p => `<tr>
        <td>${esc(p.name)}</td><td>${esc(p.shop_name)}</td><td>${money(p.sale_price)}</td><td>${Number(p.stock)}</td>
        <td>${pill(p.active ? 'Live' : 'Hidden', p.active ? 'ok' : '')}</td>
        <td><button class="btn ghost small" type="button" data-prod="${p.id}" data-active="${!p.active}">${p.active ? 'Hide' : 'Show'}</button></td>
      </tr>`).join('') || '<tr><td colspan="6">No products yet.</td></tr>'}</tbody></table></div>`);
  $$('[data-prod]').forEach(btn => btn.addEventListener('click', async () => {
    try {
      await api(`/api/admin/products/${btn.dataset.prod}`, { method: 'PATCH', body: JSON.stringify({ active: btn.dataset.active === 'true' }) });
      toast('Product updated.');
      route();
    } catch (e) { toast(e.message); }
  }));
}

// ---------- email log ----------
async function viewEmails() {
  const { emails, counts, configured } = await api('/api/admin/emails');
  const c = Object.fromEntries(counts.map(x => [x.status, x.count]));
  setView(`<h1>Email log</h1>
    ${configured ? '' : '<div class="notice error">Email sending is not configured yet. Add RESEND_API_KEY and EMAIL_FROM in Render. Messages wait here until then.</div>'}
    <div class="stats">${stat('Waiting', c.pending || 0)}${stat('Sent', c.sent || 0)}${stat('Failed', c.failed || 0)}</div>
    <div class="table-wrap"><table class="admin-table">
      <thead><tr><th>When</th><th>To</th><th>Subject</th><th>Status</th><th>Tries</th><th></th></tr></thead>
      <tbody>${emails.map(m => `<tr>
        <td>${fmtDate(m.created_at)}</td>
        <td>${esc(m.to_email)}<div class="small muted">${esc(KIND_LABELS[m.kind] || m.kind)}</div></td>
        <td>${esc(m.subject)}${m.last_error ? `<div class="small" style="color:#a33">${esc(m.last_error)}</div>` : ''}</td>
        <td>${pill(m.status, m.status === 'sent' ? 'ok' : '')}</td>
        <td>${Number(m.attempts)}</td>
        <td>${m.status === 'failed' ? `<button class="btn ghost small" type="button" data-retry="${m.id}">Retry</button>` : ''}</td>
      </tr>`).join('') || '<tr><td colspan="6">No emails yet.</td></tr>'}</tbody></table></div>`);
  $$('[data-retry]').forEach(btn => btn.addEventListener('click', async () => {
    try {
      await api(`/api/admin/emails/${btn.dataset.retry}/retry`, { method: 'POST' });
      toast('Email queued again.');
      route();
    } catch (e) { toast(e.message); }
  }));
}

// ---------- settings ----------
async function viewSettings() {
  const s = await api('/api/admin/settings');
  setView(`<h1>Settings</h1>
    <form id="emailForm" class="card stack">
      <h2>Email notifications</h2>
      <p class="small muted">Turn a type of email off for the whole marketplace. Emails that are on are queued and sent to the buyer or seller.</p>
      <div class="checks" style="flex-direction:column">
        ${s.emailKinds.map(k => `<label><input type="checkbox" data-kind="${k}" ${s.emails[k] !== false ? 'checked' : ''}> ${esc(KIND_LABELS[k] || k)}</label>`).join('')}
      </div>
      <div><button class="btn primary" type="submit">Save email settings</button></div>
    </form>`);
  $('#emailForm').addEventListener('submit', async e => {
    e.preventDefault();
    const emails = Object.fromEntries($$('[data-kind]').map(x => [x.dataset.kind, x.checked]));
    try {
      await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ emails }) });
      toast('Settings saved.');
    } catch (err) { toast(err.message); }
  });
}

boot();
