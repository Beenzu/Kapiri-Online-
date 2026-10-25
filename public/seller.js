'use strict';
// Seller dashboard page. Each section is a page with its own URL hash (#/products, #/orders, ...).
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const money = n => 'K' + Number(n || 0).toLocaleString('en-ZM', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LUSAKA = 'Africa/Lusaka';
const fmtDate = ts => ts ? new Date(ts).toLocaleDateString('en-ZM', { timeZone: LUSAKA, day: 'numeric', month: 'short', year: 'numeric' }) : '';
const CATEGORIES = ['Electronics', 'Fashion', 'Home & Living', 'Beauty', 'Food & Grocery', 'Other', 'General'];
const STATUSES = ['pending', 'confirmed', 'processing', 'ready', 'shipped', 'completed', 'cancelled'];
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
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong.');
    err.feature = data.feature || null;
    throw err;
  }
  return data;
}

// Shown in place of a page when the seller's plan does not include it.
function upgradeCard(title, message) {
  return `<h1>${esc(title)}</h1><div class="card stack"><div class="notice">${esc(message)}</div>
    <p class="muted">Your plan and its features are managed by the marketplace administrator. See your plan on the <a href="#/plan">Plan &amp; billing</a> page.</p></div>`;
}

function field(name, label, type, required, hint = '', value = '', attrs = '') {
  return `<div class="field"><label for="f_${name}">${esc(label)}${required ? ' *' : ''}</label>` +
    `<input id="f_${name}" name="${name}" type="${type}" ${required ? 'required' : ''} value="${esc(value)}" ${attrs}>` +
    (hint ? `<small class="muted">${esc(hint)}</small>` : '') + '</div>';
}

const isPending = () => !!me && me.role === 'seller' && me.sellerStatus !== 'approved';
const pendingBanner = () => isPending()
  ? '<div class="notice">Your shop is awaiting approval. You can review your details now. Products, promo codes and customer notes unlock once an administrator approves your account.</div>'
  : '';

function setView(html) { $('#view').innerHTML = html; }
function stat(label, value) { return `<div class="stat"><small>${esc(label)}</small><strong>${value}</strong></div>`; }

// ---------- sign-in ----------
function showAuth(mode = 'login', message = '') {
  const register = mode === 'register';
  $('#pageArea').classList.add('hidden');
  $('#signOutBtn').classList.add('hidden');
  $('#whoami').textContent = '';
  const panel = $('#authPanel');
  panel.classList.remove('hidden');
  panel.innerHTML = `<div class="seller-card auth-card">
    <h1>${register ? 'Open your seller account' : 'Seller sign in'}</h1>
    <p class="muted">${register ? 'Create a business account to sell on Kapiri Online. An administrator approves new shops before products go live.' : 'Sign in to manage your shop, products, orders and customers.'}</p>
    ${message ? `<div class="notice error">${esc(message)}</div>` : ''}
    <form id="authForm" class="stack">
      ${register ? field('name', 'Your full name', 'text', true, '', '', 'maxlength="120" autocomplete="name"') : ''}
      ${register ? field('businessName', 'Business name', 'text', true, '', '', 'maxlength="160"') : ''}
      ${register ? field('location', 'Town / location', 'text', false, '', '', 'maxlength="160"') : ''}
      ${register ? field('phone', 'Phone number', 'tel', false, '', '', 'maxlength="40" autocomplete="tel"') : ''}
      ${field('email', 'Email address', 'email', true, '', '', 'autocomplete="email"')}
      ${field('password', 'Password', 'password', true, 'At least 8 characters', '', `minlength="8" autocomplete="${register ? 'new-password' : 'current-password'}"`)}
      <button class="btn primary" type="submit">${register ? 'Create seller account' : 'Sign in'}</button>
    </form>
    <p class="muted center">${register ? 'Already have an account?' : 'New seller?'} <button class="link" id="authSwitch" type="button">${register ? 'Sign in' : 'Create a seller account'}</button></p>
  </div>`;
  $('#authSwitch').addEventListener('click', () => showAuth(register ? 'login' : 'register'));
  $('#authForm').addEventListener('submit', async e => {
    e.preventDefault();
    const payload = Object.fromEntries(new FormData(e.currentTarget).entries());
    const btn = e.currentTarget.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Please wait…';
    try {
      const data = register
        ? await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ ...payload, role: 'seller' }) })
        : await api('/api/auth/login', { method: 'POST', body: JSON.stringify(payload) });
      me = data.user;
      await boot();
    } catch (err) {
      showAuth(mode, err.message);
    }
  });
}

