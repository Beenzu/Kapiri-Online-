'use strict';
// Second-stage marketplace features: email verification, password reset, seller documents, delivery zones,
// payouts, returns, messaging, shop pages, receipts, extra product photos, variants and low-stock alerts.
// Everything here is mounted from server.js and receives its helpers through `ctx`.
const crypto = require('crypto');
const express = require('express');

const DOC_KINDS = ['pacra', 'tpin', 'national_id', 'other'];
const GALLERY_LIMIT = 5;
const PAYOUT_MINIMUM = 100;
const RETURN_DEFAULT_DAYS = 7;

const SCHEMA = `
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_token_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_expires_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS seller_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS delivery_zones JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS collection_enabled BOOLEAN NOT NULL DEFAULT TRUE;
UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL AND verify_token_hash IS NULL;
ALTER TABLE products ADD COLUMN IF NOT EXISTS low_stock_at INTEGER NOT NULL DEFAULT 3;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS variant_id BIGINT;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS variant_label VARCHAR(80);
ALTER TABLE seller_orders ADD COLUMN IF NOT EXISTS delivery_method VARCHAR(20) NOT NULL DEFAULT 'delivery';
ALTER TABLE seller_orders ADD COLUMN IF NOT EXISTS delivery_fee NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE seller_orders ADD COLUMN IF NOT EXISTS delivery_zone VARCHAR(80);
ALTER TABLE seller_orders ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE seller_orders ADD COLUMN IF NOT EXISTS payout_id BIGINT;
CREATE TABLE IF NOT EXISTS seller_documents (
 id BIGSERIAL PRIMARY KEY, seller_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind VARCHAR(20) NOT NULL,
 file_name VARCHAR(200) NOT NULL, mime VARCHAR(40) NOT NULL, data BYTEA NOT NULL, uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS product_images (
 id BIGSERIAL PRIMARY KEY, product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
 position INTEGER NOT NULL DEFAULT 0, mime VARCHAR(30) NOT NULL, data BYTEA NOT NULL
);
CREATE TABLE IF NOT EXISTS product_variants (
 id BIGSERIAL PRIMARY KEY, product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
 label VARCHAR(80) NOT NULL, stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0),
 price_adjust NUMERIC(12,2) NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS payouts (
 id BIGSERIAL PRIMARY KEY, seller_id BIGINT NOT NULL REFERENCES users(id), amount NUMERIC(12,2) NOT NULL,
 status VARCHAR(20) NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','paid')), reference VARCHAR(120),
 requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), paid_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS shop_follows (
 buyer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, seller_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (buyer_id, seller_id)
);
CREATE TABLE IF NOT EXISTS conversations (
 id BIGSERIAL PRIMARY KEY, buyer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 seller_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE (buyer_id, seller_id)
);
CREATE TABLE IF NOT EXISTS messages (
 id BIGSERIAL PRIMARY KEY, conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 sender_id BIGINT NOT NULL REFERENCES users(id), body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), read_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS return_requests (
 id BIGSERIAL PRIMARY KEY, order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
 seller_id BIGINT NOT NULL REFERENCES users(id), buyer_id BIGINT NOT NULL REFERENCES users(id), reason TEXT NOT NULL,
 status VARCHAR(20) NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','approved','declined','escalated','refunded','closed')),
 decision_note TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE (order_id, seller_id)
);
INSERT INTO platform_settings(key, value) VALUES ('returns', '{"days": ${RETURN_DEFAULT_DAYS}}'::jsonb) ON CONFLICT (key) DO NOTHING;
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS product_images_product_idx ON product_images(product_id);
CREATE INDEX IF NOT EXISTS product_variants_product_idx ON product_variants(product_id);
`;

