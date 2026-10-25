'use strict';
const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;
const IS_PROD = process.env.NODE_ENV === 'production';
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: IS_PROD ? { rejectUnauthorized: false } : false }) : null;

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// General API limit. Product images are excluded so a grid of photos does not use up the allowance.
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000, limit: 600, standardHeaders: true, legacyHeaders: false,
  skip: req => req.method === 'GET' && /\/image$/.test(req.path)
}));
// Stricter limit for sign-in and registration to slow password guessing.
app.use(['/api/auth/login', '/api/auth/register'], rateLimit({
  windowMs: 15 * 60 * 1000, limit: 20, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait 15 minutes and try again.' }
}));

// ---------- constants ----------
const FEATURES = ['crm', 'promos', 'discounts', 'seller_emails'];
const FEATURE_LABELS = { crm: 'Customer CRM', promos: 'Promo codes', discounts: 'Product discounts', seller_emails: 'Order email alerts' };
const EMAIL_KINDS = ['order_placed_buyer', 'order_placed_seller', 'order_status_buyer', 'order_cancelled_seller', 'seller_status', 'plan_changed', 'invoice_paid'];
const EMAIL_DEFAULTS = Object.fromEntries(EMAIL_KINDS.map(k => [k, true]));
const SELLER_ORDER_STATUSES = ['pending', 'confirmed', 'processing', 'ready', 'shipped', 'completed', 'cancelled'];
const RANK = { pending: 0, confirmed: 1, processing: 2, ready: 3, shipped: 4, completed: 5 };
const PAYMENT_STATUSES = ['unpaid', 'paid'];
const SELLER_STATUSES = ['pending', 'approved', 'rejected', 'suspended'];

// ---------- schema ----------
const schema = `
CREATE TABLE IF NOT EXISTS users (
 id BIGSERIAL PRIMARY KEY, name VARCHAR(120) NOT NULL, email VARCHAR(254) NOT NULL UNIQUE,
 phone VARCHAR(40), password_hash TEXT NOT NULL, role VARCHAR(20) NOT NULL CHECK(role IN ('buyer','seller','admin')),
 business_name VARCHAR(160), business_description TEXT, location VARCHAR(160), seller_status VARCHAR(20) NOT NULL DEFAULT 'pending',
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_code VARCHAR(30) NOT NULL DEFAULT 'free';
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS feature_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_notes TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS plans (
 code VARCHAR(30) PRIMARY KEY, name VARCHAR(80) NOT NULL, price_monthly NUMERIC(12,2) NOT NULL DEFAULT 0,
 max_products INTEGER, features JSONB NOT NULL DEFAULT '{}'::jsonb, commission_percent NUMERIC(5,2) NOT NULL DEFAULT 10,
 active BOOLEAN NOT NULL DEFAULT TRUE, sort_order INTEGER NOT NULL DEFAULT 0
);
INSERT INTO plans(code,name,price_monthly,max_products,features,commission_percent,sort_order) VALUES
 ('free','Free',0,10,'{"crm":false,"promos":false,"discounts":true,"seller_emails":true}',10,1),
 ('growth','Growth',150,100,'{"crm":true,"promos":true,"discounts":true,"seller_emails":true}',7,2),
 ('pro','Pro',400,NULL,'{"crm":true,"promos":true,"discounts":true,"seller_emails":true}',5,3)
ON CONFLICT (code) DO NOTHING;
CREATE TABLE IF NOT EXISTS platform_settings (key VARCHAR(60) PRIMARY KEY, value JSONB NOT NULL DEFAULT '{}'::jsonb);
INSERT INTO platform_settings(key,value) VALUES ('emails', '${JSON.stringify(EMAIL_DEFAULTS)}'::jsonb) ON CONFLICT (key) DO NOTHING;
CREATE TABLE IF NOT EXISTS products (
 id BIGSERIAL PRIMARY KEY, seller_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name VARCHAR(180) NOT NULL, description TEXT NOT NULL DEFAULT '', category VARCHAR(80) NOT NULL DEFAULT 'General',
 price NUMERIC(12,2) NOT NULL CHECK(price >= 0), stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0),
 image_url TEXT NOT NULL DEFAULT '', active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 discount_percent INTEGER NOT NULL DEFAULT 0, discount_ends_at TIMESTAMPTZ,
 image_data BYTEA, image_mime VARCHAR(30)
);
ALTER TABLE products ADD COLUMN IF NOT EXISTS discount_percent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS discount_ends_at TIMESTAMPTZ;
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_data BYTEA;
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_mime VARCHAR(30);
CREATE TABLE IF NOT EXISTS orders (
 id BIGSERIAL PRIMARY KEY, buyer_id BIGINT NOT NULL REFERENCES users(id), total NUMERIC(12,2) NOT NULL,
 status VARCHAR(30) NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','processing','ready','shipped','completed','cancelled')),
 payment_method VARCHAR(40) NOT NULL DEFAULT 'pay_on_delivery', payment_status VARCHAR(20) NOT NULL DEFAULT 'unpaid',
 delivery_name VARCHAR(120) NOT NULL, delivery_phone VARCHAR(40) NOT NULL, delivery_address TEXT NOT NULL,
 notes TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS order_items (
 id BIGSERIAL PRIMARY KEY, order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
 product_id BIGINT NOT NULL REFERENCES products(id), seller_id BIGINT NOT NULL REFERENCES users(id),
 product_name VARCHAR(180) NOT NULL, quantity INTEGER NOT NULL CHECK(quantity > 0), unit_price NUMERIC(12,2) NOT NULL
);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS list_price NUMERIC(12,2);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS promo_code VARCHAR(40);
CREATE TABLE IF NOT EXISTS seller_orders (
 order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
 seller_id BIGINT NOT NULL REFERENCES users(id),
 status VARCHAR(30) NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','processing','ready','shipped','completed','cancelled')),
 payment_status VARCHAR(20) NOT NULL DEFAULT 'unpaid',
 subtotal NUMERIC(12,2) NOT NULL DEFAULT 0, commission_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
 commission_amount NUMERIC(12,2) NOT NULL DEFAULT 0, promo_code VARCHAR(40),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY (order_id, seller_id)
);
INSERT INTO seller_orders(order_id, seller_id, status, payment_status, subtotal)
 SELECT oi.order_id, oi.seller_id, o.status, o.payment_status, SUM(oi.quantity * oi.unit_price)
 FROM order_items oi JOIN orders o ON o.id = oi.order_id
 GROUP BY oi.order_id, oi.seller_id, o.status, o.payment_status
 ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS seller_order_events (
 id BIGSERIAL PRIMARY KEY, order_id BIGINT NOT NULL, seller_id BIGINT NOT NULL, actor_id BIGINT,
 actor_role VARCHAR(20), detail TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS reviews (
 id BIGSERIAL PRIMARY KEY, product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
 buyer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
 comment TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(product_id,buyer_id)
);
CREATE TABLE IF NOT EXISTS promo_codes (
 id BIGSERIAL PRIMARY KEY, seller_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 code VARCHAR(40) NOT NULL UNIQUE, percent_off INTEGER NOT NULL CHECK(percent_off BETWEEN 1 AND 90),
 ends_at TIMESTAMPTZ, max_uses INTEGER, uses INTEGER NOT NULL DEFAULT 0, active BOOLEAN NOT NULL DEFAULT TRUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS seller_customer_notes (
 seller_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 buyer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 notes TEXT NOT NULL DEFAULT '', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY (seller_id, buyer_id)
);
CREATE TABLE IF NOT EXISTS invoices (
 id BIGSERIAL PRIMARY KEY, seller_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 plan_code VARCHAR(30) NOT NULL, months INTEGER NOT NULL DEFAULT 1, amount NUMERIC(12,2) NOT NULL DEFAULT 0,
 status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK(status IN ('open','paid','void')),
 period_start TIMESTAMPTZ, period_end TIMESTAMPTZ, paid_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS email_outbox (
 id BIGSERIAL PRIMARY KEY, to_email VARCHAR(254) NOT NULL, kind VARCHAR(40) NOT NULL, subject TEXT NOT NULL,
 text_body TEXT NOT NULL, html_body TEXT NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'pending',
 attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), sent_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS products_category_idx ON products(category);
CREATE INDEX IF NOT EXISTS products_seller_idx ON products(seller_id);
CREATE INDEX IF NOT EXISTS order_buyer_idx ON orders(buyer_id);
CREATE INDEX IF NOT EXISTS order_items_seller_idx ON order_items(seller_id);
CREATE INDEX IF NOT EXISTS order_items_product_idx ON order_items(product_id);
CREATE INDEX IF NOT EXISTS seller_orders_seller_idx ON seller_orders(seller_id);
CREATE INDEX IF NOT EXISTS email_outbox_status_idx ON email_outbox(status);
`;

async function initDb() {
  if (!pool) { console.warn('DATABASE_URL is not configured. API will report setup required.'); return; }
  await pool.query(schema);
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    const email = process.env.ADMIN_EMAIL.trim().toLowerCase();
    const exists = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
    if (!exists.rowCount) {
      const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
      await pool.query("INSERT INTO users(name,email,password_hash,role,seller_status) VALUES($1,$2,$3,'admin','approved')", [process.env.ADMIN_NAME || 'Kapiri Administrator', email, hash]);
      console.log('Initial admin account created from environment settings.');
    }
  }
}

