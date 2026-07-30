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
// The website reads this over /api/config, so prices and hours only ever need
// to change here.
const BARBERS = ["Momo", "Amine"];

// `price` is the online-booking (RDV) price — the discounted rate customers
// only get by booking here. `planity` is the regular Planity/walk-in rate,
// shown struck through so the saving is visible. Omit `planity` for services
// with no comparable Planity rate.
const SERVICES = {
  cheveux: { label: "Cheveux", price: 18.0, planity: 20.0, duration: 30 },
  barbe: { label: "Barbe", price: 9.99, planity: 12.0, duration: 30 },
  both: { label: "Cheveux + Barbe", price: 23.99, planity: 26.0, duration: 30 },
  enfant: { label: "Enfant", price: 12.0, duration: 30 },
};

const SLOT_MIN = 30; // minutes per bookable slot
const MAX_DAYS_AHEAD = 60; // how far in advance customers may book
const MAX_UPCOMING_PER_PHONE = 3; // simple abuse guard

// Opening hours in minutes from midnight, keyed by JS weekday (0 = Sunday).
const HOURS = {
  0: [600, 1200], // Sunday   10h00 – 20h00
  1: [570, 1200], // Monday    9h30 – 20h00
  2: [570, 1200],
  3: [570, 1200],
  4: [570, 1200],
  5: [570, 1200],
  6: [570, 1200], // Saturday  9h30 – 20h00
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

function slotsForDate(dateStr) {
  const hours = HOURS[weekdayOf(dateStr)];
  if (!hours) return [];
  const [open, close] = hours;
  const out = [];
  for (let t = open; t + SLOT_MIN <= close; t += SLOT_MIN) out.push(t);
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

function validBooking(body) {
  const service = SERVICES[body.service] ? body.service : null;
  if (!service) return { error: "Prestation inconnue." };

  const barber = body.barber === "any" || BARBERS.includes(body.barber) ? body.barber : null;
  if (!barber) return { error: "Barbier inconnu." };

  if (!isValidDate(body.date)) return { error: "Date invalide." };

  const now = shopNow();
  const ahead = daysBetween(now.date, body.date);
  if (ahead < 0) return { error: "Cette date est déjà passée." };
  if (ahead > MAX_DAYS_AHEAD) return { error: "Réservation trop lointaine." };

  const slot = Number(body.slot);
  if (!Number.isInteger(slot) || !slotsForDate(body.date).includes(slot)) {
    return { error: "Créneau invalide." };
  }
  if (ahead === 0 && slot <= now.minutes) return { error: "Ce créneau est déjà passé." };

  const name = cleanText(body.name, 80);
  if (name.length < 2) return { error: "Merci d'indiquer votre nom." };

  const phone = cleanText(body.phone, 25);
  if (!/^[+\d][\d\s().-]{5,}$/.test(phone)) return { error: "Numéro de téléphone invalide." };

  const email = cleanText(body.email, 120);
  if (email && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) return { error: "Email invalide." };

  return {
    service,
    barber,
    date: body.date,
    slot,
    name,
    phone,
    email,
    note: cleanText(body.note, 300),
  };
}

// ── Email notification (optional) ───────────────────────────────────────────
// Only fires when RESEND_API_KEY and SHOP_EMAIL are configured; a mail failure
// must never lose a booking that is already committed to the database.
async function sendMail(env, to, subject, lines) {
  if (!env.RESEND_API_KEY || !to) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + env.RESEND_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.MAIL_FROM || "Luxury Barber <onboarding@resend.dev>",
        to: [to],
        subject,
        text: lines.join("\n"),
      }),
    });
  } catch (e) {
    // swallowed on purpose — see comment above
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    const connectionString = cleanConnString(env.DATABASE_URL);
    if (!connectionString) {
      return json({ error: "DATABASE_URL secret is not set" }, 500);
    }

    // Derive Neon's SQL-over-HTTP endpoint from the connection string host,
    // exactly how the Neon serverless driver does it.
    let sqlUrl;
    try {
      let host;
      try {
        host = new URL(connectionString).hostname;
      } catch (e) {
        const m = connectionString.match(/@([^/:?]+)/);
        if (m) host = m[1];
      }
      if (!host) {
        return json(
          { error: "Bad DATABASE_URL format", starts_with: connectionString.slice(0, 13) },
          500
        );
      }
      const apiHost = host.replace(/^[^.]+\./, "api.");
      sqlUrl = "https://" + apiHost + "/sql";
    } catch (e) {
      return json({ error: "Bad DATABASE_URL format" }, 500);
    }

    async function q(query, params = []) {
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
          return json({
            barbers: BARBERS,
            services: SERVICES,
            slotMinutes: SLOT_MIN,
            maxDaysAhead: MAX_DAYS_AHEAD,
            hours: HOURS,
            today: shopNow().date,
          });
        }

        if (path === "/api/availability") {
          const date = url.searchParams.get("date");
          if (!isValidDate(date)) return json({ error: "Date invalide." }, 400);

          const now = shopNow();
          const ahead = daysBetween(now.date, date);
          if (ahead < 0 || ahead > MAX_DAYS_AHEAD) {
            return json({ date, closed: true, barbers: {} });
          }

          await ensureSchema();
          const all = slotsForDate(date);
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
          for (const b of BARBERS) {
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
          return json({ date, closed: false, slotMinutes: SLOT_MIN, barbers: out });
        }

        if (path === "/api/book") {
          if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
          const body = await request.json();
          const v = validBooking(body);
          if (v.error) return json({ error: v.error }, 400);

          await ensureSchema();

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

          const svc = SERVICES[v.service];
          // For "peu importe", try each barber in turn; the unique index below
          // decides the winner if someone books the same slot concurrently.
          const candidates = v.barber === "any" ? BARBERS : [v.barber];

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
            const barber = body.barber === "ALL" || BARBERS.includes(body.barber) ? body.barber : null;
            if (!barber) return json({ error: "Barbier inconnu." }, 400);
            const slot = body.slot == null ? null : Number(body.slot);
            if (slot != null && !slotsForDate(body.date).includes(slot)) {
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
};