async function boot() {
  try { me = (await api('/api/me')).user; } catch (e) { me = null; }
  if (!me) return showAuth('login');
  if (me.role !== 'seller' && me.role !== 'admin') {
    return showAuth('login', 'This page is for seller accounts. You are signed in with a buyer account. Sign in with a seller account, or create one.');
  }
  $('#authPanel').innerHTML = '';
  $('#authPanel').classList.add('hidden');
  $('#pageArea').classList.remove('hidden');
  $('#signOutBtn').classList.remove('hidden');
  $('#whoami').textContent = me.businessName || me.name;
  route();
}

$('#signOutBtn').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  me = null;
  location.hash = '';
  showAuth('login');
});

// ---------- router ----------
const VIEWS = { overview: viewOverview, products: viewProducts, orders: viewOrders, customers: viewCustomers, promos: viewPromos, plan: viewPlan, account: viewAccount };
async function route() {
  if (!me) return;
  const parts = (location.hash || '#/overview').replace(/^#\/?/, '').split('/').filter(Boolean);
  const page = VIEWS[parts[0]] ? parts[0] : 'overview';
  $$('#sellerNav a').forEach(a => a.classList.toggle('active', a.dataset.nav === page));
  try {
    await VIEWS[page](parts.slice(1));
  } catch (e) {
    setView(`<div class="notice error">${esc(e.message)}</div>`);
  }
}
window.addEventListener('hashchange', route);

// ---------- overview ----------
async function viewOverview() {
  setView(`<h1>Overview</h1>${pendingBanner()}<div class="stats" id="stats"><div class="muted">Loading…</div></div><div class="section-title"><h2>Recent orders</h2><a href="#/orders" class="small">All orders →</a></div><div id="recent" class="list"><div class="muted">Loading…</div></div>`);
  const [s, o] = await Promise.all([api('/api/seller/summary'), api('/api/orders')]);
  $('#stats').innerHTML = [
    stat('Products', s.products.count),
    stat('Units in stock', s.products.stock),
    stat('Orders', s.orders),
    stat('Customers', s.customers),
    stat('Sales value', money(s.sales))
  ].join('');
  $('#recent').innerHTML = o.orders.slice(0, 5).map(orderCard).join('') || '<div class="empty">No orders yet. Orders from buyers appear here.</div>';
  bindOrderActions();
}

// ---------- products ----------
function productRow(p) {
  const status = !p.active ? '<span class="pill muted-pill">Hidden</span>'
    : Number(p.stock) < 1 ? '<span class="pill warn">Out of stock</span>'
    : '<span class="pill ok">Live</span>';
  const price = p.discount_active
    ? `<s class="muted">${money(p.price)}</s> <strong>${money(p.sale_price)}</strong> <span class="pill sale">-${Number(p.discount_percent)}%</span>`
    : `<strong>${money(p.price)}</strong>`;
  return `<div class="card product-row">
    <div class="thumb">${p.has_image ? `<img src="/api/products/${p.id}/image" alt="">` : '<span>✦</span>'}</div>
    <div class="grow">
      <strong>${esc(p.name)}</strong>
      <div class="small muted">${esc(p.category)} · ${Number(p.stock)} in stock · ${Number(p.sold) || 0} sold</div>
      <div>${price}</div>
    </div>
    <div class="row-actions">
      ${status}
      <a class="btn ghost small" href="#/products/${p.id}">Edit</a>
      <button class="btn ghost small" type="button" data-toggle="${p.id}" data-active="${p.active}">${p.active ? 'Hide' : 'Show'}</button>
      <button class="btn danger small" type="button" data-delete="${p.id}">Delete</button>
    </div>
  </div>`;
}

async function viewProducts(parts) {
  if (parts[0] === 'new') return productForm(null);
  if (parts[0]) return productForm(parts[0]);
  setView(`<div class="head"><h1>Products</h1>${isPending() ? '' : '<a class="btn primary" href="#/products/new">+ Add product</a>'}</div>
    ${pendingBanner()}
    <input id="pSearch" class="search-input" placeholder="Search your products" aria-label="Search your products">
    <p class="muted small" id="pCount"></p>
    <div id="pList" class="list"><div class="muted">Loading…</div></div>`);
  const { products } = await api('/api/seller/products');
  const draw = () => {
    const q = $('#pSearch').value.trim().toLowerCase();
    const rows = products.filter(p => !q || String(p.name).toLowerCase().includes(q) || String(p.category).toLowerCase().includes(q));
    $('#pCount').textContent = `${rows.length} of ${products.length} products`;
    $('#pList').innerHTML = rows.map(productRow).join('') || '<div class="empty">No products yet. Add your first product to start selling.</div>';
    $$('[data-toggle]').forEach(b => b.addEventListener('click', async () => {
      try {
        await api(`/api/seller/products/${b.dataset.toggle}`, { method: 'PATCH', body: JSON.stringify({ active: b.dataset.active !== 'true' }) });
        toast(b.dataset.active === 'true' ? 'Product hidden from the marketplace.' : 'Product is live again.');
        route();
      } catch (e) { toast(e.message); }
    }));
    $$('[data-delete]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Delete this product? Products that have been ordered are hidden instead.')) return;
      try {
        const d = await api(`/api/seller/products/${b.dataset.delete}`, { method: 'DELETE' });
        toast(d.message || 'Product deleted.');
        route();
      } catch (e) { toast(e.message); }
    }));
  };
  $('#pSearch').addEventListener('input', draw);
  draw();
}

