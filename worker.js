// Barbershop "doorman" — a Cloudflare Worker that safely connects the app to
// the Neon Postgres database. The database password lives ONLY here, as the
// DATABASE_URL secret in the Cloudflare dashboard — never in the app.
//
// It talks to Neon's SQL-over-HTTP endpoint (the same one the official
// @neondatabase/serverless driver uses), so no npm packages or build step.
//
// Routes:
//   GET  /                  counter-app events feed        (unchanged)
//   POST /                  counter-app insert/update/delete (unchanged)
//   GET  /api/config        services, barbers, opening hours
//   GET  /api/availability  free slots for a given date
//   POST /api/book          create a booking
//   POST /api/cancel        customer cancels with their token
//   GET  /api/bookings      admin: list bookings in a date range
//   POST /api/admin         admin: cancel / block / unblock

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ── Shop configuration ──────────────────────────────────────────────────────
// Services, barbers and opening hours live in the database so the owner can
// edit them from /admin. These constants only seed an empty database on first
// run — after that the tables are the source of truth.
const DEFAULT_BARBERS = ["Momo", "Amine"];

// `price` is the online-booking (RDV) price — the discounted rate customers
// only get by booking here. `planity` is the regular Planity/walk-in rate,
// shown struck through so the saving is visible. Omit `planity` for services
// with no comparable Planity rate.
const DEFAULT_SERVICES = [
  { id: "cheveux", label: "Cheveux", price: 18.0, planity: 20.0, duration: 30, icon: "ico-ciseaux",
    description: "Coupe homme soignée, adaptée à votre style. Dégradé, classique ou moderne — le résultat est toujours net." },
  { id: "barbe", label: "Barbe", price: 9.99, planity: 12.0, duration: 30, icon: "ico-rasoir",
    description: "Taille et contours de barbe à la tondeuse et au rasoir, finition serviette chaude. Net, précis, rapide." },
  { id: "both", label: "Cheveux + Barbe", price: 23.99, planity: 26.0, duration: 30, icon: "ico-poteau",
    description: "Le combo complet — coupe homme et taille de barbe soignée pour un look parfaitement abouti de la tête aux pieds." },
  { id: "traitement_complet", label: "Le traitement complet !", price: 32.99, planity: null, duration: 60, icon: "ico-poteau",
    description: "Coupe, barbe, shampooing et soins visage — pensé pour les grandes occasions : mariage, remise de diplôme, vacances, ou simplement pour prendre soin de vous.",
    needsSkinType: true },
  { id: "enfant", label: "Enfant", price: 12.0, planity: null, duration: 30, icon: "ico-enfant",
    description: "Coupe pour les petits dans une ambiance détendue. Pour que vos enfants repartent contents et bien coiffés." },
];

// Products sold at the shop. Prices are optional — the panel lets the owner
// set them later. `image` is a path served by the website (public/products/).
const DEFAULT_PRODUCTS = [
  { id: "hydralift", label: "Hydralift Hyaluron SPF15", brand: "Revuele",
    description: "Crème-fluide hydratante à l'acide hyaluronique — lisse les rides et protège du soleil au quotidien.",
    image: "/products/hydralift.jpg", sort: 10 },
  { id: "vitamine-c", label: "Sérum Vitamine C 15%", brand: "Revuele",
    description: "Éclaircit le teint et uniformise la peau pour un éclat visible dès les premiers jours.",
    image: "/products/vitamine-c.jpg", sort: 20 },
  { id: "niacinamide-serum", label: "Sérum Niacinamide 15%", brand: "Revuele",
    description: "Resserre les pores et équilibre la peau — idéal pour les peaux mixtes à grasses.",
    image: "/products/niacinamide-serum.jpg", sort: 30 },
  { id: "glycolique", label: "Peeling Acide Glycolique", brand: "Revuele",
    description: "Exfolie en douceur et affine le grain de peau — conçu pour les peaux à imperfections.",
    image: "/products/glycolique.jpg", sort: 40 },
  { id: "niacinamide-zinc", label: "Niacinamide + Zinc 3-en-1", brand: "The Doctor",
    description: "Contrôle le sébum et unifie le teint — soin visage jour, nuit et contour des yeux.",
    image: "/products/niacinamide-zinc.jpg", sort: 50 },
  { id: "argan", label: "Crème de nuit Argan Oil", brand: "Revuele",
    description: "Régénère la peau pendant la nuit avec l'huile d'argan — anti-rides et nourrissant pour peaux sèches.",
    image: "/products/argan.jpg", sort: 60 },
  { id: "spf50", label: "Sunprotect SPF 50+", brand: "Revuele",
    description: "Protection très haute contre les UVA et UVB, fini sec — spécialement formulé pour peaux mixtes à grasses.",
    image: "/products/spf50.jpg", sort: 70 },
  { id: "masque-noir", label: "Black Mask Peel-Off", brand: "Revuele",
    description: "Masque au charbon actif qui décolle les points noirs et purifie les pores en profondeur.",
    image: "/products/masque-noir.jpg", sort: 80 },
];

const DEFAULT_SLOT_MIN = 30; // minutes per bookable slot
const MAX_DAYS_AHEAD = 60; // how far in advance customers may book
const MAX_UPCOMING_PER_PHONE = 3; // simple abuse guard

// Opening hours in minutes from midnight, keyed by JS weekday (0 = Sunday).
// A day with `null` is closed.
const DEFAULT_HOURS = {
  0: [600, 1200], // Sunday   10h00 – 20h00
  1: [570, 1200], // Monday    9h30 – 20h00
  2: [570, 1200],
  3: [570, 1200],
  4: [570, 1200],
  5: [570, 1200],
  6: [570, 1200], // Saturday  9h30 – 20h00
};

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // per photo/video
const ALLOWED_MEDIA = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

const SHOP_TZ = "Europe/Paris";

