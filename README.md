# Barbershop Counter

A simple offline app for a 2-barber shop (Momo & Amine). Tracks customers, payments (Cash/Card), and arrival check-ins.

## Usage

Open `index.html` in any modern browser (works on phone, tablet, desktop). Data is saved in your browser's localStorage — no server, no install required. You can also "Add to Home Screen" on iOS/Android to use it like a native app.

## Features

- **Register tab**: Tap a barber → enter the amount on the keypad → choose ESP (Cash) or CB (Card). Done in 3 taps.
- **RDV tab**: The day's online bookings from the website, newest first. Call the customer, cash them in, cancel a booking, or close a day when a barber is off.
- **Check-In tab**: Each barber checks in once per day on arrival; the app records the time.
- **Stats tab**: Per-barber weekly summary (customer count, cash total, card total, grand total). Browse past weeks with the prev/next arrows. Delete an entry by tapping the × next to it.

## RDV tab (online bookings)

Customers book on the website (repo `shopbar`), which writes into the same Neon
database through the same Worker.

- On first use the tab asks for the **admin code** — the `ADMIN_KEY` secret set
  on the Worker. It is stored on that device only, never in this repo.
- **Encaisser** jumps straight to the payment screen with the barber and amount
  filled in. The website prices are already the discounted RDV rate, so the
  register's own −10% RDV toggle is deliberately left off — turning it on would
  discount twice.
- Amounts are rounded to the nearest euro because the register keypad is
  whole-euro (23,99 € → 24 €).
- **Momo en repos** / **Salon fermé** blocks that day so the website stops
  offering it. Reopen it with **Rouvrir**.
- **Campagne email** sends one email to every customer who booked online.
  Unsubscribed addresses are skipped, every email has a working unsubscribe
  link, and each address gets a given text only once — if a send stops part-way
  (e.g. Resend's daily limit), pressing **Envoyer** again only reaches the rest.
  **Test** sends a single copy to your own address first.

## Worker

`worker.js` is the Cloudflare Worker. It serves both the counter app's event
feed (`GET`/`POST /`) and the website's booking API (`/api/*`), against a Neon
Postgres database. The booking tables are created automatically on first use.

Secrets (Cloudflare dashboard → Workers → Settings → Variables):

| Name             | Required | Purpose                                       |
|------------------|----------|-----------------------------------------------|
| `DATABASE_URL`   | yes      | Neon connection string                        |
| `ADMIN_KEY`      | yes      | Code for the RDV tab and admin endpoints      |
| `RESEND_API_KEY` | no       | Enables confirmation emails                   |
| `SHOP_EMAIL`     | no       | Address that receives new bookings            |
| `MAIL_FROM`      | no       | Sender address for those emails               |
| `SITE_URL`       | no       | Base URL for cancellation links in emails     |

Prices, barbers, opening hours and slot length all live in the constants at the
top of `worker.js`; the website reads them from `/api/config`.

To keep Neon inside its free compute quota the Worker avoids waking the
database: schema setup runs once per isolate, config/gallery/availability are
cached in memory for 60 s (dropped on any booking, cancel or admin change), and
the promo cron only queries between 07:00 and 21:00 Paris time, every 15
minutes (`PROMO_CRON_*` constants — widen them if opening hours change).

## Files

- `index.html` — page shell
- `styles.css` — styles
- `app.js` — all logic (state, rendering, persistence)
- `worker.js` — Cloudflare Worker: counter-app feed + booking API
- `manifest.json` — PWA metadata for "Add to Home Screen"
