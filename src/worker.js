const enc = new TextEncoder();

// ===== Log =====
// Satu baris JSON per kejadian: {lvl, rid, evt, ...}. Tiap permintaan punya "rid" yang sama
// dengan "ref" di pesan error web. Lihat: Cloudflare → Workers → web-chatbot → Logs, atau `npx wrangler tail`.
function log(lvl, rid, evt, data = {}) {
  const line = JSON.stringify({ lvl, rid, evt, ...data });
  if (lvl === "error") console.error(line);
  else if (lvl === "warn") console.warn(line);
  else console.log(line);
}

// Error dengan kode + sumber (auth | config | worker | upstream | client) + saran perbaikan.
class AppError extends Error {
  constructor(status, code, source, message, hint = "", extra = {}) {
    super(message);
    this.status = status; this.code = code; this.source = source; this.hint = hint; this.extra = extra;
  }
}

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
const errRes = (e, rid) =>
  json({ ok: false, error: { code: e.code, source: e.source, message: e.message, hint: e.hint, rid, ...e.extra } }, e.status);

// ===== Token =====
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

// ===== CORS =====
// Domain yang boleh memanggil API ini. Bisa diganti lewat Secret ALLOWED_ORIGINS (pisahkan dengan koma).
function originList(env) {
  return (env.ALLOWED_ORIGINS || "https://didinska.my.id,https://www.didinska.my.id")
    .split(",").map(s => s.trim()).filter(Boolean);
}
function allowedOrigin(request, env) {
  const o = request.headers.get("Origin");
  return o && originList(env).includes(o) ? o : null;
}
function withCors(res, origin, rid) {
  const h = new Headers(res.headers);
  h.set("X-Request-Id", rid);
  h.set("Access-Control-Expose-Headers", "X-Request-Id");
  if (origin) {
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Vary", "Origin");
  }
  return new Response(res.body, { status: res.status, headers: h });
}

// ===== Cek konfigurasi =====
const CFG_HINT = "Cloudflare → Workers → web-chatbot → Settings → Variables and Secrets, lalu Deploy.";
function need(env, names) {
  const miss = names.filter(n => !env[n]);
  if (miss.length) throw new AppError(500, "config_missing", "config", "Secret belum diisi: " + miss.join(", "), CFG_HINT, { missing: miss });
}
function checkApiUrl(env) {
  try { return new URL(env.API_URL); }
  catch { throw new AppError(500, "config_invalid", "config", "API_URL bukan URL yang valid.", "Harus diawali https://, contoh: https://codecraftapi.com/v1/chat/completions"); }
}
function upstreamUrl(env, kind) {
  const u = checkApiUrl(env);
  if (kind === "models") u.pathname = u.pathname.replace(/\/chat\/completions\/?$/, "").replace(/\/$/, "") + "/models";
  return u.toString();
}
async function requireAuth(request, env, rid) {
  need(env, ["SESSION_SECRET"]);
  if (!(await isLoggedIn(request, env.SESSION_SECRET))) {
    log("warn", rid, "auth_fail", { hasHeader: !!request.headers.get("Authorization") });
    throw new AppError(401, "session_invalid", "auth", "Sesi habis atau tidak valid.", "Masukkan PIN lagi.");
  }
}

// ===== Panggilan ke provider API =====
const HINTS = {
  400: "Permintaan ditolak provider. Biasanya MODEL salah/tidak didukung atau format pesan tidak cocok.",
  401: "API_KEY salah, kedaluwarsa, atau bukan milik provider di API_URL ini.",
  403: "API_KEY tidak punya akses ke model/endpoint ini.",
  404: "API_URL salah (path harus berakhir /chat/completions) atau MODEL tidak ada.",
  429: "Kuota atau rate limit provider habis. Tunggu sebentar atau ganti API key.",
};
async function upstreamError(res, rid, label) {
  let full = "";
  try { full = await res.text(); } catch {}
  let detail = full;
  try {
    const j = JSON.parse(full);
    detail = (j.error && (j.error.message || j.error)) || j.message || j.detail || full;
  } catch {}
  if (typeof detail !== "string") detail = JSON.stringify(detail);
  detail = detail.replace(/\s+/g, " ").slice(0, 300);
  const hint = HINTS[res.status] || (res.status >= 500 ? "Provider sedang bermasalah (5xx). Coba lagi nanti." : "Lihat pesan dari provider.");
  log("error", rid, "upstream_error", { label, status: res.status, detail });
  return new AppError(502, "upstream_error", "upstream", `Provider API menjawab ${res.status}: ${detail || res.statusText}`, hint, { upstream_status: res.status });
}
async function callUpstream(rid, url, init, label) {
  const host = new URL(url).host;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60000); // batas menunggu jawaban awal, bukan lama stream
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, { ...init, signal: ctl.signal });
  } catch (e) {
    const timeout = e && e.name === "AbortError";
    log("error", rid, "upstream_fail", { label, host, timeout, msg: String((e && e.message) || e) });
    throw new AppError(timeout ? 504 : 502, timeout ? "upstream_timeout" : "upstream_unreachable", "upstream",
      timeout ? "Provider API tidak menjawab dalam 60 detik." : "Worker tidak bisa menghubungi provider API.",
      "Cek ejaan API_URL dan apakah provider sedang down.");
  } finally { clearTimeout(timer); }
  log(res.ok ? "info" : "warn", rid, "upstream", { label, host, status: res.status, ms: Date.now() - t0 });
  if (!res.ok) throw await upstreamError(res, rid, label);
  return res;
}
const modelIds = j => ((j && (j.data || j.models)) || []).map(m => typeof m === "string" ? m : m.id || m.name).filter(Boolean);

