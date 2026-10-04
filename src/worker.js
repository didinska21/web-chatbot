const enc = new TextEncoder();

async function sign(msg, secret) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function safeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function makeToken(secret) {
  const exp = Date.now() + 7 * 864e5; // berlaku 7 hari
  return exp + "." + (await sign(String(exp), secret));
}

// Token dikirim lewat header Authorization: Bearer <token>
async function isLoggedIn(request, secret) {
  const m = /^Bearer (.+)$/.exec(request.headers.get("Authorization") || "");
  if (!m || !secret) return false;
  const [exp, sig] = m[1].split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEq(sig, await sign(exp, secret));
}

// Domain yang boleh memanggil API ini (frontend di GitHub Pages).
// Bisa diganti lewat Secret/Variable ALLOWED_ORIGINS (pisahkan dengan koma).
function allowedOrigin(request, env) {
  const list = (env.ALLOWED_ORIGINS || "https://didinska.my.id,https://www.didinska.my.id")
    .split(",").map(s => s.trim()).filter(Boolean);
  const o = request.headers.get("Origin");
  return o && list.includes(o) ? o : null;
}

function withCors(res, origin) {
  const h = new Headers(res.headers);
  if (origin) {
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Vary", "Origin");
  }
  return new Response(res.body, { status: res.status, headers: h });
}

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

async function login(request, env) {
  const { pin } = await request.json().catch(() => ({}));
  await new Promise(r => setTimeout(r, 600)); // perlambat tebak-tebakan PIN
  if (!env.PIN || !env.SESSION_SECRET || !safeEq(String(pin || ""), String(env.PIN))) return json({ ok: false }, 401);
  return json({ ok: true, token: await makeToken(env.SESSION_SECRET) });
}

async function session(request, env) {
  const ok = await isLoggedIn(request, env.SESSION_SECRET);
  return new Response(null, { status: ok ? 204 : 401 });
}

async function chat(request, env) {
  if (!(await isLoggedIn(request, env.SESSION_SECRET))) {
    return new Response("Unauthorized", { status: 401 });
  }
  const body = await request.json();
  const res = await fetch(env.API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + env.API_KEY,
    },
    body: JSON.stringify({ ...body, model: env.MODEL || body.model }),
  });
  return new Response(res.body, {
    status: res.status,
    headers: { "Content-Type": res.headers.get("Content-Type") || "application/json" },
  });
}

export default {
  async fetch(request, env) {
    const { pathname: p } = new URL(request.url);
    const origin = allowedOrigin(request, env);

    if (request.method === "OPTIONS") {
      return withCors(new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
        },
      }), origin);
    }

    let res;
    if (p === "/api/login" && request.method === "POST") res = await login(request, env);
    else if (p === "/api/session" && request.method === "GET") res = await session(request, env);
    else if (p === "/api/chat" && request.method === "POST") res = await chat(request, env);
    else res = new Response("Not found", { status: 404 });
    return withCors(res, origin);
  },
};