const sessionConfig = {
  secret: process.env.SESSION_SECRET || 'development-only-change-this-secret-before-deploying',
  resave: false, saveUninitialized: false, rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: IS_PROD, maxAge: 1000 * 60 * 60 * 24 * 7 }
};
if (pool) sessionConfig.store = new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true });
app.use(session(sessionConfig));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const httpError = (message, status = 400) => Object.assign(new Error(message), { status });
const requireDb = (req, res, next) => pool ? next() : res.status(503).json({ error: 'Marketplace database is not configured yet. Add DATABASE_URL in Render.' });
const requireAuth = (req, res, next) => req.session.user ? next() : res.status(401).json({ error: 'Please sign in to continue.' });
const requireRole = role => (req, res, next) => req.session.user && (req.session.user.role === role || req.session.user.role === 'admin') ? next() : res.status(403).json({ error: 'You do not have permission to do that.' });
const requireAdmin = (req, res, next) => req.session.user && req.session.user.role === 'admin' ? next() : res.status(403).json({ error: 'Administrator access is required.' });
// Checks the database, not the session, so a status change takes effect immediately.
const requireApprovedSeller = asyncRoute(async (req, res, next) => {
  const r = await pool.query('SELECT seller_status FROM users WHERE id=$1', [req.session.user.id]);
  if (!r.rowCount || r.rows[0].seller_status !== 'approved') return res.status(403).json({ error: 'Your seller account is not active. Check its status with the marketplace administrator.' });
  next();
});
const safeUser = u => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, businessName: u.business_name, businessDescription: u.business_description, location: u.location, sellerStatus: u.seller_status });
const validEmail = email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
const clean = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const pickStr = (v, max) => v === undefined ? undefined : clean(v, max);
const parseId = v => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const roundMoney = n => Math.round(Number(n) * 100) / 100;
const toNum = v => (v === '' || v === null || v === undefined || typeof v === 'boolean') ? NaN : Number(v);
const isValidPrice = v => { const n = toNum(v); return Number.isFinite(n) && n >= 0; };
const isValidStock = v => { const n = toNum(v); return Number.isInteger(n) && n >= 0; };
const escapeHtml = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const siteUrl = () => (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const addMonths = (date, months) => { const d = new Date(date); d.setMonth(d.getMonth() + months); return d; };

// Combine duplicate cart lines so the stock check sees the true total for each product.
function mergeCart(items) {
  const merged = new Map();
  for (const item of items) {
    const id = Number(item.id), qty = Number(item.quantity);
    if (!Number.isInteger(id) || !Number.isInteger(qty) || qty < 1) throw httpError('One of the cart quantities is invalid.');
    merged.set(id, (merged.get(id) || 0) + qty);
  }
  for (const q of merged.values()) if (q > 100) throw httpError('You can order up to 100 of each item at a time.');
  return [...merged.entries()];
}

// Discount logic shared by every product query. A discount applies only while it is set and not expired.
const DISCOUNT_ACTIVE = '(p.discount_percent > 0 AND (p.discount_ends_at IS NULL OR p.discount_ends_at > NOW()))';
const SALE_PRICE = `(CASE WHEN ${DISCOUNT_ACTIVE} THEN ROUND(p.price * (100 - p.discount_percent) / 100.0, 2) ELSE p.price END)`;
const PRODUCT_COLS = `p.id, p.seller_id, p.name, p.description, p.category, p.price, p.stock, p.image_url,
  (p.image_data IS NOT NULL) AS has_image, p.discount_percent, p.discount_ends_at, p.active, p.created_at,
  ${DISCOUNT_ACTIVE} AS discount_active, ${SALE_PRICE} AS sale_price`;

function detectImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'image/png';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

function validateProduct(i) {
  const name = clean(i.name, 180);
  if (!name) return { error: 'Enter a product name.' };
  if (!isValidPrice(i.price)) return { error: 'Enter a valid price of zero or more.' };
  if (!isValidStock(i.stock)) return { error: 'Stock must be a whole number of zero or more.' };
  const discountPercent = toNum(i.discountPercent ?? 0);
  if (!Number.isInteger(discountPercent) || discountPercent < 0 || discountPercent > 90) return { error: 'Discount must be a whole number from 0 to 90 percent.' };
  let discountEndsAt = null;
  if (i.discountEndsAt) {
    const d = new Date(i.discountEndsAt);
    if (isNaN(d)) return { error: 'Enter a valid discount end date.' };
    discountEndsAt = d;
  }
  return {
    value: {
      name, description: clean(i.description, 3000), category: clean(i.category, 80) || 'General',
      price: toNum(i.price), stock: toNum(i.stock), discountPercent, discountEndsAt,
      active: i.active === true || i.active === 'true' || i.active === 1
    }
  };
}

function validatePromo(b) {
  const code = clean(b.code, 40).toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z0-9_-]{3,40}$/.test(code)) return { error: 'Promo codes use 3 to 40 letters, numbers, dashes or underscores.' };
  const percentOff = toNum(b.percentOff);
  if (!Number.isInteger(percentOff) || percentOff < 1 || percentOff > 90) return { error: 'Promo discount must be a whole number from 1 to 90 percent.' };
  let endsAt = null;
  if (b.endsAt) { endsAt = new Date(b.endsAt); if (isNaN(endsAt)) return { error: 'Enter a valid expiry date.' }; }
  let maxUses = null;
  if (b.maxUses !== '' && b.maxUses !== null && b.maxUses !== undefined) {
    maxUses = toNum(b.maxUses);
    if (!Number.isInteger(maxUses) || maxUses < 1) return { error: 'Maximum uses must be a whole number of at least 1, or left blank.' };
  }
  return { value: { code, percentOff, endsAt, maxUses } };
}

async function loadSellerProduct(id, sellerId) {
  const r = await pool.query(`SELECT ${PRODUCT_COLS} FROM products p WHERE p.id=$1 AND p.seller_id=$2`, [id, sellerId]);
  return r.rows[0] || null;
}

// ---------- plans and entitlements ----------
// Effective limits for a seller: the plan, unless it has expired, with per-seller overrides applied on top.
async function entitlementsFor(userId, db = pool) {
  const r = await db.query('SELECT plan_code, plan_expires_at, feature_overrides, seller_status, business_name, name FROM users WHERE id=$1', [userId]);
  if (!r.rowCount) return null;
  const u = r.rows[0];
  const expired = !!u.plan_expires_at && new Date(u.plan_expires_at) < new Date();
  const code = expired ? 'free' : u.plan_code;
  let plan = (await db.query('SELECT * FROM plans WHERE code=$1', [code])).rows[0];
  if (!plan) plan = (await db.query("SELECT * FROM plans WHERE code='free'")).rows[0] || { code: 'free', name: 'Free', price_monthly: 0, max_products: 10, features: {}, commission_percent: 10 };
  const ov = u.feature_overrides || {};
  const features = { ...plan.features };
  for (const k of FEATURES) if (typeof ov[k] === 'boolean') features[k] = ov[k];
  const maxProducts = ov.max_products !== undefined ? (ov.max_products === null ? null : Number(ov.max_products)) : (plan.max_products === null ? null : Number(plan.max_products));
  const commissionPercent = ov.commission !== undefined && ov.commission !== null ? Number(ov.commission) : Number(plan.commission_percent);
  return {
    planCode: plan.code, planName: plan.name, planPrice: Number(plan.price_monthly), expired,
    expiresAt: u.plan_expires_at, features, maxProducts, commissionPercent,
    sellerStatus: u.seller_status, shopName: u.business_name || u.name
  };
}

const planError = (res, ent, feature) => res.status(403).json({
  error: `${FEATURE_LABELS[feature] || feature} is not included in your ${ent ? ent.planName : ''} plan. Ask the marketplace administrator to upgrade you.`,
  feature
});

const requireFeature = feature => asyncRoute(async (req, res, next) => {
  const ent = await entitlementsFor(req.session.user.id);
  if (!ent || !ent.features[feature]) return planError(res, ent, feature);
  req.entitlements = ent;
  next();
});

// ---------- settings and email ----------
async function getSetting(key, fallback, db = pool) {
  const r = await db.query('SELECT value FROM platform_settings WHERE key=$1', [key]);
  return r.rowCount ? r.rows[0].value : fallback;
}
async function emailOn(kind) {
  const s = await getSetting('emails', EMAIL_DEFAULTS);
  return (s[kind] ?? EMAIL_DEFAULTS[kind]) !== false;
}

function renderMail(subject, heading, lines) {
  const text = [heading, '', ...lines, '', 'Kapiri Online'].join('\n');
  const html = `<div style="font-family:Arial,sans-serif;color:#17251f"><h2 style="color:#143c32">${escapeHtml(heading)}</h2>${lines.map(l => `<p>${escapeHtml(l)}</p>`).join('')}<p style="color:#78827c">Kapiri Online</p></div>`;
  return { subject, text, html };
}

async function enqueueEmail(db, to, kind, mail) {
  if (!to) return;
  await db.query('INSERT INTO email_outbox(to_email,kind,subject,text_body,html_body) VALUES($1,$2,$3,$4,$5)', [to, kind, mail.subject, mail.text, mail.html]);
}