module.exports = function build(ctx) {
  const {
    pool, enqueueEmail, renderMail, emailOn, siteUrl, escapeHtml, detectImage, bcrypt,
    requireDb, requireAuth, requireRole, requireAdmin, requireApprovedSeller, asyncRoute,
    httpError, roundMoney, parseId, clean, validEmail, restockSellerPart, PRODUCT_COLS
  } = ctx;

  const hashToken = t => crypto.createHash('sha256').update(String(t)).digest('hex');
  const newToken = () => crypto.randomBytes(32).toString('base64url');
  const url = p => `${siteUrl()}${p}`;
  const money = n => 'K' + Number(n || 0).toFixed(2);

  async function migrate() {
    await pool.query(SCHEMA);
  }

  // Sends the verification link. Called on registration and from the resend button.
  async function sendVerification(user) {
    const token = newToken();
    await pool.query('UPDATE users SET verify_token_hash=$1 WHERE id=$2', [hashToken(token), user.id]);
    await enqueueEmail(pool, user.email, 'verify_email', renderMail('Verify your email address', 'Confirm your email address', [
      'Confirm your email address to start shopping and messaging shops on Kapiri Online.',
      url(`/?verify=${token}`),
      'If you did not create this account, you can ignore this email.'
    ]));
  }

  const verifiedOnly = asyncRoute(async (req, res, next) => {
    const r = await pool.query('SELECT email_verified_at FROM users WHERE id=$1', [req.session.user.id]);
    if (!r.rowCount || !r.rows[0].email_verified_at) {
      return res.status(403).json({ error: 'Verify your email address first. Check your inbox for the verification link.', code: 'unverified' });
    }
    next();
  });

  // Emails buyers who follow a shop when it publishes a new product.
  async function onNewProduct(productId) {
    if (!(await emailOn('new_product'))) return;
    const p = (await pool.query(
      `SELECT p.id, p.name, p.price, COALESCE(u.business_name, u.name) AS shop, p.seller_id
       FROM products p JOIN users u ON u.id=p.seller_id WHERE p.id=$1 AND p.active=TRUE AND u.seller_status='approved'`, [productId])).rows[0];
    if (!p) return;
    const followers = (await pool.query(
      `SELECT b.email FROM shop_follows f JOIN users b ON b.id=f.buyer_id WHERE f.seller_id=$1 LIMIT 500`, [p.seller_id])).rows;
    for (const f of followers) {
      await enqueueEmail(pool, f.email, 'new_product', renderMail(`New from ${p.shop}`, `${p.shop} just added a product`, [
        p.name, `Price: ${money(p.price)}`, url('/')
      ]));
    }
  }

  // Called after an order is saved. Alerts the shop when stock drops to its low-stock level.
  async function lowStockAlerts(list) {
    if (!(await emailOn('low_stock'))) return;
    for (const x of list) {
      if (x.newStock <= x.lowAt && x.oldStock > x.lowAt) {
        const s = (await pool.query('SELECT email FROM users WHERE id=$1', [x.sellerId])).rows[0];
        if (!s) continue;
        await enqueueEmail(pool, s.email, 'low_stock', renderMail(`Low stock: ${x.name}`, 'A product is running low', [
          `${x.name} has ${Math.max(0, x.newStock)} left. Your low-stock level is ${x.lowAt}.`,
          url('/seller#/products')
        ]));
      }
    }
  }

  async function sendMessage(convId, me, body) {
    const conv = (await pool.query('SELECT * FROM conversations WHERE id=$1', [convId])).rows[0];
    const recipientId = Number(me.id) === Number(conv.buyer_id) ? conv.seller_id : conv.buyer_id;
    // Only email when the other person has no unread messages from this sender already, so a chat does not flood their inbox.
    const unread = (await pool.query(
      'SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id=$1 AND sender_id=$2 AND read_at IS NULL', [convId, me.id])).rows[0].n;
    const m = (await pool.query(
      'INSERT INTO messages(conversation_id, sender_id, body) VALUES($1,$2,$3) RETURNING id, sender_id, body, created_at', [convId, me.id, body])).rows[0];
    await pool.query('UPDATE conversations SET updated_at=NOW() WHERE id=$1', [convId]);
    if (unread === 0 && (await emailOn('new_message'))) {
      const r = (await pool.query('SELECT email, name FROM users WHERE id=$1', [recipientId])).rows[0];
      await enqueueEmail(pool, r.email, 'new_message', renderMail('New message on Kapiri Online', 'You have a new message', [
        `${me.name || me.businessName || 'Someone'} sent you a message:`, `"${body.slice(0, 300)}"`, url('/')
      ]));
    }
    return m;
  }

  async function returnWindowDays(db = pool) {
    const r = await db.query("SELECT value FROM platform_settings WHERE key='returns'");
    return Number(r.rows[0] && r.rows[0].value && r.rows[0].value.days) || RETURN_DEFAULT_DAYS;
  }

  const AVAILABLE_PAYOUT_SQL = `FROM seller_orders so
    WHERE so.seller_id=$1 AND so.status='completed' AND so.payout_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM return_requests r WHERE r.order_id=so.order_id AND r.seller_id=so.seller_id AND r.status='refunded')`;

  function receiptHtml(order, parts, items, viewerLabel) {
    const rows = items.map(i => `<tr><td>${escapeHtml(i.product_name)}${i.variant_label ? ` <span class="v">(${escapeHtml(i.variant_label)})</span>` : ''}</td><td>${Number(i.quantity)}</td><td class="r">${money(i.unit_price)}</td><td class="r">${money(i.quantity * i.unit_price)}</td></tr>`).join('');
    const shops = parts.map(p => `<div class="shop"><strong>${escapeHtml(p.shop)}</strong> · ${escapeHtml(p.status)} · ${p.delivery_method === 'collect' ? 'Collection' : `Delivery${p.delivery_zone ? ' to ' + escapeHtml(p.delivery_zone) : ''}`}</div>`).join('');
    const total = parts.reduce((s, p) => s + Number(p.subtotal) + Number(p.delivery_fee), 0);
    const fees = parts.reduce((s, p) => s + Number(p.delivery_fee), 0);
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Receipt #${order.id} — Kapiri Online</title>
<style>
body{font-family:'DM Sans',Arial,sans-serif;color:#17251f;max-width:720px;margin:32px auto;padding:0 20px}
h1{font-family:Manrope,Arial,sans-serif;color:#143c32;margin:0 0 4px}.muted{color:#78827c;font-size:13px}
table{width:100%;border-collapse:collapse;margin:18px 0}th,td{padding:9px 6px;border-bottom:1px solid #e8ebe6;text-align:left;font-size:14px}
th{font-size:12px;color:#78827c;text-transform:uppercase}.r{text-align:right}.v{color:#78827c}.shop{font-size:14px;margin:6px 0}
.total{font:800 20px Manrope,Arial,sans-serif;color:#143c32;text-align:right;margin-top:14px}
.btn{background:#143c32;color:#fff;border:0;border-radius:999px;padding:10px 18px;font-size:14px;cursor:pointer}
@media print{.btn{display:none}body{margin:0}}
</style></head><body>
<h1>Kapiri Online</h1><div class="muted">Receipt for order #${order.id} · ${viewerLabel}</div>
<p class="muted">Placed ${new Date(order.created_at).toLocaleString('en-ZM', { timeZone: 'Africa/Lusaka' })}<br>Buyer: ${escapeHtml(order.buyer_name)}<br>Delivery: ${escapeHtml(order.delivery_name)}, ${escapeHtml(order.delivery_phone)}, ${escapeHtml(order.delivery_address)}<br>Payment: ${escapeHtml(String(order.payment_method).replace(/_/g, ' '))} · ${escapeHtml(order.payment_status)}</p>
${shops}
<table><thead><tr><th>Item</th><th>Qty</th><th class="r">Unit</th><th class="r">Amount</th></tr></thead><tbody>${rows}</tbody></table>
${fees > 0 ? `<div class="muted r">Delivery fees: ${money(fees)}</div>` : ''}
<div class="total">Total ${money(total)}</div>
<p><button class="btn" onclick="window.print()">Print or save as PDF</button></p>
</body></html>`;
  }

  function mount(app) {
    const rawImage = express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '2mb' });
    const rawDocument = express.raw({ type: ['application/pdf', 'image/jpeg', 'image/png'], limit: '5mb' });

    // ----- email verification and password reset -----
    app.post('/api/auth/verify-email', requireDb, asyncRoute(async (req, res) => {
      const token = clean(req.body.token, 200);
      const r = token ? await pool.query('UPDATE users SET email_verified_at=NOW(), verify_token_hash=NULL WHERE verify_token_hash=$1 RETURNING id', [hashToken(token)]) : { rowCount: 0 };
      if (!r.rowCount) return res.status(400).json({ error: 'This verification link has already been used or is not valid.' });
      res.json({ ok: true, message: 'Your email address is verified. Thank you!' });
    }));

    app.post('/api/auth/resend-verification', requireDb, requireAuth, asyncRoute(async (req, res) => {
      const u = (await pool.query('SELECT id, email, email_verified_at FROM users WHERE id=$1', [req.session.user.id])).rows[0];
      if (!u) return res.status(401).json({ error: 'Please sign in to continue.' });
      if (u.email_verified_at) return res.json({ ok: true, message: 'Your email address is already verified.' });
      await sendVerification(u);
      res.json({ ok: true, message: 'We sent a new verification link to your email.' });
    }));

    app.post('/api/auth/forgot', requireDb, asyncRoute(async (req, res) => {
      const email = clean(req.body.email, 254).toLowerCase();
      const u = validEmail(email) ? (await pool.query('SELECT id, email FROM users WHERE email=$1', [email])).rows[0] : null;
      if (u) {
        const token = newToken();
        await pool.query("UPDATE users SET reset_token_hash=$1, reset_expires_at=NOW() + INTERVAL '1 hour' WHERE id=$2", [hashToken(token), u.id]);
        await enqueueEmail(pool, u.email, 'password_reset', renderMail('Reset your password', 'Reset your password', [
          'Someone asked to reset the password on your Kapiri Online account. The link works for one hour.',
          url(`/?reset=${token}`),
          'If this was not you, ignore this email and your password stays the same.'
        ]));
      }
      res.json({ ok: true, message: 'If an account exists for that email, a reset link is on its way.' });
    }));

    app.post('/api/auth/reset', requireDb, asyncRoute(async (req, res) => {
      const token = clean(req.body.token, 200), password = String(req.body.password || '');
      if (password.length < 8) return res.status(400).json({ error: 'Your new password must be at least 8 characters.' });
      const r = token ? await pool.query(
        `UPDATE users SET password_hash=$1, reset_token_hash=NULL, reset_expires_at=NULL,
           email_verified_at=COALESCE(email_verified_at, NOW())
         WHERE reset_token_hash=$2 AND reset_expires_at > NOW() RETURNING id`,
        [await bcrypt.hash(password, 12), hashToken(token)]) : { rowCount: 0 };
      if (!r.rowCount) return res.status(400).json({ error: 'This reset link has expired or has already been used. Request a new one.' });
      res.json({ ok: true, message: 'Your password has been reset. You can sign in now.' });
    }));

    // ----- seller verification documents -----
    app.get('/api/seller/documents', requireDb, requireAuth, requireRole('seller'), asyncRoute(async (req, res) => {
      const r = await pool.query('SELECT id, kind, file_name, mime, uploaded_at FROM seller_documents WHERE seller_id=$1 ORDER BY uploaded_at DESC', [req.session.user.id]);
      res.json({ documents: r.rows });
    }));

    app.post('/api/seller/documents', requireDb, requireAuth, requireRole('seller'), rawDocument, asyncRoute(async (req, res) => {
      const kind = clean(req.query.kind, 20);
      if (!DOC_KINDS.includes(kind)) return res.status(400).json({ error: 'Choose what kind of document this is.' });
      const buf = req.body;
      let mime = null;
      if (Buffer.isBuffer(buf) && buf.length > 4 && buf.subarray(0, 4).toString('ascii') === '%PDF') mime = 'application/pdf';
      else mime = detectImage(buf);
      if (!mime) return res.status(400).json({ error: 'Upload a PDF, JPEG or PNG of 5 MB or smaller.' });
      const ext = mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : 'jpg';
      const name = clean(req.query.name, 200) || `${kind}.${ext}`;
      const r = await pool.query(
        'INSERT INTO seller_documents(seller_id, kind, file_name, mime, data) VALUES($1,$2,$3,$4,$5) RETURNING id, kind, file_name, mime, uploaded_at',
        [req.session.user.id, kind, name, mime, buf]);
      res.status(201).json({ document: r.rows[0] });
    }));

    app.delete('/api/seller/documents/:id', requireDb, requireAuth, requireRole('seller'), asyncRoute(async (req, res) => {
      const id = parseId(req.params.id);
      await pool.query('DELETE FROM seller_documents WHERE id=$1 AND seller_id=$2', [id, req.session.user.id]);
      res.json({ ok: true });
    }));

    app.get('/api/admin/sellers/:id/documents', requireDb, requireAuth, requireAdmin, asyncRoute(async (req, res) => {
      const id = parseId(req.params.id);
      const seller = (await pool.query("SELECT seller_verified FROM users WHERE id=$1 AND role='seller'", [id])).rows[0];
      if (!seller) return res.status(404).json({ error: 'Seller not found.' });
      const r = await pool.query('SELECT id, kind, file_name, mime, uploaded_at FROM seller_documents WHERE seller_id=$1 ORDER BY uploaded_at DESC', [id]);
      res.json({ documents: r.rows, verified: seller.seller_verified });
    }));

    app.get('/api/admin/documents/:id', requireDb, requireAuth, requireAdmin, asyncRoute(async (req, res) => {
      const r = await pool.query('SELECT data, mime, file_name FROM seller_documents WHERE id=$1', [parseId(req.params.id)]);
      if (!r.rowCount) return res.status(404).json({ error: 'Document not found.' });
      res.set({
        'Content-Type': r.rows[0].mime, 'Content-Disposition': `inline; filename="${r.rows[0].file_name.replace(/"/g, '')}"`,
        'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store'
      });
      res.send(r.rows[0].data);
    }));

    app.patch('/api/admin/sellers/:id/verified', requireDb, requireAuth, requireAdmin, asyncRoute(async (req, res) => {
      const r = await pool.query("UPDATE users SET seller_verified=$1 WHERE id=$2 AND role='seller' RETURNING id", [req.body.verified === true, parseId(req.params.id)]);
      if (!r.rowCount) return res.status(404).json({ error: 'Seller not found.' });
      res.json({ ok: true });
    }));

    // ----- delivery zones and collection -----
    app.get('/api/seller/delivery', requireDb, requireAuth, requireRole('seller'), asyncRoute(async (req, res) => {
      const r = (await pool.query('SELECT delivery_zones, collection_enabled FROM users WHERE id=$1', [req.session.user.id])).rows[0];
      res.json({ zones: r.delivery_zones, collectionEnabled: r.collection_enabled });
    }));

    app.patch('/api/seller/delivery', requireDb, requireAuth, requireRole('seller'), asyncRoute(async (req, res) => {
      const raw = Array.isArray(req.body.zones) ? req.body.zones : [];
      if (raw.length > 30) return res.status(400).json({ error: 'You can add up to 30 delivery areas.' });
      const seen = new Set(), zones = [];
      for (const z of raw) {
        const name = clean(z && z.name, 80);
        const fee = Number(z && z.fee);
        if (!name) return res.status(400).json({ error: 'Every delivery area needs a name.' });
        if (seen.has(name.toLowerCase())) return res.status(400).json({ error: `"${name}" is listed twice.` });
        if (!Number.isFinite(fee) || fee < 0 || fee > 50000) return res.status(400).json({ error: `Enter a delivery fee from 0 to 50,000 for ${name}.` });
        seen.add(name.toLowerCase());
        zones.push({ name, fee: roundMoney(fee) });
      }
      await pool.query('UPDATE users SET delivery_zones=$1, collection_enabled=$2 WHERE id=$3',
        [JSON.stringify(zones), req.body.collectionEnabled !== false, req.session.user.id]);
      res.json({ ok: true, zones, collectionEnabled: req.body.collectionEnabled !== false });
    }));

    // ----- payouts -----
    app.get('/api/seller/payouts', requireDb, requireAuth, requireRole('seller'), asyncRoute(async (req, res) => {
      const uid = req.session.user.id;
      const avail = (await pool.query(`SELECT COALESCE(SUM(so.subtotal + so.delivery_fee - so.commission_amount), 0) AS amount, COUNT(*)::int AS orders ${AVAILABLE_PAYOUT_SQL}`, [uid])).rows[0];
      const list = (await pool.query('SELECT id, amount, status, reference, requested_at, paid_at FROM payouts WHERE seller_id=$1 ORDER BY requested_at DESC LIMIT 100', [uid])).rows;
      res.json({ available: roundMoney(avail.amount), orders: avail.orders, minimum: PAYOUT_MINIMUM, payouts: list });
    }));

    app.post('/api/seller/payouts', requireDb, requireAuth, requireRole('seller'), requireApprovedSeller, asyncRoute(async (req, res) => {
      const uid = req.session.user.id;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [uid]);
        const avail = (await client.query(`SELECT COALESCE(SUM(so.subtotal + so.delivery_fee - so.commission_amount), 0) AS amount ${AVAILABLE_PAYOUT_SQL}`, [uid])).rows[0];
        const amount = roundMoney(avail.amount);
        if (amount < PAYOUT_MINIMUM) throw httpError(`You need at least K${PAYOUT_MINIMUM} of completed sales to request a payout. You have K${amount.toFixed(2)}.`);
        const p = (await client.query("INSERT INTO payouts(seller_id, amount) VALUES($1,$2) RETURNING id, amount, status, requested_at", [uid, amount])).rows[0];
        await client.query(`UPDATE seller_orders so SET payout_id=$1 WHERE so.seller_id=$2 AND so.status='completed' AND so.payout_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM return_requests r WHERE r.order_id=so.order_id AND r.seller_id=so.seller_id AND r.status='refunded')`, [p.id, uid]);
        await client.query('COMMIT');
        res.status(201).json({ payout: p, message: 'Payout requested. The marketplace will pay it out and mark it paid here.' });
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    }));

    app.get('/api/admin/payouts', requireDb, requireAuth, requireAdmin, asyncRoute(async (req, res) => {
      const r = await pool.query(`SELECT p.*, COALESCE(u.business_name, u.name) AS shop_name, u.email
        FROM payouts p JOIN users u ON u.id=p.seller_id ORDER BY p.requested_at DESC LIMIT 300`);
      res.json({ payouts: r.rows });
    }));

    app.patch('/api/admin/payouts/:id', requireDb, requireAuth, requireAdmin, asyncRoute(async (req, res) => {
      const reference = clean(req.body.reference, 120);
      const r = await pool.query(
        "UPDATE payouts SET status='paid', reference=$1, paid_at=NOW() WHERE id=$2 AND status='requested' RETURNING *",
        [reference || null, parseId(req.params.id)]);
      if (!r.rowCount) return res.status(400).json({ error: 'Only requested payouts can be marked paid.' });
      if (await emailOn('payout_paid')) {
        const s = (await pool.query('SELECT email FROM users WHERE id=$1', [r.rows[0].seller_id])).rows[0];
        await enqueueEmail(pool, s.email, 'payout_paid', renderMail('Your payout has been sent', 'Payout sent', [
          `We have paid out ${money(r.rows[0].amount)} for your completed sales.`,
          reference ? `Reference: ${reference}` : ''
        ].filter(Boolean)));
      }
      res.json({ payout: r.rows[0] });
    }));

    // ----- returns -----
    app.get('/api/returns/settings', requireDb, requireAuth, asyncRoute(async (req, res) => {
      res.json({ days: await returnWindowDays() });
    }));

    app.put('/api/admin/returns/settings', requireDb, requireAuth, requireAdmin, asyncRoute(async (req, res) => {
      const days = Number(req.body.days);
      if (!Number.isInteger(days) || days < 0 || days > 90) return res.status(400).json({ error: 'The return window must be a whole number of days from 0 to 90.' });
      await pool.query("INSERT INTO platform_settings(key, value) VALUES ('returns', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [JSON.stringify({ days })]);
      res.json({ days });
    }));

    app.post('/api/orders/:id/returns', requireDb, requireAuth, requireRole('buyer'), asyncRoute(async (req, res) => {
      const orderId = parseId(req.params.id), sellerId = parseId(req.body.sellerId);
      const reason = clean(req.body.reason, 1000);
      if (!orderId || !sellerId) return res.status(404).json({ error: 'Order not found.' });
      if (reason.length < 5) return res.status(400).json({ error: 'Tell the shop why you want to return this (at least a few words).' });
      const row = (await pool.query(
        `SELECT o.buyer_id, so.status, so.completed_at, o.created_at FROM orders o
         JOIN seller_orders so ON so.order_id=o.id AND so.seller_id=$2 WHERE o.id=$1`, [orderId, sellerId])).rows[0];
      if (!row || Number(row.buyer_id) !== Number(req.session.user.id)) return res.status(404).json({ error: 'Order not found.' });
      if (row.status !== 'completed') return res.status(400).json({ error: 'Returns can be requested once the shop has marked this part of your order completed.' });
      const days = await returnWindowDays();
      const since = new Date(row.completed_at || row.created_at);
      if (Date.now() - since.getTime() > days * 86400000) return res.status(400).json({ error: `The ${days}-day return window for this order has closed.` });
      const r = await pool.query(
        'INSERT INTO return_requests(order_id, seller_id, buyer_id, reason) VALUES($1,$2,$3,$4) ON CONFLICT (order_id, seller_id) DO NOTHING RETURNING id',
        [orderId, sellerId, req.session.user.id, reason]);
      if (!r.rowCount) return res.status(409).json({ error: 'You have already requested a return for this shop on this order.' });
      if (await emailOn('return_requested')) {
        const s = (await pool.query('SELECT email FROM users WHERE id=$1', [sellerId])).rows[0];
        await enqueueEmail(pool, s.email, 'return_requested', renderMail(`Return requested on order #${orderId}`, 'A buyer wants to return an item', [
          `Reason: ${reason}`, url('/seller#/returns')
        ]));
      }
      res.status(201).json({ ok: true, message: 'Return requested. The shop will review it and reply.' });
    }));

    app.get('/api/returns', requireDb, requireAuth, asyncRoute(async (req, res) => {
      const me = req.session.user;
      const where = me.role === 'admin' ? '' : me.role === 'seller' ? 'WHERE r.seller_id=$1' : 'WHERE r.buyer_id=$1';
      const params = me.role === 'admin' ? [] : [me.id];
      const r = await pool.query(
        `SELECT r.id, r.order_id, r.status, r.reason, r.decision_note, r.created_at, r.updated_at, r.seller_id, r.buyer_id,
           COALESCE(s.business_name, s.name) AS shop_name, b.name AS buyer_name
         FROM return_requests r JOIN users s ON s.id=r.seller_id JOIN users b ON b.id=r.buyer_id
         ${where} ORDER BY r.created_at DESC LIMIT 200`, params);
      res.json({ returns: r.rows });
    }));

    app.patch('/api/returns/:id', requireDb, requireAuth, asyncRoute(async (req, res) => {
      const id = parseId(req.params.id), action = clean(req.body.action, 20), note = clean(req.body.note, 1000);
      const me = req.session.user;
      const client = await pool.connect();
      let rr;
      try {
        await client.query('BEGIN');
        rr = (await client.query('SELECT * FROM return_requests WHERE id=$1 FOR UPDATE', [id])).rows[0];
        if (!rr) throw httpError('Return not found.', 404);
        const isSeller = me.role === 'seller' && Number(rr.seller_id) === Number(me.id);
        const isBuyer = me.role === 'buyer' && Number(rr.buyer_id) === Number(me.id);
        const isAdmin = me.role === 'admin';
        const s = rr.status;
        let next = null;
        if (action === 'approve' && ((isSeller && s === 'requested') || (isAdmin && (s === 'requested' || s === 'escalated')))) next = 'approved';
        if (action === 'decline' && ((isSeller && s === 'requested') || (isAdmin && (s === 'requested' || s === 'escalated')))) next = 'declined';
        if (action === 'escalate' && isBuyer && s === 'declined') next = 'escalated';
        if (action === 'refunded' && ((isSeller || isAdmin) && s === 'approved')) next = 'refunded';
        if (action === 'close' && isAdmin) next = 'closed';
        if (!next) throw httpError('That action is not available for this return.');
        await client.query('UPDATE return_requests SET status=$1, decision_note=CASE WHEN $2 = \'\' THEN decision_note ELSE $2 END, updated_at=NOW() WHERE id=$3', [next, note, id]);
        if (next === 'refunded') await restockSellerPart(client, rr.order_id, rr.seller_id);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      const status = (await pool.query('SELECT status FROM return_requests WHERE id=$1', [id])).rows[0].status;
      // Tell the other party about the change.
      const notifyBuyer = ['approved', 'declined', 'refunded', 'closed'].includes(status);
      const who = notifyBuyer ? rr.buyer_id : rr.seller_id;
      if (await emailOn('return_update')) {
        const u = (await pool.query('SELECT email FROM users WHERE id=$1', [who])).rows[0];
        await enqueueEmail(pool, u.email, 'return_update', renderMail(`Return on order #${rr.order_id}: ${status}`, 'Return update', [
          `The return on order #${rr.order_id} is now ${status}.`, note ? `Note: ${note}` : '', url('/#orders')
        ].filter(Boolean)));
      }
      res.json({ ok: true, status });
    }));

    // ----- messaging -----
    app.get('/api/conversations', requireDb, requireAuth, asyncRoute(async (req, res) => {
      const me = req.session.user;
      if (me.role === 'admin') return res.json({ conversations: [] });
      const col = me.role === 'buyer' ? 'c.buyer_id' : 'c.seller_id';
      const r = await pool.query(
        `SELECT c.id, c.buyer_id, c.seller_id, c.updated_at, COALESCE(s.business_name, s.name) AS shop_name, b.name AS buyer_name,
           (SELECT body FROM messages m WHERE m.conversation_id=c.id ORDER BY m.id DESC LIMIT 1) AS last_message,
           (SELECT COUNT(*)::int FROM messages m WHERE m.conversation_id=c.id AND m.sender_id<>$1 AND m.read_at IS NULL) AS unread
         FROM conversations c JOIN users s ON s.id=c.seller_id JOIN users b ON b.id=c.buyer_id
         WHERE ${col}=$1 ORDER BY c.updated_at DESC LIMIT 100`, [me.id]);
      res.json({ conversations: r.rows });
    }));

    app.post('/api/conversations', requireDb, requireAuth, requireRole('buyer'), verifiedOnly, asyncRoute(async (req, res) => {
      const sellerId = parseId(req.body.sellerId), body = clean(req.body.body, 2000);
      if (!sellerId || !body) return res.status(400).json({ error: 'Write a message to the shop.' });
      const s = (await pool.query("SELECT id FROM users WHERE id=$1 AND role='seller' AND seller_status='approved'", [sellerId])).rows[0];
      if (!s) return res.status(404).json({ error: 'Shop not found.' });
      const conv = (await pool.query(
        'INSERT INTO conversations(buyer_id, seller_id) VALUES($1,$2) ON CONFLICT (buyer_id, seller_id) DO UPDATE SET updated_at=NOW() RETURNING id',
        [req.session.user.id, sellerId])).rows[0];
      const message = await sendMessage(conv.id, req.session.user, body);
      res.status(201).json({ conversationId: conv.id, message });
    }));

    app.get('/api/conversations/:id', requireDb, requireAuth, asyncRoute(async (req, res) => {
      const id = parseId(req.params.id), me = req.session.user;
      const conv = (await pool.query(
        `SELECT c.*, COALESCE(s.business_name, s.name) AS shop_name, b.name AS buyer_name
         FROM conversations c JOIN users s ON s.id=c.seller_id JOIN users b ON b.id=c.buyer_id WHERE c.id=$1`, [id])).rows[0];
      if (!conv || (Number(conv.buyer_id) !== Number(me.id) && Number(conv.seller_id) !== Number(me.id))) return res.status(404).json({ error: 'Conversation not found.' });
      await pool.query('UPDATE messages SET read_at=NOW() WHERE conversation_id=$1 AND sender_id<>$2 AND read_at IS NULL', [id, me.id]);
      const msgs = (await pool.query(
        'SELECT id, sender_id, body, created_at FROM messages WHERE conversation_id=$1 ORDER BY id DESC LIMIT 200', [id])).rows.reverse();
      res.json({ conversation: conv, messages: msgs });
    }));

    app.post('/api/conversations/:id/messages', requireDb, requireAuth, verifiedOnly, asyncRoute(async (req, res) => {
      const id = parseId(req.params.id), me = req.session.user;
      const body = clean(req.body.body, 2000);
      const conv = (await pool.query('SELECT * FROM conversations WHERE id=$1', [id])).rows[0];
      if (!conv || (Number(conv.buyer_id) !== Number(me.id) && Number(conv.seller_id) !== Number(me.id))) return res.status(404).json({ error: 'Conversation not found.' });
      if (!body) return res.status(400).json({ error: 'Write a message first.' });
      res.status(201).json({ message: await sendMessage(id, me, body) });
    }));

    // ----- shop pages and follows -----
    app.get('/api/shops/:id', requireDb, asyncRoute(async (req, res) => {
      const id = parseId(req.params.id);
      const s = id ? (await pool.query(
        "SELECT id, name, business_name, business_description, location, seller_verified, delivery_zones, collection_enabled FROM users WHERE id=$1 AND role='seller' AND seller_status='approved'", [id])).rows[0] : null;
      if (!s) return res.status(404).json({ error: 'Shop not found.' });
      const stats = (await pool.query(
        `SELECT (SELECT COUNT(*)::int FROM products p WHERE p.seller_id=$1 AND p.active=TRUE) AS products,
           (SELECT COUNT(*)::int FROM shop_follows WHERE seller_id=$1) AS followers,
           (SELECT COALESCE(AVG(rv.rating),0) FROM reviews rv JOIN products p ON p.id=rv.product_id WHERE p.seller_id=$1) AS rating,
           (SELECT COUNT(rv.id)::int FROM reviews rv JOIN products p ON p.id=rv.product_id WHERE p.seller_id=$1) AS review_count`, [id])).rows[0];
      const me = req.session.user;
      const following = !!(me && me.role === 'buyer' && (await pool.query('SELECT 1 FROM shop_follows WHERE buyer_id=$1 AND seller_id=$2', [me.id, id])).rowCount);
      res.json({ shop: {
        id: s.id, name: s.business_name || s.name, description: s.business_description || '', location: s.location || '',
        verified: s.seller_verified, zones: s.delivery_zones, collectionEnabled: s.collection_enabled,
        products: stats.products, followers: stats.followers, rating: Number(stats.rating), reviewCount: stats.review_count, following
      } });
    }));

    app.get('/api/shops/:id/products', requireDb, asyncRoute(async (req, res) => {
      const id = parseId(req.params.id);
      const r = await pool.query(
        `SELECT ${PRODUCT_COLS}, u.business_name, u.location FROM products p JOIN users u ON u.id=p.seller_id
         WHERE p.seller_id=$1 AND p.active=TRUE AND u.seller_status='approved' ORDER BY p.created_at DESC LIMIT 100`, [id]);
      res.json({ products: r.rows });
    }));

    app.post('/api/shops/:id/follow', requireDb, requireAuth, requireRole('buyer'), asyncRoute(async (req, res) => {
      const id = parseId(req.params.id);
      const s = (await pool.query("SELECT id FROM users WHERE id=$1 AND role='seller' AND seller_status='approved'", [id])).rows[0];
      if (!s) return res.status(404).json({ error: 'Shop not found.' });
      await pool.query('INSERT INTO shop_follows(buyer_id, seller_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [req.session.user.id, id]);
      res.json({ ok: true, following: true });
    }));

    app.delete('/api/shops/:id/follow', requireDb, requireAuth, requireRole('buyer'), asyncRoute(async (req, res) => {
      await pool.query('DELETE FROM shop_follows WHERE buyer_id=$1 AND seller_id=$2', [req.session.user.id, parseId(req.params.id)]);
      res.json({ ok: true, following: false });
    }));

    // ----- product photos beyond the first, options (variants) and low-stock level -----
    app.get('/api/products/:id/gallery', requireDb, asyncRoute(async (req, res) => {
      const id = parseId(req.params.id);
      const p = id ? (await pool.query(
        `SELECT p.id, p.active, p.seller_id, u.seller_status FROM products p JOIN users u ON u.id=p.seller_id WHERE p.id=$1`, [id])).rows[0] : null;
      const me = req.session.user;
      const owner = p && me && me.role === 'seller' && Number(me.id) === Number(p.seller_id);
      if (!p || (!owner && (!p.active || p.seller_status !== 'approved'))) return res.status(404).json({ error: 'Product not found.' });
      const images = (await pool.query('SELECT id FROM product_images WHERE product_id=$1 ORDER BY position, id', [id])).rows;
      const variants = (await pool.query('SELECT id, label, stock, price_adjust FROM product_variants WHERE product_id=$1 ORDER BY position, id', [id])).rows;
      res.json({
        images: images.map(i => ({ id: Number(i.id), url: `/api/products/${id}/images/${i.id}` })),
        variants: variants.map(v => ({ id: Number(v.id), label: v.label, stock: Number(v.stock), priceAdjust: Number(v.price_adjust) }))
      });
    }));

    app.get('/api/products/:id/images/:imageId', requireDb, asyncRoute(async (req, res) => {
      const r = await pool.query(
        `SELECT pi.data, pi.mime FROM product_images pi JOIN products p ON p.id=pi.product_id JOIN users u ON u.id=p.seller_id
         WHERE pi.id=$1 AND p.id=$2 AND p.active=TRUE AND u.seller_status='approved'`, [parseId(req.params.imageId), parseId(req.params.id)]);
      if (!r.rowCount) return res.status(404).end();
      res.set({ 'Content-Type': r.rows[0].mime, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      res.send(r.rows[0].data);
    }));

    app.post('/api/seller/products/:id/images', requireDb, requireAuth, requireRole('seller'), requireApprovedSeller, rawImage, asyncRoute(async (req, res) => {
      const id = parseId(req.params.id);
      const owned = id && (await pool.query('SELECT id FROM products WHERE id=$1 AND seller_id=$2', [id, req.session.user.id])).rowCount;
      if (!owned) return res.status(404).json({ error: 'Product not found in your shop.' });
      const mime = detectImage(req.body);
      if (!mime) return res.status(400).json({ error: 'Upload a JPEG, PNG or WebP image of 2 MB or smaller.' });
      const count = (await pool.query('SELECT COUNT(*)::int AS n FROM product_images WHERE product_id=$1', [id])).rows[0].n;
      if (count >= GALLERY_LIMIT) return res.status(400).json({ error: `You can add up to ${GALLERY_LIMIT} extra photos per product.` });
      const r = await pool.query('INSERT INTO product_images(product_id, position, mime, data) VALUES($1,$2,$3,$4) RETURNING id', [id, count, mime, req.body]);
      res.status(201).json({ id: Number(r.rows[0].id) });
    }));

    app.delete('/api/seller/products/:id/images/:imageId', requireDb, requireAuth, requireRole('seller'), asyncRoute(async (req, res) => {
      await pool.query(
        `DELETE FROM product_images pi USING products p WHERE pi.id=$1 AND pi.product_id=p.id AND p.id=$2 AND p.seller_id=$3`,
        [parseId(req.params.imageId), parseId(req.params.id), req.session.user.id]);
      res.json({ ok: true });
    }));

    // Replaces the option list for a product. Options keep their id when they are edited, so past orders still link to them.
    app.put('/api/seller/products/:id/variants', requireDb, requireAuth, requireRole('seller'), requireApprovedSeller, asyncRoute(async (req, res) => {
      const id = parseId(req.params.id);
      const owned = id && (await pool.query('SELECT id FROM products WHERE id=$1 AND seller_id=$2', [id, req.session.user.id])).rowCount;
      if (!owned) return res.status(404).json({ error: 'Product not found in your shop.' });
      const input = Array.isArray(req.body.variants) ? req.body.variants : [];
      if (input.length > 50) return res.status(400).json({ error: 'You can add up to 50 options per product.' });
      const rows = [];
      for (const v of input) {
        const label = clean(v && v.label, 80);
        const stock = Number(v && v.stock), adjust = Number(v && (v.priceAdjust ?? 0));
        if (!label) return res.status(400).json({ error: 'Every option needs a name, such as "Size M" or "Blue".' });
        if (!Number.isInteger(stock) || stock < 0) return res.status(400).json({ error: `Stock for ${label} must be a whole number of zero or more.` });
        if (!Number.isFinite(adjust) || Math.abs(adjust) > 100000) return res.status(400).json({ error: `Price change for ${label} is not valid.` });
        rows.push({ id: parseId(v && v.id), label, stock, adjust: roundMoney(adjust) });
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const existing = (await client.query('SELECT id FROM product_variants WHERE product_id=$1', [id])).rows.map(r => Number(r.id));
        const keep = rows.filter(r => r.id && existing.includes(r.id)).map(r => r.id);
        await client.query('DELETE FROM product_variants WHERE product_id=$1 AND NOT (id = ANY($2::bigint[]))', [id, keep]);
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          if (r.id && existing.includes(r.id)) {
            await client.query('UPDATE product_variants SET label=$1, stock=$2, price_adjust=$3, position=$4 WHERE id=$5', [r.label, r.stock, r.adjust, i, r.id]);
          } else {
            await client.query('INSERT INTO product_variants(product_id, label, stock, price_adjust, position) VALUES($1,$2,$3,$4,$5)', [id, r.label, r.stock, r.adjust, i]);
          }
        }
        // With options, the product's stock is the total across options.
        if (rows.length) await client.query('UPDATE products SET stock=(SELECT COALESCE(SUM(stock),0) FROM product_variants WHERE product_id=$1) WHERE id=$1', [id]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      res.json({ ok: true });
    }));

    app.patch('/api/seller/products/:id/low-stock', requireDb, requireAuth, requireRole('seller'), asyncRoute(async (req, res) => {
      const level = Number(req.body.lowStockAt);
      if (!Number.isInteger(level) || level < 0 || level > 1000) return res.status(400).json({ error: 'The low-stock level must be a whole number from 0 to 1000.' });
      const r = await pool.query('UPDATE products SET low_stock_at=$1 WHERE id=$2 AND seller_id=$3 RETURNING id', [level, parseId(req.params.id), req.session.user.id]);
      if (!r.rowCount) return res.status(404).json({ error: 'Product not found in your shop.' });
      res.json({ ok: true, lowStockAt: level });
    }));

    // ----- receipts -----
    app.get('/api/orders/:id/receipt', requireDb, requireAuth, asyncRoute(async (req, res) => {
      const id = parseId(req.params.id), me = req.session.user;
      const order = (await pool.query('SELECT o.*, b.name AS buyer_name FROM orders o JOIN users b ON b.id=o.buyer_id WHERE o.id=$1', [id])).rows[0];
      if (!order) return res.status(404).send('Receipt not found.');
      if (me.role === 'buyer' && Number(order.buyer_id) !== Number(me.id)) return res.status(404).send('Receipt not found.');
      const scope = me.role === 'seller' ? me.id : null;
      const parts = (await pool.query(
        `SELECT so.seller_id, so.status, so.subtotal, so.delivery_fee, so.delivery_method, so.delivery_zone, COALESCE(u.business_name, u.name) AS shop
         FROM seller_orders so JOIN users u ON u.id=so.seller_id WHERE so.order_id=$1 AND ($2::bigint IS NULL OR so.seller_id=$2)`, [id, scope])).rows;
      if (me.role === 'seller' && !parts.length) return res.status(404).send('Receipt not found.');
      const items = (await pool.query(
        'SELECT * FROM order_items WHERE order_id=$1 AND ($2::bigint IS NULL OR seller_id=$2) ORDER BY id', [id, scope])).rows;
      const label = me.role === 'admin' ? 'Administrator copy' : me.role === 'seller' ? 'Your shop’s part' : 'Your copy';
      res.type('html').send(receiptHtml(order, parts, items, label));
    }));

  }

  return { migrate, mount, sendVerification, verifiedOnly, onNewProduct, lowStockAlerts };
};
