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
  if (me.role === 'admin') {
    // Administrators manage the marketplace from /admin, not from a seller shop.
    location.replace('/admin');
    return;
  }
  if (me.role !== 'seller') {
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
const VIEWS = { overview: viewOverview, products: viewProducts, orders: viewOrders, customers: viewCustomers, promos: viewPromos, plan: viewPlan, verify: viewVerify, delivery: viewDelivery, payouts: viewPayouts, messages: viewMessages, returns: viewReturns, account: viewAccount };
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
      <a class="btn ghost small" href="#/products/${p.id}/media">Photos &amp; options</a>
      <button class="btn ghost small" type="button" data-toggle="${p.id}" data-active="${p.active}">${p.active ? 'Hide' : 'Show'}</button>
      <button class="btn danger small" type="button" data-delete="${p.id}">Delete</button>
    </div>
  </div>`;
}

async function viewProducts(parts) {
  if (parts[1] === 'media') return viewMedia(parts[0]);
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

// ---------- verification documents ----------
const DOC_LABELS = { pacra: 'PACRA business registration', tpin: 'TPIN certificate', national_id: 'National ID', other: 'Other document' };
async function viewVerify() {
  const { documents } = await api('/api/seller/documents');
  setView(`<h1>Verification</h1>
    <p class="muted">Upload your business documents. The marketplace reviews them and, once they check out, your shop shows as verified to buyers.</p>
    ${pendingBanner()}
    <form id="docForm" class="card stack">
      <div class="grid2">
        <div class="field"><label for="docKind">Document type</label><select id="docKind">${Object.entries(DOC_LABELS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></div>
        <div class="field"><label for="docFile">File (PDF, JPEG or PNG, up to 5 MB)</label><input id="docFile" type="file" accept="application/pdf,image/jpeg,image/png" required></div>
      </div>
      <div id="docMsg"></div>
      <button class="btn primary" type="submit">Upload document</button>
    </form>
    <h2>Uploaded</h2>
    <div class="list">${documents.map(d => `<div class="card product-row"><div class="grow"><strong>${esc(DOC_LABELS[d.kind] || d.kind)}</strong><div class="small muted">${esc(d.file_name)} · ${fmtDate(d.uploaded_at)}</div></div><button class="btn ghost small" type="button" data-doc-del="${d.id}">Remove</button></div>`).join('') || '<div class="empty">Nothing uploaded yet.</div>'}</div>`);
  $('#docForm').addEventListener('submit', async e => {
    e.preventDefault();
    const file = $('#docFile').files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { $('#docMsg').innerHTML = '<div class="notice error">That file is over 5 MB.</div>'; return; }
    try {
      const res = await fetch(`/api/seller/documents?kind=${encodeURIComponent($('#docKind').value)}&name=${encodeURIComponent(file.name)}`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': file.type }, body: file
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Upload failed.');
      toast('Document uploaded.');
      route();
    } catch (err) { $('#docMsg').innerHTML = `<div class="notice error">${esc(err.message)}</div>`; }
  });
  $('[data-doc-del]').forEach(b => b.addEventListener('click', async () => {
    try { await api(`/api/seller/documents/${b.dataset.docDel}`, { method: 'DELETE' }); toast('Document removed.'); route(); }
    catch (err) { toast(err.message); }
  }));
}

// ---------- delivery areas ----------
async function viewDelivery() {
  const d = await api('/api/seller/delivery');
  const zoneRow = z => `<div class="grid2 zone-row">
      <div class="field"><label>Area or town</label><input class="zName" maxlength="80" value="${esc(z.name || '')}"></div>
      <div class="field"><label>Delivery fee (K)</label><input class="zFee" type="number" min="0" max="50000" step="1" value="${Number(z.fee || 0)}"></div></div>`;
  setView(`<h1>Delivery</h1>
    <p class="muted">Add the areas you deliver to and a fee for each. Buyers pick an area at checkout. With no areas listed, you arrange delivery with each buyer.</p>
    ${pendingBanner()}
    <form id="deliveryForm" class="card stack">
      <div id="zones">${d.zones.map(zoneRow).join('')}</div>
      <div><button class="btn ghost small" type="button" id="addZone">+ Add area</button></div>
      <label class="checks"><input type="checkbox" id="collectOn" ${d.collectionEnabled ? 'checked' : ''}> Allow buyers to collect from me</label>
      <div id="deliveryMsg"></div>
      <button class="btn primary" type="submit">Save delivery settings</button>
    </form>`);
  $('#addZone').addEventListener('click', () => $('#zones').insertAdjacentHTML('beforeend', zoneRow({})));
  $('#deliveryForm').addEventListener('submit', async e => {
    e.preventDefault();
    const zones = $('.zone-row').map(r => ({ name: r.querySelector('.zName').value.trim(), fee: r.querySelector('.zFee').value })).filter(z => z.name);
    try {
      await api('/api/seller/delivery', { method: 'PATCH', body: JSON.stringify({ zones, collectionEnabled: $('#collectOn').checked }) });
      toast('Delivery settings saved.');
      route();
    } catch (err) { $('#deliveryMsg').innerHTML = `<div class="notice error">${esc(err.message)}</div>`; }
  });
}

// ---------- payouts ----------
async function viewPayouts() {
  const d = await api('/api/seller/payouts');
  const canRequest = d.available >= d.minimum && !isPending();
  setView(`<h1>Payouts</h1>
    <p class="muted">Money from completed orders, less the platform fee, plus any delivery fees. Request a payout once you have at least ${money(d.minimum)} available.</p>
    ${pendingBanner()}
    <div class="stats">${stat('Available to request', money(d.available))}${stat('Completed orders not yet paid', d.orders)}</div>
    <form id="payoutForm" class="card stack">
      <p>${d.available >= d.minimum ? `You can request ${money(d.available)} now.` : `You need ${money(d.minimum - d.available)} more in completed sales before you can request a payout.`}</p>
      <div id="payoutMsg"></div>
      <button class="btn primary" type="submit" ${canRequest ? '' : 'disabled'}>Request payout</button>
    </form>
    <h2>History</h2>
    <div class="list">${d.payouts.map(p => `<div class="card product-row"><div class="grow"><strong>${money(p.amount)}</strong> <span class="pill ${p.status === 'paid' ? 'ok' : ''}">${esc(p.status)}</span>
      <div class="small muted">Requested ${fmtDate(p.requested_at)}${p.paid_at ? ` · paid ${fmtDate(p.paid_at)}` : ''}${p.reference ? ` · reference ${esc(p.reference)}` : ''}</div></div></div>`).join('') || '<div class="empty">No payouts yet.</div>'}</div>`);
  $('#payoutForm').addEventListener('submit', async e => {
    e.preventDefault();
    try { await api('/api/seller/payouts', { method: 'POST' }); toast('Payout requested.'); route(); }
    catch (err) { $('#payoutMsg').innerHTML = `<div class="notice error">${esc(err.message)}</div>`; }
  });
}

// ---------- messages with buyers ----------
async function viewMessages(parts) {
  if (parts[0]) return viewThread(parts[0]);
  const { conversations } = await api('/api/conversations');
  setView(`<h1>Messages</h1><p class="muted">Chat with buyers about their orders and products.</p>
    <div class="list">${conversations.map(c => `<a class="card product-row" href="#/messages/${c.id}"><div class="grow"><strong>${esc(c.buyer_name)}${Number(c.unread) ? ` <span class="pill ok">${Number(c.unread)} new</span>` : ''}</strong><div class="small muted">${esc(c.last_message || '')}</div></div></a>`).join('') || '<div class="empty">No messages yet.</div>'}</div>`);
}

async function viewThread(id) {
  const { conversation: c, messages } = await api(`/api/conversations/${id}`);
  const meId = Number(me.id);
  setView(`<a href="#/messages" class="back">← Back to messages</a>
    <h1>${esc(c.buyer_name)}</h1>
    <div id="thread" class="kx-thread" style="max-height:60vh;overflow-y:auto">${messages.map(m => `<div class="kx-bubble ${Number(m.sender_id) === meId ? 'mine' : ''}"><span>${esc(m.body)}</span><small>${fmtDate(m.created_at)}</small></div>`).join('')}</div>
    <form id="replyForm" class="kx-reply" style="display:grid;gap:8px;margin-top:10px">
      <textarea name="body" required maxlength="2000" style="min-height:90px;border:1px solid #dfe5df;border-radius:10px;padding:10px"></textarea>
      <button class="btn primary" type="submit">Send</button>
    </form>`);
  $('#thread').scrollTop = 1e6;
  $('#replyForm').addEventListener('submit', async e => {
    e.preventDefault();
    const body = e.currentTarget.body.value;
    try {
      await api(`/api/conversations/${id}/messages`, { method: 'POST', body: JSON.stringify({ body }) });
      viewThread(id);
    } catch (err) { toast(err.message); }
  });
}

// ---------- returns ----------
async function viewReturns() {
  const { returns } = await api('/api/returns');
  setView(`<h1>Returns</h1>
    <p class="muted">Approve or decline return requests. Once the buyer has sent the item back and you have refunded them, mark the return refunded. That puts the items back into stock.</p>
    ${pendingBanner()}
    <div class="list">${returns.map(r => `<div class="card stack">
      <div class="order-head"><strong>Order #${Number(r.order_id)}</strong><span class="pill">${esc(r.status)}</span></div>
      <div class="small">${esc(r.reason)}</div>
      ${r.decision_note ? `<div class="small muted">Your note: ${esc(r.decision_note)}</div>` : ''}
      <div class="row-actions">
        ${r.status === 'requested' ? `<button class="btn primary small" type="button" data-ret="approve" data-id="${r.id}">Approve</button><button class="btn ghost small" type="button" data-ret="decline" data-id="${r.id}">Decline</button>` : ''}
        ${r.status === 'approved' ? `<button class="btn primary small" type="button" data-ret="refunded" data-id="${r.id}">Mark refunded</button>` : ''}
      </div></div>`).join('') || '<div class="empty">No return requests yet.</div>'}</div>`);
  $('[data-ret]').forEach(b => b.addEventListener('click', async () => {
    let note = '';
    if (b.dataset.ret === 'decline') {
      note = prompt('Why are you declining this return? The buyer will see your reason.') || '';
      if (!note) { toast('Add a short reason before declining.'); return; }
    }
    try {
      await api(`/api/returns/${b.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ action: b.dataset.ret, note }) });
      toast('Return updated.');
      route();
    } catch (err) { toast(err.message); }
  }));
}