// ===== Endpoint =====
async function login(request, env, rid) {
  need(env, ["PIN", "SESSION_SECRET"]);
  const { pin } = await request.json().catch(() => ({}));
  await new Promise(r => setTimeout(r, 600)); // perlambat tebak-tebakan PIN
  if (!safeEq(String(pin || ""), String(env.PIN))) {
    log("warn", rid, "login_failed", { ip: request.headers.get("CF-Connecting-IP") || "" });
    throw new AppError(401, "pin_wrong", "auth", "PIN salah.");
  }
  log("info", rid, "login_ok");
  return json({ ok: true, token: await makeToken(env.SESSION_SECRET) });
}

async function session(request, env) {
  const ok = await isLoggedIn(request, env.SESSION_SECRET);
  return new Response(null, { status: ok ? 204 : 401 });
}

// Riwayat obrolan disimpan di KV (binding CHATS) supaya sama di semua perangkat.
async function chats(request, env, rid) {
  await requireAuth(request, env, rid);
  if (!env.CHATS) throw new AppError(500, "kv_missing", "config", "KV 'CHATS' belum terpasang.", "Deploy ulang Worker (wrangler.jsonc membuat KV otomatis) atau buat KV manual lalu isi \"id\" di wrangler.jsonc.");
  if (request.method === "GET") {
    let v;
    try { v = await env.CHATS.get("chats"); }
    catch (e) { log("error", rid, "kv_error", { op: "get", msg: String(e.message || e) }); throw new AppError(500, "kv_error", "worker", "Gagal membaca KV: " + (e.message || e)); }
    return new Response(v || '{"chats":[],"gone":{}}', { headers: { "Content-Type": "application/json" } });
  }
  const body = await request.text();
  if (body.length > 5e6) throw new AppError(413, "too_large", "client", "Data riwayat terlalu besar (maks 5 MB).", "Hapus beberapa obrolan lama.");
  try { if (!Array.isArray(JSON.parse(body).chats)) throw 0; }
  catch { throw new AppError(400, "invalid_data", "client", "Data riwayat tidak valid.", ""); }
  try { await env.CHATS.put("chats", body); }
  catch (e) { log("error", rid, "kv_error", { op: "put", msg: String(e.message || e) }); throw new AppError(500, "kv_error", "worker", "Gagal menulis KV: " + (e.message || e)); }
  return json({ ok: true });
}

async function models(request, env, rid) {
  await requireAuth(request, env, rid);
  need(env, ["API_URL", "API_KEY"]);
  const res = await callUpstream(rid, upstreamUrl(env, "models"), { headers: { Authorization: "Bearer " + env.API_KEY } }, "models");
  const ids = modelIds(await res.json().catch(() => null)).sort();
  if (!ids.length) throw new AppError(502, "upstream_bad_format", "upstream", "Daftar model kosong atau formatnya tidak dikenali.", "Provider mungkin tidak menyediakan /models. Isi Secret MODEL secara manual.");
  return json({ ok: true, models: ids, default: env.MODEL || "" });
}

