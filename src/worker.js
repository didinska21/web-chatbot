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

// Token v2: peran.exp.kode.tanda-tangan. Token pemilik ikut terikat ke PIN, jadi ganti PIN = semua sesi pemilik langsung keluar.
const pinOf = env => String(env.PIN || "").trim();
const keyOf = (env, role) => env.SESSION_SECRET + (role === "owner" ? "|" + pinOf(env) : "");
async function makeToken(env, role, exp, cid = "-") {
  const msg = `${role}.${exp}.${cid}`;
  return msg + "." + (await sign(msg, keyOf(env, role)));
}
// Token dikirim lewat header Authorization: Bearer <token>
async function readToken(request, env) {
  const m = /^Bearer (.+)$/.exec(request.headers.get("Authorization") || "");
  if (!m || !env.SESSION_SECRET) return null;
  const p = m[1].split(".");
  if (p.length !== 4) return null;
  const [role, exp, cid, sig] = p;
  if (role !== "owner" && role !== "guest") return null;
  if (!(Number(exp) > Date.now())) return null; // NaN juga ditolak
  if (!safeEq(sig, await sign(`${role}.${exp}.${cid}`, keyOf(env, role)))) return null;
  return { role, exp: Number(exp), cid };
}

// ===== Kode tamu (disimpan di KV "CHATS" dengan awalan code:) =====
const trialMs = env => (Number(env.GUEST_TRIAL_MIN) || 60) * 60e3;
const codeValidMs = env => (Number(env.GUEST_CODE_HOURS) || 24) * 3600e3;
const codeCache = new Map(); // kode -> { t, rec }, hanya menghemat pembacaan KV
async function getCode(env, code, fresh) {
  const c = codeCache.get(code);
  if (!fresh && c && Date.now() - c.t < 15000) return c.rec;
  const rec = env.CHATS ? await env.CHATS.get("code:" + code, "json") : null;
  codeCache.set(code, { t: Date.now(), rec });
  return rec;
}
async function putCode(env, code, rec) {
  const ttl = rec.redeemed ? Math.ceil((rec.trialEnd - Date.now()) / 1000) + 86400 : Math.ceil((rec.expires - Date.now()) / 1000) + 3600;
  await env.CHATS.put("code:" + code, JSON.stringify(rec), { expirationTtl: Math.max(120, ttl) });
  codeCache.set(code, { t: Date.now(), rec });
}
// Batas pemakaian tamu (di memori Worker, best-effort) supaya kuota API-mu tidak terkuras.
const GUEST_MAX = { chat: 60, forex: 200 };
const guestUse = new Map();
function guestCap(au, kind) {
  if (au.role !== "guest") return;
  const k = au.cid + "|" + kind, n = (guestUse.get(k) || 0) + 1;
  guestUse.set(k, n);
  if (n > GUEST_MAX[kind]) throw new AppError(429, "guest_limit", "auth", "Batas pemakaian trial tercapai.", "Minta akses penuh ke pemilik.");
}

