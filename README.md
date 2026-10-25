# Kapiri Online

A mobile-friendly, multi-vendor marketplace foundation for Zambia. Built with Node.js, Express, PostgreSQL and vanilla JavaScript. Designed for deployment on Render and source control on GitHub.

## Included

- Buyer and seller registration; password hashing with bcrypt.
- Session-based authentication with secure, HTTP-only cookies.
- Seller approval workflow and seller-only product management.
- Product catalogue, category/search filters, sorting, favourites and cart.
- Checkout and order history; stock is checked and decremented in a database transaction.
- Seller order management and order status changes.
- Admin overview, user listing and seller approvals.
- Seller dashboard at `/seller`: overview, full product catalogue, product photos, discounts (percentage with optional end date), promo codes, order management with paid/unpaid tracking, a customer list with private notes, and account and password changes.
- Hot selling products section on the home page, ranked by units sold.
- Email alert to each seller when an order containing their products is placed.
- Product reviews limited to buyers with completed purchases (API endpoint).
- Render Blueprint (`render.yaml`) provisions a web service and PostgreSQL database.
- Security headers, API rate limiting and health endpoint.

## Deploy on Render

1. Create a GitHub repository named `kapiri-online` and upload the contents of this project to the repository root.
2. In Render, choose **New → Blueprint** and select the GitHub repository. Render reads `render.yaml`.
3. Before first production use, set the `ADMIN_EMAIL` and `ADMIN_PASSWORD` values in the Render service environment. Use a long, unique password. Set `SESSION_SECRET` to a unique random value if you are not using the Blueprint-generated value.
4. Confirm the database and web service deploy successfully. Visit `/api/health`; it should return `status: "ok"` and `databaseConfigured: true`.
5. Sign in using the admin email/password configured in Render. Approve seller accounts in the Marketplace admin screen.

Render may change free database availability, expiry and limits. Check current plan terms in your Render dashboard before relying on free-tier persistence for a live business.

## Email alerts

Sellers receive an email when an order includes their products. Sending uses [Resend](https://resend.com):

1. Create a Resend API key and verify the domain the emails will come from.
2. In Render, set `RESEND_API_KEY` to the key, `EMAIL_FROM` to a verified sender (for example `Kapiri Online <orders@yourdomain.com>`), and `PUBLIC_URL` to your site address (for example `https://kapiri-online.onrender.com`) so the email links work.

If these are not set, orders still work and the server log records that no email was sent.

## Plans, per-shop orders and the administrator console

- **Shops and orders.** A buyer's order is split by shop. Each shop has its own status (pending, confirmed, processing, ready, shipped, completed, cancelled), its own payment status, and its own platform fee. A shop can only change its own part of an order.
- **Buyer cancellation.** A buyer can cancel while every shop is still pending. Cancelled stock is returned automatically.
- **Plans.** Free, Growth and Pro are seeded on first start. Each plan sets the product limit, the features (customer CRM, promo codes, discounts, order emails) and the platform fee. Plans are edited at `/admin` under Plans.
- **Administrator console.** Sign in with the admin account and open `/admin`. It covers seller approval, suspension and notes, plan assignment, per-seller overrides, invoices, shop order management, product visibility, the email log with retries, and email settings.
- **Payments.** No payment provider is connected. Assigning a plan creates an invoice that the administrator marks paid when the money arrives. Buyer payment status is recorded per shop.
- **Email.** Order confirmations (buyers), new-order alerts (sellers), shop status updates (buyers) and cancellations (sellers) are written to a queue and sent by a background worker through Resend. Set `RESEND_API_KEY` and `EMAIL_FROM` to start sending. Until then, messages wait in the queue and are visible in the admin email log.

## Local development

Requirements: Node.js 20+ and PostgreSQL.

```bash
npm install
# Set DATABASE_URL, SESSION_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD
npm start
```

Open `http://localhost:10000`.

## Important launch notes

- Product photos are uploaded by sellers (JPEG, PNG or WebP, up to 2 MB; resized in the browser) and stored in the PostgreSQL database, so they survive redeploys. Large or heavy image traffic should move to object storage later.
- Checkout records orders and stock, but does not charge customers. Mobile money and bank-transfer options are manual arrangements to confirm with sellers. Integrate a supported payment provider before describing payments as automatic.
- Delivery fees are not calculated by the app; sellers and buyers must agree delivery arrangements.
- Configure email/SMS/WhatsApp notifications, password reset, seller verification, privacy/terms pages, backups, monitoring and formal security testing before a public commercial launch.
- Seller order views are filtered by seller. For multi-seller orders, the current status is attached to the overall buyer order; a mature marketplace should move to per-seller fulfilment records.
- Admin credentials should be configured as Render environment variables only. Never commit credentials or `.env` files to GitHub.
