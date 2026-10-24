'use strict';
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false }) : null;
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false }));
// Stricter limit for sign-in and registration to slow password guessing and account spam.
app.use(['/api/auth/login', '/api/auth/register'], rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts. Please wait 15 minutes and try again.' } }));

const schema = `
CREATE TABLE IF NOT EXISTS users (
 id BIGSERIAL PRIMARY KEY, name VARCHAR(120) NOT NULL, email VARCHAR(254) NOT NULL UNIQUE,
 phone VARCHAR(40), password_hash TEXT NOT NULL, role VARCHAR(20) NOT NULL CHECK(role IN ('buyer','seller','admin')),
 business_name VARCHAR(160), business_description TEXT, location VARCHAR(160), seller_status VARCHAR(20) NOT NULL DEFAULT 'pending',
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS products (
 id BIGSERIAL PRIMARY KEY, seller_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name VARCHAR(180) NOT NULL, description TEXT NOT NULL DEFAULT '', category VARCHAR(80) NOT NULL DEFAULT 'General',
 price NUMERIC(12,2) NOT NULL CHECK(price >= 0), stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0),
 image_url TEXT NOT NULL DEFAULT '', active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
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
CREATE TABLE IF NOT EXISTS reviews (
 id BIGSERIAL PRIMARY KEY, product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
 buyer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
 comment TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(product_id,buyer_id)
);
CREATE INDEX IF NOT EXISTS products_category_idx ON products(category);
CREATE INDEX IF NOT EXISTS products_seller_idx ON products(seller_id);
CREATE INDEX IF NOT EXISTS order_buyer_idx ON orders(buyer_id);
CREATE INDEX IF NOT EXISTS order_items_seller_idx ON order_items(seller_id);
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
 cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 24 * 7 }
};
if (pool) sessionConfig.store = new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true });
app.use(session(sessionConfig));
app.use(express.static(path.join(__dirname, 'public')));

const asyncRoute = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);
const requireDb = (req,res,next) => pool ? next() : res.status(503).json({ error: 'Marketplace database is not configured yet. Add DATABASE_URL in Render.' });
const requireAuth = (req,res,next) => req.session.user ? next() : res.status(401).json({ error: 'Please sign in to continue.' });
const requireRole = role => (req,res,next) => req.session.user && (req.session.user.role === role || req.session.user.role === 'admin') ? next() : res.status(403).json({ error: 'You do not have permission to do that.' });
const safeUser = u => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, businessName: u.business_name, businessDescription: u.business_description, location: u.location, sellerStatus: u.seller_status });
const validEmail = email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
const clean = (v, max=500) => String(v ?? '').trim().slice(0,max);
// Blank strings and booleans are rejected rather than silently becoming 0.
const toNum = v => (v === '' || v === null || v === undefined || typeof v === 'boolean') ? NaN : Number(v);
const isValidPrice = v => { const n = toNum(v); return Number.isFinite(n) && n >= 0; };
const isValidStock = v => { const n = toNum(v); return Number.isInteger(n) && n >= 0; };
// Combine duplicate cart lines so the stock check sees the true total for each product.
function mergeCart(items) {
 const merged = new Map();
 for (const item of items) {
  const id = Number(item.id), qty = Number(item.quantity);
  if (!Number.isInteger(id) || !Number.isInteger(qty) || qty < 1) throw Object.assign(new Error('One of the cart quantities is invalid.'), { status: 400 });
  merged.set(id, (merged.get(id) || 0) + qty);
}
 for (const q of merged.values()) if (q > 100) throw Object.assign(new Error('You can order up to 100 of each item at a time.'), { status: 400 });
 return [...merged.entries()];
}

app.get('/api/health', (req,res) => res.json({ status: 'ok', databaseConfigured: !!pool, service: 'Kapiri Online' }));
// Reload the user from the database so role and seller approval changes take effect without signing out.
app.get('/api/me', requireDb, asyncRoute(async (req,res) => {
 if (!req.session.user) return res.json({ user: null });
 const r = await pool.query('SELECT * FROM users WHERE id=$1', [req.session.user.id]);
 if (!r.rowCount) { req.session.user = null; return res.json({ user: null }); }
 req.session.user = safeUser(r.rows[0]);
 res.json({ user: req.session.user });
}));
app.post('/api/auth/register', requireDb, asyncRoute(async (req,res) => {
 const name=clean(req.body.name,120), email=clean(req.body.email,254).toLowerCase(), phone=clean(req.body.phone,40), password=String(req.body.password||''), role=req.body.role==='seller'?'seller':'buyer';
 const businessName=clean(req.body.businessName,160), location=clean(req.body.location,160);
 if (!name || !validEmail(email) || password.length < 8) return res.status(400).json({error:'Enter your name, a valid email, and a password of at least 8 characters.'});
 if(role==='seller' && !businessName) return res.status(400).json({error:'Enter your business name to open a seller account.'});
 const hash=await bcrypt.hash(password,12);
 try {
  const result=await pool.query('INSERT INTO users(name,email,phone,password_hash,role,business_name,location,seller_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[name,email,phone,hash,role,businessName||null,location||null,role==='seller'?'pending':'approved']);
  req.session.user=safeUser(result.rows[0]);
  res.status(201).json({user:req.session.user,message:role==='seller'?'Your seller account is created and awaiting marketplace approval. You can manage your shop and publish products once an administrator approves it.':'Your buyer account is ready.'});
 } catch(e) { if(e.code==='23505') return res.status(409).json({error:'An account with that email already exists.'}); throw e; }
}));
app.post('/api/auth/login', requireDb, asyncRoute(async (req,res) => {
 const email=clean(req.body.email,254).toLowerCase(), password=String(req.body.password||'');
 const r=await pool.query('SELECT * FROM users WHERE email=$1',[email]);
 if(!r.rowCount || !(await bcrypt.compare(password,r.rows[0].password_hash))) return res.status(401).json({error:'Email or password is incorrect.'});
 req.session.regenerate(err=>{ if(err) return res.status(500).json({error:'Could not start your session.'}); req.session.user=safeUser(r.rows[0]); res.json({user:req.session.user,message:'Welcome back.'}); });
}));
app.post('/api/auth/logout',(req,res)=>req.session.destroy(()=>{res.clearCookie('connect.sid');res.json({ok:true});}));

app.get('/api/products', requireDb, asyncRoute(async (req,res)=>{
 const q=clean(req.query.q,100), category=clean(req.query.category,80), sort=clean(req.query.sort,20);
 const params=[], where=["p.active=TRUE", "(u.role='seller' AND u.seller_status='approved')"];
 if(q){params.push(`%${q}%`);where.push(`(p.name ILIKE $${params.length} OR p.description ILIKE $${params.length} OR p.category ILIKE $${params.length} OR u.business_name ILIKE $${params.length})`)}
 if(category && category!=='All'){params.push(category);where.push(`p.category=$${params.length}`)}
 let order='p.created_at DESC'; if(sort==='price-low')order='p.price ASC'; if(sort==='price-high')order='p.price DESC'; if(sort==='popular')order='p.id DESC';
 const r=await pool.query(`SELECT p.id,p.seller_id,p.name,p.description,p.category,p.price,p.stock,p.image_url,p.created_at,u.business_name,u.location,COALESCE(AVG(rv.rating),0) AS rating,COUNT(rv.id)::int AS review_count FROM products p JOIN users u ON u.id=p.seller_id LEFT JOIN reviews rv ON rv.product_id=p.id WHERE ${where.join(' AND ')} GROUP BY p.id,u.business_name,u.location ORDER BY ${order} LIMIT 100`,params);
 const cats=await pool.query("SELECT DISTINCT category FROM products WHERE active=TRUE ORDER BY category");res.json({products:r.rows,categories:['All',...cats.rows.map(x=>x.category)]});
}));
app.get('/api/products/:id',requireDb,asyncRoute(async(req,res)=>{const r=await pool.query("SELECT p.*,u.business_name,u.location,u.id AS seller_id,COALESCE(AVG(rv.rating),0) AS rating,COUNT(rv.id)::int AS review_count FROM products p JOIN users u ON u.id=p.seller_id LEFT JOIN reviews rv ON rv.product_id=p.id WHERE p.id=$1 AND p.active=TRUE AND u.seller_status='approved' GROUP BY p.id,u.business_name,u.location,u.id",[req.params.id]);if(!r.rowCount)return res.status(404).json({error:'Product not found.'});res.json({product:r.rows[0]})}));
app.post('/api/seller/products',requireDb,requireAuth,requireRole('seller'),asyncRoute(async(req,res)=>{
 const sellerRow=await pool.query('SELECT seller_status FROM users WHERE id=$1',[req.session.user.id]);if(!sellerRow.rowCount||sellerRow.rows[0].seller_status!=='approved')return res.status(403).json({error:'Your seller account is awaiting approval before products can be published.'});
 const {name,description,category,price,stock,imageUrl}=req.body;const n=clean(name,180),c=clean(category,80)||'General',p=toNum(price),s=toNum(stock);
 if(!n||!Number.isFinite(p)||p<0||!Number.isInteger(s)||s<0)return res.status(400).json({error:'Provide a product name, valid price and whole-number stock quantity.'});
 if(imageUrl && !/^https:\/\//i.test(imageUrl))return res.status(400).json({error:'Product image must use a secure https:// image URL.'});
 const r=await pool.query('INSERT INTO products(seller_id,name,description,category,price,stock,image_url) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[req.session.user.id,n,clean(description,3000),c,p,s,clean(imageUrl,1000)]);res.status(201).json({product:r.rows[0]});
}));
app.get('/api/seller/products',requireDb,requireAuth,requireRole('seller'),asyncRoute(async(req,res)=>{const r=await pool.query('SELECT * FROM products WHERE seller_id=$1 ORDER BY created_at DESC',[req.session.user.id]);res.json({products:r.rows})}));
app.patch('/api/seller/products/:id',requireDb,requireAuth,requireRole('seller'),asyncRoute(async(req,res)=>{const {name,description,category,price,stock,imageUrl,active}=req.body;if(price!==undefined&&!isValidPrice(price))return res.status(400).json({error:'Enter a valid price of zero or more.'});if(stock!==undefined&&!isValidStock(stock))return res.status(400).json({error:'Stock must be a whole number of zero or more.'});if(imageUrl!==undefined&&imageUrl!==''&&!/^https:\/\//i.test(String(imageUrl)))return res.status(400).json({error:'Product image must use a secure https:// image URL.'});const r=await pool.query('UPDATE products SET name=COALESCE($1,name),description=COALESCE($2,description),category=COALESCE($3,category),price=COALESCE($4,price),stock=COALESCE($5,stock),image_url=COALESCE($6,image_url),active=COALESCE($7,active) WHERE id=$8 AND seller_id=$9 RETURNING *',[name===undefined?null:clean(name,180),description===undefined?null:clean(description,3000),category===undefined?null:clean(category,80),price===undefined?null:Number(price),stock===undefined?null:Number(stock),imageUrl===undefined?null:clean(imageUrl,1000),active===undefined?null:Boolean(active),req.params.id,req.session.user.id]);if(!r.rowCount)return res.status(404).json({error:'Product not found in your shop.'});res.json({product:r.rows[0]})}));
app.delete('/api/seller/products/:id',requireDb,requireAuth,requireRole('seller'),asyncRoute(async(req,res)=>{const r=await pool.query('DELETE FROM products WHERE id=$1 AND seller_id=$2 RETURNING id',[req.params.id,req.session.user.id]);if(!r.rowCount)return res.status(404).json({error:'Product not found in your shop.'});res.json({ok:true})}));
app.get('/api/seller/summary',requireDb,requireAuth,requireRole('seller'),asyncRoute(async(req,res)=>{const [products,orders,sales]=await Promise.all([pool.query('SELECT COUNT(*)::int AS count,COALESCE(SUM(stock),0)::int AS stock FROM products WHERE seller_id=$1',[req.session.user.id]),pool.query('SELECT COUNT(DISTINCT oi.order_id)::int AS count FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.seller_id=$1 AND o.status<>\'cancelled\'',[req.session.user.id]),pool.query("SELECT COALESCE(SUM(oi.quantity*oi.unit_price),0) AS total FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.seller_id=$1 AND o.status<>'cancelled'",[req.session.user.id])]);res.json({products:products.rows[0],orders:orders.rows[0].count,sales:sales.rows[0].total})}));

app.post('/api/orders',requireDb,requireAuth,asyncRoute(async(req,res)=>{
 if(req.session.user.role==='seller')return res.status(403).json({error:'Seller accounts cannot place buyer orders. Use a buyer account to shop.'});
 const items=Array.isArray(req.body.items)?req.body.items:[],deliveryName=clean(req.body.deliveryName,120),deliveryPhone=clean(req.body.deliveryPhone,40),deliveryAddress=clean(req.body.deliveryAddress,1000),notes=clean(req.body.notes,1000),paymentMethod=['pay_on_delivery','mobile_money_manual','bank_transfer_manual'].includes(req.body.paymentMethod)?req.body.paymentMethod:'pay_on_delivery';
 if(!items.length||items.length>50)return res.status(400).json({error:'Your cart is empty or contains too many items.'});if(!deliveryName||!deliveryPhone||!deliveryAddress)return res.status(400).json({error:'Enter the delivery name, phone number and address.'});
 const client=await pool.connect();try{await client.query('BEGIN');let total=0,prepared=[];for(const [id,qty] of mergeCart(items)){const r=await client.query("SELECT p.*,u.seller_status FROM products p JOIN users u ON u.id=p.seller_id WHERE p.id=$1 AND p.active=TRUE FOR UPDATE OF p",[id]);if(!r.rowCount||r.rows[0].seller_status!=='approved')throw Object.assign(new Error('A product in your cart is no longer available.'),{status:400});const p=r.rows[0];if(p.stock<qty)throw Object.assign(new Error(`Not enough stock for ${p.name}.`),{status:400});prepared.push({p,qty});total+=Number(p.price)*qty;}
 const o=await client.query('INSERT INTO orders(buyer_id,total,payment_method,delivery_name,delivery_phone,delivery_address,notes) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[req.session.user.id,total,paymentMethod,deliveryName,deliveryPhone,deliveryAddress,notes]);for(const x of prepared){await client.query('INSERT INTO order_items(order_id,product_id,seller_id,product_name,quantity,unit_price) VALUES($1,$2,$3,$4,$5,$6)',[o.rows[0].id,x.p.id,x.p.seller_id,x.p.name,x.qty,x.p.price]);await client.query('UPDATE products SET stock=stock-$1 WHERE id=$2',[x.qty,x.p.id]);}await client.query('COMMIT');res.status(201).json({order:o.rows[0],message:'Order placed. Payment instructions and fulfilment will be confirmed by the seller.'});
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}));
app.get('/api/orders',requireDb,requireAuth,asyncRoute(async(req,res)=>{let r;if(req.session.user.role==='admin')r=await pool.query('SELECT o.*,u.name AS buyer_name FROM orders o JOIN users u ON u.id=o.buyer_id ORDER BY o.created_at DESC LIMIT 200');else if(req.session.user.role==='seller')r=await pool.query('SELECT DISTINCT o.*,u.name AS buyer_name FROM orders o JOIN users u ON u.id=o.buyer_id JOIN order_items oi ON oi.order_id=o.id WHERE oi.seller_id=$1 ORDER BY o.created_at DESC',[req.session.user.id]);else r=await pool.query('SELECT * FROM orders WHERE buyer_id=$1 ORDER BY created_at DESC',[req.session.user.id]);for(const order of r.rows){const items=await pool.query('SELECT oi.*,p.image_url FROM order_items oi LEFT JOIN products p ON p.id=oi.product_id WHERE oi.order_id=$1 AND ($2::text <> \'seller\' OR oi.seller_id=$3::bigint)',[order.id,req.session.user.role,String(req.session.user.id)]);order.items=items.rows;}res.json({orders:r.rows})}));
app.patch('/api/orders/:id/status',requireDb,requireAuth,asyncRoute(async(req,res)=>{const allowed=['confirmed','processing','ready','shipped','completed','cancelled'];const status=clean(req.body.status,30);if(!allowed.includes(status))return res.status(400).json({error:'Invalid order status.'});const client=await pool.connect();try{await client.query('BEGIN');const order=await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[req.params.id]);if(!order.rowCount)throw Object.assign(new Error('Order not found.'),{status:404});const isAdmin=req.session.user.role==='admin';const own=await client.query('SELECT 1 FROM order_items WHERE order_id=$1 AND seller_id=$2 LIMIT 1',[req.params.id,req.session.user.id]);if(!isAdmin&&!own.rowCount)throw Object.assign(new Error('You cannot update this order.'),{status:403});if(!isAdmin&&status==='cancelled'){const others=await client.query('SELECT 1 FROM order_items WHERE order_id=$1 AND seller_id<>$2 LIMIT 1',[req.params.id,req.session.user.id]);if(others.rowCount)throw Object.assign(new Error('This order includes products from other shops, so only a marketplace administrator can cancel it.'),{status:403});}if(order.rows[0].status==='cancelled'&&status!=='cancelled')throw Object.assign(new Error('Cancelled orders cannot be reopened. Place a new order instead.'),{status:400});if(status==='cancelled'&&order.rows[0].status!=='cancelled'){const items=await client.query('SELECT product_id,quantity FROM order_items WHERE order_id=$1',[req.params.id]);for(const i of items.rows)await client.query('UPDATE products SET stock=stock+$1 WHERE id=$2',[i.quantity,i.product_id]);}const r=await client.query('UPDATE orders SET status=$1 WHERE id=$2 RETURNING *',[status,req.params.id]);await client.query('COMMIT');res.json({order:r.rows[0]});}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}));
// Sellers (for their own orders) and admins record whether an order has been paid.
app.patch('/api/orders/:id/payment',requireDb,requireAuth,asyncRoute(async(req,res)=>{
 const paymentStatus=clean(req.body.paymentStatus,20);
 if(!['unpaid','paid'].includes(paymentStatus))return res.status(400).json({error:'Payment status must be unpaid or paid.'});
 if(req.session.user.role!=='admin'){const own=req.session.user.role==='seller'?await pool.query('SELECT 1 FROM order_items WHERE order_id=$1 AND seller_id=$2 LIMIT 1',[req.params.id,req.session.user.id]):{rowCount:0};if(!own.rowCount)return res.status(403).json({error:'You cannot update this order.'});}
 const r=await pool.query('UPDATE orders SET payment_status=$1 WHERE id=$2 RETURNING *',[paymentStatus,req.params.id]);
 if(!r.rowCount)return res.status(404).json({error:'Order not found.'});
 res.json({order:r.rows[0]});
}));
app.post('/api/products/:id/reviews',requireDb,requireAuth,asyncRoute(async(req,res)=>{if(req.session.user.role!=='buyer')return res.status(403).json({error:'Only buyer accounts can review products.'});const rating=Number(req.body.rating),comment=clean(req.body.comment,1000);if(!Number.isInteger(rating)||rating<1||rating>5)return res.status(400).json({error:'Choose a rating from 1 to 5.'});const purchased=await pool.query("SELECT 1 FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.product_id=$1 AND o.buyer_id=$2 AND o.status='completed' LIMIT 1",[req.params.id,req.session.user.id]);if(!purchased.rowCount)return res.status(403).json({error:'You can review a product after a completed purchase.'});const r=await pool.query('INSERT INTO reviews(product_id,buyer_id,rating,comment) VALUES($1,$2,$3,$4) ON CONFLICT(product_id,buyer_id) DO UPDATE SET rating=EXCLUDED.rating,comment=EXCLUDED.comment RETURNING *',[req.params.id,req.session.user.id,rating,comment]);res.status(201).json({review:r.rows[0]})}));
app.get('/api/admin/overview',requireDb,requireAuth,requireRole('admin'),asyncRoute(async(req,res)=>{const [users,products,orders,sales,pending]=await Promise.all([pool.query('SELECT COUNT(*)::int AS count FROM users'),pool.query('SELECT COUNT(*)::int AS count FROM products'),pool.query('SELECT COUNT(*)::int AS count FROM orders'),pool.query("SELECT COALESCE(SUM(total),0) AS total FROM orders WHERE status<>'cancelled'"),pool.query("SELECT id,name,email,business_name,location,created_at FROM users WHERE role='seller' AND seller_status='pending' ORDER BY created_at")]);res.json({users:users.rows[0].count,products:products.rows[0].count,orders:orders.rows[0].count,grossSales:sales.rows[0].total,pendingSellers:pending.rows})}));
app.get('/api/admin/users',requireDb,requireAuth,requireRole('admin'),asyncRoute(async(req,res)=>{const r=await pool.query('SELECT id,name,email,phone,role,business_name,location,seller_status,created_at FROM users ORDER BY created_at DESC LIMIT 500');res.json({users:r.rows})}));
app.patch('/api/admin/sellers/:id',requireDb,requireAuth,requireRole('admin'),asyncRoute(async(req,res)=>{const status=req.body.status;if(!['approved','rejected','pending'].includes(status))return res.status(400).json({error:'Invalid seller status.'});const r=await pool.query("UPDATE users SET seller_status=$1 WHERE id=$2 AND role='seller' RETURNING id,name,email,business_name,seller_status",[status,req.params.id]);if(!r.rowCount)return res.status(404).json({error:'Seller not found.'});res.json({seller:r.rows[0]})}));
app.use('/api', (req,res)=>res.status(404).json({error:'API route not found.'}));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.use((err,req,res,next)=>{console.error(err);res.status(err.status||500).json({error:err.status?err.message:'Something went wrong. Please try again.'});});
initDb().then(()=>app.listen(PORT,'0.0.0.0',()=>console.log(`Kapiri Online running on port ${PORT}`))).catch(err=>{console.error('Startup failed:',err);process.exit(1)});