// Sends queued emails through Resend. Set RESEND_API_KEY and EMAIL_FROM. Messages wait in the queue until they are configured.
async function sendViaResend(m) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [m.to_email], subject: m.subject, text: m.text_body, html: m.html_body })
  });
  if (!res.ok) throw new Error(`Email provider responded ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
}

let outboxBusy = false;
async function processOutbox() {
  if (!pool || outboxBusy) return;
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) return;
  outboxBusy = true;
  try {
    const rows = (await pool.query("SELECT * FROM email_outbox WHERE status='pending' AND attempts < 5 ORDER BY id LIMIT 20")).rows;
    for (const m of rows) {
      try {
        await sendViaResend(m);
        await pool.query("UPDATE email_outbox SET status='sent', sent_at=NOW(), attempts=attempts+1, last_error=NULL WHERE id=$1", [m.id]);
      } catch (e) {
        const failed = m.attempts + 1 >= 5;
        await pool.query('UPDATE email_outbox SET status=$1, attempts=attempts+1, last_error=$2 WHERE id=$3', [failed ? 'failed' : 'pending', String(e.message).slice(0, 500), m.id]);
      }
    }
  } finally {
    outboxBusy = false;
  }
}

// Notification builders. Each one queues email; nothing is sent inline with the request.
async function notifyBuyerOfOrder(order, lines, sellerSubtotals, buyerEmail) {
  if (!(await emailOn('order_placed_buyer'))) return;
  const shops = [...sellerSubtotals.entries()].map(([sid, sub]) => {
    const items = lines.filter(l => Number(l.p.seller_id) === sid).map(l => `   ${l.qty} x ${l.p.name} @ K${l.unit.toFixed(2)}`);
    return [`${sub.shop}: K${sub.total.toFixed(2)}`, ...items];
  }).flat();
  const mail = renderMail(`Order #${order.id} received`, 'Thank you for your order', [
    `Order #${order.id} has been placed. Each shop confirms its part of your order separately.`,
    ...shops,
    `Total: K${Number(order.total).toFixed(2)}`,
    `Payment: ${order.payment_method.replace(/_/g, ' ')}`,
    `Delivery: ${order.delivery_address}`,
    siteUrl() ? `Track your orders: ${siteUrl()}/#orders` : 'Track your orders in My orders on the marketplace.'
  ]);
  await enqueueEmail(pool, buyerEmail, 'order_placed_buyer', mail);
}

async function notifySellersOfOrder(order, lines, buyer) {
  if (!(await emailOn('order_placed_seller'))) return;
  const bySeller = new Map();
  for (const l of lines) {
    const key = Number(l.p.seller_id);
    if (!bySeller.has(key)) bySeller.set(key, []);
    bySeller.get(key).push(l);
  }
  const { rows: sellers } = await pool.query('SELECT id, email FROM users WHERE id = ANY($1::bigint[])', [[...bySeller.keys()]]);
  for (const seller of sellers) {
    const ent = await entitlementsFor(seller.id);
    if (!ent || !ent.features.seller_emails) continue;
    const items = bySeller.get(Number(seller.id));
    const share = roundMoney(items.reduce((s, l) => s + l.unit * l.qty, 0));
    const mail = renderMail(`New order #${order.id} on Kapiri Online`, 'You have a new order', [
      `Buyer: ${buyer.name}`,
      `Phone: ${order.delivery_phone}`,
      `Delivery: ${order.delivery_address}`,
      `Payment: ${order.payment_method.replace(/_/g, ' ')}`,
      order.notes ? `Notes: ${order.notes}` : '',
      'Your items:',
      ...items.map(l => `   ${l.qty} x ${l.p.name} @ K${l.unit.toFixed(2)}${l.promo ? ` (promo ${l.promo})` : ''}`),
      `Your share of this order: K${share.toFixed(2)}`,
      siteUrl() ? `Manage your orders: ${siteUrl()}/seller#/orders` : 'Manage your orders in your seller dashboard.'
    ].filter(Boolean));
    await enqueueEmail(pool, seller.email, 'order_placed_seller', mail);
  }
}

async function notifyBuyerOfSellerUpdate(orderId, sellerId) {
  if (!(await emailOn('order_status_buyer'))) return;
  const r = await pool.query(
    `SELECT o.id, b.email AS buyer_email, so.status, so.payment_status, s.business_name, s.name AS seller_name
     FROM orders o JOIN users b ON b.id=o.buyer_id JOIN seller_orders so ON so.order_id=o.id
     JOIN users s ON s.id=so.seller_id WHERE o.id=$1 AND so.seller_id=$2`, [orderId, sellerId]);
  if (!r.rowCount) return;
  const x = r.rows[0];
  const shop = x.business_name || x.seller_name;
  const mail = renderMail(`Update on order #${x.id} from ${shop}`, `${shop} updated your order`, [
    `Order #${x.id}`,
    `Status: ${x.status}`,
    `Payment: ${x.payment_status}`,
    siteUrl() ? `Track your orders: ${siteUrl()}/#orders` : 'Track your orders in My orders on the marketplace.'
  ]);
  await enqueueEmail(pool, x.buyer_email, 'order_status_buyer', mail);
}

// ---------- per-seller fulfilment ----------
// The order's own status is a summary of its shop parts: the least advanced live part, or cancelled if every part is cancelled.
async function recomputeOrder(db, orderId) {
  const r = await db.query('SELECT status, payment_status FROM seller_orders WHERE order_id=$1', [orderId]);
  const live = r.rows.filter(x => x.status !== 'cancelled');
  const status = live.length ? live.reduce((min, x) => RANK[x.status] < RANK[min] ? x.status : min, live[0].status) : 'cancelled';
  const paid = live.length && live.every(x => x.payment_status === 'paid') ? 'paid' : live.some(x => x.payment_status === 'paid') ? 'partial' : 'unpaid';
  await db.query('UPDATE orders SET status=$1, payment_status=$2 WHERE id=$3', [status, paid, orderId]);
}

// Applies a status or payment change to one shop's part of an order. Cancelling returns that shop's stock.
async function applySellerOrderChange(db, { orderId, sellerId, status, paymentStatus, actorId, actorRole }) {
  const cur = (await db.query('SELECT * FROM seller_orders WHERE order_id=$1 AND seller_id=$2 FOR UPDATE', [orderId, sellerId])).rows[0];
  if (!cur) throw httpError('Order not found.', 404);
  let newStatus = cur.status, newPayment = cur.payment_status;
  const changes = [];
  if (status !== undefined && status !== cur.status) {
    if (!SELLER_ORDER_STATUSES.includes(status)) throw httpError('Invalid order status.');
    if (cur.status === 'cancelled') throw httpError('Cancelled orders cannot be reopened. Place a new order instead.');
    if (status === 'cancelled') {
      await db.query('UPDATE products p SET stock = p.stock + oi.quantity FROM order_items oi WHERE oi.order_id=$1 AND oi.seller_id=$2 AND p.id=oi.product_id', [orderId, sellerId]);
    }
    newStatus = status;
    changes.push(`status ${status}`);
  }
  if (paymentStatus !== undefined && paymentStatus !== cur.payment_status) {
    if (!PAYMENT_STATUSES.includes(paymentStatus)) throw httpError('Payment status must be unpaid or paid.');
    newPayment = paymentStatus;
    changes.push(`payment ${paymentStatus}`);
  }
  if (!changes.length) return { row: cur, changed: false };
  const r = await db.query('UPDATE seller_orders SET status=$1, payment_status=$2, updated_at=NOW() WHERE order_id=$3 AND seller_id=$4 RETURNING *', [newStatus, newPayment, orderId, sellerId]);
  await db.query('INSERT INTO seller_order_events(order_id,seller_id,actor_id,actor_role,detail) VALUES($1,$2,$3,$4,$5)', [orderId, sellerId, actorId, actorRole, changes.join(', ')]);
  await recomputeOrder(db, orderId);
  return { row: r.rows[0], changed: true };
}

async function changeSellerOrder(req, res, orderId, sellerId, body) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { row, changed } = await applySellerOrderChange(client, {
      orderId, sellerId, status: body.status, paymentStatus: body.paymentStatus,
      actorId: req.session.user.id, actorRole: req.session.user.role
    });
    await client.query('COMMIT');
    if (changed) notifyBuyerOfSellerUpdate(orderId, sellerId).catch(err => console.error('Buyer update email failed:', err.message));
    res.json({ sellerOrder: row });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ---------- public endpoints ----------
app.get('/api/health', (req, res) => res.json({ status: 'ok', databaseConfigured: !!pool, service: 'Kapiri Online' }));

app.get('/api/plans', requireDb, asyncRoute(async (req, res) => {
  const r = await pool.query('SELECT code, name, price_monthly, max_products, features, commission_percent FROM plans WHERE active=TRUE ORDER BY sort_order');
  res.json({ plans: r.rows });
}));

app.get('/api/me', requireDb, asyncRoute(async (req, res) => {
  if (!req.session.user) return res.json({ user: null });
  const r = await pool.query('SELECT * FROM users WHERE id=$1', [req.session.user.id]);
  if (!r.rowCount) { req.session.user = null; return res.json({ user: null }); }
  req.session.user = safeUser(r.rows[0]);
  res.json({ user: req.session.user });
}));

app.post('/api/auth/register', requireDb, asyncRoute(async (req, res) => {
  const name = clean(req.body.name, 120), email = clean(req.body.email, 254).toLowerCase(), phone = clean(req.body.phone, 40);
  const password = String(req.body.password || ''), role = req.body.role === 'seller' ? 'seller' : 'buyer';
  const businessName = clean(req.body.businessName, 160), location = clean(req.body.location, 160);
  if (!name || !validEmail(email) || password.length < 8) return res.status(400).json({ error: 'Enter your name, a valid email, and a password of at least 8 characters.' });
  if (role === 'seller' && !businessName) return res.status(400).json({ error: 'Enter your business name to open a seller account.' });
  const hash = await bcrypt.hash(password, 12);
  try {
    const result = await pool.query('INSERT INTO users(name,email,phone,password_hash,role,business_name,location,seller_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [name, email, phone, hash, role, businessName || null, location || null, role === 'seller' ? 'pending' : 'approved']);
    req.session.user = safeUser(result.rows[0]);
    res.status(201).json({
      user: req.session.user,
      message: role === 'seller'
        ? 'Your seller account is created and awaiting marketplace approval. You can manage your shop and publish products once an administrator approves it.'
        : 'Your buyer account is ready.'
    });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'An account with that email already exists.' });
    throw e;
  }
}));