async function productForm(id) {
  let p = { name: '', description: '', category: 'General', price: '', stock: 0, discount_percent: 0, discount_ends_at: null, active: true, has_image: false };
  if (id) {
    const { products } = await api('/api/seller/products');
    p = products.find(x => String(x.id) === String(id));
    if (!p) throw new Error('Product not found in your shop.');
  }
  const endsDate = p.discount_ends_at ? new Date(p.discount_ends_at).toLocaleDateString('en-CA', { timeZone: LUSAKA }) : '';
  const disabled = isPending() ? 'disabled' : '';
  setView(`<a href="#/products" class="back">← Back to products</a>
    <h1>${id ? 'Edit product' : 'New product'}</h1>
    ${pendingBanner()}
    <form id="pForm" class="card stack">
      ${field('name', 'Product name', 'text', true, '', p.name, 'maxlength="180"')}
      <div class="field"><label for="f_description">Description</label><textarea id="f_description" rows="4" maxlength="3000">${esc(p.description)}</textarea></div>
      <div class="grid2">
        <div class="field"><label for="f_category">Category</label><select id="f_category">${CATEGORIES.map(c => `<option ${c === p.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
        ${field('price', 'Price (K)', 'number', true, '', p.price, 'step="0.01" min="0"')}
        ${field('stock', 'Stock quantity', 'number', true, '', p.stock, 'step="1" min="0"')}
      </div>
      <h2>Discount</h2>
      <div class="grid2">
        ${field('discountPercent', 'Discount %', 'number', false, '0 means no discount', p.discount_percent, 'min="0" max="90" step="1"')}
        ${field('discountEndsAt', 'Discount ends on', 'date', false, 'Leave blank for no end date', endsDate)}
      </div>
      <label class="check"><input type="checkbox" id="f_active" ${p.active ? 'checked' : ''}> Show this product in the marketplace</label>
      <h2>Photo</h2>
      <div class="photo-row">
        <div class="photo-preview">${p.has_image ? `<img src="/api/products/${p.id}/image" alt="Current product photo">` : 'No photo yet'}</div>
        <div class="grow">
          <input type="file" id="f_photo" accept="image/jpeg,image/png,image/webp">
          <p class="muted small">JPEG, PNG or WebP. Large photos are resized automatically.</p>
          ${id && p.has_image ? '<button type="button" class="btn ghost small" id="removePhoto">Remove photo</button>' : ''}
        </div>
      </div>
      <div id="pMsg"></div>
      <button class="btn primary" type="submit" ${disabled}>Save product</button>
    </form>`);

  $('#removePhoto')?.addEventListener('click', async () => {
    try { await api(`/api/seller/products/${id}/image`, { method: 'DELETE' }); toast('Photo removed.'); route(); }
    catch (e) { toast(e.message); }
  });
  $('#pForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.currentTarget.querySelector('button[type=submit]');
    const endsAt = $('#f_discountEndsAt').value;
    const body = {
      name: $('#f_name').value,
      description: $('#f_description').value,
      category: $('#f_category').value,
      price: $('#f_price').value,
      stock: $('#f_stock').value,
      discountPercent: $('#f_discountPercent').value || 0,
      discountEndsAt: endsAt ? `${endsAt}T23:59:59+02:00` : null,
      active: $('#f_active').checked
    };
    btn.disabled = true;
    btn.textContent = 'Saving…';
    let pid = id;
    try {
      if (id) await api(`/api/seller/products/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      else pid = (await api('/api/seller/products', { method: 'POST', body: JSON.stringify(body) })).product.id;
    } catch (err) {
      $('#pMsg').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
      btn.disabled = false;
      btn.textContent = 'Save product';
      return;
    }
    const file = $('#f_photo').files[0];
    if (file) {
      try {
        await uploadPhoto(pid, file);
      } catch (err) {
        // The product is saved. Send the seller back to edit it so the photo can be retried.
        toast(`Product saved, but the photo was not uploaded: ${err.message}`);
        location.hash = `#/products/${pid}`;
        return;
      }
    }
    toast('Product saved.');
    location.hash = '#/products';
  });
}