// The `events` table predates the coupon/RDV promo columns. Older databases are
// missing them, which makes the counter app's feed fail with
// `column "rdv" does not exist`. Adding them is idempotent, and the flag keeps
// it to one round trip per Worker isolate rather than one per request.
let eventsColumnsReady = false;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function cleanConnString(s) {
  if (!s) return "";
  s = String(s).trim();
  s = s.replace(/^psql\s+/i, ""); // strip leading "psql "
  s = s.replace(/^['"]+|['"]+$/g, ""); // strip surrounding quotes
  s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=/, ""); // strip "DATABASE_URL=" prefix
  s = s.replace(/^['"]+|['"]+$/g, ""); // strip quotes again
  return s.trim();
}

// ── Time helpers ────────────────────────────────────────────────────────────
// The Worker runs in UTC, but "is this slot already in the past?" has to be
// answered in the shop's own timezone or bookings break twice a year.
function shopNow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SHOP_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const p = {};
  for (const part of parts) p[part.type] = part.value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: (Number(p.hour) % 24) * 60 + Number(p.minute),
  };
}

function isValidDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// Weekday of a YYYY-MM-DD string, independent of the server's own timezone.
function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function daysBetween(fromISO, toISO) {
  const a = Date.parse(fromISO + "T00:00:00Z");
  const b = Date.parse(toISO + "T00:00:00Z");
  return Math.round((b - a) / 86400000);
}

function slotsForDate(dateStr, cfg) {
  const hours = cfg.hours[weekdayOf(dateStr)];
  if (!hours || !Array.isArray(hours) || hours.length !== 2) return [];
  const [open, close] = hours;
  const step = cfg.slotMinutes;
  const out = [];
  for (let t = open; t + step <= close; t += step) out.push(t);
  return out;
}

function hhmm(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

function token() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time-ish comparison so the admin key can't be guessed byte by byte.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── Input validation ────────────────────────────────────────────────────────
function cleanText(v, max) {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

function validBooking(body, cfg) {
  const service = cfg.services[body.service] ? body.service : null;
  if (!service) return { error: "Prestation inconnue." };

  const barber = body.barber === "any" || cfg.barbers.includes(body.barber) ? body.barber : null;
  if (!barber) return { error: "Barbier inconnu." };

  if (!isValidDate(body.date)) return { error: "Date invalide." };

  const now = shopNow();
  const ahead = daysBetween(now.date, body.date);
  if (ahead < 0) return { error: "Cette date est déjà passée." };
  if (ahead > MAX_DAYS_AHEAD) return { error: "Réservation trop lointaine." };

  const slot = Number(body.slot);
  if (!Number.isInteger(slot) || !slotsForDate(body.date, cfg).includes(slot)) {
    return { error: "Créneau invalide." };
  }
  if (ahead === 0 && slot <= now.minutes) return { error: "Ce créneau est déjà passé." };

  const name = cleanText(body.name, 80);
  if (name.length < 2) return { error: "Merci d'indiquer votre nom." };

  const phone = cleanText(body.phone, 25);
  if (!/^[+\d][\d\s().-]{5,}$/.test(phone)) return { error: "Numéro de téléphone invalide." };

  // The email is what carries the confirmation and the cancel link, so it is
  // required rather than optional.
  const email = cleanText(body.email, 120);
  if (!email) return { error: "Merci d'indiquer votre email pour recevoir la confirmation." };
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) return { error: "Email invalide." };

  // For services that ask for it (see `needsSkinType` in DEFAULT_SERVICES),
  // the customer's answer is prepended to the note so the barber sees it in
  // one place in the RDV tab.
  let note = cleanText(body.note, 300);
  const skinType = cleanText(body.skinType, 60);
  const svcDef = DEFAULT_SERVICES.find((s) => s.id === service);
  if (skinType && svcDef && svcDef.needsSkinType) {
    note = `Peau : ${skinType}${note ? " — " + note : ""}`.slice(0, 300);
  }

  return { service, barber, date: body.date, slot, name, phone, email, note };
}

// ── Web Push (optional) ─────────────────────────────────────────────────────
// Sends a payload-less push: the notification body is fetched by the service
// worker when it wakes. That deliberately avoids implementing RFC 8291 payload
// encryption, which is where most hand-rolled push code goes wrong.
function b64urlToBytes(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes) {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function textToB64url(s) {
  return bytesToB64url(new TextEncoder().encode(s));
}

// Builds the signed VAPID token that proves to the push service we are the
// application server this subscription was created for.
async function vapidAuth(env, audience) {
  const pub = b64urlToBytes(env.VAPID_PUBLIC_KEY); // 65-byte uncompressed point
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("VAPID_PUBLIC_KEY malformed");

  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
    d: String(env.VAPID_PRIVATE_KEY).trim(),
    ext: true,
  };
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );

  const header = textToB64url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const body = textToB64url(
    JSON.stringify({
      aud: audience,
      exp: Math.floor(Date.now() / 1000) + 12 * 3600,
      sub: env.VAPID_SUBJECT || "mailto:contact@luxurybarber.fr",
    })
  );
  const signingInput = new TextEncoder().encode(header + "." + body);
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    signingInput
  );
  const jwt = header + "." + body + "." + bytesToB64url(sig);
  return "vapid t=" + jwt + ", k=" + env.VAPID_PUBLIC_KEY;
}

// Pushes a wake-up to every registered device. Returns endpoints the push
// service says are gone, so the caller can drop them.
async function sendPushes(env, subscriptions) {
  const dead = [];
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return dead;

  for (const sub of subscriptions) {
    try {
      const endpoint = String(sub.endpoint);
      const audience = new URL(endpoint).origin;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: await vapidAuth(env, audience),
          TTL: "3600",
          Urgency: "high",
          "Content-Length": "0",
        },
      });
      // 404/410 mean the browser dropped the subscription for good.
      if (res.status === 404 || res.status === 410) dead.push(endpoint);
    } catch (e) {
      // A push failure must never undo a booking that is already saved.
    }
  }
  return dead;
}

// ── Email notification (optional) ───────────────────────────────────────────
// Only fires when RESEND_API_KEY and SHOP_EMAIL are configured; a mail failure
// must never lose a booking that is already committed to the database.
async function sendMail(env, to, subject, lines, extraHeaders) {
  if (!env.RESEND_API_KEY || !to) return;
  try {
    const payload = {
      from: env.MAIL_FROM || "Luxury Barber <onboarding@resend.dev>",
      to: [to],
      subject,
      text: lines.join("\n"),
    };
    if (extraHeaders) payload.headers = extraHeaders;
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + env.RESEND_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    // swallowed on purpose — see comment above
  }
}

// ── Marketing email ─────────────────────────────────────────────────────────
// Sent alongside the confirmation. French law (art. L34-5 CPCE) allows this to
// an existing customer for similar services, provided they were told when the
// address was collected and every message carries a working opt-out — hence
// the notice on the booking form and the unsubscribe link below.
function b64urlEncode(s) {
  return btoa(unescape(encodeURIComponent(s)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return decodeURIComponent(escape(atob(s)));
}

// Signed with ADMIN_KEY so nobody can unsubscribe someone else's address.
async function unsubToken(env, email) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(env.ADMIN_KEY || "lb")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(email.toLowerCase()));
  return bytesToB64url(sig).slice(0, 32);
}

