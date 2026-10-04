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

async function isLoggedIn(request, secret) {
  const m = /(?:^|; )sess=([^;]+)/.exec(request.headers.get("Cookie") || "");
  if (!m || !secret) return false;
  const [exp, sig] = m[1].split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEq(sig, await sign(exp, secret));
}

const json = (o, status = 200, h = {}) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", ...h } });

async function login(request, env) {
  const { pin } = await request.json().catch(() => ({}));
  await new Promise(r => setTimeout(r, 600)); // perlambat tebak-tebakan PIN
  if (!env.PIN || !safeEq(String(pin || ""), String(env.PIN))) return json({ ok: false }, 401);
  const t = await makeToken(env.SESSION_SECRET);
  return json({ ok: true }, 200, {
    "Set-Cookie": `sess=${t}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`,
  });
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
    if (p === "/api/login" && request.method === "POST") return login(request, env);
    if (p === "/api/session" && request.method === "GET") return session(request, env);
    if (p === "/api/chat" && request.method === "POST") return chat(request, env);
    if (p.startsWith("/api/")) return new Response("Not found", { status: 404 });
    return env.ASSETS.fetch(request);
  },
};