async function shrinkImage(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Choose a JPEG, PNG or WebP image.');
  const img = await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const el = new Image();
    el.onload = () => { URL.revokeObjectURL(url); resolve(el); };
    el.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image.')); };
    el.src = url;
  });
  const scale = Math.min(1, 1200 / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  if (!blob || blob.size > 2 * 1024 * 1024) throw new Error('That photo is still too large after resizing. Try a smaller photo.');
  return blob;
}

async function uploadPhoto(productId, file) {
  const blob = await shrinkImage(file);
  const res = await fetch(`/api/seller/products/${productId}/image`, {
    method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'image/jpeg' }, body: blob
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Photo upload failed.');
}

// ---------- orders ----------
function orderCard(o) {
  const items = (o.items || []).map(i => `${esc(i.product_name)} × ${Number(i.quantity)} @ ${money(i.unit_price)}${i.promo_code ? ` <span class="tag">${esc(i.promo_code)}</span>` : ''}`).join('<br>');
  // The status and payment shown are this shop's own part of the order, not the whole order.
  const status = o.seller_status ?? o.status;
  const payment = o.seller_payment_status ?? o.payment_status;
  const share = o.seller_subtotal ?? o.seller_total ?? o.total;
  const fee = o.seller_commission;
  const paid = payment === 'paid';
  const finished = status === 'completed' || status === 'cancelled';
  return `<div class="card order">
    <div class="order-head"><strong>Order #${o.id}</strong><span class="small muted">${fmtDate(o.created_at)}</span></div>
    <div class="grid2">
      <div><div class="small muted">Buyer</div>${esc(o.buyer_name || 'Customer')} · ${esc(o.delivery_phone || '')}<div class="small">${esc(o.delivery_address || '')}</div></div>
      <div><div class="small muted">Your part of this order</div><strong>${money(share)}</strong>
        ${fee !== undefined ? `<div class="small muted">Platform fee ${money(fee)} · you receive ${money(Number(share) - Number(fee))}</div>` : ''}
        <div class="small muted">${esc(String(o.payment_method || '').replace(/_/g, ' '))} · ${paid ? 'Paid' : 'Unpaid'}</div></div>
    </div>
    <div class="small items">${items}</div>
    ${o.notes ? `<div class="small muted">Note from buyer: ${esc(o.notes)}</div>` : ''}
    <div class="order-actions">
      <label class="small">Status
        <select data-status="${o.id}" ${finished ? 'disabled' : ''}><option value="">Update…</option>${STATUSES.map(s => `<option value="${s}" ${status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
      </label>
      <button class="btn ghost small" type="button" data-pay="${o.id}" data-next="${paid ? 'unpaid' : 'paid'}" ${status === 'cancelled' ? 'disabled' : ''}>Mark ${paid ? 'unpaid' : 'paid'}</button>
      <span class="pill">${esc(status)}</span>
    </div>
  </div>`;
}

function bindOrderActions() {
  $$('[data-status]').forEach(sel => sel.addEventListener('change', async () => {
    if (!sel.value) return;
    try {
      await api(`/api/seller/orders/${sel.dataset.status}/status`, { method: 'PATCH', body: JSON.stringify({ status: sel.value }) });
      toast('Order status updated.');
    } catch (e) { toast(e.message); }
    route();
  }));
  $$('[data-pay]').forEach(b => b.addEventListener('click', async () => {
    try {
      await api(`/api/seller/orders/${b.dataset.pay}/payment`, { method: 'PATCH', body: JSON.stringify({ paymentStatus: b.dataset.next }) });
      toast('Payment status updated.');
    } catch (e) { toast(e.message); }
    route();
  }));
}

async function viewOrders() {
  setView(`<h1>Orders</h1>${pendingBanner()}<div id="oList" class="list"><div class="muted">Loading…</div></div>`);
  const { orders } = await api('/api/orders');
  $('#oList').innerHTML = orders.map(orderCard).join('') || '<div class="empty">No orders yet. Orders from buyers appear here.</div>';
  bindOrderActions();
}

// ---------- customers (CRM) ----------
function customerCard(c) {
  const disabled = isPending() ? 'disabled' : '';
  const phone = c.delivery_phone || c.account_phone || 'No phone';
  return `<div class="card customer">
    <div class="customer-head">
      <div><strong>${esc(c.name)}</strong><div class="small muted">${esc(phone)} · ${esc(c.email)}</div></div>
      <div class="stat-mini">${Number(c.orders_count)} order${Number(c.orders_count) === 1 ? '' : 's'}<strong>${money(c.spent)}</strong></div>
    </div>
    <div class="small muted">Last order: ${fmtDate(c.last_order_at) || '—'}${c.delivery_address ? ` · ${esc(c.delivery_address)}` : ''}</div>
    <div class="field"><label for="n_${c.id}">Your private notes</label><textarea id="n_${c.id}" rows="2" maxlength="2000" ${disabled}>${esc(c.notes)}</textarea></div>
    <button class="btn ghost small" type="button" data-save-notes="${c.id}" ${disabled}>Save notes</button>
  </div>`;
}

async function viewCustomers() {
  let customers;
  try {
    ({ customers } = await api('/api/seller/customers'));
  } catch (e) {
    if (e.feature) return setView(upgradeCard('Customers', e.message));
    throw e;
  }
  setView(`<h1>Customers</h1>
    <p class="muted">Everyone who has bought from your shop, with their order history and your private notes.</p>
    ${pendingBanner()}
    <input id="cSearch" class="search-input" placeholder="Search by name, phone or email" aria-label="Search customers">
    <div id="cList" class="list"><div class="muted">Loading…</div></div>`);
  const draw = () => {
    const q = $('#cSearch').value.trim().toLowerCase();
    const rows = customers.filter(c => !q || [c.name, c.email, c.delivery_phone, c.account_phone].some(x => String(x || '').toLowerCase().includes(q)));
    $('#cList').innerHTML = rows.map(customerCard).join('') || '<div class="empty">No customers yet.</div>';
    $$('[data-save-notes]').forEach(b => b.addEventListener('click', async () => {
      try {
        await api(`/api/seller/customers/${b.dataset.saveNotes}/notes`, { method: 'PUT', body: JSON.stringify({ notes: $(`#n_${b.dataset.saveNotes}`).value }) });
        toast('Notes saved.');
      } catch (e) { toast(e.message); }
    }));
  };
  $('#cSearch').addEventListener('input', draw);
  draw();
}