// Subject leads with the reminder, because that is the part the customer
// actually needs an hour before — the offer rides along behind it.
const PROMO_SUBJECT = "Votre RDV dans 1h — et notre nouveau Rituel Luxe Visage & Barbe ✂️";

function promoLines(firstName, when) {
  return [
    `Bonjour ${firstName},`,
    ``,
    when ? `Votre rendez-vous est dans une heure — ${when}.` : `Votre rendez-vous est dans une heure.`,
    ``,
    `Merci pour votre confiance et votre réservation chez Luxury Barber.`,
    ``,
    `Nous avons le plaisir de vous annoncer notre nouveau soin signature :`,
    `le Rituel Luxe Visage & Barbe.`,
    ``,
    `Une expérience complète qui va au-delà de la simple coupe :`,
    ``,
    `  • Coupe et taille de barbe soignées`,
    `  • Shampooing et soin capillaire`,
    `  • Exfoliation du visage`,
    `  • Application de soins visage premium (sérums vitamine C, niacinamide, hydratation)`,
    ``,
    `Un moment de détente et de soin pensé pour les hommes qui veulent prendre`,
    `soin de leur peau autant que de leur style.`,
    ``,
    `Nous proposons également une sélection de produits de soin à emporter,`,
    `avec des conseils d'utilisation clairs pour prolonger les résultats à la maison.`,
    ``,
    `Envie d'essayer ? Parlez-en à votre barbier lors de votre prochain passage —`,
    `il vous présentera le rituel et vous orientera vers ce qui convient le mieux`,
    `à votre peau.`,
    ``,
    `À très bientôt,`,
    `L'équipe Luxury Barber`,
    `11 rue Duméril, 80000 Amiens`,
    `@luxurybarber80`,
  ];
}

