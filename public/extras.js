'use strict';
// Buyer features added in the second stage: email verification, password reset, shop pages and follows,
// messages with shops, product photos and options, checkout with delivery areas, returns and receipts.
// Loaded after app.js. It replaces a few of app.js's functions with versions that know about these features.
(function () {
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const call = (url, method = 'GET', body) => api(url, { method, body: body ? JSON.stringify(body) : undefined });
  const when = ts => new Date(ts).toLocaleString('en-ZM', { timeZone: 'Africa/Lusaka', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const PAYMENT_LABELS = { pay_on_delivery: 'Pay on delivery', mobile_money_manual: 'Mobile money (arranged with the shop)', bank_transfer_manual: 'Bank transfer (arranged with the shop)' };

  // ----- banner for unverified accounts -----
  function setBanner(html) {
    let el = $('#kxBanner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'kxBanner';
      el.className = 'kx-banner';
      $('.header').after(el);
    }
    el.innerHTML = html;
  }

  // ----- startup: verification and reset links from email -----
  async function init() {
    const params = new URLSearchParams(location.search);
    const verify = params.get('verify'), reset = params.get('reset');
    if (verify || reset) history.replaceState({}, '', '/');
    if (verify) {
      try { toast((await call('/api/auth/verify-email', 'POST', { token: verify })).message); }
      catch (e) { toast(e.message); }
    }
    if (reset) showResetForm(reset);
    try {
      const me = (await call('/api/me')).user;
      if (me && me.role === 'buyer' && me.emailVerified === false) {
        setBanner(`<span>Please verify your email address to place orders and message shops.</span>
          <button class="kx-link" data-kx="resend" type="button">Resend verification email</button>`);
      }
    } catch (e) { /* not signed in or offline: nothing to show */ }
  }

  // ----- sign-in modal: forgot password -----
  const originalAuthModal = window.authModal;
  window.authModal = function (mode = 'login', role = 'buyer', message = '') {
    originalAuthModal(mode, role, message);
    if (mode === 'login') {
      $('#modalContent').insertAdjacentHTML('beforeend', '<p class="kx-center"><button class="kx-link" data-kx="forgot" type="button">Forgot your password?</button></p>');
    }
  };

  function showForgotForm() {
    showModal(`<h2 id="modalTitle">Reset your password</h2>
      <p class="modal-intro">Enter the email address on your account and we will send you a link.</p>
      <div id="kxMsg"></div>
      <form id="kxForgot" class="kx-form"><div class="field"><label for="kxEmail">Email address</label><input id="kxEmail" name="email" type="email" required></div>
      <button class="form-submit" type="submit">Send reset link</button></form>`);
  }

  function showResetForm(token) {
    showModal(`<h2 id="modalTitle">Choose a new password</h2>
      <p class="modal-intro">Use at least 8 characters.</p>
      <div id="kxMsg"></div>
      <form id="kxReset" class="kx-form" data-token="${esc(token)}">
        <div class="field"><label for="kxPw">New password</label><input id="kxPw" name="password" type="password" minlength="8" required></div>
        <div class="field"><label for="kxPw2">Confirm new password</label><input id="kxPw2" name="confirm" type="password" minlength="8" required></div>
        <button class="form-submit" type="submit">Save new password</button></form>`);
  }

  // ----- product detail with photos and options -----
  window.openProduct = async function (id) {
    let p = allProducts().find(x => Number(x.id) === Number(id));
    try { if (!p) p = (await call(`/api/products/${id}`)).product; } catch (e) { return toast(e.message); }
    if (!p) return;
    const g = await call(`/api/products/${id}/gallery`).catch(() => ({ images: [], variants: [] }));
    const photos = [imageHtml(p), ...g.images.map(i => `<img loading="lazy" src="${esc(i.url)}" alt="${esc(p.name)}">`)];
    const thumbs = photos.length > 1 ? `<div class="kx-thumbs">${photos.map((_, i) => `<button type="button" data-photo="${i}" aria-label="Photo ${i + 1}">${photos[i]}</button>`).join('')}</div>` : '';
    const options = g.variants.length ? `<div class="field"><label for="kxOption">Choose an option</label><select id="kxOption">
        <option value="">Select…</option>${g.variants.map(v => `<option value="${v.id}" ${v.stock < 1 ? 'disabled' : ''}>${esc(v.label)}${v.priceAdjust ? ` (${v.priceAdjust > 0 ? '+' : ''}${money(v.priceAdjust)})` : ''}${v.stock < 1 ? ' · sold out' : ''}</option>`).join('')}
      </select></div>` : '';
    showModal(`<span class="shop-label">${esc(p.category || 'General')}</span>
      <div class="kx-main" id="kxMain">${photos[0]}</div>${thumbs}
      <h2 id="modalTitle">${esc(p.name)}</h2>
      <p class="muted">Sold by <button class="kx-link" data-kx="shop" data-id="${p.seller_id}" type="button">${esc(p.business_name || 'a local shop')}</button></p>
      <div class="product-detail-price">${money(p.sale_price ?? p.price)}</div>
      ${options}
      <p class="product-detail-desc">${esc(p.description || '')}</p>
      <button class="form-submit" id="kxAdd" type="button">Add to cart</button>`);
    $$('[data-photo]').forEach(b => b.addEventListener('click', () => { $('#kxMain').innerHTML = photos[Number(b.dataset.photo)]; }));
    $('#kxAdd').addEventListener('click', () => {
      const v = $('#kxOption') ? $('#kxOption').value : null;
      if (g.variants.length && !v) return toast('Choose an option first.');
      addToCart(id, v || null);
    });
  };

  // Adds to the cart, keeping each option as its own line.
  window.addToCart = async function (id, variantId) {
    let product = allProducts().find(x => Number(x.id) === Number(id));
    try { if (!product) product = (await call(`/api/products/${id}`)).product; } catch (e) { return toast(e.message); }
    if (!product) return;
    const g = await call(`/api/products/${id}/gallery`).catch(() => ({ variants: [] }));
    if (g.variants.length && (variantId === null || variantId === undefined)) return openProduct(id);
    const variant = variantId ? g.variants.find(v => v.id === Number(variantId)) : null;
    const available = variant ? variant.stock : Number(product.stock);
    if (available < 1) return toast('This product is currently out of stock.');
    const vid = variant ? variant.id : null;
    const existing = state.cart.find(x => Number(x.id) === Number(id) && (x.variantId ?? null) === vid);
    if (existing) {
      if (existing.quantity >= available) return toast('You already have all that is in stock.');
      existing.quantity++;
    } else {
      state.cart.push({ id: Number(id), variantId: vid, label: variant ? variant.label : '', quantity: 1 });
    }
    refreshCart();
    toast(variant ? `Added ${product.name} (${variant.label}) to your cart.` : `Added ${product.name} to your cart.`);
  };

  // ----- checkout with a delivery choice for each shop -----
  window.checkoutModal = async function () {
    if (!state.user) return authModal('login');
    if (state.user.role !== 'buyer') return toast('Please sign in with a buyer account to place an order.');
    if (!state.cart.length) return toast('Your cart is empty.');
    if (state.user.emailVerified === false) return toast('Verify your email address first. Check your inbox for the link.');
    showModal('<h2 id="modalTitle">Delivery & checkout</h2><div class="no-items">Loading your order…</div>');
    try {
      const products = {};
      for (const id of [...new Set(state.cart.map(x => Number(x.id)))]) products[id] = (await call(`/api/products/${id}`)).product;
      const gallery = {};
      for (const id of Object.keys(products)) gallery[id] = await call(`/api/products/${id}/gallery`).catch(() => ({ variants: [] }));
      const sellerIds = [...new Set(Object.values(products).map(p => Number(p.seller_id)))];
      const shops = Object.fromEntries((await Promise.all(sellerIds.map(sid => call(`/api/shops/${sid}`)))).map(d => [d.shop.id, d.shop]));
      let subtotal = 0;
      for (const line of state.cart) {
        const p = products[line.id];
        const adjust = line.variantId ? ((gallery[line.id].variants.find(v => v.id === line.variantId) || {}).priceAdjust || 0) : 0;
        subtotal += (Number(p.sale_price ?? p.price) + adjust) * line.quantity;
      }
      const shopRows = sellerIds.map(sid => {
        const s = shops[sid];
        const opts = s.zones.length
          ? s.zones.map(z => `<option value="${esc(z.name)}" data-fee="${Number(z.fee)}">${esc(z.name)} · ${money(z.fee)}</option>`).join('')
          : '<option value="" data-fee="0">Delivery arranged with the shop</option>';
        const collect = s.collectionEnabled ? '<option value="__collect__" data-fee="0">Collect from the shop</option>' : '';
        return `<div class="field"><label for="kxZone_${sid}">${esc(s.name)} · delivery</label><select id="kxZone_${sid}" data-shop="${sid}">${opts}${collect}</select></div>`;
      }).join('');
      showModal(`<h2 id="modalTitle">Delivery & checkout</h2>
        <p class="modal-intro">Choose how each shop delivers its part of your order.</p>
        <div id="kxMsg"></div>
        <form id="kxCheckout" class="kx-form">
          <div class="field"><label for="kxName">Recipient full name</label><input id="kxName" name="deliveryName" required value="${esc(state.user.name)}"></div>
          <div class="field"><label for="kxPhone">Phone number</label><input id="kxPhone" name="deliveryPhone" required value="${esc(state.user.phone || '')}"></div>
          <div class="field"><label for="kxAddr">Delivery address or collection point</label><textarea id="kxAddr" name="deliveryAddress" required></textarea></div>
          ${shopRows}
          <div class="field"><label for="kxPay">Payment method</label><select id="kxPay" name="paymentMethod">
            ${Object.entries(PAYMENT_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
          <div class="field"><label for="kxPromo">Promo code (optional)</label><input id="kxPromo" name="promoCode" style="text-transform:uppercase"></div>
          <p class="kx-total">Items <span>${money(subtotal)}</span> · Delivery <span id="kxFees">K0.00</span><br><small class="muted">Promo codes and item options are applied when the order is placed.</small></p>
          <button class="form-submit" type="submit">Place order</button>
        </form>`);
      const recalc = () => {
        const fees = $$('select[data-shop]').reduce((sum, sel) => sum + Number(sel.selectedOptions[0] ? sel.selectedOptions[0].dataset.fee : 0), 0);
        $('#kxFees').textContent = money(fees);
      };
      $$('select[data-shop]').forEach(sel => sel.addEventListener('change', recalc));
      recalc();
    } catch (e) {
      showModal(`<h2 id="modalTitle">Checkout</h2><div class="form-error">${esc(e.message)}</div>`);
    }
  };

  // ----- orders with shop status, receipts, returns and messages -----
  window.openOrders = async function () {
    if (!state.user) return authModal('login');
    showModal(`<h2 id="modalTitle">Your orders</h2><p class="modal-intro">Each shop confirms and delivers its part of your order separately.</p>
      <div id="kxOrders" class="dashboard-list"><div class="no-items">Loading orders…</div></div>`);
    try {
      const [{ orders }, { returns }] = await Promise.all([call('/api/orders'), call('/api/returns')]);
      const returnFor = new Map(returns.map(r => [`${r.order_id}:${r.seller_id}`, r]));
      if (!orders.length) { $('#kxOrders').innerHTML = '<div class="no-items">No orders yet. Your purchases will appear here.</div>'; return; }
      $('#kxOrders').innerHTML = orders.map(o => {
        const live = o.sellers || [];
        const cancellable = o.status !== 'cancelled' && live.filter(s => s.status !== 'cancelled').every(s => s.status === 'pending');
        const parts = live.map(s => {
          const r = returnFor.get(`${o.id}:${s.seller_id}`);
          const actions = [
            `<button class="mini-btn" type="button" data-kx="message" data-seller="${s.seller_id}" data-name="${esc(s.shop_name)}">Message shop</button>`,
            s.status === 'completed' && !r ? `<button class="mini-btn" type="button" data-kx="return" data-order="${o.id}" data-seller="${s.seller_id}">Return an item</button>` : '',
            r ? `<span class="order-status">Return: ${esc(r.status)}</span>` : '',
            r && r.status === 'declined' ? `<button class="mini-btn" type="button" data-kx="escalate" data-id="${r.id}">Ask marketplace to review</button>` : ''
          ].join('');
          return `<div class="kx-part"><div><button class="kx-link" data-kx="shop" data-id="${s.seller_id}" type="button">${esc(s.shop_name)}</button>
              · <b>${esc(s.status)}</b> · payment ${esc(s.payment_status)} · ${money(s.subtotal)}
              ${s.delivery_method === 'collect' ? ' · collection' : s.delivery_zone ? ` · ${esc(s.delivery_zone)}${Number(s.delivery_fee) ? ' (' + money(s.delivery_fee) + ')' : ''}` : ''}</div>
            <div class="kx-actions">${actions}</div></div>`;
        }).join('');
        return `<div class="dash-item"><div class="dash-copy"><strong>Order #${o.id} · ${money(o.total)}</strong>
            <small>${new Date(o.created_at).toLocaleDateString()} · ${esc(o.delivery_address || '')}</small>${parts}
            <small>${(o.items || []).map(i => esc(i.product_name) + (i.variant_label ? ' (' + esc(i.variant_label) + ')' : '') + ' × ' + i.quantity).join(', ')}</small></div>
          <div class="kx-col">${cancellable ? `<button class="mini-btn danger" type="button" data-kx="cancel" data-id="${o.id}">Cancel</button>` : ''}
            <a class="mini-btn" href="/api/orders/${o.id}/receipt" target="_blank" rel="noopener">Receipt</a>
            <span class="order-status">${esc(o.status)}</span></div></div>`;
      }).join('');
    } catch (e) { $('#kxOrders').innerHTML = `<div class="form-error">${esc(e.message)}</div>`; }
  };

  function showReturnForm(orderId, sellerId) {
    showModal(`<h2 id="modalTitle">Return an item</h2>
      <p class="modal-intro">Tell the shop what is wrong or why you want to return it. They will reply in your messages.</p>
      <div id="kxMsg"></div>
      <form id="kxReturn" class="kx-form" data-order="${orderId}" data-seller="${sellerId}">
        <div class="field"><label for="kxReason">Reason</label><textarea id="kxReason" name="reason" required minlength="5" maxlength="1000"></textarea></div>
        <button class="form-submit" type="submit">Send return request</button></form>`);
  }

  // ----- shop page -----
  window.openShop = async function (id) {
    showModal('<div id="kxShop" class="dashboard-list"><div class="no-items">Loading shop…</div></div>');
    try {
      const [{ shop }, { products }] = await Promise.all([call(`/api/shops/${id}`), call(`/api/shops/${id}/products`)]);
      const isBuyer = state.user && state.user.role === 'buyer';
      const zones = shop.zones.length ? shop.zones.map(z => `${esc(z.name)} (${money(z.fee)})`).join(', ') : 'Arranged with the shop';
      $('#kxShop').innerHTML = `<h2 id="modalTitle">${esc(shop.name)} ${shop.verified ? '<span class="kx-badge ok">Verified</span>' : ''}</h2>
        <p class="muted">${esc(shop.location || '')}${shop.reviewCount ? ` · ★ ${Number(shop.rating).toFixed(1)} (${shop.reviewCount})` : ''} · ${shop.followers} follower${shop.followers === 1 ? '' : 's'} · ${shop.products} product${shop.products === 1 ? '' : 's'}</p>
        <p>${esc(shop.description || '')}</p>
        <p class="small muted">Delivery: ${zones}${shop.collectionEnabled ? ' · collection available' : ''}</p>
        ${isBuyer ? `<div class="kx-actions">
            <button class="mini-btn" type="button" data-kx="${shop.following ? 'unfollow' : 'follow'}" data-id="${shop.id}">${shop.following ? 'Following' : 'Follow shop'}</button>
            <button class="mini-btn" type="button" data-kx="message" data-seller="${shop.id}" data-name="${esc(shop.name)}">Message shop</button></div>` : ''}
        <div class="kx-grid">${products.map(p => `<button class="kx-tile" type="button" data-kx="product" data-id="${p.id}">${imageHtml(p)}<span>${esc(p.name)}</span><b>${money(p.sale_price ?? p.price)}</b></button>`).join('') || '<div class="no-items">No products yet.</div>'}</div>`;
    } catch (e) { $('#kxShop').innerHTML = `<div class="form-error">${esc(e.message)}</div>`; }
  };

  // ----- messages -----
  window.openMessages = async function () {
    if (!requireUser(() => openMessages())) return;
    showModal(`<h2 id="modalTitle">Messages</h2><p class="modal-intro">Chat with shops about your orders and products.</p><div id="kxConvos" class="dashboard-list"><div class="no-items">Loading…</div></div>`);
    try {
      const { conversations } = await call('/api/conversations');
      $('#kxConvos').innerHTML = conversations.length
        ? conversations.map(c => `<button class="dash-item kx-convo" type="button" data-kx="thread" data-id="${c.id}"><div class="dash-copy"><strong>${esc(c.shop_name)} ${c.unread ? `<span class="kx-badge">${Number(c.unread)} new</span>` : ''}</strong><small>${esc(c.last_message || '')}</small></div></button>`).join('')
        : '<div class="no-items">No conversations yet. Message a shop from its page or from one of your orders.</div>';
    } catch (e) { $('#kxConvos').innerHTML = `<div class="form-error">${esc(e.message)}</div>`; }
  };

  window.openThread = async function (id) {
    const { conversation: c, messages } = await call(`/api/conversations/${id}`);
    const me = Number(state.user.id);
    showModal(`<h2 id="modalTitle">${esc(c.shop_name)}</h2>
      <button class="kx-link" type="button" data-kx="messages">← All messages</button>
      <div id="kxThread" class="kx-thread">${messages.map(m => `<div class="kx-bubble ${Number(m.sender_id) === me ? 'mine' : ''}"><span>${esc(m.body)}</span><small>${when(m.created_at)}</small></div>`).join('') || '<div class="no-items">Say hello.</div>'}</div>
      <form id="kxReply" class="kx-reply" data-conv="${c.id}"><textarea name="body" maxlength="2000" required placeholder="Write a message"></textarea><button class="form-submit" type="submit">Send</button></form>`);
    const thread = $('#kxThread');
    thread.scrollTop = thread.scrollHeight;
  };

  function showCompose(sellerId, name) {
    showModal(`<h2 id="modalTitle">Message ${esc(name)}</h2>
      <p class="modal-intro">Ask about a product, delivery or your order.</p>
      <div id="kxMsg"></div>
      <form id="kxCompose" class="kx-form" data-seller="${sellerId}">
        <div class="field"><label for="kxBody">Your message</label><textarea id="kxBody" name="body" required maxlength="2000"></textarea></div>
        <button class="form-submit" type="submit">Send message</button></form>`);
  }

  // ----- header button for messages -----
  function addHeaderButton() {
    const orders = $('#ordersBtn');
    if (!orders || $('#kxMessagesBtn')) return;
    const b = document.createElement('button');
    b.id = 'kxMessagesBtn';
    b.className = 'text-btn';
    b.type = 'button';
    b.dataset.kx = 'messages';
    b.textContent = 'Messages';
    orders.before(b);
  }

  // ----- clicks -----
  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-kx]');
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    const id = b.dataset.id;
    try {
      switch (b.dataset.kx) {
        case 'resend': toast((await call('/api/auth/resend-verification', 'POST')).message); break;
        case 'forgot': showForgotForm(); break;
        case 'shop': openShop(id); break;
        case 'product': openProduct(id); break;
        case 'follow': await call(`/api/shops/${id}/follow`, 'POST'); toast('You are following this shop.'); openShop(id); break;
        case 'unfollow': await call(`/api/shops/${id}/follow`, 'DELETE'); toast('You have unfollowed this shop.'); openShop(id); break;
        case 'message': if (!requireUser(() => {})) break; showCompose(b.dataset.seller, b.dataset.name); break;
        case 'messages': openMessages(); break;
        case 'thread': openThread(id); break;
        case 'return': showReturnForm(b.dataset.order, b.dataset.seller); break;
        case 'escalate': await call(`/api/returns/${id}`, 'PATCH', { action: 'escalate' }); toast('The marketplace will review this return.'); openOrders(); break;
        case 'cancel': await call(`/api/orders/${id}/cancel`, 'POST'); toast('Your order has been cancelled.'); openOrders(); break;
      }
    } catch (err) { toast(err.message); }
  }, true);

  // ----- forms -----
  document.addEventListener('submit', async e => {
    const f = e.target;
    const id = f.id;
    if (!['kxForgot', 'kxReset', 'kxReturn', 'kxCompose', 'kxReply', 'kxCheckout'].includes(id)) return;
    e.preventDefault();
    const data = Object.fromEntries(new FormData(f).entries());
    const fail = err => { const m = $('#kxMsg'); if (m) m.innerHTML = `<div class="form-error">${esc(err.message)}</div>`; else toast(err.message); };
    try {
      if (id === 'kxForgot') {
        const d = await call('/api/auth/forgot', 'POST', { email: data.email });
        $('#kxMsg').innerHTML = `<div class="notice">${esc(d.message)}</div>`;
      } else if (id === 'kxReset') {
        if (data.password !== data.confirm) return fail(new Error('The two passwords do not match.'));
        const d = await call('/api/auth/reset', 'POST', { token: f.dataset.token, password: data.password });
        toast(d.message);
        history.replaceState({}, '', '/');
        authModal('login');
      } else if (id === 'kxReturn') {
        const d = await call(`/api/orders/${f.dataset.order}/returns`, 'POST', { sellerId: Number(f.dataset.seller), reason: data.reason });
        toast(d.message);
        openOrders();
      } else if (id === 'kxCompose') {
        const d = await call('/api/conversations', 'POST', { sellerId: Number(f.dataset.seller), body: data.body });
        openThread(d.conversationId);
      } else if (id === 'kxReply') {
        await call(`/api/conversations/${f.dataset.conv}/messages`, 'POST', { body: data.body });
        openThread(f.dataset.conv);
      } else if (id === 'kxCheckout') {
        const deliveryZones = {};
        $$('select[data-shop]').forEach(sel => { deliveryZones[sel.dataset.shop] = sel.value; });
        const body = {
          items: state.cart.map(x => ({ id: x.id, variantId: x.variantId, quantity: x.quantity })),
          deliveryName: data.deliveryName, deliveryPhone: data.deliveryPhone, deliveryAddress: data.deliveryAddress,
          paymentMethod: data.paymentMethod, promoCode: data.promoCode, deliveryZones
        };
        const d = await call('/api/orders', 'POST', body);
        state.cart = [];
        refreshCart();
        closeModal();
        toast(d.message);
      }
    } catch (err) { fail(err); }
  });

  const start = () => { addHeaderButton(); init(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