// ---------- promo codes ----------
function promoRow(p) {
  const expired = p.ends_at && new Date(p.ends_at) < new Date();
  const usedUp = p.max_uses !== null && p.uses >= p.max_uses;
  const status = !p.active ? 'Paused' : expired ? 'Expired' : usedUp ? 'Used up' : 'Active';
  return `<div class="card product-row">
    <div class="grow">
      <strong>${esc(p.code)}</strong> <span class="pill">${Number(p.percent_off)}% off</span>
      <div class="small muted">Used ${Number(p.uses)}${p.max_uses !== null ? ` of ${Number(p.max_uses)}` : ''} · ${p.ends_at ? `Ends ${fmtDate(p.ends_at)}` : 'No end date'}</div>
    </div>
    <div class="row-actions">
      <span class="pill ${status === 'Active' ? 'ok' : 'muted-pill'}">${status}</span>
      <button class="btn ghost small" type="button" data-promo-toggle="${p.id}" data-active="${p.active}">${p.active ? 'Pause' : 'Activate'}</button>
    </div>
  </div>`;
}

async function viewPromos() {
  const pending = isPending();
  const { plan } = await api('/api/seller/plan');
  if (!plan.features.promos) return setView(upgradeCard('Promo codes', `Promo codes are not included in your ${plan.planName} plan.`));
  setView(`<h1>Promo codes</h1>
    <p class="muted">A promo code takes a percentage off your products only. Buyers enter it at checkout.</p>
    ${pendingBanner()}
    ${pending ? '' : `<form id="promoForm" class="card stack">
      <h2>New promo code</h2>
      <div class="grid2">
        ${field('code', 'Code', 'text', true, 'Letters, numbers, dashes or underscores', '', 'maxlength="40" autocomplete="off" style="text-transform:uppercase"')}
        ${field('percentOff', 'Percent off', 'number', true, '1 to 90', '', 'min="1" max="90" step="1"')}
        ${field('endsAt', 'Ends on', 'date', false, 'Leave blank for no end date')}
        ${field('maxUses', 'Maximum uses', 'number', false, 'Leave blank for unlimited', '', 'min="1" step="1"')}
      </div>
      <div id="promoMsg"></div>
      <button class="btn primary" type="submit">Create promo code</button>
    </form>`}
    <h2>Your codes</h2>
    <div id="promoList" class="list"><div class="muted">Loading…</div></div>`);

  const { promos } = await api('/api/seller/promos');
  $('#promoList').innerHTML = promos.map(promoRow).join('') || '<div class="empty">No promo codes yet.</div>';
  $$('[data-promo-toggle]').forEach(b => b.addEventListener('click', async () => {
    try {
      await api(`/api/seller/promos/${b.dataset.promoToggle}`, { method: 'PATCH', body: JSON.stringify({ active: b.dataset.active !== 'true' }) });
      toast('Promo code updated.');
      route();
    } catch (e) { toast(e.message); }
  }));
  $('#promoForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const endsAt = $('#f_endsAt').value;
    const body = {
      code: $('#f_code').value,
      percentOff: $('#f_percentOff').value,
      endsAt: endsAt ? `${endsAt}T23:59:59+02:00` : null,
      maxUses: $('#f_maxUses').value || null
    };
    try {
      await api('/api/seller/promos', { method: 'POST', body: JSON.stringify(body) });
      toast('Promo code created.');
      route();
    } catch (err) {
      $('#promoMsg').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
    }
  });
}

