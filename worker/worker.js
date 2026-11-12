// Relais Cloudflare Worker entre l'appli et l'API PRIM d'Île-de-France Mobilités.
// - ajoute la clé API (secret PRIM_API_KEY, jamais visible côté navigateur) ;
// - n'autorise que les appels utiles, avec des paramètres vérifiés ;
// - n'accepte que les pages listées dans ALLOWED_ORIGINS (CORS) ;
// - garde chaque réponse quelques secondes pour économiser le quota.

const PRIM = "https://prim.iledefrance-mobilites.fr/marketplace";

const ROUTES = {
  "/stop-monitoring": { param: "MonitoringRef", pattern: /^STIF:(StopArea:SP|StopPoint:Q):\d{1,8}:$/, ttl: 15 },
  "/general-message": { param: "LineRef", pattern: /^STIF:Line::C\d{5}:$/, ttl: 120 },
};

// Info trafic détaillée (périodes, stations touchées) : PRIM renvoie tout le réseau,
// le relais ne garde que ce qui concerne la ligne demandée.
const DISRUPTIONS = { path: "/disruptions", upstream: `${PRIM}/disruptions_bulk/disruptions/v2`, pattern: /^C\d{5}$/, ttl: 120 };

function filterDisruptions(raw, line) {
  const data = JSON.parse(raw);
  const lines = (data.lines || []).filter((l) => JSON.stringify([l.id, l.lineId, l.code]).includes(line));
  const ids = new Set();
  for (const l of lines) for (const o of l.impactedObjects || []) for (const id of o.disruptionIds || []) ids.add(id);
  const disruptions = (data.disruptions || []).filter((d) => ids.has(d.id));
  return JSON.stringify({ lastUpdatedDate: data.lastUpdatedDate, lines, disruptions });
}

const DEFAULT_ORIGINS = "https://edgarblava.github.io,http://localhost:8000,http://127.0.0.1:8000";

const memo = new Map(); // cache en mémoire (par instance du Worker)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const allowed = (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(",").map((s) => s.trim());
    const cors = {
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
    if (origin && allowed.includes(origin)) cors["Access-Control-Allow-Origin"] = origin;

    const reply = (body, status, extra = {}) =>
      new Response(body, { status, headers: { "Content-Type": "application/json; charset=utf-8", ...cors, ...extra } });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET") return reply('{"error":"method"}', 405);
    if (url.pathname === "/" || url.pathname === "/health") {
      return reply(JSON.stringify({ ok: true, key: Boolean(env.PRIM_API_KEY) }), 200);
    }
    if (!origin || !allowed.includes(origin)) return reply('{"error":"origin"}', 403);

    if (url.pathname === DISRUPTIONS.path) {
      const line = url.searchParams.get("line");
      if (!line || !DISRUPTIONS.pattern.test(line)) return reply('{"error":"bad request"}', 400);
      if (!env.PRIM_API_KEY) return reply('{"error":"PRIM_API_KEY manquante"}', 500);
      let hit = memo.get(DISRUPTIONS.upstream);
      if (!hit || Date.now() - hit.at > DISRUPTIONS.ttl * 1000) {
        let upstream;
        try {
          upstream = await fetch(DISRUPTIONS.upstream, { headers: { apikey: env.PRIM_API_KEY, Accept: "application/json" } });
        } catch {
          return reply('{"error":"PRIM injoignable"}', 502);
        }
        if (!upstream.ok) return reply(JSON.stringify({ error: "PRIM", status: upstream.status }), 502);
        hit = { at: Date.now(), body: await upstream.text() };
        memo.set(DISRUPTIONS.upstream, hit);
      }
      try {
        return reply(filterDisruptions(hit.body, line), 200, { "Cache-Control": "no-store" });
      } catch {
        return reply('{"error":"format"}', 502);
      }
    }

    const route = ROUTES[url.pathname];
    const value = route && url.searchParams.get(route.param);
    if (!route || !value || !route.pattern.test(value)) return reply('{"error":"bad request"}', 400);
    if (!env.PRIM_API_KEY) return reply('{"error":"PRIM_API_KEY manquante"}', 500);

    const target = `${PRIM}${url.pathname}?${route.param}=${encodeURIComponent(value)}`;
    const hit = memo.get(target);
    if (hit && Date.now() - hit.at < route.ttl * 1000) return reply(hit.body, 200, { "X-Cache": "HIT" });

    let upstream;
    try {
      upstream = await fetch(target, { headers: { apikey: env.PRIM_API_KEY, Accept: "application/json" } });
    } catch {
      return reply('{"error":"PRIM injoignable"}', 502);
    }
    const body = await upstream.text();
    if (!upstream.ok) return reply(JSON.stringify({ error: "PRIM", status: upstream.status }), 502);

    memo.set(target, { at: Date.now(), body });
    if (memo.size > 500) memo.delete(memo.keys().next().value);
    return reply(body, 200, { "Cache-Control": "no-store", "X-Cache": "MISS" });
  },
};
