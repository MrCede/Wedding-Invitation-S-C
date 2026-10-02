import { DurableObject } from "cloudflare:workers";

// Si el agente no reporta en este tiempo, la web muestra "sin señal" (gris)
// en lugar de seguir mostrando un verde que ya no es verdad.
const STALE_MS = 20_000;
const HISTORY_LEN = 40;
const MAX_TARGETS = 8;
const PERSIST_EVERY_MS = 60_000;

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

export class StatusHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.state = { agentSeen: 0, targets: [] };
    this.lastPersist = 0;
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get("state")) ?? this.state;
    });
  }

  /** Recibe el resultado de los pings desde el agente. */
  async report(results) {
    const now = Date.now();
    const previous = new Map(this.state.targets.map((t) => [t.ip, t]));
    let changed = false;

    const targets = results.map((r) => {
      const t = previous.get(r.ip) ?? {
        ip: r.ip, name: "", alive: null, since: now, ms: null, lastAlive: null, history: [],
      };
      if (t.alive !== r.alive) {
        t.since = now;
        changed = true;
      }
      t.name = r.name;
      t.alive = r.alive;
      t.ms = r.alive ? r.ms : null;
      if (r.alive) t.lastAlive = now;
      t.history.push([now, r.alive ? (r.ms ?? 0) : -1]);
      if (t.history.length > HISTORY_LEN) t.history.splice(0, t.history.length - HISTORY_LEN);
      return t;
    });

    this.state = { agentSeen: now, targets };
    if (changed || now - this.lastPersist > PERSIST_EVERY_MS) {
      this.lastPersist = now;
      await this.ctx.storage.put("state", this.state);
    }
  }

  /** Estado actual para la web. */
  async snapshot() {
    const now = Date.now();
    const { agentSeen, targets } = this.state;
    return {
      now,
      agentSeen,
      agentOnline: agentSeen > 0 && now - agentSeen < STALE_MS,
      targets,
    };
  }
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/** Comparación en tiempo constante del token del agente. */
async function validToken(request, secret) {
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(secret)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function parseResults(body) {
  const list = body?.results;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_TARGETS) return null;
  const out = [];
  for (const r of list) {
    if (typeof r?.ip !== "string" || !IPV4.test(r.ip) || typeof r.alive !== "boolean") return null;
    const ms = typeof r.ms === "number" && r.ms >= 0 && r.ms < 60_000 ? Math.round(r.ms * 10) / 10 : null;
    const name = typeof r.name === "string" ? r.name.trim().slice(0, 40) : "";
    out.push({ ip: r.ip, alive: r.alive, ms, name });
  }
  return out;
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const hub = env.HUB.get(env.HUB.idFromName("main"));

    if (pathname === "/api/status" && request.method === "GET") {
      return json(await hub.snapshot());
    }

    if (pathname === "/api/report" && request.method === "POST") {
      if (!env.AGENT_TOKEN) return json({ error: "AGENT_TOKEN no configurado en el Worker" }, 500);
      if (!(await validToken(request, env.AGENT_TOKEN))) return json({ error: "No autorizado" }, 401);

      const text = await request.text();
      if (text.length > 4096) return json({ error: "Cuerpo demasiado grande" }, 413);
      let results;
      try {
        results = parseResults(JSON.parse(text));
      } catch {
        results = null;
      }
      if (!results) return json({ error: "Formato inválido" }, 400);

      await hub.report(results);
      return json({ ok: true });
    }

    return json({ error: "No encontrado" }, 404);
  },
};
