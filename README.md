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

## Local development

Requirements: Node.js 20+ and PostgreSQL.

```bash
npm install
# Set DATABASE_URL, SESSION_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD
npm start
```

Open `http://localhost:10000`.

## Important launch notes

- Product photos are entered as public HTTPS image URLs. The app does not currently upload images to persistent object storage.
- Checkout records orders and stock, but does not charge customers. Mobile money and bank-transfer options are manual arrangements to confirm with sellers. Integrate a supported payment provider before describing payments as automatic.
- Delivery fees are not calculated by the app; sellers and buyers must agree delivery arrangements.
- Configure email/SMS/WhatsApp notifications, password reset, seller verification, privacy/terms pages, backups, monitoring and formal security testing before a public commercial launch.
- Seller order views are filtered by seller. For multi-seller orders, the current status is attached to the overall buyer order; a mature marketplace should move to per-seller fulfilment records.
- Admin credentials should be configured as Render environment variables only. Never commit credentials or `.env` files to GitHub.