app.post('/api/auth/login', requireDb, asyncRoute(async (req, res) => {
  const email = clean(req.body.email, 254).toLowerCase(), password = String(req.body.password || '');
  const r = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
  if (!r.rowCount || !(await bcrypt.compare(password, r.rows[0].password_hash))) return res.status(401).json({ error: 'Email or password is incorrect.' });
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Could not start your session.' });
    req.session.user = safeUser(r.rows[0]);
    res.json({ user: req.session.user, message: 'Welcome back.' });
  });
}));

app.post('/api/auth/logout', (req, res) => req.session.destroy(() => { res.clearCookie('connect.sid'); res.json({ ok: true }); }));

// Account details: personal information for every user, and business details for sellers.
app.patch('/api/account', requireDb, requireAuth, asyncRoute(async (req, res) => {
  const b = req.body;
  const cur = (await pool.query('SELECT * FROM users WHERE id=$1', [req.session.user.id])).rows[0];
  if (!cur) return res.status(401).json({ error: 'Please sign in to continue.' });
  const isSeller = cur.role === 'seller';
  const pick = (key, current, max) => b[key] === undefined ? current : clean(b[key], max);
  const name = pick('name', cur.name, 120);
  const phone = pick('phone', cur.phone || '', 40);
  const email = b.email === undefined ? cur.email : clean(b.email, 254).toLowerCase();
  const businessName = isSeller ? pick('businessName', cur.business_name || '', 160) : cur.business_name;
  const businessDescription = isSeller ? pick('businessDescription', cur.business_description || '', 1000) : cur.business_description;
  const location = isSeller ? pick('location', cur.location || '', 160) : cur.location;
  if (!name) return res.status(400).json({ error: 'Enter your name.' });
  if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (isSeller && !businessName) return res.status(400).json({ error: 'Enter your business name.' });

  const wantsPassword = typeof b.newPassword === 'string' && b.newPassword.length > 0;
  const emailChanged = email !== cur.email;
  let hash = cur.password_hash;
  if (emailChanged || wantsPassword) {
    const ok = await bcrypt.compare(String(b.currentPassword || ''), cur.password_hash);
    if (!ok) return res.status(400).json({ error: 'Enter your current password to change your email or password.' });
  }
  if (wantsPassword) {
    if (b.newPassword.length < 8) return res.status(400).json({ error: 'Your new password must be at least 8 characters.' });
    hash = await bcrypt.hash(b.newPassword, 12);
  }
  try {
    const r = await pool.query(
      'UPDATE users SET name=$1, phone=$2, email=$3, business_name=$4, business_description=$5, location=$6, password_hash=$7 WHERE id=$8 RETURNING *',
      [name, phone, email, businessName || null, businessDescription || null, location || null, hash, cur.id]);
    req.session.user = safeUser(r.rows[0]);
    res.json({ user: req.session.user, message: wantsPassword ? 'Your details and password have been saved.' : 'Your details have been saved.' });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That email address is already used by another account.' });
    throw e;
  }
}));

// Catalogue. /hot must be defined before /:id.
app.get('/api/products', requireDb, asyncRoute(async (req, res) => {
  const q = clean(req.query.q, 100), category = clean(req.query.category, 80), sort = clean(req.query.sort, 20);
  const params = [], where = ['p.active=TRUE', "u.role='seller'", "u.seller_status='approved'"];
  if (q) { params.push(`%${q}%`); where.push(`(p.name ILIKE $${params.length} OR p.description ILIKE $${params.length} OR p.category ILIKE $${params.length} OR u.business_name ILIKE $${params.length})`); }
  if (category && category !== 'All') { params.push(category); where.push(`p.category=$${params.length}`); }
  let order = 'p.created_at DESC';
  if (sort === 'price-low') order = `${SALE_PRICE} ASC`;
  if (sort === 'price-high') order = `${SALE_PRICE} DESC`;
  if (sort === 'popular') order = 'p.id DESC';
  const r = await pool.query(
    `SELECT ${PRODUCT_COLS}, u.business_name, u.location, COALESCE(AVG(rv.rating),0) AS rating, COUNT(rv.id)::int AS review_count
     FROM products p JOIN users u ON u.id=p.seller_id LEFT JOIN reviews rv ON rv.product_id=p.id
     WHERE ${where.join(' AND ')} GROUP BY p.id, u.business_name, u.location ORDER BY ${order} LIMIT 100`, params);
  const cats = await pool.query("SELECT DISTINCT category FROM products WHERE active=TRUE ORDER BY category");
  res.json({ products: r.rows, categories: ['All', ...cats.rows.map(x => x.category)] });
}));

app.get('/api/products/hot', requireDb, asyncRoute(async (req, res) => {
  const r = await pool.query(
    `SELECT ${PRODUCT_COLS}, u.business_name, u.location,
       (SELECT COALESCE(SUM(oi.quantity),0)::int FROM order_items oi
          JOIN seller_orders so ON so.order_id=oi.order_id AND so.seller_id=oi.seller_id
          WHERE oi.product_id=p.id AND so.status<>'cancelled') AS sold,
       (SELECT COALESCE(AVG(rv.rating),0) FROM reviews rv WHERE rv.product_id=p.id) AS rating,
       (SELECT COUNT(*)::int FROM reviews rv WHERE rv.product_id=p.id) AS review_count
     FROM products p JOIN users u ON u.id=p.seller_id
     WHERE p.active=TRUE AND p.stock>0 AND u.role='seller' AND u.seller_status='approved'
     ORDER BY sold DESC, p.created_at DESC LIMIT 8`);
  res.json({ products: r.rows });
}));

app.get('/api/products/:id', requireDb, asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).json({ error: 'Product not found.' });
  const r = await pool.query(
    `SELECT ${PRODUCT_COLS}, u.business_name, u.location, COALESCE(AVG(rv.rating),0) AS rating, COUNT(rv.id)::int AS review_count
     FROM products p JOIN users u ON u.id=p.seller_id LEFT JOIN reviews rv ON rv.product_id=p.id
     WHERE p.id=$1 AND p.active=TRUE AND u.seller_status='approved' GROUP BY p.id, u.business_name, u.location`, [id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Product not found.' });
  res.json({ product: r.rows[0] });
}));

// Product photos are stored in the database, so they survive redeploys on Render's free plan.
app.get('/api/products/:id/image', requireDb, asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).end();
  const r = await pool.query(
    `SELECT p.image_data, p.image_mime FROM products p JOIN users u ON u.id=p.seller_id
     WHERE p.id=$1 AND p.active=TRUE AND u.seller_status='approved' AND p.image_data IS NOT NULL`, [id]);
  if (!r.rowCount) return res.status(404).end();
  res.set({ 'Content-Type': r.rows[0].image_mime, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  res.send(r.rows[0].image_data);
}));

// ---------- seller: shop, plan, products, promo codes ----------
app.get('/api/seller/summary', requireDb, requireAuth, requireRole('seller'), asyncRoute(async (req, res) => {
  const uid = req.session.user.id;
  const [products, orders, sales, customers] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS count, COALESCE(SUM(stock),0)::int AS stock FROM products WHERE seller_id=$1', [uid]),
    pool.query("SELECT COUNT(*)::int AS count FROM seller_orders WHERE seller_id=$1 AND status<>'cancelled'", [uid]),
    pool.query("SELECT COALESCE(SUM(subtotal),0) AS total, COALESCE(SUM(commission_amount),0) AS commission FROM seller_orders WHERE seller_id=$1 AND status<>'cancelled'", [uid]),
    pool.query("SELECT COUNT(DISTINCT buyer_id)::int AS count FROM orders o JOIN seller_orders so ON so.order_id=o.id WHERE so.seller_id=$1 AND so.status<>'cancelled'", [uid])
  ]);
  res.json({
    products: products.rows[0], orders: orders.rows[0].count, sales: sales.rows[0].total,
    platformFee: sales.rows[0].commission, customers: customers.rows[0].count
  });
}));

app.get('/api/seller/plan', requireDb, requireAuth, requireRole('seller'), asyncRoute(async (req, res) => {
  const uid = req.session.user.id;
  const ent = await entitlementsFor(uid);
  const [usage, invoices, plans] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS count FROM products WHERE seller_id=$1', [uid]),
    pool.query('SELECT id, plan_code, months, amount, status, period_start, period_end, paid_at, created_at FROM invoices WHERE seller_id=$1 ORDER BY created_at DESC LIMIT 20', [uid]),
    pool.query('SELECT code, name, price_monthly, max_products, features, commission_percent FROM plans WHERE active=TRUE ORDER BY sort_order')
  ]);
  res.json({ plan: ent, usage: { products: usage.rows[0].count }, invoices: invoices.rows, plans: plans.rows });
}));

// Full catalogue for the seller, including inactive and out-of-stock products.
app.get('/api/seller/products', requireDb, requireAuth, requireRole('seller'), asyncRoute(async (req, res) => {
  const r = await pool.query(
    `SELECT ${PRODUCT_COLS}, (SELECT COALESCE(SUM(oi.quantity),0)::int FROM order_items oi
        JOIN seller_orders so ON so.order_id=oi.order_id AND so.seller_id=oi.seller_id
        WHERE oi.product_id=p.id AND so.status<>'cancelled') AS sold
     FROM products p WHERE p.seller_id=$1 ORDER BY p.created_at DESC`, [req.session.user.id]);
  res.json({ products: r.rows });
}));