// Builds the database query function. Lifted out of fetch() so the cron
// handler can use it too.
function makeQuery(env) {
  const connectionString = cleanConnString(env.DATABASE_URL);
  if (!connectionString) throw new Error("DATABASE_URL secret is not set");

  // Derive Neon's SQL-over-HTTP endpoint from the connection string host,
  // exactly how the Neon serverless driver does it.
  let host;
  try {
    host = new URL(connectionString).hostname;
  } catch (e) {
    const m = connectionString.match(/@([^/:?]+)/);
    if (m) host = m[1];
  }
  if (!host) throw new Error("Bad DATABASE_URL format");

  const sqlUrl = "https://" + host.replace(/^[^.]+\./, "api.") + "/sql";

  return async function q(query, params = []) {
    const r = await fetch(sqlUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Neon-Connection-String": connectionString,
      },
      body: JSON.stringify({ query, params }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error("DB " + r.status + ": " + text);
    return text ? JSON.parse(text) : { rows: [] };
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    let q;
    try {
      q = makeQuery(env);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }

    // Creates the booking tables on first use so there is no manual SQL step.
    // The partial unique index is what actually makes double-booking
    // impossible, even if two customers tap "confirmer" at the same instant.
    async function ensureSchema() {
      await q(
        `create table if not exists bookings (
           id text primary key,
           barber text not null,
           service text not null,
           price numeric(6,2) not null,
           slot_date date not null,
           slot_min int not null,
           duration_min int not null default 30,
           name text not null,
           phone text not null,
           email text,
           note text,
           status text not null default 'confirmed',
           cancel_token text not null,
           created_at timestamptz not null default now(),
           cancelled_at timestamptz
         )`
      );
      await q(
        `create unique index if not exists bookings_slot_uniq
           on bookings (barber, slot_date, slot_min) where status = 'confirmed'`
      );
      // Editable shop configuration. Seeded from the constants above the first
      // time it runs, then owned by /admin.
      await q(
        `create table if not exists services (
           id text primary key,
           label text not null,
           price numeric(6,2) not null,
           planity numeric(6,2),
           duration int not null default 30,
           icon text,
           description text,
           sort int not null default 0,
           active boolean not null default true
         )`
      );
      await q("alter table services add column if not exists description text");
      // barbers.id holds the name, because events.barber and bookings.barber
      // already store names — keeping them equal avoids migrating history.
      await q(
        `create table if not exists barbers (
           id text primary key,
           name text not null,
           photo_key text,
           sort int not null default 0,
           active boolean not null default true
         )`
      );
      await q(
        `create table if not exists settings (
           key text primary key,
           value text not null
         )`
      );
      // Products sold at the shop. Prices are optional; when null the card
       // just shows the product without any "€" line.
      await q(
        `create table if not exists products (
           id text primary key,
           label text not null,
           brand text,
           description text,
           image text,
           price numeric(6,2),
           sort int not null default 0,
           active boolean not null default true,
           created_at timestamptz not null default now()
         )`
      );

      const prodCount = await q("select count(*)::int as n from products");
      if (Number((prodCount.rows || [{}])[0]?.n || 0) === 0) {
        for (const p of DEFAULT_PRODUCTS) {
          await q(
            `insert into products (id,label,brand,description,image,price,sort)
             values ($1,$2,$3,$4,$5,$6,$7) on conflict (id) do nothing`,
            [p.id, p.label, p.brand, p.description, p.image, p.price ?? null, p.sort]
          );
        }
      }

      await q(
        `create table if not exists media (
           id text primary key,
           kind text not null,
           r2_key text not null,
           mime text,
           caption text,
           sort int not null default 0,
           created_at timestamptz not null default now()
         )`
      );

      const svcCount = await q("select count(*)::int as n from services");
      if (Number((svcCount.rows || [{}])[0]?.n || 0) === 0) {
        let i = 0;
        for (const s of DEFAULT_SERVICES) {
          await q(
            `insert into services (id,label,price,planity,duration,icon,description,sort)
             values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (id) do nothing`,
            [s.id, s.label, s.price, s.planity, s.duration, s.icon, s.description, i++]
          );
        }
      }
      const barbCount = await q("select count(*)::int as n from barbers");
      if (Number((barbCount.rows || [{}])[0]?.n || 0) === 0) {
        let i = 0;
        for (const b of DEFAULT_BARBERS) {
          await q(
            "insert into barbers (id,name,sort) values ($1,$2,$3) on conflict (id) do nothing",
            [b, b, i++]
          );
        }
      }

      // Records when the pre-appointment promo went out, so the cron handler
      // sends it exactly once per booking.
      await q("alter table bookings add column if not exists promo_sent_at timestamptz");
      await q(
        `create table if not exists marketing_optout (
           email text primary key,
           created_at timestamptz not null default now()
         )`
      );
      await q(
        `create table if not exists push_subscriptions (
           endpoint text primary key,
           label text,
           created_at timestamptz not null default now()
         )`
      );
      await q(
        `create table if not exists blocked_slots (
           id text primary key,
           barber text not null,
           slot_date date not null,
           slot_min int,
           reason text,
           created_at timestamptz not null default now()
         )`
      );
    }

    // Brings an older `events` table up to date. Both statements are no-ops
    // once the columns exist, and neither touches existing rows.
    async function ensureEventsColumns() {
      if (eventsColumnsReady) return;
      await q("alter table events add column if not exists coupon boolean not null default false");
      await q("alter table events add column if not exists rdv boolean not null default false");
      eventsColumnsReady = true;
    }

    // Reads the live shop configuration. Everything downstream — availability,
    // validation, pricing — goes through this rather than the constants, so an
    // edit in /admin takes effect on the next request.
    async function loadConfig() {
      await ensureSchema();
      const [svc, barb, set, prod] = await Promise.all([
        q("select id,label,price,planity,duration,icon,description,sort from services where active order by sort, label"),
        q("select id,name,photo_key,sort from barbers where active order by sort, name"),
        q("select key,value from settings"),
        q("select id,label,brand,description,image,price,sort from products where active order by sort, label"),
      ]);

      const services = {};
      for (const r of svc.rows || []) {
        services[r.id] = {
          label: r.label,
          price: Number(r.price),
          planity: r.planity == null ? null : Number(r.planity),
          duration: Number(r.duration) || DEFAULT_SLOT_MIN,
          icon: r.icon || null,
          desc: r.description || "",
        };
      }

      const barberRows = barb.rows || [];
      const barbers = barberRows.map((r) => r.id);
      const barberInfo = barberRows.map((r) => ({
        name: r.name || r.id,
        id: r.id,
        photo: r.photo_key ? "/api/media/" + r.photo_key : null,
      }));

      const settings = {};
      for (const r of set.rows || []) {
        try {
          settings[r.key] = JSON.parse(r.value);
        } catch (e) {}
      }

      // Which services want an extra "skin type" field on the booking form.
      // Kept alongside the service so the site can render the field without
      // needing a hardcoded id.
      const skinTypeServices = DEFAULT_SERVICES
        .filter((s) => s.needsSkinType)
        .map((s) => s.id);

      const products = (prod.rows || []).map((r) => ({
        id: r.id,
        label: r.label,
        brand: r.brand || null,
        description: r.description || "",
        image: r.image || null,
        price: r.price == null ? null : Number(r.price),
        sort: Number(r.sort),
      }));

      return {
        services,
        barbers,
        barberInfo,
        products,
        skinTypeServices,
        hours: settings.hours || DEFAULT_HOURS,
        slotMinutes: Number(settings.slotMinutes) || DEFAULT_SLOT_MIN,
      };
    }

    async function saveSetting(key, value) {
      await q(
        `insert into settings (key,value) values ($1,$2)
         on conflict (key) do update set value = excluded.value`,
        [key, JSON.stringify(value)]
      );
    }

    function requireAdmin(body) {
      const expected = env.ADMIN_KEY;
      if (!expected) return "ADMIN_KEY secret is not set";
      if (!safeEqual(String(body.key || ""), expected)) return "Code administrateur invalide";
      return null;
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      // ── Booking API ────────────────────────────────────────────────────
      if (path.startsWith("/api/")) {
        if (path === "/api/config") {
          const cfg = await loadConfig();
          const gallery = await q(
            "select id, kind, r2_key, caption from media order by sort, created_at desc limit 60"
          );
          return json({
            barbers: cfg.barbers,
            barberInfo: cfg.barberInfo,
            services: cfg.services,
            products: cfg.products,
            skinTypeServices: cfg.skinTypeServices,
            slotMinutes: cfg.slotMinutes,
            maxDaysAhead: MAX_DAYS_AHEAD,
            hours: cfg.hours,
            today: shopNow().date,
            media: (gallery.rows || []).map((m) => ({
              id: m.id,
              kind: m.kind,
              url: "/api/media/" + m.r2_key,
              caption: m.caption,
            })),
          });
        }

        // Public: serve an uploaded photo or video out of R2.
        if (path.startsWith("/api/media/")) {
          if (!env.MEDIA) return json({ error: "Stockage non configuré." }, 503);
          const key = decodeURIComponent(path.slice("/api/media/".length));
          const obj = await env.MEDIA.get(key);
          if (!obj) return json({ error: "Introuvable." }, 404);
          const headers = new Headers(CORS);
          headers.set("Content-Type", obj.httpMetadata?.contentType || "application/octet-stream");
          headers.set("Cache-Control", "public, max-age=31536000, immutable");
          if (obj.size != null) headers.set("Content-Length", String(obj.size));
          return new Response(obj.body, { headers });
        }

        if (path === "/api/availability") {
          const date = url.searchParams.get("date");
          if (!isValidDate(date)) return json({ error: "Date invalide." }, 400);

          const now = shopNow();
          const ahead = daysBetween(now.date, date);
          if (ahead < 0 || ahead > MAX_DAYS_AHEAD) {
            return json({ date, closed: true, barbers: {} });
          }

          const cfg = await loadConfig();
          const all = slotsForDate(date, cfg);
          if (!all.length) return json({ date, closed: true, barbers: {} });

          const taken = await q(
            "select barber, slot_min from bookings where slot_date = $1 and status = 'confirmed'",
            [date]
          );
          const blocked = await q(
            "select barber, slot_min from blocked_slots where slot_date = $1",
            [date]
          );

          const out = {};
          for (const b of cfg.barbers) {
            const busy = new Set();
            for (const r of taken.rows || []) {
              if (r.barber === b) busy.add(Number(r.slot_min));
            }
            let wholeDayOff = false;
            for (const r of blocked.rows || []) {
              if (r.barber !== b && r.barber !== "ALL") continue;
              if (r.slot_min == null) wholeDayOff = true;
              else busy.add(Number(r.slot_min));
            }
            out[b] = wholeDayOff
              ? []
              : all.filter((s) => !busy.has(s) && !(ahead === 0 && s <= now.minutes));
          }
          return json({ date, closed: false, slotMinutes: cfg.slotMinutes, barbers: out });
        }

        // The public VAPID key is safe to hand out — the app needs it to
        // create a subscription.
        if (path === "/api/push/key") {
          return json({
            publicKey: env.VAPID_PUBLIC_KEY || null,
            enabled: !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
          });
        }

        if (path === "/api/push/subscribe") {
          if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
          const body = await request.json();
          const denied = requireAdmin(body);
          if (denied) return json({ error: denied }, 401);

          const sub = body.subscription || {};
          if (!sub.endpoint || !/^https:\/\//.test(String(sub.endpoint))) {
            return json({ error: "Abonnement invalide." }, 400);
          }
          await ensureSchema();
          await q(
            `insert into push_subscriptions (endpoint, label) values ($1,$2)
             on conflict (endpoint) do update set label = excluded.label`,
            [String(sub.endpoint), cleanText(body.label, 80) || null]
          );
          return json({ ok: true });
        }

        if (path === "/api/push/unsubscribe") {
          if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
          const body = await request.json();
          const denied = requireAdmin(body);
          if (denied) return json({ error: denied }, 401);
          await ensureSchema();
          await q("delete from push_subscriptions where endpoint = $1", [
            String(body.endpoint || ""),
          ]);
          return json({ ok: true });
        }

        // Lets a barber confirm notifications actually reach their phone.
        if (path === "/api/push/test") {
          if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
          const body = await request.json();
          const denied = requireAdmin(body);
          if (denied) return json({ error: denied }, 401);
          await ensureSchema();
          const subs = await q("select endpoint from push_subscriptions");
          const dead = await sendPushes(env, subs.rows || []);
          for (const e of dead) await q("delete from push_subscriptions where endpoint = $1", [e]);
          return json({ ok: true, sent: (subs.rows || []).length - dead.length });
        }

        if (path === "/api/book") {
          if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
          const body = await request.json();
          const cfg = await loadConfig();
          const v = validBooking(body, cfg);
          if (v.error) return json({ error: v.error }, 400);

          const upcoming = await q(
            `select count(*)::int as n from bookings
             where phone = $1 and status = 'confirmed' and slot_date >= $2`,
            [v.phone, shopNow().date]
          );
          if (Number((upcoming.rows || [{}])[0]?.n || 0) >= MAX_UPCOMING_PER_PHONE) {
            return json(
              { error: "Vous avez déjà plusieurs rendez-vous à venir. Appelez-nous au salon." },
              429
            );
          }

          const blocked = await q(
            `select 1 from blocked_slots
             where slot_date = $1 and (barber = $2 or barber = 'ALL')
               and (slot_min is null or slot_min = $3) limit 1`,
            [v.date, v.barber === "any" ? "ALL" : v.barber, v.slot]
          );
          if ((blocked.rows || []).length && v.barber !== "any") {
            return json({ error: "Ce créneau n'est plus disponible." }, 409);
          }

          const svc = cfg.services[v.service];
          // For "peu importe", try each barber in turn; the unique index below
          // decides the winner if someone books the same slot concurrently.
          const candidates = v.barber === "any" ? cfg.barbers : [v.barber];

          for (const barber of candidates) {
            const off = await q(
              `select 1 from blocked_slots
               where slot_date = $1 and (barber = $2 or barber = 'ALL')
                 and (slot_min is null or slot_min = $3) limit 1`,
              [v.date, barber, v.slot]
            );
            if ((off.rows || []).length) continue;

            const id = token();
            const cancelToken = token();
            const res = await q(
              `insert into bookings
                 (id, barber, service, price, slot_date, slot_min, duration_min,
                  name, phone, email, note, cancel_token)
               values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
               on conflict do nothing`,
              [
                id,
                barber,
                v.service,
                svc.price,
                v.date,
                v.slot,
                svc.duration,
                v.name,
                v.phone,
                v.email || null,
                v.note || null,
                cancelToken,
              ]
            );

            if (Number(res.rowCount || 0) === 0) continue; // slot just taken

            // Wake the barbers' phones. Done before the response so it isn't
            // cut short, but any failure is swallowed — the booking is saved.
            try {
              const subs = await q("select endpoint from push_subscriptions");
              const dead = await sendPushes(env, subs.rows || []);
              for (const e of dead) {
                await q("delete from push_subscriptions where endpoint = $1", [e]);
              }
            } catch (e) {}

            const when = `${v.date} à ${hhmm(v.slot)}`;
            await sendMail(env, env.SHOP_EMAIL, `Nouveau RDV — ${v.name} — ${when}`, [
              `Nouveau rendez-vous en ligne`,
              ``,
              `Barbier    : ${barber}`,
              `Prestation : ${svc.label} (${svc.price.toFixed(2)} €)`,
              `Quand      : ${when}`,
              `Client     : ${v.name}`,
              `Téléphone  : ${v.phone}`,
              v.email ? `Email      : ${v.email}` : ``,
              v.note ? `Note       : ${v.note}` : ``,
            ]);
            if (v.email) {
              // The promotional email is NOT sent here — the cron handler
              // below sends it an hour before the appointment, so it lands
              // when the customer is about to come in, and is skipped
              // entirely if they cancel in the meantime.
              await sendMail(env, v.email, `Votre rendez-vous chez Luxury Barber — ${when}`, [
                `Bonjour ${v.name},`,
                ``,
                `Votre rendez-vous est confirmé :`,
                ``,
                `  ${svc.label} — ${svc.price.toFixed(2)} €`,
                `  Avec ${barber}`,
                `  Le ${v.date} à ${hhmm(v.slot)}`,
                ``,
                `Luxury Barber — 11 Rue Dumeril, 80000 Amiens`,
                ``,
                `Un empêchement ? Annulez ici :`,
                `${env.SITE_URL || "https://luxurybarber.fr"}/?annuler=${id}&token=${cancelToken}`,
              ]);
            }

            return json({
              ok: true,
              id,
              cancelToken,
              barber,
              service: svc.label,
              price: svc.price,
              date: v.date,
              time: hhmm(v.slot),
            });
          }

          return json({ error: "Ce créneau vient d'être réservé. Choisissez-en un autre." }, 409);
        }

        // One-click unsubscribe from the marketing email. Reached from the
        // link in the message and from the List-Unsubscribe header, so it has
        // to work on a plain GET with no session.
        if (path === "/api/unsub") {
          const page = (title, body) =>
            new Response(
              `<!doctype html><html lang="fr"><meta charset="utf-8">` +
                `<meta name="viewport" content="width=device-width,initial-scale=1">` +
                `<title>${title}</title>` +
                `<body style="background:#0d0d0d;color:#f0ece4;font-family:system-ui,sans-serif;` +
                `display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px">` +
                `<div style="max-width:420px;text-align:center">` +
                `<h1 style="color:#c9a227;font-size:1.3rem;margin:0 0 12px">${title}</h1>` +
                `<p style="color:#9e9890;line-height:1.6;margin:0 0 24px">${body}</p>` +
                `<a href="${env.SITE_URL || "https://luxurybarber80.fr"}" ` +
                `style="color:#c9a227">Retour au site</a></div></body></html>`,
              { headers: { "Content-Type": "text/html; charset=utf-8", ...CORS } }
            );

          let email = "";
          try {
            email = b64urlDecode(url.searchParams.get("e") || "");
          } catch (e) {}
          const tok = url.searchParams.get("t") || "";
          if (!email || !safeEqual(tok, await unsubToken(env, email))) {
            return page("Lien invalide", "Ce lien de désinscription n'est pas valide.");
          }

          await ensureSchema();
          await q(
            "insert into marketing_optout (email) values ($1) on conflict (email) do nothing",
            [email.toLowerCase()]
          );
          return page(
            "C'est fait",
            "Vous ne recevrez plus nos actualités. Vos confirmations de rendez-vous continueront d'arriver normalement."
          );
        }

        if (path === "/api/cancel") {
          if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
          const body = await request.json();
          await ensureSchema();
          const res = await q(
            `update bookings set status = 'cancelled', cancelled_at = now()
             where id = $1 and cancel_token = $2 and status = 'confirmed'`,
            [String(body.id || ""), String(body.token || "")]
          );
          if (Number(res.rowCount || 0) === 0) {
            return json({ error: "Rendez-vous introuvable ou déjà annulé." }, 404);
          }
          return json({ ok: true });
        }

        // ── Admin (counter app) ──────────────────────────────────────────
        if (path === "/api/bookings") {
          const key = url.searchParams.get("key") || "";
          const denied = requireAdmin({ key });
          if (denied) return json({ error: denied }, 401);

          const from = url.searchParams.get("from");
          const to = url.searchParams.get("to");
          if (!isValidDate(from) || !isValidDate(to)) return json({ error: "Dates invalides." }, 400);

          await ensureSchema();
          const rows = await q(
            `select id, barber, service, price, slot_date, slot_min, name, phone,
                    email, note, status, created_at
             from bookings
             where slot_date between $1 and $2
             order by slot_date, slot_min`,
            [from, to]
          );
          const blocked = await q(
            `select id, barber, slot_date, slot_min, reason from blocked_slots
             where slot_date between $1 and $2 order by slot_date, slot_min`,
            [from, to]
          );
          return json({ bookings: rows.rows || [], blocked: blocked.rows || [] });
        }

        // ── /admin panel: shop configuration ─────────────────────────────
        if (path === "/api/admin/config") {
          if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
          const body = await request.json();
          const denied = requireAdmin(body);
          if (denied) return json({ error: denied }, 401);
          await ensureSchema();

          // Everything the panel needs to render, including hidden entries.
          if (body.op === "state") {
            const [svc, barb, med, set, prod] = await Promise.all([
              q("select id,label,price,planity,duration,icon,description,sort,active from services order by sort, label"),
              q("select id,name,photo_key,sort,active from barbers order by sort, name"),
              q("select id,kind,r2_key,caption,sort,created_at from media order by sort, created_at desc"),
              q("select key,value from settings"),
              q("select id,label,brand,description,image,price,sort,active from products order by sort, label"),
            ]);
            const settings = {};
            for (const r of set.rows || []) {
              try {
                settings[r.key] = JSON.parse(r.value);
              } catch (e) {}
            }
            return json({
              services: (svc.rows || []).map((r) => ({
                ...r,
                price: Number(r.price),
                planity: r.planity == null ? null : Number(r.planity),
                duration: Number(r.duration),
                sort: Number(r.sort),
              })),
              barbers: (barb.rows || []).map((r) => ({
                id: r.id,
                name: r.name,
                sort: Number(r.sort),
                active: r.active === true || r.active === "t",
                photo: r.photo_key ? "/api/media/" + r.photo_key : null,
              })),
              media: (med.rows || []).map((m) => ({
                id: m.id,
                kind: m.kind,
                url: "/api/media/" + m.r2_key,
                caption: m.caption,
                sort: Number(m.sort),
              })),
              products: (prod.rows || []).map((r) => ({
                id: r.id,
                label: r.label,
                brand: r.brand || "",
                description: r.description || "",
                image: r.image || null,
                price: r.price == null ? null : Number(r.price),
                sort: Number(r.sort),
                active: r.active === true || r.active === "t",
              })),
              hours: settings.hours || DEFAULT_HOURS,
              slotMinutes: Number(settings.slotMinutes) || DEFAULT_SLOT_MIN,
              storage: !!env.MEDIA,
              email: !!env.RESEND_API_KEY,
            });
          }

          // Products ------------------------------------------------------
          if (body.op === "product-save") {
            const p = body.product || {};
            const id = cleanText(p.id, 40).toLowerCase().replace(/[^a-z0-9_-]/g, "");
            if (!id) return json({ error: "Identifiant de produit invalide." }, 400);
            const label = cleanText(p.label, 80);
            if (!label) return json({ error: "Le nom du produit est obligatoire." }, 400);
            const price =
              p.price === "" || p.price == null ? null : Number(p.price);
            if (price != null && (!Number.isFinite(price) || price < 0 || price > 999)) {
              return json({ error: "Prix invalide." }, 400);
            }
            await q(
              `insert into products (id,label,brand,description,image,price,sort,active)
               values ($1,$2,$3,$4,$5,$6,$7,true)
               on conflict (id) do update set
                 label=excluded.label, brand=excluded.brand,
                 description=excluded.description, image=excluded.image,
                 price=excluded.price, sort=excluded.sort, active=true`,
              [
                id, label,
                cleanText(p.brand, 40) || null,
                cleanText(p.description, 300) || null,
                cleanText(p.image, 200) || null,
                price,
                Number(p.sort) || 0,
              ]
            );
            return json({ ok: true, id });
          }

          if (body.op === "product-delete") {
            await q("update products set active=false where id=$1", [String(body.id || "")]);
            return json({ ok: true });
          }

          // Services ------------------------------------------------------
          if (body.op === "service-save") {
            const s = body.service || {};
            const id = cleanText(s.id, 40).toLowerCase().replace(/[^a-z0-9_-]/g, "");
            if (!id) return json({ error: "Identifiant de prestation invalide." }, 400);
            const label = cleanText(s.label, 60);
            if (!label) return json({ error: "Le nom de la prestation est obligatoire." }, 400);
            const price = Number(s.price);
            if (!Number.isFinite(price) || price < 0 || price > 999) {
              return json({ error: "Prix invalide." }, 400);
            }
            const planity =
              s.planity === "" || s.planity == null ? null : Number(s.planity);
            if (planity != null && (!Number.isFinite(planity) || planity < 0 || planity > 999)) {
              return json({ error: "Prix Planity invalide." }, 400);
            }
            const duration = Number(s.duration) || DEFAULT_SLOT_MIN;
            await q(
              `insert into services (id,label,price,planity,duration,icon,description,sort,active)
               values ($1,$2,$3,$4,$5,$6,$7,$8,true)
               on conflict (id) do update set
                 label=excluded.label, price=excluded.price, planity=excluded.planity,
                 duration=excluded.duration, icon=excluded.icon,
                 description=excluded.description, sort=excluded.sort, active=true`,
              [id, label, price, planity, duration, cleanText(s.icon, 40) || null,
               cleanText(s.description, 300) || null, Number(s.sort) || 0]
            );
            return json({ ok: true, id });
          }

          if (body.op === "service-delete") {
            // Soft delete: past bookings still reference the service id.
            await q("update services set active=false where id=$1", [String(body.id || "")]);
            return json({ ok: true });
          }

          // Barbers -------------------------------------------------------
          if (body.op === "barber-save") {
            const b = body.barber || {};
            const name = cleanText(b.name, 40);
            if (!name) return json({ error: "Le nom du barbier est obligatoire." }, 400);
            const id = cleanText(b.id, 40) || name;
            await q(
              `insert into barbers (id,name,sort,active) values ($1,$2,$3,true)
               on conflict (id) do update set name=excluded.name, sort=excluded.sort, active=true`,
              [id, name, Number(b.sort) || 0]
            );
            return json({ ok: true, id });
          }

          if (body.op === "barber-delete") {
            // Soft delete so their history and takings stay intact.
            await q("update barbers set active=false where id=$1", [String(body.id || "")]);
            return json({ ok: true });
          }

          // Opening hours -------------------------------------------------
          if (body.op === "hours-save") {
            const h = body.hours || {};
            const clean = {};
            for (let d = 0; d <= 6; d++) {
              const v = h[d] ?? h[String(d)];
              if (v == null) {
                clean[d] = null; // closed
                continue;
              }
              const open = Number(v[0]);
              const close = Number(v[1]);
              if (!Number.isInteger(open) || !Number.isInteger(close) || open < 0 || close > 1440 || open >= close) {
                return json({ error: `Horaires invalides pour le jour ${d}.` }, 400);
              }
              clean[d] = [open, close];
            }
            await saveSetting("hours", clean);

            if (body.slotMinutes != null) {
              const sm = Number(body.slotMinutes);
              if (![10, 15, 20, 30, 45, 60].includes(sm)) {
                return json({ error: "Durée de créneau invalide." }, 400);
              }
              await saveSetting("slotMinutes", sm);
            }
            return json({ ok: true });
          }

          return json({ error: "Unknown op" }, 400);
        }

        // ── /admin panel: media (photos & videos) ────────────────────────
        if (path === "/api/admin/media") {
          if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
          if (!env.MEDIA) {
            return json(
              { error: "Stockage R2 non configuré. Créez un bucket et liez-le sous le nom MEDIA." },
              503
            );
          }
          await ensureSchema();

          const ct = request.headers.get("Content-Type") || "";

          // Upload arrives as multipart so the file streams rather than being
          // base64'd through JSON.
          if (ct.includes("multipart/form-data")) {
            const form = await request.formData();
            const denied = requireAdmin({ key: form.get("key") });
            if (denied) return json({ error: denied }, 401);

            const file = form.get("file");
            if (!file || typeof file === "string") return json({ error: "Aucun fichier." }, 400);

            const mime = file.type || "";
            const ext = ALLOWED_MEDIA[mime];
            if (!ext) {
              return json({ error: "Format non accepté (JPEG, PNG, WebP, MP4, MOV, WebM)." }, 400);
            }
            if (file.size > MAX_UPLOAD_BYTES) {
              return json({ error: "Fichier trop lourd (25 Mo maximum)." }, 413);
            }

            const kind = mime.startsWith("video/") ? "video" : "photo";
            const target = String(form.get("target") || "gallery"); // gallery | barber
            const r2key = `${target}/${token()}.${ext}`;
            await env.MEDIA.put(r2key, file.stream(), {
              httpMetadata: { contentType: mime },
            });

            if (target === "barber") {
              const barberId = cleanText(form.get("barberId"), 40);
              if (!barberId) return json({ error: "Barbier manquant." }, 400);
              const prev = await q("select photo_key from barbers where id=$1", [barberId]);
              await q("update barbers set photo_key=$1 where id=$2", [r2key, barberId]);
              const old = (prev.rows || [{}])[0]?.photo_key;
              if (old) await env.MEDIA.delete(old).catch(() => {});
              return json({ ok: true, url: "/api/media/" + r2key });
            }

            const id = token();
            await q(
              `insert into media (id,kind,r2_key,mime,caption,sort)
               values ($1,$2,$3,$4,$5,$6)`,
              [id, kind, r2key, mime, cleanText(form.get("caption"), 120) || null, Number(form.get("sort")) || 0]
            );
            return json({ ok: true, id, kind, url: "/api/media/" + r2key });
          }

          // JSON body — delete or re-caption.
          const body = await request.json();
          const denied = requireAdmin(body);
          if (denied) return json({ error: denied }, 401);

          if (body.op === "delete") {
            const row = await q("select r2_key from media where id=$1", [String(body.id || "")]);
            const key = (row.rows || [{}])[0]?.r2_key;
            await q("delete from media where id=$1", [String(body.id || "")]);
            if (key) await env.MEDIA.delete(key).catch(() => {});
            return json({ ok: true });
          }

          if (body.op === "caption") {
            await q("update media set caption=$1 where id=$2", [
              cleanText(body.caption, 120) || null,
              String(body.id || ""),
            ]);
            return json({ ok: true });
          }

          if (body.op === "barber-photo-delete") {
            const prev = await q("select photo_key from barbers where id=$1", [String(body.id || "")]);
            const key = (prev.rows || [{}])[0]?.photo_key;
            await q("update barbers set photo_key=null where id=$1", [String(body.id || "")]);
            if (key) await env.MEDIA.delete(key).catch(() => {});
            return json({ ok: true });
          }

          return json({ error: "Unknown op" }, 400);
        }

        if (path === "/api/admin") {
          if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
          const body = await request.json();
          const denied = requireAdmin(body);
          if (denied) return json({ error: denied }, 401);
          await ensureSchema();

          if (body.op === "cancel") {
            await q(
              `update bookings set status = 'cancelled', cancelled_at = now() where id = $1`,
              [String(body.id || "")]
            );
            return json({ ok: true });
          }

          if (body.op === "block") {
            if (!isValidDate(body.date)) return json({ error: "Date invalide." }, 400);
            const acfg = await loadConfig();
            const barber =
              body.barber === "ALL" || acfg.barbers.includes(body.barber) ? body.barber : null;
            if (!barber) return json({ error: "Barbier inconnu." }, 400);
            const slot = body.slot == null ? null : Number(body.slot);
            if (slot != null && !slotsForDate(body.date, acfg).includes(slot)) {
              return json({ error: "Créneau invalide." }, 400);
            }
            await q(
              `insert into blocked_slots (id, barber, slot_date, slot_min, reason)
               values ($1,$2,$3,$4,$5)`,
              [token(), barber, body.date, slot, cleanText(body.reason, 120) || null]
            );
            return json({ ok: true });
          }

          if (body.op === "unblock") {
            await q("delete from blocked_slots where id = $1", [String(body.id || "")]);
            return json({ ok: true });
          }

          return json({ error: "Unknown op" }, 400);
        }

        return json({ error: "Not found" }, 404);
      }

      // ── Counter-app events feed (unchanged) ────────────────────────────
      if (request.method === "GET") {
        await ensureEventsColumns();
        const out = await q(
          "select id, type, barber, amount, method, ts, deleted_at, coupon, rdv, created_at from events order by ts desc limit 5000"
        );
        return json(out.rows || []);
      }

      if (request.method === "POST") {
        const body = await request.json();
        await ensureEventsColumns();

        if (body.op === "insert") {
          const r = body.row || {};
          await q(
            "insert into events (id, type, barber, amount, method, ts, coupon, rdv) " +
              "values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (id) do nothing",
            [
              r.id,
              r.type,
              r.barber ?? null,
              r.amount ?? null,
              r.method ?? null,
              r.ts,
              r.coupon === true,
              r.rdv === true,
            ]
          );
          return json({ ok: true });
        }

        if (body.op === "update") {
          const p = body.patch || {};
          const sets = ["amount=$1"];
          const vals = [p.amount];
          let i = 2;
          if (p.method !== undefined) {
            sets.push("method=$" + i++);
            vals.push(p.method);
          }
          if (p.coupon !== undefined) {
            sets.push("coupon=$" + i++);
            vals.push(p.coupon === true);
          }
          if (p.rdv !== undefined) {
            sets.push("rdv=$" + i++);
            vals.push(p.rdv === true);
          }
          vals.push(body.id);
          await q(
            "update events set " + sets.join(", ") + " where id=$" + i,
            vals
          );
          return json({ ok: true });
        }

        if (body.op === "delete") {
          // soft delete — keep the row so the owner always has a trace
          await q("update events set deleted_at = now() where id=$1", [body.id]);
          return json({ ok: true });
        }

        return json({ error: "Unknown op" }, 400);
      }

      return json({ error: "Method not allowed" }, 405);
    } catch (err) {
      return json({ error: String(err && err.message ? err.message : err) }, 500);
    }
  },

  // ── Cron: the pre-appointment promotional email ──────────────────────────
  // Runs on a Cloudflare Cron Trigger (every 5 minutes). Sends the shop's
  // promotion to anyone whose appointment starts within the next hour and who
  // has not already received it.
  //
  // Doing it here rather than at booking time means a customer who cancels
  // never gets it, and someone booking three weeks ahead is not emailed three
  // weeks early.
  async scheduled(event, env, ctx) {
    if (!env.RESEND_API_KEY) return;

    let q;
    try {
      q = makeQuery(env);
    } catch (e) {
      return;
    }

    try {
      // `slot_date + slot_min` is wall-clock time in the shop; `at time zone`
      // turns it into a real instant so the comparison survives DST.
      const due = await q(
        `select b.id, b.name, b.email, b.slot_date, b.slot_min, b.barber
         from bookings b
         where b.status = 'confirmed'
           and b.promo_sent_at is null
           and b.email is not null
           and not exists (
             select 1 from marketing_optout m where m.email = lower(b.email)
           )
           and ((b.slot_date + (b.slot_min || ' minutes')::interval)
                 at time zone 'Europe/Paris') between now() and now() + interval '60 minutes'
         limit 50`
      );

      const site = env.SITE_URL || "https://luxurybarber80.fr";

      for (const row of due.rows || []) {
        // Claim it first: if the send fails we would rather skip one promo
        // than risk emailing the same customer on every cron tick.
        const claimed = await q(
          "update bookings set promo_sent_at = now() where id = $1 and promo_sent_at is null",
          [row.id]
        );
        if (Number(claimed.rowCount || 0) === 0) continue;

        const unsub =
          `${site}/api/unsub?e=${encodeURIComponent(b64urlEncode(row.email))}` +
          `&t=${await unsubToken(env, row.email)}`;

        const when = `à ${hhmm(Number(row.slot_min)).replace(":", "h")} avec ${row.barber}`;

        await sendMail(
          env,
          row.email,
          PROMO_SUBJECT,
          promoLines(String(row.name || "").split(/\s+/)[0] || "", when).concat([
            ``,
            `—`,
            `Vous recevez cet email car vous avez réservé chez Luxury Barber.`,
            `Ne plus recevoir nos actualités : ${unsub}`,
          ]),
          { "List-Unsubscribe": `<${unsub}>` }
        );
      }
    } catch (e) {
      // A failed run is retried on the next tick; nothing else depends on it.
    }
  },
};