// ===== Batas percobaan login: 8 kali salah per IP = diblokir 10 menit (di memori Worker) =====
const loginFails = new Map();
function loginBlocked(ip) {
  const r = loginFails.get(ip), now = Date.now();
  if (!r) return 0;
  if (r.until && r.until > now) return Math.ceil((r.until - now) / 1000);
  if (now - r.first > 600e3 || r.until) loginFails.delete(ip);
  return 0;
}
function loginFail(ip) {
  const now = Date.now();
  let r = loginFails.get(ip);
  if (!r || now - r.first > 600e3) r = { n: 0, first: now };
  if (++r.n >= 8) r.until = now + 600e3;
  loginFails.set(ip, r);
  if (loginFails.size > 5000) for (const [k, v] of loginFails) if (now - v.first > 600e3) loginFails.delete(k);
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
async function requireAuth(request, env, rid, ownerOnly = false) {
  need(env, ["SESSION_SECRET"]);
  const au = await readToken(request, env);
  if (!au) {
    log("warn", rid, "auth_fail", { hasHeader: !!request.headers.get("Authorization") });
    throw new AppError(401, "session_invalid", "auth", "Sesi habis atau tidak valid.", "Masukkan PIN lagi.");
  }
  if (au.role === "guest") {
    const rec = await getCode(env, au.cid);
    if (!rec || rec.revoked || !rec.trialEnd || Date.now() >= rec.trialEnd)
      throw new AppError(401, "session_invalid", "auth", "Trial tamu sudah berakhir atau kodenya dicabut.", "Minta kode baru ke pemilik.");
  }
  if (ownerOnly && au.role !== "owner") throw new AppError(403, "forbidden", "auth", "Fitur ini hanya untuk pemilik.");
  return au;
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
  const ip = request.headers.get("CF-Connecting-IP") || "?";
  const wait = loginBlocked(ip);
  if (wait) throw new AppError(429, "too_many_attempts", "auth", `Terlalu banyak percobaan salah. Coba lagi dalam ${Math.ceil(wait / 60)} menit.`, "", { retry_after: wait });
  const { pin } = await request.json().catch(() => ({}));
  const input = String(pin ?? "").trim();
  await new Promise(r => setTimeout(r, 600)); // perlambat tebak-tebakan
  if (input && safeEq(input, pinOf(env))) {
    loginFails.delete(ip);
    log("info", rid, "login_ok", { role: "owner" });
    return json({ ok: true, role: "owner", token: await makeToken(env, "owner", Date.now() + 7 * 864e5) });
  }
  const code = input.replace(/[\s-]/g, "");
  if (/^\d{8}$/.test(code)) {
    if (!env.CHATS) throw new AppError(500, "kv_missing", "config", "KV 'CHATS' belum terpasang, kode tamu tidak bisa dipakai.", CFG_HINT);
    const rec = await getCode(env, code, true);
    const bad = (c, m) => { loginFail(ip); log("warn", rid, "code_failed", { code: c, tail: code.slice(-2) }); return new AppError(401, c, "auth", m); };
    if (!rec || rec.revoked) throw bad("code_invalid", "Kode tidak dikenal atau sudah dicabut.");
    if (!rec.redeemed) {
      if (Date.now() > rec.expires) throw bad("code_expired", "Kode ini sudah kedaluwarsa. Minta kode baru ke pemilik.");
      rec.redeemed = Date.now();
      rec.trialEnd = rec.redeemed + (rec.trialMs || trialMs(env));
      await putCode(env, code, rec);
    } else if (Date.now() >= rec.trialEnd) {
      throw bad("trial_over", "Trial untuk kode ini sudah habis. Minta kode baru ke pemilik.");
    }
    loginFails.delete(ip);
    log("info", rid, "login_ok", { role: "guest", tail: code.slice(-2) });
    return json({ ok: true, role: "guest", exp: rec.trialEnd, token: await makeToken(env, "guest", rec.trialEnd, code) });
  }
  loginFail(ip);
  log("warn", rid, "login_failed", { ip });
  throw new AppError(401, "pin_wrong", "auth", "PIN salah.");
}

async function session(request, env, rid) {
  try {
    const au = await requireAuth(request, env, rid);
    return json({ ok: true, role: au.role, exp: au.exp });
  } catch (e) {
    if (e instanceof AppError && e.status === 401) return new Response(null, { status: 401 });
    throw e;
  }
}

// ===== Kelola kode tamu (khusus pemilik) =====
async function adminCodes(request, env, rid) {
  await requireAuth(request, env, rid, true);
  if (!env.CHATS) throw new AppError(500, "kv_missing", "config", "KV 'CHATS' belum terpasang.", CFG_HINT);
  const base = { trialMin: Math.round(trialMs(env) / 60e3), validHours: Math.round(codeValidMs(env) / 3600e3) };
  if (request.method === "GET") {
    const l = await env.CHATS.list({ prefix: "code:", limit: 100 });
    const codes = (await Promise.all(l.keys.map(async k => {
      const rec = await env.CHATS.get(k.name, "json");
      return rec ? { code: k.name.slice(5), ...rec } : null;
    }))).filter(Boolean).sort((a, b) => b.created - a.created);
    return json({ ok: true, ...base, now: Date.now(), codes });
  }
  const body = await request.json().catch(() => ({}));
  if (body.action === "create") {
    let code = "";
    for (let i = 0; i < 12 && !code; i++) {
      const b = new Uint32Array(1); crypto.getRandomValues(b);
      const c = String(10000000 + (b[0] % 90000000)); // 8 digit, tanpa nol di depan
      if (!(await getCode(env, c, true))) code = c;
    }
    if (!code) throw new AppError(500, "code_gen_failed", "worker", "Gagal membuat kode unik.", "Coba lagi.");
    const rec = { created: Date.now(), expires: Date.now() + codeValidMs(env), trialMs: trialMs(env), redeemed: null, trialEnd: null, revoked: false };
    await putCode(env, code, rec);
    log("info", rid, "code_created", { tail: code.slice(-2) });
    return json({ ok: true, ...base, code, ...rec });
  }
  if (body.action === "revoke") {
    const code = String(body.code || "");
    if (!/^\d{8}$/.test(code)) throw new AppError(400, "bad_request", "client", "Kode tidak valid.");
    const rec = await getCode(env, code, true);
    if (!rec) throw new AppError(404, "not_found", "client", "Kode tidak ditemukan.");
    if (rec.redeemed && !rec.revoked) { rec.revoked = true; await putCode(env, code, rec); }
    else { await env.CHATS.delete("code:" + code); codeCache.delete(code); }
    log("info", rid, "code_revoked", { tail: code.slice(-2) });
    return json({ ok: true });
  }
  throw new AppError(400, "bad_request", "client", "Aksi tidak dikenal.", "Gunakan action: create atau revoke.");
}

// Riwayat obrolan disimpan di KV (binding CHATS) supaya sama di semua perangkat.
async function chats(request, env, rid) {
  await requireAuth(request, env, rid, true); // riwayat obrolan pemilik: tamu tidak boleh membaca atau menimpa
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

// ===== Grafik emas / forex (Twelve Data) =====
// API key Twelve Data disimpan di Secret TWELVEDATA_KEY, tidak pernah dikirim ke browser.
const FX_SYMBOLS = ["XAU/USD"];
// Lama hasil disimpan di memori Worker (detik). Menghindari panggilan ganda ke Twelve Data (paket gratis: 8/menit, 800/hari).
const FX_TTL = { "1min": 50, "5min": 50, "15min": 50, "1h": 50, "4h": 120, "1day": 300 }; // detik; browser memeriksa tiap 60 dtk
const fxCache = new Map(); // best-effort: hidup selama isolate Worker masih aktif
const FX_HINTS = {
  400: "Simbol atau parameter ditolak Twelve Data.",
  401: "TWELVEDATA_KEY salah atau belum aktif. Cek key di dashboard twelvedata.com.",
  403: "Paket Twelve Data-mu kemungkinan belum mencakup simbol ini (XAU/USD). Cek paket di twelvedata.com/pricing.",
  404: "Data tidak ditemukan untuk simbol ini.",
  429: "Kuota Twelve Data habis (paket gratis: 8 permintaan per menit, 800 per hari). Tunggu sebentar lalu coba lagi.",
};
async function forex(request, env, rid) {
  guestCap(await requireAuth(request, env, rid), "forex");
  need(env, ["TWELVEDATA_KEY"]);
  const q = new URL(request.url).searchParams;
  const symbol = q.get("symbol") || "XAU/USD", interval = q.get("interval") || "5min";
  if (!FX_SYMBOLS.includes(symbol)) throw new AppError(400, "bad_request", "client", "Simbol tidak didukung: " + symbol, "Yang diizinkan: " + FX_SYMBOLS.join(", "));
  if (!FX_TTL[interval]) throw new AppError(400, "bad_request", "client", "Interval tidak didukung: " + interval, "Yang diizinkan: " + Object.keys(FX_TTL).join(", "));
  const key = symbol + "|" + interval, now = Date.now(), hit = fxCache.get(key);
  if (hit && now - hit.t < FX_TTL[interval] * 1000) return json({ ...hit.data, cached: true, age: Math.round((now - hit.t) / 1000) });

  // Kalau Twelve Data gagal tapi ada data lama (maks 15 menit), tampilkan data lama daripada layar kosong.
  const fail = (err) => {
    if (hit && now - hit.t < 15 * 60e3) {
      log("warn", rid, "forex_stale", { code: err.code, msg: err.message });
      return json({ ...hit.data, cached: true, stale: true, age: Math.round((now - hit.t) / 1000), note: err.message });
    }
    throw err;
  };

  const u = new URL("https://api.twelvedata.com/time_series");
  u.search = new URLSearchParams({ symbol, interval, outputsize: "100", timezone: "Asia/Jakarta", apikey: env.TWELVEDATA_KEY }).toString();
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 15000);
  const t0 = Date.now();
  let res, j;
  try {
    res = await fetch(u, { signal: ctl.signal });
    j = await res.json().catch(() => null);
  } catch (e) {
    const timeout = e && e.name === "AbortError";
    log("error", rid, "upstream_fail", { label: "forex", host: "api.twelvedata.com", timeout, msg: String((e && e.message) || e) });
    return fail(new AppError(timeout ? 504 : 502, timeout ? "upstream_timeout" : "upstream_unreachable", "upstream",
      timeout ? "Twelve Data tidak menjawab dalam 15 detik." : "Worker tidak bisa menghubungi Twelve Data.", "Coba lagi sebentar lagi."));
  } finally { clearTimeout(timer); }
  log(res.ok ? "info" : "warn", rid, "upstream", { label: "forex", host: "api.twelvedata.com", status: res.status, ms: Date.now() - t0 });

  const code = Number((j && j.code) || (!res.ok && res.status) || 0);
  if ((j && j.status === "error") || !res.ok || !j || !Array.isArray(j.values)) {
    const msg = String((j && j.message) || res.statusText || "balasan tidak dikenali").replace(/\s+/g, " ").replace(/apikey=[^&\s]+/gi, "apikey=***").slice(0, 300);
    const hint = FX_HINTS[code] || (code >= 500 ? "Twelve Data sedang bermasalah. Coba lagi nanti." : "Lihat pesan dari Twelve Data.");
    log("error", rid, "upstream_error", { label: "forex", status: code || res.status, detail: msg });
    return fail(new AppError(502, "upstream_error", "upstream", `Twelve Data menjawab ${code || res.status}: ${msg}`, hint, { upstream_status: code || res.status }));
  }

  const values = j.values
    .map(v => ({ t: String(v.datetime), o: +v.open, h: +v.high, l: +v.low, c: +v.close }))
    .filter(v => [v.o, v.h, v.l, v.c].every(Number.isFinite))
    .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  if (!values.length) return fail(new AppError(502, "upstream_bad_format", "upstream", "Twelve Data tidak mengirim candle.", "Pasar mungkin tutup atau simbol belum tersedia di paketmu."));
  const left = res.headers.get("api-credits-left"), used = res.headers.get("api-credits-used");
  const data = { ok: true, symbol, interval, tz: "Asia/Jakarta", values, credits: { left: left == null ? null : Number(left), used: used == null ? null : Number(used) } };
  fxCache.set(key, { t: now, data });
  return json({ ...data, cached: false, age: 0 });
}

// Pemeriksaan satu per satu: Secret, KV, origin, dan koneksi ke provider.
async function diag(request, env, rid) {
  await requireAuth(request, env, rid, true);
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
  add("TWELVEDATA_KEY", !!env.TWELVEDATA_KEY, env.TWELVEDATA_KEY ? "terisi (grafik XAU/USD)" : "belum diisi (menu Grafik XAU/USD tidak akan jalan)");
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

// ===== Penalaran panjang (analisa AI) =====
// Parameter penalaran dikirim bertahap: kalau provider menolak (HTTP 400/422), dicoba lagi dengan parameter lebih sederhana, lalu tanpa parameter.
// Bisa diganti lewat Secret REASONING_HIGH / REASONING_MAX berisi JSON, contoh: {"reasoning":{"effort":"high"},"max_tokens":64000}
function reasoningTries(env, depth) {
  if (depth !== "high" && depth !== "max") return [];
  const raw = depth === "max" ? env.REASONING_MAX : env.REASONING_HIGH;
  if (raw) {
    try { const o = JSON.parse(raw); if (o && typeof o === "object" && !Array.isArray(o)) return [o]; } catch {}
    log("warn", "-", "reasoning_env_invalid", { depth });
  }
  const host = new URL(env.API_URL).host;
  if (host.includes("openrouter.ai"))
    return depth === "max" ? [{ reasoning: { effort: "high" }, max_tokens: 64000 }, { reasoning: { effort: "high" } }] : [{ reasoning: { effort: "high" } }];
  return [{ reasoning_effort: "high" }];
}
// Respons dikembalikan langsung (SSE) dan dijaga tetap hidup dengan ": ping" selama AI berpikir, tanpa batas 60 detik.
function longChat(env, rid, ctx, body, model, extras) {
  const { readable, writable } = new TransformStream(), w = writable.getWriter(), enc = new TextEncoder();
  let boundary = true; // ping hanya disisipkan di antara event SSE, tidak di tengah event
  const raw = s => w.write(enc.encode(s)).catch(() => {});
  const ev = o => raw("data: " + JSON.stringify(o) + "\n\n");
  const job = (async () => {
    const ping = setInterval(() => { if (boundary) raw(": ping\n\n"); }, 8000);
    const t0 = Date.now(), host = new URL(env.API_URL).host;
    try {
      raw(": start\n\n");
      const tries = [...extras, {}];
      let res = null, used = -1;
      for (let i = 0; i < tries.length; i++) {
        const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 20 * 60e3);
        try {
          res = await fetch(env.API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.API_KEY },
            body: JSON.stringify({ ...body, model, ...tries[i] }),
            signal: ctl.signal,
          });
        } finally { clearTimeout(timer); }
        log(res.ok ? "info" : "warn", rid, "upstream", { label: "chat-long", host, status: res.status, ms: Date.now() - t0, attempt: i });
        if (res.ok) { used = i; break; }
        if ((res.status === 400 || res.status === 422) && i < tries.length - 1) continue;
        break;
      }
      if (!res.ok) {
        const e = await upstreamError(res, rid, "chat");
        ev({ error: { message: e.message, code: e.code, hint: e.hint } });
        return;
      }
      ev({ meta: { think: used < extras.length ? "param" : "none", attempt: used } });
      if ((res.headers.get("content-type") || "").includes("event-stream")) {
        const rd = res.body.getReader();
        for (;;) {
          const { done, value } = await rd.read();
          if (done) break;
          try { await w.write(value); } catch { await rd.cancel().catch(() => {}); break; }
          const n = value.length;
          boundary = n > 1 && value[n - 1] === 10 && (value[n - 2] === 10 || (value[n - 2] === 13 && n > 2 && value[n - 3] === 10));
        }
      } else {
        const j = await res.json().catch(() => null);
        ev({ choices: [{ delta: { content: (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "" } }] });
        raw("data: [DONE]\n\n");
      }
    } catch (e) {
      const timeout = e && e.name === "AbortError";
      log("error", rid, "upstream_fail", { label: "chat-long", host, timeout, msg: String((e && e.message) || e) });
      ev({ error: { message: timeout ? "Provider API tidak menjawab dalam 20 menit." : "Worker tidak bisa menghubungi provider API.", code: timeout ? "upstream_timeout" : "upstream_unreachable", hint: "Coba lagi atau turunkan kedalaman berpikir." } });
    } finally { clearInterval(ping); w.close().catch(() => {}); }
  })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(job);
  return new Response(readable, { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}
async function chat(request, env, rid, ctx) {
  const au = await requireAuth(request, env, rid);
  guestCap(au, "chat");
  need(env, ["API_URL", "API_KEY"]);
  checkApiUrl(env);
  let body;
  try { body = await request.json(); }
  catch { throw new AppError(400, "bad_request", "client", "Isi permintaan bukan JSON yang valid."); }
  if (!body || !Array.isArray(body.messages) || !body.messages.length) throw new AppError(400, "bad_request", "client", "Field 'messages' kosong atau bukan array.");
  const model = body.model || env.MODEL;
  if (!model) throw new AppError(500, "config_missing", "config", "MODEL belum diisi.", "Isi Secret MODEL atau pilih model di sidebar.", { missing: ["MODEL"] });
  const long = body.longThink === true && body.stream === true;
  const depth = au.role === "guest" ? "std" : String(body.depth || "std"); // tamu selalu standar, supaya kuota pemilik aman
  delete body.longThink; delete body.depth;
  log("info", rid, "chat", { model, msgs: body.messages.length, stream: !!body.stream, chars: JSON.stringify(body.messages).length, long, depth });
  if (long) return longChat(env, rid, ctx, body, model, reasoningTries(env, depth));
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
  async fetch(request, env, ctx) {
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
      else if (p === "/api/session" && m === "GET") res = await session(request, env, rid);
      else if (p === "/api/chat" && m === "POST") res = await chat(request, env, rid, ctx);
      else if (p === "/api/chats" && (m === "GET" || m === "PUT")) res = await chats(request, env, rid);
      else if (p === "/api/models" && m === "GET") res = await models(request, env, rid);
      else if (p === "/api/forex" && m === "GET") res = await forex(request, env, rid);
      else if (p === "/api/admin/codes" && (m === "GET" || m === "POST")) res = await adminCodes(request, env, rid);
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