app.post('/api/seller/products', requireDb, requireAuth, requireRole('seller'), requireApprovedSeller, asyncRoute(async (req, res) => {
  const ent = await entitlementsFor(req.session.user.id);
  const v = validateProduct({ name: '', price: '', stock: 0, category: 'General', active: true, ...req.body });
  if (v.error) return res.status(400).json({ error: v.error });
  const x = v.value;
  if (x.discountPercent > 0 && !ent.features.discounts) return planError(res, ent, 'discounts');
  if (ent.maxProducts !== null) {
    const count = (await pool.query('SELECT COUNT(*)::int AS count FROM products WHERE seller_id=$1', [req.session.user.id])).rows[0].count;
    if (count >= ent.maxProducts) return res.status(403).json({ error: `Your ${ent.planName} plan allows ${ent.maxProducts} products. Ask the marketplace administrator to upgrade your plan.` });
  }
  const r = await pool.query(
    'INSERT INTO products(seller_id,name,description,category,price,stock,discount_percent,discount_ends_at,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
    [req.session.user.id, x.name, x.description, x.category, x.price, x.stock, x.discountPercent, x.discountEndsAt, x.active]);
  res.status(201).json({ product: await loadSellerProduct(r.rows[0].id, req.session.user.id) });
}));

app.patch('/api/seller/products/:id', requireDb, requireAuth, requireRole('seller'), requireApprovedSeller, asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  const cur = id && (await pool.query('SELECT * FROM products WHERE id=$1 AND seller_id=$2', [id, req.session.user.id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'Product not found in your shop.' });
  const base = { name: cur.name, description: cur.description, category: cur.category, price: cur.price, stock: cur.stock,
    discountPercent: cur.discount_percent, discountEndsAt: cur.discount_ends_at, active: cur.active };
  const input = { ...base };
  for (const k of Object.keys(base)) if (req.body[k] !== undefined) input[k] = req.body[k];
  const v = validateProduct(input);
  if (v.error) return res.status(400).json({ error: v.error });
  const x = v.value;
  const ent = await entitlementsFor(req.session.user.id);
  if (x.discountPercent > 0 && !ent.features.discounts) return planError(res, ent, 'discounts');
  await pool.query(
    'UPDATE products SET name=$1, description=$2, category=$3, price=$4, stock=$5, discount_percent=$6, discount_ends_at=$7, active=$8 WHERE id=$9 AND seller_id=$10',
    [x.name, x.description, x.category, x.price, x.stock, x.discountPercent, x.discountEndsAt, x.active, id, req.session.user.id]);
  res.json({ product: await loadSellerProduct(id, req.session.user.id) });
}));

// Products that have been ordered are hidden rather than deleted, so order history stays intact.
app.delete('/api/seller/products/:id', requireDb, requireAuth, requireRole('seller'), asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  const owned = id && (await pool.query('SELECT id FROM products WHERE id=$1 AND seller_id=$2', [id, req.session.user.id])).rowCount;
  if (!owned) return res.status(404).json({ error: 'Product not found in your shop.' });
  const ordered = await pool.query('SELECT 1 FROM order_items WHERE product_id=$1 LIMIT 1', [id]);
  if (ordered.rowCount) {
    await pool.query('UPDATE products SET active=FALSE WHERE id=$1', [id]);
    return res.json({ ok: true, archived: true, message: 'This product has past orders, so it was hidden instead of deleted.' });
  }
  await pool.query('DELETE FROM products WHERE id=$1', [id]);
  res.json({ ok: true, archived: false });
}));

// Raw image upload. The body is the image file itself; the type is checked from the file's first bytes.
app.put('/api/seller/products/:id/image', requireDb, requireAuth, requireRole('seller'), requireApprovedSeller,
  express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '2mb' }),
  asyncRoute(async (req, res) => {
    const id = parseId(req.params.id);
    const mime = detectImage(req.body);
    if (!id) return res.status(404).json({ error: 'Product not found in your shop.' });
    if (!mime) return res.status(400).json({ error: 'Upload a JPEG, PNG or WebP image of 2 MB or smaller.' });
    const r = await pool.query('UPDATE products SET image_data=$1, image_mime=$2 WHERE id=$3 AND seller_id=$4 RETURNING id', [req.body, mime, id, req.session.user.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Product not found in your shop.' });
    res.json({ ok: true, imageUrl: `/api/products/${id}/image` });
  }));

app.delete('/api/seller/products/:id/image', requireDb, requireAuth, requireRole('seller'), asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).json({ error: 'Product not found in your shop.' });
  await pool.query('UPDATE products SET image_data=NULL, image_mime=NULL WHERE id=$1 AND seller_id=$2', [id, req.session.user.id]);
  res.json({ ok: true });
}));

app.get('/api/seller/promos', requireDb, requireAuth, requireRole('seller'), asyncRoute(async (req, res) => {
  const r = await pool.query('SELECT * FROM promo_codes WHERE seller_id=$1 ORDER BY created_at DESC', [req.session.user.id]);
  res.json({ promos: r.rows });
}));

app.post('/api/seller/promos', requireDb, requireAuth, requireRole('seller'), requireApprovedSeller, requireFeature('promos'), asyncRoute(async (req, res) => {
  const v = validatePromo(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const x = v.value;
  try {
    const r = await pool.query('INSERT INTO promo_codes(seller_id,code,percent_off,ends_at,max_uses) VALUES($1,$2,$3,$4,$5) RETURNING *',
      [req.session.user.id, x.code, x.percentOff, x.endsAt, x.maxUses]);
    res.status(201).json({ promo: r.rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That promo code is already in use. Choose another.' });
    throw e;
  }
}));

app.patch('/api/seller/promos/:id', requireDb, requireAuth, requireRole('seller'), requireApprovedSeller, requireFeature('promos'), asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  const cur = id && (await pool.query('SELECT * FROM promo_codes WHERE id=$1 AND seller_id=$2', [id, req.session.user.id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'Promo code not found.' });
  const b = req.body;
  const active = b.active === undefined ? cur.active : (b.active === true || b.active === 'true');
  let endsAt = cur.ends_at;
  if (b.endsAt !== undefined) {
    endsAt = b.endsAt ? new Date(b.endsAt) : null;
    if (endsAt && isNaN(endsAt)) return res.status(400).json({ error: 'Enter a valid expiry date.' });
  }
  let maxUses = cur.max_uses;
  if (b.maxUses !== undefined) {
    maxUses = (b.maxUses === '' || b.maxUses === null) ? null : toNum(b.maxUses);
    if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1)) return res.status(400).json({ error: 'Maximum uses must be a whole number of at least 1, or left blank.' });
  }
  const r = await pool.query('UPDATE promo_codes SET active=$1, ends_at=$2, max_uses=$3 WHERE id=$4 RETURNING *', [active, endsAt, maxUses, id]);
  res.json({ promo: r.rows[0] });
}));

// ---------- seller: customers (CRM) ----------
app.get('/api/seller/customers', requireDb, requireAuth, requireRole('seller'), requireFeature('crm'), asyncRoute(async (req, res) => {
  const uid = req.session.user.id;
  const r = await pool.query(
    `SELECT b.id, b.name, b.email, b.phone AS account_phone,
       COALESCE(n.notes,'') AS notes,
       COUNT(DISTINCT o.id)::int AS orders_count,
       COALESCE(SUM(oi.quantity*oi.unit_price),0) AS spent,
       MAX(o.created_at) AS last_order_at,
       (SELECT o2.delivery_phone FROM orders o2 WHERE o2.buyer_id=b.id AND o2.id IN (SELECT order_id FROM seller_orders WHERE seller_id=$1) ORDER BY o2.created_at DESC LIMIT 1) AS delivery_phone,
       (SELECT o2.delivery_address FROM orders o2 WHERE o2.buyer_id=b.id AND o2.id IN (SELECT order_id FROM seller_orders WHERE seller_id=$1) ORDER BY o2.created_at DESC LIMIT 1) AS delivery_address
     FROM order_items oi
     JOIN orders o ON o.id=oi.order_id
     JOIN seller_orders so ON so.order_id=oi.order_id AND so.seller_id=oi.seller_id
     JOIN users b ON b.id=o.buyer_id
     LEFT JOIN seller_customer_notes n ON n.seller_id=oi.seller_id AND n.buyer_id=b.id
     WHERE oi.seller_id=$1 AND so.status<>'cancelled'
     GROUP BY b.id, b.name, b.email, b.phone, n.notes
     ORDER BY last_order_at DESC`, [uid]);
  res.json({ customers: r.rows });
}));

app.put('/api/seller/customers/:buyerId/notes', requireDb, requireAuth, requireRole('seller'), requireApprovedSeller, requireFeature('crm'), asyncRoute(async (req, res) => {
  const buyerId = parseId(req.params.buyerId);
  const own = buyerId && (await pool.query(
    'SELECT 1 FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.seller_id=$1 AND o.buyer_id=$2 LIMIT 1',
    [req.session.user.id, buyerId])).rowCount;
  if (!own) return res.status(404).json({ error: 'Customer not found in your shop.' });
  const notes = clean(req.body.notes, 2000);
  await pool.query(
    `INSERT INTO seller_customer_notes(seller_id,buyer_id,notes,updated_at) VALUES($1,$2,$3,NOW())
     ON CONFLICT(seller_id,buyer_id) DO UPDATE SET notes=EXCLUDED.notes, updated_at=NOW()`,
    [req.session.user.id, buyerId, notes]);
  res.json({ ok: true, notes });
}));

// Each seller updates only their own part of an order.
app.patch('/api/seller/orders/:id/status', requireDb, requireAuth, requireRole('seller'), requireApprovedSeller, asyncRoute(async (req, res) => {
  const orderId = parseId(req.params.id);
  if (!orderId) return res.status(404).json({ error: 'Order not found.' });
  return changeSellerOrder(req, res, orderId, req.session.user.id, { status: clean(req.body.status, 30) });
}));

