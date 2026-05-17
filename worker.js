// Barbershop "doorman" — a Cloudflare Worker that safely connects the app to
// the Neon Postgres database. The database password lives ONLY here, as the
// DATABASE_URL secret in the Cloudflare dashboard — never in the app.
//
// It talks to Neon's SQL-over-HTTP endpoint (the same one the official
// @neondatabase/serverless driver uses), so no npm packages or build step.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function cleanConnString(s) {
  if (!s) return "";
  s = String(s).trim();
  s = s.replace(/^psql\s+/i, "");                // strip leading "psql "
  s = s.replace(/^['"]+|['"]+$/g, "");           // strip surrounding quotes
  s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=/, ""); // strip "DATABASE_URL=" prefix
  s = s.replace(/^['"]+|['"]+$/g, "");           // strip quotes again
  return s.trim();
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

    try {
      if (request.method === "GET") {
        const out = await q(
          "select id, type, barber, amount, method, ts from events order by ts desc limit 5000"
        );
        return json(out.rows || []);
      }

      if (request.method === "POST") {
        const body = await request.json();

        if (body.op === "insert") {
          const r = body.row || {};
          await q(
            "insert into events (id, type, barber, amount, method, ts) " +
              "values ($1,$2,$3,$4,$5,$6) on conflict (id) do nothing",
            [
              r.id,
              r.type,
              r.barber ?? null,
              r.amount ?? null,
              r.method ?? null,
              r.ts,
            ]
          );
          return json({ ok: true });
        }

        if (body.op === "update") {
          const p = body.patch || {};
          if (p.method !== undefined) {
            await q("update events set amount=$1, method=$2 where id=$3", [
              p.amount,
              p.method,
              body.id,
            ]);
          } else {
            await q("update events set amount=$1 where id=$2", [
              p.amount,
              body.id,
            ]);
          }
          return json({ ok: true });
        }

        if (body.op === "delete") {
          await q("delete from events where id=$1", [body.id]);
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
