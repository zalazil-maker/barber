# Barbershop Counter

A simple offline app for a 2-barber shop (Momo & Amine). Tracks customers, payments (Cash/Card), and arrival check-ins.

## Usage

Open `index.html` in any modern browser (works on phone, tablet, desktop). Data is saved in your browser's localStorage — no server, no install required. You can also "Add to Home Screen" on iOS/Android to use it like a native app.

## Features

- **Register tab**: Tap a barber → enter the amount on the keypad → choose ESP (Cash) or CB (Card). Done in 3 taps.
- **Check-In tab**: Each barber checks in once per day on arrival; the app records the time.
- **Stats tab**: Per-barber weekly summary (customer count, cash total, card total, grand total). Browse past weeks with the prev/next arrows. Delete an entry by tapping the × next to it.

## Files

- `index.html` — page shell
- `styles.css` — styles
- `app.js` — all logic (state, rendering, persistence)
- `manifest.json` — PWA metadata for "Add to Home Screen"