app.patch('/api/seller/orders/:id/payment', requireDb, requireAuth, requireRole('seller'), requireApprovedSeller, asyncRoute(async (req, res) => {
  const orderId = parseId(req.params.id);
  if (!orderId) return res.status(404).json({ error: 'Order not found.' });
  return changeSellerOrder(req, res, orderId, req.session.user.id, { paymentStatus: clean(req.body.paymentStatus, 20) });
}));

// ---------- orders ----------
app.post('/api/orders', requireDb, requireAuth, asyncRoute(async (req, res) => {
  if (req.session.user.role === 'seller') return res.status(403).json({ error: 'Seller accounts cannot place buyer orders. Use a buyer account to shop.' });
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  const deliveryName = clean(req.body.deliveryName, 120), deliveryPhone = clean(req.body.deliveryPhone, 40);
  const deliveryAddress = clean(req.body.deliveryAddress, 1000), notes = clean(req.body.notes, 1000);
  const promoInput = clean(req.body.promoCode, 40).toUpperCase();
  const paymentMethod = ['pay_on_delivery', 'mobile_money_manual', 'bank_transfer_manual'].includes(req.body.paymentMethod) ? req.body.paymentMethod : 'pay_on_delivery';
  if (!items.length || items.length > 50) return res.status(400).json({ error: 'Your cart is empty or contains too many items.' });
  if (!deliveryName || !deliveryPhone || !deliveryAddress) return res.status(400).json({ error: 'Enter the delivery name, phone number and address.' });

  const client = await pool.connect();
  let order, lines, sellerSubtotals;
  try {
    await client.query('BEGIN');
    lines = [];
    for (const [id, qty] of mergeCart(items)) {
      const r = await client.query(
        `SELECT ${PRODUCT_COLS}, u.seller_status, u.business_name AS shop FROM products p JOIN users u ON u.id=p.seller_id
         WHERE p.id=$1 AND p.active=TRUE AND u.seller_status='approved' AND u.role='seller' FOR UPDATE OF p`, [id]);
      if (!r.rowCount) throw httpError('A product in your cart is no longer available.');
      const p = r.rows[0];
      if (p.stock < qty) throw httpError(`Not enough stock for ${p.name}.`);
      lines.push({ p, qty, unit: Number(p.sale_price), listPrice: Number(p.price), promo: null });
    }

    // A promo code belongs to one seller and only discounts that seller's items in the cart.
    let promo = null;
    if (promoInput) {
      const pr = await client.query('SELECT * FROM promo_codes WHERE code=$1 AND active=TRUE AND (ends_at IS NULL OR ends_at > NOW()) FOR UPDATE', [promoInput]);
      if (!pr.rowCount) throw httpError('That promo code is not valid or has expired.');
      promo = pr.rows[0];
      if (promo.max_uses !== null && promo.uses >= promo.max_uses) throw httpError('That promo code has been fully used.');
      const promoOwner = await entitlementsFor(promo.seller_id, client);
      if (!promoOwner || !promoOwner.features.promos) throw httpError('That promo code is no longer available.');
      let applied = 0;
      for (const l of lines) {
        if (Number(l.p.seller_id) === Number(promo.seller_id)) {
          l.unit = roundMoney(l.unit * (100 - promo.percent_off) / 100);
          l.promo = promo.code;
          applied++;
        }
      }
      if (!applied) throw httpError('This promo code does not apply to any items in your cart.');
    }

    // Group the cart by shop. Each shop gets its own order part with its own subtotal and platform fee.
    sellerSubtotals = new Map();
    for (const l of lines) {
      const sid = Number(l.p.seller_id);
      const cur = sellerSubtotals.get(sid) || { total: 0, shop: l.p.shop, promo: null };
      cur.total = roundMoney(cur.total + l.unit * l.qty);
      if (l.promo) cur.promo = l.promo;
      sellerSubtotals.set(sid, cur);
    }
    const total = roundMoney([...sellerSubtotals.values()].reduce((s, x) => s + x.total, 0));
    const o = await client.query(
      'INSERT INTO orders(buyer_id,total,payment_method,delivery_name,delivery_phone,delivery_address,notes) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [req.session.user.id, total, paymentMethod, deliveryName, deliveryPhone, deliveryAddress, notes]);
    order = o.rows[0];
    for (const [sid, s] of sellerSubtotals) {
      const ent = await entitlementsFor(sid, client);
      const pct = ent ? ent.commissionPercent : 10;
      await client.query(
        'INSERT INTO seller_orders(order_id,seller_id,status,payment_status,subtotal,commission_percent,commission_amount,promo_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [order.id, sid, 'pending', 'unpaid', s.total, pct, roundMoney(s.total * pct / 100), s.promo]);
    }
    for (const l of lines) {
      await client.query(
        'INSERT INTO order_items(order_id,product_id,seller_id,product_name,quantity,unit_price,list_price,promo_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [order.id, l.p.id, l.p.seller_id, l.p.name, l.qty, l.unit, l.listPrice, l.promo]);
      await client.query('UPDATE products SET stock=stock-$1 WHERE id=$2', [l.qty, l.p.id]);
    }
    if (promo) await client.query('UPDATE promo_codes SET uses=uses+1 WHERE id=$1', [promo.id]);
    await recomputeOrder(client, order.id);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  // Emails are queued after the order is saved. A failed email never fails the order.
  const sellerTotals = new Map([...sellerSubtotals].map(([sid, s]) => [sid, { total: s.total, shop: s.shop }]));
  notifyBuyerOfOrder(order, lines, sellerTotals, req.session.user.email).catch(err => console.error('Buyer order email failed:', err.message));
  notifySellersOfOrder(order, lines, { name: deliveryName }).catch(err => console.error('Seller order email failed:', err.message));
  const fresh = (await pool.query('SELECT * FROM orders WHERE id=$1', [order.id])).rows[0];
  res.status(201).json({ order: fresh, message: 'Order placed. Each shop will confirm its part of your order and the payment arrangements.' });
}));

app.get('/api/orders', requireDb, requireAuth, asyncRoute(async (req, res) => {
  const { id, role } = req.session.user;
  let orders;
  if (role === 'admin') {
    orders = (await pool.query('SELECT o.*, u.name AS buyer_name FROM orders o JOIN users u ON u.id=o.buyer_id ORDER BY o.created_at DESC LIMIT 200')).rows;
  } else if (role === 'seller') {
    orders = (await pool.query(
      `SELECT o.*, u.name AS buyer_name, so.status AS seller_status, so.payment_status AS seller_payment_status,
         so.subtotal AS seller_subtotal, so.commission_amount AS seller_commission
       FROM orders o JOIN users u ON u.id=o.buyer_id JOIN seller_orders so ON so.order_id=o.id AND so.seller_id=$1
       ORDER BY o.created_at DESC LIMIT 200`, [id])).rows;
  } else {
    orders = (await pool.query('SELECT * FROM orders WHERE buyer_id=$1 ORDER BY created_at DESC', [id])).rows;
  }
  const ids = orders.map(o => o.id);
  const itemsByOrder = new Map(), sellersByOrder = new Map();
  if (ids.length) {
    const itemParams = [ids];
    let itemFilter = '';
    if (role === 'seller') { itemParams.push(id); itemFilter = ' AND oi.seller_id=$2::bigint'; }
    const items = (await pool.query(
      `SELECT oi.*, (p.image_data IS NOT NULL) AS has_image, su.business_name AS shop_name
       FROM order_items oi LEFT JOIN products p ON p.id=oi.product_id JOIN users su ON su.id=oi.seller_id
       WHERE oi.order_id = ANY($1::bigint[])${itemFilter} ORDER BY oi.id`, itemParams)).rows;
    for (const it of items) {
      if (!itemsByOrder.has(it.order_id)) itemsByOrder.set(it.order_id, []);
      itemsByOrder.get(it.order_id).push(it);
    }
    const sellerParams = [ids];
    let sellerFilter = '';
    if (role === 'seller') { sellerParams.push(id); sellerFilter = ' AND so.seller_id=$2::bigint'; }
    const sellers = (await pool.query(
      `SELECT so.order_id, so.seller_id, so.status, so.payment_status, so.subtotal, so.commission_amount, so.promo_code,
         COALESCE(u.business_name, u.name) AS shop_name
       FROM seller_orders so JOIN users u ON u.id=so.seller_id
       WHERE so.order_id = ANY($1::bigint[])${sellerFilter} ORDER BY so.order_id`, sellerParams)).rows;
    for (const s of sellers) {
      if (!sellersByOrder.has(s.order_id)) sellersByOrder.set(s.order_id, []);
      sellersByOrder.get(s.order_id).push(s);
    }
  }
  for (const o of orders) {
    o.items = itemsByOrder.get(o.id) || [];
    o.sellers = sellersByOrder.get(o.id) || [];
  }
  res.json({ orders });
}));

// Buyers can cancel while no shop has started on their order. After that, the shop has to be contacted.
app.post('/api/orders/:id/cancel', requireDb, requireAuth, asyncRoute(async (req, res) => {
  const orderId = parseId(req.params.id);
  if (!orderId) return res.status(404).json({ error: 'Order not found.' });
  const client = await pool.connect();
  let sellerIds = [];
  try {
    await client.query('BEGIN');
    const o = (await client.query('SELECT * FROM orders WHERE id=$1 AND buyer_id=$2 FOR UPDATE', [orderId, req.session.user.id])).rows[0];
    if (!o) throw httpError('Order not found.', 404);
    if (o.status === 'cancelled') throw httpError('This order is already cancelled.');
    const parts = (await client.query('SELECT seller_id, status FROM seller_orders WHERE order_id=$1', [orderId])).rows;
    if (parts.some(p => p.status !== 'pending' && p.status !== 'cancelled')) throw httpError('A shop has already started on your order, so it can no longer be cancelled here. Contact the shop.');
    for (const p of parts) {
      if (p.status === 'cancelled') continue;
      await applySellerOrderChange(client, { orderId, sellerId: p.seller_id, status: 'cancelled', actorId: req.session.user.id, actorRole: 'buyer' });
      sellerIds.push(p.seller_id);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  if (await emailOn('order_cancelled_seller')) {
    const { rows } = await pool.query('SELECT id, email, business_name, name FROM users WHERE id = ANY($1::bigint[])', [sellerIds]);
    for (const s of rows) {
      const mail = renderMail(`Order #${orderId} was cancelled`, 'A buyer cancelled their order', [
        `Order #${orderId} was cancelled by the buyer. The stock for your items has been returned.`
      ]);
      await enqueueEmail(pool, s.email, 'order_cancelled_seller', mail);
    }
  }
  res.json({ ok: true, message: 'Your order has been cancelled.' });
}));

app.patch('/api/orders/:id/payment', requireDb, requireAuth, asyncRoute(async (req, res) => {
  return res.status(410).json({ error: 'Payment is now recorded per shop. Use the seller dashboard.' });
}));

app.post('/api/products/:id/reviews', requireDb, requireAuth, asyncRoute(async (req, res) => {
  if (req.session.user.role !== 'buyer') return res.status(403).json({ error: 'Only buyer accounts can review products.' });
  const productId = parseId(req.params.id);
  const rating = Number(req.body.rating), comment = clean(req.body.comment, 1000);
  if (!productId) return res.status(404).json({ error: 'Product not found.' });
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'Choose a rating from 1 to 5.' });
  const purchased = await pool.query(
    "SELECT 1 FROM order_items oi JOIN seller_orders so ON so.order_id=oi.order_id AND so.seller_id=oi.seller_id JOIN orders o ON o.id=oi.order_id WHERE oi.product_id=$1 AND o.buyer_id=$2 AND so.status='completed' LIMIT 1",
    [productId, req.session.user.id]);
  if (!purchased.rowCount) return res.status(403).json({ error: 'You can review a product after the shop has completed the order.' });
  const r = await pool.query(
    'INSERT INTO reviews(product_id,buyer_id,rating,comment) VALUES($1,$2,$3,$4) ON CONFLICT(product_id,buyer_id) DO UPDATE SET rating=EXCLUDED.rating, comment=EXCLUDED.comment RETURNING *',
    [productId, req.session.user.id, rating, comment]);
  res.status(201).json({ review: r.rows[0] });
}));

// ---------- admin: overview, sellers, plans, invoices, orders, products, emails, settings ----------
app.get('/api/admin/overview', requireDb, requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const [users, sellers, products, orders, money, invoices, mrr, pending] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS count FROM users'),
    pool.query("SELECT seller_status, COUNT(*)::int AS count FROM users WHERE role='seller' GROUP BY seller_status"),
    pool.query('SELECT COUNT(*)::int AS count FROM products'),
    pool.query('SELECT COUNT(*)::int AS count FROM orders'),
    pool.query("SELECT COALESCE(SUM(subtotal),0) AS gross, COALESCE(SUM(commission_amount),0) AS fees FROM seller_orders WHERE status<>'cancelled'"),
    pool.query("SELECT COALESCE(SUM(amount),0) AS paid FROM invoices WHERE status='paid'"),
    pool.query("SELECT COALESCE(SUM(p.price_monthly),0) AS mrr FROM users u JOIN plans p ON p.code=u.plan_code WHERE u.role='seller' AND (u.plan_expires_at IS NULL OR u.plan_expires_at > NOW()) AND p.price_monthly > 0"),
    pool.query("SELECT id, name, email, business_name, location, created_at FROM users WHERE role='seller' AND seller_status='pending' ORDER BY created_at")
  ]);
  const byStatus = Object.fromEntries(SELLER_STATUSES.map(s => [s, 0]));
  for (const r of sellers.rows) byStatus[r.seller_status] = r.count;
  res.json({
    users: users.rows[0].count, products: products.rows[0].count, orders: orders.rows[0].count,
    grossSales: money.rows[0].gross, platformFees: money.rows[0].fees, subscriptionsPaid: invoices.rows[0].paid,
    monthlyRecurring: mrr.rows[0].mrr, sellersByStatus: byStatus, pendingSellers: pending.rows
  });
}));