// ---------- plan and billing ----------
const FEATURE_NAMES = { crm: 'Customer CRM', promos: 'Promo codes', discounts: 'Product discounts', seller_emails: 'Order email alerts' };
async function viewPlan() {
  const d = await api('/api/seller/plan');
  const p = d.plan;
  const limit = p.maxProducts === null ? 'Unlimited' : `${p.maxProducts}`;
  const feats = Object.entries(FEATURE_NAMES).map(([k, label]) => `<li>${p.features[k] ? '✓' : '—'} ${esc(label)}</li>`).join('');
  const plans = d.plans.map(x => `<div class="plan-option ${x.code === p.planCode ? 'current' : ''}"><strong>${esc(x.name)}</strong>
      <div class="small">${Number(x.price_monthly) === 0 ? 'Free' : money(x.price_monthly) + ' / month'}</div>
      <div class="small muted">${x.max_products === null ? 'Unlimited products' : `Up to ${x.max_products} products`} · platform fee ${Number(x.commission_percent)}%</div>
      ${x.code === p.planCode ? '<span class="pill ok">Your plan</span>' : ''}</div>`).join('');
  const invoices = d.invoices.map(i => `<div class="card product-row"><div class="grow"><strong>${money(i.amount)}</strong> · ${esc(i.plan_code)} · ${Number(i.months)} month(s)
      <div class="small muted">${fmtDate(i.created_at)} · ${i.status === 'paid' ? `Paid ${fmtDate(i.paid_at)}` : 'Awaiting payment'}</div></div>
      <span class="pill ${i.status === 'paid' ? 'ok' : ''}">${esc(i.status)}</span></div>`).join('') || '<div class="empty">No invoices yet.</div>';
  setView(`<h1>Plan &amp; billing</h1>
    <p class="muted">Your plan controls which tools are available in your shop. The marketplace administrator changes plans and records payments.</p>
    ${pendingBanner()}
    <div class="card stack">
      <h2>Current plan: ${esc(p.planName)}</h2>
      <div class="grid2">
        ${stat('Products used', `${d.usage.products} of ${limit}`)}
        ${stat('Valid until', p.expiresAt ? fmtDate(p.expiresAt) : (p.planPrice === 0 ? 'No expiry' : '—'))}
      </div>
      ${p.expired ? '<div class="notice error">Your paid plan has expired, so your shop is on the Free plan. Contact the administrator to renew.</div>' : ''}
      <ul class="feature-list">${feats}</ul>
      <p class="small muted">Platform fee on your sales: ${Number(p.commissionPercent)}%</p>
    </div>
    <h2>Plans</h2>
    <div class="plan-grid">${plans}</div>
    <h2>Invoices</h2>
    <div class="list">${invoices}</div>`);
}