// Pemeriksaan satu per satu: Secret, KV, origin, dan koneksi ke provider.
async function diag(request, env, rid) {
  await requireAuth(request, env, rid);
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  add("PIN", !!env.PIN, env.PIN ? "terisi" : "belum diisi");
  add("SESSION_SECRET", !!env.SESSION_SECRET, env.SESSION_SECRET ? "terisi" : "belum diisi");
  let urlOk = false;
  if (!env.API_URL) add("API_URL", false, "belum diisi");
  else {
    try {
      const u = new URL(env.API_URL); urlOk = true;
      const okPath = /\/chat\/completions\/?$/.test(u.pathname);
      add("API_URL", okPath, env.API_URL + (okPath ? "" : "\n    path tidak berakhir /chat/completions (kemungkinan salah)"));
    } catch { add("API_URL", false, "bukan URL yang valid (harus diawali https://)"); }
  }
  const k = String(env.API_KEY || "");
  add("API_KEY", !!k, k ? "terisi, awalan " + (k.includes("_") ? k.split("_")[0] + "_" : k.slice(0, 3) + "…") : "belum diisi");
  add("MODEL", true, env.MODEL || "(kosong, model dipilih dari sidebar)");
  if (!env.CHATS) add("KV CHATS", false, "belum terpasang, deploy ulang Worker");
  else { try { await env.CHATS.get("chats"); add("KV CHATS", true, "bisa dibaca"); } catch (e) { add("KV CHATS", false, String(e.message || e)); } }
  const reqOrigin = request.headers.get("Origin") || "";
  add("ALLOWED_ORIGINS", !!allowedOrigin(request, env), (reqOrigin ? reqOrigin + " → " : "") + originList(env).join(", "));
  if (urlOk && k) {
    const t0 = Date.now();
    try {
      const res = await callUpstream(rid, upstreamUrl(env, "models"), { headers: { Authorization: "Bearer " + k } }, "diag-models");
      const ids = modelIds(await res.json().catch(() => null));
      add("Provider (GET /models)", true, `HTTP ${res.status}, ${ids.length} model, ${Date.now() - t0} ms`);
      if (env.MODEL) {
        const has = ids.includes(env.MODEL);
        add("MODEL ada di provider", has, has ? env.MODEL : `"${env.MODEL}" tidak ada. Contoh yang ada: ${ids.slice(0, 5).join(", ") || "-"}`);
      }
    } catch (e) {
      const note = e instanceof AppError && e.extra.upstream_status === 404 ? "\n    (sebagian provider memang tidak punya /models; coba kirim chat)" : "";
      add("Provider (GET /models)", false, e instanceof AppError ? `${e.message}\n    ${e.hint}${note}` : String((e && e.message) || e));
    }
  }
  return json({ ok: checks.every(c => c.ok), checks, rid });
}

async function chat(request, env, rid) {
  await requireAuth(request, env, rid);
  need(env, ["API_URL", "API_KEY"]);
  checkApiUrl(env);
  let body;
  try { body = await request.json(); }
  catch { throw new AppError(400, "bad_request", "client", "Isi permintaan bukan JSON yang valid."); }
  if (!body || !Array.isArray(body.messages) || !body.messages.length) throw new AppError(400, "bad_request", "client", "Field 'messages' kosong atau bukan array.");
  const model = body.model || env.MODEL;
  if (!model) throw new AppError(500, "config_missing", "config", "MODEL belum diisi.", "Isi Secret MODEL atau pilih model di sidebar.", { missing: ["MODEL"] });
  log("info", rid, "chat", { model, msgs: body.messages.length, stream: !!body.stream, chars: JSON.stringify(body.messages).length });
  const res = await callUpstream(rid, env.API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.API_KEY },
    body: JSON.stringify({ ...body, model }),
  }, "chat");
  return new Response(res.body, {
    status: 200,
    headers: { "Content-Type": res.headers.get("Content-Type") || "application/json", "Cache-Control": "no-store" },
  });
}

export default {
  async fetch(request, env) {
    const rid = crypto.randomUUID().slice(0, 8);
    const t0 = Date.now();
    const p = new URL(request.url).pathname, m = request.method;
    const origin = allowedOrigin(request, env);
    const reqOrigin = request.headers.get("Origin");
    if (reqOrigin && !origin) log("warn", rid, "origin_blocked", { origin: reqOrigin, hint: "Tambahkan ke ALLOWED_ORIGINS" });

    if (m === "OPTIONS") {
      return withCors(new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
        },
      }), origin, rid);
    }

    let res;
    try {
      if (p === "/api/login" && m === "POST") res = await login(request, env, rid);
      else if (p === "/api/session" && m === "GET") res = await session(request, env);
      else if (p === "/api/chat" && m === "POST") res = await chat(request, env, rid);
      else if (p === "/api/chats" && (m === "GET" || m === "PUT")) res = await chats(request, env, rid);
      else if (p === "/api/models" && m === "GET") res = await models(request, env, rid);
      else if (p === "/api/diag" && m === "GET") res = await diag(request, env, rid);
      else throw new AppError(404, "not_found", "worker", `Path tidak dikenal: ${m} ${p}`, "Cek alamat API di docs/index.html.");
    } catch (e) {
      if (e instanceof AppError) {
        log(e.status >= 500 ? "error" : "warn", rid, "app_error", { code: e.code, source: e.source, status: e.status, msg: e.message });
        res = errRes(e, rid);
      } else {
        log("error", rid, "internal", { msg: String((e && e.message) || e), stack: String((e && e.stack) || "").slice(0, 600) });
        res = errRes(new AppError(500, "internal", "worker", "Kesalahan tak terduga di Worker: " + ((e && e.message) || e), "Cari baris log dengan rid ini di Cloudflare."), rid);
      }
    }
    log(res.status >= 500 ? "error" : res.status >= 400 ? "warn" : "info", rid, "request", { method: m, path: p, status: res.status, ms: Date.now() - t0, origin: reqOrigin || "" });
    return withCors(res, origin, rid);
  },
};