app.get('/api/admin/sellers', requireDb, requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const params = ["u.role='seller'"], vals = [];
  const status = clean(req.query.status, 20), q = clean(req.query.q, 100);
  if (status) { vals.push(status); params.push(`u.seller_status=$${vals.length}`); }
  if (q) { vals.push(`%${q}%`); params.push(`(u.name ILIKE $${vals.length} OR u.business_name ILIKE $${vals.length} OR u.email ILIKE $${vals.length})`); }
  const r = await pool.query(
    `SELECT u.id, u.name, u.email, u.phone, u.business_name, u.location, u.seller_status, u.plan_code, u.plan_expires_at,
       u.feature_overrides, u.admin_notes, u.created_at,
       (SELECT COUNT(*)::int FROM products p WHERE p.seller_id=u.id) AS products,
       (SELECT COALESCE(SUM(so.subtotal),0) FROM seller_orders so WHERE so.seller_id=u.id AND so.status<>'cancelled') AS sales,
       (SELECT COALESCE(SUM(so.commission_amount),0) FROM seller_orders so WHERE so.seller_id=u.id AND so.status<>'cancelled') AS platform_fees
     FROM users u WHERE ${params.join(' AND ')} ORDER BY u.created_at DESC LIMIT 500`, vals);
  res.json({ sellers: r.rows });
}));