// ---------- account ----------
async function viewAccount() {
  const u = me;
  const isSeller = u.role === 'seller';
  setView(`<h1>Account</h1>
    <form id="detailsForm" class="card stack">
      <h2>Personal details</h2>
      ${field('name', 'Your full name', 'text', true, '', u.name, 'maxlength="120"')}
      ${field('phone', 'Phone number', 'tel', false, '', u.phone || '', 'maxlength="40"')}
      ${field('email', 'Email address', 'email', true, 'Changing your email requires your current password', u.email)}
      ${isSeller ? `<h2>Business details</h2>
        ${field('businessName', 'Business name', 'text', true, '', u.businessName || '', 'maxlength="160"')}
        ${field('location', 'Town / location', 'text', false, '', u.location || '', 'maxlength="160"')}
        <div class="field"><label for="f_businessDescription">About your business</label><textarea id="f_businessDescription" rows="3" maxlength="1000">${esc(u.businessDescription || '')}</textarea></div>` : ''}
      <div id="detailsMsg"></div>
      <button class="btn primary" type="submit">Save details</button>
    </form>
    <form id="passwordForm" class="card stack">
      <h2>Change password</h2>
      ${field('currentPassword', 'Current password', 'password', true, '', '', 'autocomplete="current-password"')}
      ${field('newPassword', 'New password', 'password', true, 'At least 8 characters', '', 'minlength="8" autocomplete="new-password"')}
      ${field('confirmPassword', 'Confirm new password', 'password', true, '', '', 'minlength="8" autocomplete="new-password"')}
      <div id="passwordMsg"></div>
      <button class="btn primary" type="submit">Change password</button>
    </form>`);

  $('#detailsForm').addEventListener('submit', async e => {
    e.preventDefault();
    const body = { name: $('#f_name').value, phone: $('#f_phone').value, email: $('#f_email').value };
    if (isSeller) {
      body.businessName = $('#f_businessName').value;
      body.location = $('#f_location').value;
      body.businessDescription = $('#f_businessDescription').value;
    }
    // Only ask for the current password when the email is actually changing.
    if (body.email !== u.email) {
      const current = prompt('To change your email, enter your current password:');
      if (!current) return;
      body.currentPassword = current;
    }
    try {
      const d = await api('/api/account', { method: 'PATCH', body: JSON.stringify(body) });
      me = d.user;
      $('#whoami').textContent = me.businessName || me.name;
      toast(d.message);
      route();
    } catch (err) {
      $('#detailsMsg').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
    }
  });

  $('#passwordForm').addEventListener('submit', async e => {
    e.preventDefault();
    const newPassword = $('#f_newPassword').value;
    if (newPassword !== $('#f_confirmPassword').value) {
      $('#passwordMsg').innerHTML = '<div class="notice error">The new passwords do not match.</div>';
      return;
    }
    try {
      const d = await api('/api/account', { method: 'PATCH', body: JSON.stringify({ currentPassword: $('#f_currentPassword').value, newPassword }) });
      me = d.user;
      toast('Your password has been changed.');
      e.currentTarget.reset();
      $('#passwordMsg').innerHTML = '';
    } catch (err) {
      $('#passwordMsg').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
    }
  });
}

boot();