// ---------- product photos and options ----------
function variantRow(v = {}) {
  return `<div class="grid2 variant-row" data-id="${v.id ?? ''}">
    <div class="field"><label>Option name</label><input class="vLabel" maxlength="80" value="${esc(v.label || '')}" placeholder="e.g. Size M"></div>
    <div class="field"><label>Stock</label><input class="vStock" type="number" min="0" step="1" value="${Number(v.stock || 0)}"></div>
    <div class="field"><label>Price change (K)</label><input class="vAdjust" type="number" step="1" value="${Number(v.priceAdjust || 0)}"></div></div>`;
}

async function viewMedia(id) {
  const [{ products }, g] = await Promise.all([api('/api/seller/products'), api(`/api/products/${id}/gallery`)]);
  const p = products.find(x => Number(x.id) === Number(id));
  if (!p) { setView('<a href="#/products" class="back">← Back to products</a><div class="notice error">Product not found in your shop.</div>'); return; }
  const locked = isPending() ? 'disabled' : '';
  setView(`<a href="#/products" class="back">← Back to products</a>
    <h1>Photos &amp; options</h1><p class="muted">${esc(p.name)}</p>
    ${pendingBanner()}
    <div class="card stack">
      <h2>Extra photos</h2>
      <p class="small muted">The main photo is set on the product form. Add up to 5 more here. Photos are shown whole, not cropped.</p>
      <div class="photo-row">${g.images.map(i => `<div class="photo-thumb"><img src="${esc(i.url)}" alt="" style="width:110px;height:110px;object-fit:contain;border-radius:12px;background:#f5f6f2"><div><button class="btn ghost small" type="button" data-img-del="${i.id}" ${locked}>Remove</button></div></div>`).join('') || '<span class="muted">No extra photos yet.</span>'}</div>
      <input id="imgFile" type="file" accept="image/jpeg,image/png,image/webp" ${locked}>
      <div id="imgMsg"></div>
      <div><button class="btn primary" type="button" id="imgUpload" ${locked}>Upload photo</button></div>
    </div>
    <form id="variantForm" class="card stack">
      <h2>Options</h2>
      <p class="small muted">Sizes, colours or other choices. Each option has its own stock. With options, the product's stock is the total of all options. Leave the list empty for a product with no options.</p>
      <div id="variants">${g.variants.map(variantRow).join('')}</div>
      <div><button class="btn ghost small" type="button" id="addVariant" ${locked}>+ Add option</button></div>
      <div id="variantMsg"></div>
      <div><button class="btn primary" type="submit" ${locked}>Save options</button></div>
    </form>
    <form id="lowForm" class="card stack">
      <h2>Low-stock alert</h2>
      <div class="field"><label for="lowAt">Email me when stock falls to</label><input id="lowAt" type="number" min="0" max="1000" step="1" value="${Number(p.low_stock_at ?? 3)}" ${locked}></div>
      <div><button class="btn ghost small" type="submit" ${locked}>Save alert level</button></div>
    </form>`);

  $('#imgUpload').addEventListener('click', async () => {
    const file = $('#imgFile').files[0];
    if (!file) { toast('Choose a photo first.'); return; }
    try {
      const blob = await shrinkImage(file);
      const res = await fetch(`/api/seller/products/${id}/images`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Photo upload failed.');
      toast('Photo added.');
      viewMedia(id);
    } catch (err) { $('#imgMsg').innerHTML = `<div class="notice error">${esc(err.message)}</div>`; }
  });
  $('[data-img-del]').forEach(b => b.addEventListener('click', async () => {
    try { await api(`/api/seller/products/${id}/images/${b.dataset.imgDel}`, { method: 'DELETE' }); viewMedia(id); }
    catch (err) { toast(err.message); }
  }));
  $('#addVariant').addEventListener('click', () => $('#variants').insertAdjacentHTML('beforeend', variantRow({})));
  $('#variantForm').addEventListener('submit', async e => {
    e.preventDefault();
    const variants = $('.variant-row').map(r => ({
      id: r.dataset.id ? Number(r.dataset.id) : undefined,
      label: r.querySelector('.vLabel').value.trim(),
      stock: r.querySelector('.vStock').value,
      priceAdjust: r.querySelector('.vAdjust').value
    })).filter(v => v.label);
    try {
      await api(`/api/seller/products/${id}/variants`, { method: 'PUT', body: JSON.stringify({ variants }) });
      toast('Options saved.');
      viewMedia(id);
    } catch (err) { $('#variantMsg').innerHTML = `<div class="notice error">${esc(err.message)}</div>`; }
  });
  $('#lowForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api(`/api/seller/products/${id}/low-stock`, { method: 'PATCH', body: JSON.stringify({ lowStockAt: $('#lowAt').value }) });
      toast('Alert level saved.');
    } catch (err) { toast(err.message); }
  });
}


boot();