// Admin changes to a seller: approval status, notes, and per-seller overrides of the plan.
app.patch('/api/admin/sellers/:id', requireDb, requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  const cur = id && (await pool.query("SELECT * FROM users WHERE id=$1 AND role='seller'", [id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'Seller not found.' });
  const b = req.body;
  const status = b.status === undefined ? cur.seller_status : b.status;
  if (!SELLER_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid seller status.' });
  const notes = b.adminNotes === undefined ? cur.admin_notes : clean(b.adminNotes, 2000);
  let overrides = cur.feature_overrides || {};
  if (b.featureOverrides !== undefined) {
    const src = b.featureOverrides || {};
    overrides = {};
    for (const [k, v] of Object.entries(src)) {
      if (v === null) continue;
      if (FEATURES.includes(k)) { if (typeof v !== 'boolean') return res.status(400).json({ error: `${k} must be on or off.` }); overrides[k] = v; }
      else if (k === 'max_products') {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0) return res.status(400).json({ error: 'Product limit must be a whole number, or blank for the plan default.' });
        overrides.max_products = n;
      } else if (k === 'commission') {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 50) return res.status(400).json({ error: 'Platform fee must be between 0 and 50 percent.' });
        overrides.commission = n;
      } else return res.status(400).json({ error: `Unknown setting: ${k}` });
    }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE users SET seller_status=$1, admin_notes=$2, feature_overrides=$3 WHERE id=$4', [status, notes, JSON.stringify(overrides), id]);
    const ent = await entitlementsFor(id, client);
    if (!ent.features.discounts) await client.query('UPDATE products SET discount_percent=0, discount_ends_at=NULL WHERE seller_id=$1', [id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  if (status !== cur.seller_status && (await emailOn('seller_status'))) {
    const text = { approved: 'Your seller account has been approved. You can now publish products.', rejected: 'Your seller application was not approved. Contact the marketplace administrator for details.', suspended: 'Your seller account has been suspended. Your shop is hidden until the administrator restores it.', pending: 'Your seller account is awaiting review.' }[status];
    await enqueueEmail(pool, cur.email, 'seller_status', renderMail(`Seller account ${status}`, 'Seller account update', [text, siteUrl() ? `Seller dashboard: ${siteUrl()}/seller` : '']));
  }
  res.json({ ok: true });
}));

// Assigning a plan sets access straight away and records an invoice. Payment is marked by the administrator.
app.post('/api/admin/sellers/:id/plan', requireDb, requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  const planCode = clean(req.body.planCode, 30);
  const months = Math.min(12, Math.max(1, Number(req.body.months) || 1));
  const markPaid = req.body.markPaid === true || req.body.markPaid === 'true';
  const plan = (await pool.query('SELECT * FROM plans WHERE code=$1', [planCode])).rows[0];
  const seller = id && (await pool.query("SELECT * FROM users WHERE id=$1 AND role='seller'", [id])).rows[0];
  if (!plan) return res.status(400).json({ error: 'Choose a valid plan.' });
  if (!seller) return res.status(404).json({ error: 'Seller not found.' });
  const isFree = Number(plan.price_monthly) === 0;
  const now = new Date();
  const base = seller.plan_expires_at && new Date(seller.plan_expires_at) > now ? new Date(seller.plan_expires_at) : now;
  const expires = isFree ? null : addMonths(base, months);
  const amount = roundMoney(Number(plan.price_monthly) * months);
  const status = isFree || markPaid ? 'paid' : 'open';
  const client = await pool.connect();
  let invoice;
  try {
    await client.query('BEGIN');
    await client.query('UPDATE users SET plan_code=$1, plan_expires_at=$2 WHERE id=$3', [plan.code, expires, id]);
    invoice = (await client.query(
      `INSERT INTO invoices(seller_id,plan_code,months,amount,status,period_start,period_end,paid_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [id, plan.code, months, amount, status, base, expires, status === 'paid' ? now : null])).rows[0];
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  if (await emailOn('plan_changed')) {
    await enqueueEmail(pool, seller.email, 'plan_changed', renderMail(`Your plan is now ${plan.name}`, 'Plan updated', [
      `Your Kapiri Online plan is now ${plan.name}${expires ? `, valid until ${expires.toLocaleDateString('en-ZM', { timeZone: 'Africa/Lusaka' })}` : ''}.`,
      `Amount: K${amount.toFixed(2)} (${status === 'paid' ? 'paid' : 'awaiting payment'})`
    ]));
  }
  res.json({ ok: true, invoice });
}));

app.get('/api/admin/invoices', requireDb, requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const r = await pool.query(
    `SELECT i.*, u.name AS seller_name, COALESCE(u.business_name, u.name) AS shop_name, u.email AS seller_email
     FROM invoices i JOIN users u ON u.id=i.seller_id ORDER BY i.created_at DESC LIMIT 300`);
  res.json({ invoices: r.rows });
}));

app.patch('/api/admin/invoices/:id', requireDb, requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  const status = clean(req.body.status, 10);
  if (!id || !['paid', 'void'].includes(status)) return res.status(400).json({ error: 'Status must be paid or void.' });
  const r = await pool.query(
    `UPDATE invoices SET status=$1, paid_at=CASE WHEN $1='paid' THEN NOW() ELSE paid_at END WHERE id=$2 AND status='open' RETURNING *`, [status, id]);
  if (!r.rowCount) return res.status(400).json({ error: 'Only open invoices can be marked paid or void.' });
  if (status === 'paid' && (await emailOn('invoice_paid'))) {
    const s = (await pool.query('SELECT email FROM users WHERE id=$1', [r.rows[0].seller_id])).rows[0];
    await enqueueEmail(pool, s.email, 'invoice_paid', renderMail('Payment received', 'Thank you for your payment', [`We have received K${Number(r.rows[0].amount).toFixed(2)} for your Kapiri Online plan.`]));
  }
  res.json({ invoice: r.rows[0] });
}));

app.get('/api/admin/plans', requireDb, requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const r = await pool.query('SELECT * FROM plans ORDER BY sort_order, code');
  res.json({ plans: r.rows });
}));

function planInput(b) {
  const code = clean(b.code, 30).toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const name = clean(b.name, 80);
  const price = toNum(b.pricePerMonth ?? b.price_monthly ?? 0);
  const maxProducts = (b.maxProducts === '' || b.maxProducts === null || b.maxProducts === undefined) ? null : toNum(b.maxProducts);
  const commission = toNum(b.commissionPercent ?? 10);
  if (!/^[a-z0-9_-]{2,30}$/.test(code)) return { error: 'Plan code must be 2 to 30 letters, numbers, dashes or underscores.' };
  if (!name) return { error: 'Enter a plan name.' };
  if (!Number.isFinite(price) || price < 0) return { error: 'Price must be zero or more.' };
  if (maxProducts !== null && (!Number.isInteger(maxProducts) || maxProducts < 0)) return { error: 'Product limit must be a whole number, or blank for unlimited.' };
  if (!Number.isFinite(commission) || commission < 0 || commission > 50) return { error: 'Platform fee must be between 0 and 50 percent.' };
  const features = {};
  for (const f of FEATURES) features[f] = !!(b.features && b.features[f]);
  return { value: { code, name, price, maxProducts, features, commission, active: b.active !== false, sortOrder: Number(b.sortOrder) || 0 } };
}

app.post('/api/admin/plans', requireDb, requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const v = planInput(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const x = v.value;
  try {
    const r = await pool.query('INSERT INTO plans(code,name,price_monthly,max_products,features,commission_percent,active,sort_order) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [x.code, x.name, x.price, x.maxProducts, JSON.stringify(x.features), x.commission, x.active, x.sortOrder]);
    res.status(201).json({ plan: r.rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'A plan with that code already exists.' });
    throw e;
  }
}));

app.patch('/api/admin/plans/:code', requireDb, requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const code = clean(req.params.code, 30);
  const cur = (await pool.query('SELECT * FROM plans WHERE code=$1', [code])).rows[0];
  if (!cur) return res.status(404).json({ error: 'Plan not found.' });
  const merged = {
    code, name: req.body.name ?? cur.name,
    pricePerMonth: req.body.pricePerMonth ?? cur.price_monthly,
    maxProducts: req.body.maxProducts !== undefined ? req.body.maxProducts : cur.max_products,
    features: { ...cur.features, ...(req.body.features || {}) },
    commissionPercent: req.body.commissionPercent ?? cur.commission_percent,
    active: req.body.active !== undefined ? req.body.active : cur.active,
    sortOrder: req.body.sortOrder ?? cur.sort_order
  };
  const v = planInput(merged);
  if (v.error) return res.status(400).json({ error: v.error });
  const x = v.value;
  const r = await pool.query('UPDATE plans SET name=$1, price_monthly=$2, max_products=$3, features=$4, commission_percent=$5, active=$6, sort_order=$7 WHERE code=$8 RETURNING *',
    [x.name, x.price, x.maxProducts, JSON.stringify(x.features), x.commission, x.active, x.sortOrder, code]);
  res.json({ plan: r.rows[0] });
}));

app.get('/api/admin/orders', requireDb, requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const r = await pool.query('SELECT o.*, u.name AS buyer_name FROM orders o JOIN users u ON u.id=o.buyer_id ORDER BY o.created_at DESC LIMIT 200');
  const ids = r.rows.map(o => o.id);
  const sellers = ids.length ? (await pool.query(
    `SELECT so.*, COALESCE(u.business_name,u.name) AS shop_name FROM seller_orders so JOIN users u ON u.id=so.seller_id WHERE so.order_id = ANY($1::bigint[])`, [ids])).rows : [];
  for (const o of r.rows) o.sellers = sellers.filter(s => Number(s.order_id) === Number(o.id));
  res.json({ orders: r.rows });
}));

app.patch('/api/admin/orders/:id/sellers/:sellerId', requireDb, requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const orderId = parseId(req.params.id), sellerId = parseId(req.params.sellerId);
  if (!orderId || !sellerId) return res.status(404).json({ error: 'Order not found.' });
  return changeSellerOrder(req, res, orderId, sellerId, { status: pickStr(req.body.status, 30), paymentStatus: pickStr(req.body.paymentStatus, 20) });
}));

app.get('/api/admin/products', requireDb, requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const r = await pool.query(`SELECT ${PRODUCT_COLS}, COALESCE(u.business_name,u.name) AS shop_name FROM products p JOIN users u ON u.id=p.seller_id ORDER BY p.created_at DESC LIMIT 500`);
  res.json({ products: r.rows });
}));

app.patch('/api/admin/products/:id', requireDb, requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id || typeof req.body.active !== 'boolean') return res.status(400).json({ error: 'Send active as true or false.' });
  const r = await pool.query('UPDATE products SET active=$1 WHERE id=$2 RETURNING id, active', [req.body.active, id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Product not found.' });
  res.json({ product: r.rows[0] });
}));

app.get('/api/admin/users', requireDb, requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const r = await pool.query('SELECT id, name, email, phone, role, business_name, location, seller_status, plan_code, created_at FROM users ORDER BY created_at DESC LIMIT 500');
  res.json({ users: r.rows });
}));

app.get('/api/admin/emails', requireDb, requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const status = clean(req.query.status, 20);
  const r = status
    ? await pool.query('SELECT id, to_email, kind, subject, status, attempts, last_error, created_at, sent_at FROM email_outbox WHERE status=$1 ORDER BY id DESC LIMIT 200', [status])
    : await pool.query('SELECT id, to_email, kind, subject, status, attempts, last_error, created_at, sent_at FROM email_outbox ORDER BY id DESC LIMIT 200');
  const counts = await pool.query('SELECT status, COUNT(*)::int AS count FROM email_outbox GROUP BY status');
  res.json({ emails: r.rows, counts: counts.rows, configured: !!(process.env.RESEND_API_KEY && process.env.EMAIL_FROM) });
}));

app.post('/api/admin/emails/:id/retry', requireDb, requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  const r = await pool.query("UPDATE email_outbox SET status='pending', attempts=0, last_error=NULL WHERE id=$1 AND status IN ('failed','pending') RETURNING id", [id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Email not found or already sent.' });
  res.json({ ok: true });
}));

app.get('/api/admin/settings', requireDb, requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  res.json({ emails: await getSetting('emails', EMAIL_DEFAULTS), emailKinds: EMAIL_KINDS, features: FEATURES, featureLabels: FEATURE_LABELS });
}));

app.put('/api/admin/settings', requireDb, requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const current = await getSetting('emails', EMAIL_DEFAULTS);
  const next = { ...EMAIL_DEFAULTS, ...current };
  for (const [k, v] of Object.entries(req.body.emails || {})) {
    if (EMAIL_KINDS.includes(k) && typeof v === 'boolean') next[k] = v;
  }
  await pool.query("INSERT INTO platform_settings(key,value) VALUES('emails',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [JSON.stringify(next)]);
  res.json({ emails: next });
}));

// ---------- pages ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found.' }));
app.get('/seller', (req, res) => res.sendFile(path.join(__dirname, 'public', 'seller.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    const msg = req.path.endsWith('/image') ? 'Images must be 2 MB or smaller.' : 'That request is too large.';
    return res.status(413).json({ error: msg });
  }
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

initDb()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => console.log(`Kapiri Online running on port ${PORT}`));
    setInterval(() => processOutbox().catch(err => console.error('Email worker:', err.message)), 20000);
  })
  .catch(err => { console.error('Startup failed:', err); process.exit(1); });
