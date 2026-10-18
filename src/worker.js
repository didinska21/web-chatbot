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
  402: "Saldo atau kredit akun di provider habis (atau paketmu tidak mencakup model ini). Top up di dashboard provider, atau pilih model lain yang lebih murah.",
  404: "API_URL salah (path harus berakhir /chat/completions) atau MODEL tidak ada.",
  429: "Kuota atau rate limit provider habis. Tunggu sebentar atau ganti API key.",
};
async function upstreamError(res, rid, label, note = "") {
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
  return new AppError(502, "upstream_error", "upstream", `Provider API menjawab ${res.status}: ${detail || res.statusText}`, hint + (note ? " " + note : ""), { upstream_status: res.status });
}
// ===== Banyak API key =====
// Isi Secret API_KEY dengan beberapa key dipisah koma. Variabel tambahan API_KEY_2, API_KEY_3, dan seterusnya juga dibaca
// (satu variabel dibatasi sekitar 5 KB oleh Cloudflare, jadi daftar yang panjang dibagi ke beberapa variabel).
// Key yang saldonya habis (402) atau ditolak (401/403) dilewati otomatis; yang kena rate limit (429) diistirahatkan 1 menit.
function apiKeys(env) {
  const names = Object.keys(env).filter(k => /^API_KEY(_\d+)?$/.test(k)).sort((a, b) => (parseInt(a.slice(8)) || 1) - (parseInt(b.slice(8)) || 1));
  const seen = new Set(), out = [];
  for (const n of names) for (const raw of String(env[n] || "").split(/[,\s]+/)) { const k = raw.trim(); if (k && !seen.has(k)) { seen.add(k); out.push(k); } }
  return out;
}
function needKeys(env) {
  if (!apiKeys(env).length) throw new AppError(500, "config_missing", "config", "API_KEY belum diisi.", "Isi Secret API_KEY. Boleh beberapa key dipisah koma.", { missing: ["API_KEY"] });
}
const keyMem = { ids: new Map(), dead: null, deadT: 0, cool: new Map() };
async function keyId(k) {
  let h = keyMem.ids.get(k);
  if (!h) { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(k)); h = [...new Uint8Array(d)].slice(0, 6).map(x => x.toString(16).padStart(2, "0")).join(""); keyMem.ids.set(k, h); }
  return h; // hanya sidik jari yang disimpan dan dicatat, bukan key-nya
}
async function deadMap(env, fresh) {
  if (!env.CHATS) return keyMem.dead || {};
  if (!fresh && keyMem.dead && Date.now() - keyMem.deadT < 30000) return keyMem.dead;
  const d = (await env.CHATS.get("keys:dead", "json")) || {}, now = Date.now();
  for (const k of Object.keys(d)) if (!(d[k].until > now)) delete d[k];
  keyMem.dead = d; keyMem.deadT = now;
  return d;
}
async function saveDead(env, d) {
  keyMem.dead = d; keyMem.deadT = Date.now();
  if (env.CHATS) await env.CHATS.put("keys:dead", JSON.stringify(d), { expirationTtl: 86400 + 3600 });
}
async function markDead(env, key, status) {
  const d = { ...(await deadMap(env, true)) };
  d[await keyId(key)] = { until: Date.now() + (status === 402 ? 6 : 24) * 3600e3, why: status };
  await saveDead(env, d);
}
async function unmarkDead(env, id) { const d = { ...(await deadMap(env, true)) }; delete d[id]; await saveDead(env, d); }
async function keyStatus(env) {
  const keys = apiKeys(env), dead = await deadMap(env), now = Date.now();
  let alive = 0, saldo = 0, ditolak = 0, cooling = 0;
  for (const k of keys) {
    const id = await keyId(k), d = dead[id], c = keyMem.cool.get(id);
    if (d) { if (d.why === 402) saldo++; else ditolak++; } else if (c && c > now) cooling++; else alive++;
  }
  return { total: keys.length, alive, saldo, ditolak, cooling };
}
// Mencoba key satu per satu sampai ada yang berhasil. 400/404/422 bukan salah key, jadi langsung dikembalikan.
async function withKeys(env, rid, label, fn) {
  const keys = apiKeys(env), dead = await deadMap(env), now = Date.now(), alive = [];
  for (const k of keys) { const id = await keyId(k), c = keyMem.cool.get(id); if (!dead[id] && !(c && c > now)) alive.push(k); }
  const cand = (alive.length ? alive : keys.slice(0, 3)).slice(0, 12), tally = { saldo: 0, ditolak: 0, limit: 0, error: 0 };
  const done = extra => ({ tried, total: keys.length, alive: alive.length, tally, ...extra });
  let last = null, tried = 0;
  for (const key of cand) {
    tried++;
    let res;
    try { res = await fn(key); }
    catch (e) { tally.error++; last = { err: e }; if (tried >= 3) break; continue; }
    if (res.ok) { const id = await keyId(key); if (dead[id]) await unmarkDead(env, id); return done({ res }); }
    const st = res.status;
    if (st === 402 || st === 401 || st === 403) {
      await markDead(env, key, st); tally[st === 402 ? "saldo" : "ditolak"]++;
      log("warn", rid, "key_dead", { label, status: st, id: await keyId(key), tried });
      if (last && last.res) await last.res.body?.cancel().catch(() => {});
      last = { res }; continue;
    }
    if (st === 429) { keyMem.cool.set(await keyId(key), Date.now() + 60e3); tally.limit++; if (last && last.res) await last.res.body?.cancel().catch(() => {}); last = { res }; continue; }
    if (st >= 500) { tally.error++; if (last && last.res) await last.res.body?.cancel().catch(() => {}); last = { res }; if (tried >= 3) break; continue; }
    return done({ res });
  }
  if (!last || last.err) throw (last && last.err) || new AppError(502, "upstream_unreachable", "upstream", "Tidak ada API key yang bisa dipakai.", "Isi atau tambah Secret API_KEY.");
  return done({ res: last.res, failed: true });
}
function keyNote(r) {
  if (!(r.failed || r.tried > 1)) return "";
  const t = r.tally, parts = [t.saldo && `${t.saldo} saldo habis`, t.ditolak && `${t.ditolak} ditolak`, t.limit && `${t.limit} kena rate limit`, t.error && `${t.error} error`].filter(Boolean).join(", ");
  return `${r.tried} dari ${r.total} API key dicoba${parts ? " (" + parts + ")" : ""}.${r.failed ? " Top up saldo atau tambahkan key baru di Secret API_KEY." : ""}`;
}
// Satu permintaan ke provider tanpa melempar error untuk status non-2xx (kecuali jaringan/timeout).
async function rawUpstream(rid, url, init, label, ms = 60000) {
  const host = new URL(url).host, ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), ms), t0 = Date.now();
  let res;
  try { res = await fetch(url, { ...init, signal: ctl.signal }); }
  catch (e) {
    const timeout = e && e.name === "AbortError";
    log("error", rid, "upstream_fail", { label, host, timeout, msg: String((e && e.message) || e) });
    throw new AppError(timeout ? 504 : 502, timeout ? "upstream_timeout" : "upstream_unreachable", "upstream",
      timeout ? "Provider API tidak menjawab dalam " + Math.round(ms / 1000) + " detik." : "Worker tidak bisa menghubungi provider API.",
      "Cek ejaan API_URL dan apakah provider sedang down.");
  } finally { clearTimeout(timer); }
  log(res.ok ? "info" : "warn", rid, "upstream", { label, host, status: res.status, ms: Date.now() - t0 });
  return res;
}
async function callUpstreamK(env, rid, url, mkInit, label) {
  const r = await withKeys(env, rid, label, key => rawUpstream(rid, url, mkInit(key), label, 60000));
  if (!r.res.ok) throw await upstreamError(r.res, rid, label, keyNote(r));
  return r.res;
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
  need(env, ["API_URL"]); needKeys(env);
  const res = await callUpstreamK(env, rid, upstreamUrl(env, "models"), key => ({ headers: { Authorization: "Bearer " + key } }), "models");
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
  const q = new URL(request.url).searchParams;
  return json(await tdSeries(env, rid, q.get("symbol") || "XAU/USD", q.get("interval") || "5min"));
}
// Inti pengambilan candle (dipakai halaman, Cron, dan bot Telegram), dengan cache singkat di memori Worker.
async function tdSeries(env, rid, symbol, interval) {
  need(env, ["TWELVEDATA_KEY"]);
  if (!FX_SYMBOLS.includes(symbol)) throw new AppError(400, "bad_request", "client", "Simbol tidak didukung: " + symbol, "Yang diizinkan: " + FX_SYMBOLS.join(", "));
  if (!FX_TTL[interval]) throw new AppError(400, "bad_request", "client", "Interval tidak didukung: " + interval, "Yang diizinkan: " + Object.keys(FX_TTL).join(", "));
  const key = symbol + "|" + interval, now = Date.now(), hit = fxCache.get(key);
  if (hit && now - hit.t < FX_TTL[interval] * 1000) return { ...hit.data, cached: true, age: Math.round((now - hit.t) / 1000) };

  // Kalau Twelve Data gagal tapi ada data lama (maks 15 menit), tampilkan data lama daripada layar kosong.
  const fail = (err) => {
    if (hit && now - hit.t < 15 * 60e3) {
      log("warn", rid, "forex_stale", { code: err.code, msg: err.message });
      return { ...hit.data, cached: true, stale: true, age: Math.round((now - hit.t) / 1000), note: err.message };
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
  return { ...data, cached: false, age: 0 };
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
  const ks = await keyStatus(env), k0 = apiKeys(env)[0] || "";
  add("API_KEY", ks.total > 0, ks.total ? (ks.total > 1 ? `${ks.total} key (${ks.alive} aktif, ${ks.saldo} saldo habis, ${ks.ditolak} ditolak, ${ks.cooling} istirahat)` : "terisi") + ", awalan " + (k0.includes("_") ? k0.split("_")[0] + "_" : k0.slice(0, 3) + "…") : "belum diisi");
  add("MODEL", true, env.MODEL || "(kosong, model dipilih dari sidebar)");
  add("TELEGRAM_BOT_TOKEN", true, env.TELEGRAM_BOT_TOKEN ? "terisi (notifikasi Telegram)" : "belum diisi (opsional, untuk notifikasi Telegram)");
  add("TWELVEDATA_KEY", !!env.TWELVEDATA_KEY, env.TWELVEDATA_KEY ? "terisi (grafik XAU/USD)" : "belum diisi (menu Grafik XAU/USD tidak akan jalan)");
  if (!env.CHATS) add("KV CHATS", false, "belum terpasang, deploy ulang Worker");
  else { try { await env.CHATS.get("chats"); add("KV CHATS", true, "bisa dibaca"); } catch (e) { add("KV CHATS", false, String(e.message || e)); } }
  const reqOrigin = request.headers.get("Origin") || "";
  add("ALLOWED_ORIGINS", !!allowedOrigin(request, env), (reqOrigin ? reqOrigin + " → " : "") + originList(env).join(", "));
  if (urlOk && ks.total) {
    const t0 = Date.now();
    try {
      const res = await callUpstreamK(env, rid, upstreamUrl(env, "models"), key => ({ headers: { Authorization: "Bearer " + key } }), "diag-models");
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
      let kr = null;
      for (let i = 0; i < tries.length; i++) {
        kr = await withKeys(env, rid, "chat-long", async key => {
          const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 20 * 60e3);
          try {
            return await fetch(env.API_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
              body: JSON.stringify({ ...body, model, ...tries[i] }),
              signal: ctl.signal,
            });
          } finally { clearTimeout(timer); }
        });
        res = kr.res;
        log(res.ok ? "info" : "warn", rid, "upstream", { label: "chat-long", host, status: res.status, ms: Date.now() - t0, attempt: i, keysTried: kr.tried });
        if (res.ok) { used = i; break; }
        if ((res.status === 400 || res.status === 422) && i < tries.length - 1) continue;
        break;
      }
      if (!res.ok) {
        const e = await upstreamError(res, rid, "chat", keyNote(kr));
        ev({ error: { message: e.message, code: e.code, hint: e.hint } });
        return;
      }
      ev({ meta: { think: used < extras.length ? "param" : "none", attempt: used, model, key: kr.tried, keys: kr.total } });
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
  need(env, ["API_URL"]); needKeys(env);
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
  const res = await callUpstreamK(env, rid, env.API_URL, key => ({
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify({ ...body, model }),
  }), "chat");
  return new Response(res.body, {
    status: 200,
    headers: { "Content-Type": res.headers.get("Content-Type") || "application/json", "Cache-Control": "no-store" },
  });
}

// ===== Sinyal: penyimpanan, penilaian di server (Cron), alert harga, dan notifikasi Telegram =====
const FINE = { scalp: "5min", intra: "15min", swing: "1h" };
const HOR = { scalp: 3, intra: 12, swing: 48 }; // jam jangka penilaian
const STYLE_NM = { scalp: "Scalping", intra: "Intraday", swing: "Swing" };
const SIG_MAX = 300;
const ZONES = { ET: "America/New_York", CET: "Europe/Berlin", UK: "Europe/London", JST: "Asia/Tokyo" };
const NEWS_EV = [
  ["2026-10-07", "14:00", "ET", "Risalah rapat FOMC (rapat September)"],
  ["2026-10-14", "08:30", "ET", "CPI AS (inflasi September)"],
  ["2026-10-28", "14:00", "ET", "FOMC: keputusan suku bunga"],
  ["2026-10-29", "08:30", "ET", "PDB AS kuartal III (estimasi awal)"],
  ["2026-10-29", "08:30", "ET", "Core PCE AS (September)"],
  ["2026-10-29", "14:15", "CET", "ECB: keputusan suku bunga"],
  ["2026-10-30", "12:00", "JST", "BoJ: keputusan suku bunga + Outlook Report"],
  ["2026-11-05", "12:00", "UK", "BoE: keputusan suku bunga + Monetary Policy Report"],
  ["2026-11-06", "08:30", "ET", "NFP (Non-Farm Payrolls) Oktober"],
  ["2026-11-10", "08:30", "ET", "CPI AS (inflasi Oktober)"],
  ["2026-11-18", "14:00", "ET", "Risalah rapat FOMC (rapat Oktober)"],
  ["2026-11-25", "08:30", "ET", "Core PCE AS (Oktober)"],
  ["2026-12-04", "08:30", "ET", "NFP (Non-Farm Payrolls) November"],
  ["2026-12-09", "14:00", "ET", "FOMC: keputusan suku bunga + proyeksi (SEP)"],
  ["2026-12-10", "08:30", "ET", "CPI AS (inflasi November)"],
  ["2026-12-17", "14:15", "CET", "ECB: keputusan suku bunga"],
  ["2026-12-17", "12:00", "UK", "BoE: keputusan suku bunga"],
  ["2026-12-18", "12:00", "JST", "BoJ: keputusan suku bunga"],
  ["2026-12-23", "08:30", "ET", "Core PCE AS (November)"],
  ["2026-12-30", "14:00", "ET", "Risalah rapat FOMC (rapat Desember)"]
];

const MON = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const p2 = n => String(n).padStart(2, "0");
const P = s => { const m = /^(\d{4})-(\d\d)-(\d\d)(?:[ T](\d\d):(\d\d))?/.exec(s); return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) : NaN; };
const wibNow = () => Date.now() + 7 * 36e5; // "waktu dinding WIB" sebagai milidetik, sama dengan jam di candle
const numOf = x => { const n = typeof x === "number" ? x : parseFloat(String(x).replace(/,/g, "")); return Number.isFinite(n) ? n : null; };
const fmt = (x, d = 2) => Number(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const H = s => String(s ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const strOf = (x, n) => (typeof x === "string" ? x.slice(0, n) : null);
const wibStr = w => { const d = new Date(w); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} WIB`; };
const rTxt = x => (x && x.r != null ? (x.r >= 0 ? "+" : "−") + Math.abs(x.r).toFixed(1) + "R" : "-");

function zWall(u, z) {
  const o = {};
  new Intl.DateTimeFormat("en-GB", { timeZone: z, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(u)).forEach(x => (o[x.type] = x.value));
  return Date.UTC(+o.year, o.month - 1, +o.day, +o.hour, +o.minute);
}
function zUtc(d, t, z) {
  const [y, m, dd] = d.split("-").map(Number), [h, mi] = t.split(":").map(Number), want = Date.UTC(y, m - 1, dd, h, mi);
  let u = want;
  for (let i = 0; i < 3; i++) u += want - zWall(u, z);
  return u;
}
// Pasar emas tutup Jumat 17:00 ET sampai Minggu 18:00 ET (libur khusus tidak dihitung)
function marketOpen(u = Date.now()) {
  const x = new Date(zWall(u, "America/New_York")), dow = x.getUTCDay(), m = x.getUTCHours() * 60 + x.getUTCMinutes();
  return !(dow === 6 || (dow === 5 && m >= 1020) || (dow === 0 && m < 1080));
}

// ---------- penilaian ----------
function candleStep(v) {
  let m = Infinity;
  for (let i = 1; i < Math.min(v.length, 7); i++) m = Math.min(m, P(v[i].t) - P(v[i - 1].t));
  return Number.isFinite(m) && m > 0 ? m : 36e5;
}
// mode "ideal": masuk di harga saat analisa tanpa biaya. mode "real": masuk di open candle berikutnya + spread (candle dianggap harga bid:
// BUY masuk di ask = open + spread, SELL keluar di ask). Jika SL dan TP di satu candle, dihitung SL (pesimis).
function judgeTrade(S, ts, hor, atr, v, mode, spread, wall) {
  const end = ts + hor * 36e5;
  if (!v.length || P(v[0].t) > ts + candleStep(v)) return { s: "nodata" };
  const buy = S.type === "BUY", real = mode === "real", idx = v.findIndex(c => P(c.t) > ts);
  if (idx < 0 || P(v[idx].t) >= end) return wall >= end ? { s: "expired", r: 0 } : { s: "pending" };
  const c0 = v[idx], entry = real ? (buy ? c0.o + spread : c0.o) : S.entry, risk = buy ? entry - S.sl : S.sl - entry, a = atr || entry * 0.002;
  if (!(risk > 1e-9)) return { s: "skip", e: entry };
  if (real && (!(risk >= a * 0.2) || !(buy ? S.tp1 > entry : S.tp1 < entry))) return { s: "skip", e: entry };
  let last = null;
  for (let i = idx; i < v.length; i++) {
    const c = v[i], t = P(c.t);
    if (t >= end) break;
    last = c;
    const sp = real && !buy ? spread : 0;
    const slHit = buy ? c.l <= S.sl : c.h + sp >= S.sl, tpHit = buy ? c.h >= S.tp1 : c.l + sp <= S.tp1;
    if (slHit) {
      let r = -1;
      if (real) { const px = buy ? Math.min(c.o, S.sl) : Math.max(c.o + spread, S.sl); r = (buy ? px - entry : entry - px) / risk; }
      return { s: "loss", r, at: t, e: entry };
    }
    if (tpHit) return { s: "win", r: (buy ? S.tp1 - entry : entry - S.tp1) / risk, at: t, e: entry };
  }
  if (wall >= end) { const lc = last ? last.c + (real && !buy ? spread : 0) : entry; return { s: "expired", r: (buy ? lc - entry : entry - lc) / risk, e: entry }; }
  return { s: "pending", e: entry };
}
// WAIT dinilai dari pemicu: menembus pemicu BUY/SELL (atau 1 ATR bila tidak ada) sebelum jangka habis = terlewat, jika tidak = tepat
function judgeWait(r, v, wall) {
  const end = r.ts + r.hor * 36e5, a = r.atr || r.price * 0.002;
  if (!v.length || P(v[0].t) > r.ts + candleStep(v)) return { s: "nodata" };
  const B = r.trg && r.trg.buy != null ? r.trg.buy : r.price + a, S = r.trg && r.trg.sell != null ? r.trg.sell : r.price - a;
  for (const c of v) { const t = P(c.t); if (!(t > r.ts && t < end)) continue; if (c.h >= B || c.l <= S) return { s: "wmiss", at: t }; }
  return wall >= end ? { s: "wok" } : { s: "pending" };
}
const fin = o => !!o && o.s !== "pending";
async function evalRecord(rec, getS, spread, wall) {
  const before = JSON.stringify([rec.ev, rec.bv, rec.status, rec.done]), fine = FINE[rec.style] || "1h";
  const run = async fn => {
    const j = await getS(fine); let o = j ? fn(j.values) : null;
    if ((!o || o.s === "nodata") && fine !== "1h") { const j2 = await getS("1h"); if (j2) o = fn(j2.values); }
    return o;
  };
  rec.ev = rec.ev || {};
  if (rec.sig) {
    const oi = await run(v => judgeTrade(rec.sig, rec.ts, rec.hor, rec.atr, v, "ideal", spread, wall)), or = await run(v => judgeTrade(rec.sig, rec.ts, rec.hor, rec.atr, v, "real", spread, wall));
    if (oi) rec.ev.i = oi; if (or) rec.ev.r = or;
  } else if (rec.wait) {
    const o = await run(v => judgeWait(rec, v, wall));
    if (o) { rec.ev.i = o; rec.ev.r = o; }
  }
  if (rec.base && rec.base.type) {
    const bi = await run(v => judgeTrade(rec.base, rec.ts, rec.hor, rec.atr, v, "ideal", spread, wall)), br = await run(v => judgeTrade(rec.base, rec.ts, rec.hor, rec.atr, v, "real", spread, wall));
    rec.bv = { i: bi || (rec.bv && rec.bv.i) || null, r: br || (rec.bv && rec.bv.r) || null };
  }
  const mainDone = rec.sig || rec.wait ? fin(rec.ev.r) && fin(rec.ev.i) : true, baseDone = rec.base && rec.base.type ? !!rec.bv && fin(rec.bv.r) && fin(rec.bv.i) : true;
  rec.done = mainDone && baseDone;
  rec.status = (rec.ev.r && rec.ev.r.s) || rec.status || "pending";
  return JSON.stringify([rec.ev, rec.bv, rec.status, rec.done]) !== before;
}

// ---------- rekaman ----------
const r3 = x => (x == null ? null : +Number(x).toFixed(3));
function metaOf(r) {
  const ev = r.ev || {}, bv = r.bv || {};
  return {
    i: r.id, ts: r.ts, st: r.style, sn: r.sens || "seimbang", cf: r.conf || null, g: r.sig ? (r.sig.type === "BUY" ? "B" : "S") : r.wait ? "W" : "-", d: r.done ? 1 : 0,
    s: (ev.r && ev.r.s) || r.status || "pending", r: r3(ev.r && ev.r.r), si: (ev.i && ev.i.s) || null, ri: r3(ev.i && ev.i.r),
    m: r.model ? String(r.model).slice(0, 40) : null, pv: r.pv || null, dp: r.depth || null, ss: r.ss || "", ne: r.ne == null ? null : r.ne, tf: r.tf, hor: r.hor, pr: r.price,
    b: r.base && r.base.type ? r.base.type[0] : null, bs: (bv.r && bv.r.s) || null, bsi: (bv.i && bv.i.s) || null, br: r3(bv.r && bv.r.r), bri: r3(bv.i && bv.i.r),
  };
}
const putRec = (env, rec) => env.CHATS.put("sig:" + rec.id, JSON.stringify(rec), { metadata: metaOf(rec) });
function cleanTrade(t, price) {
  if (!t || (t.type !== "BUY" && t.type !== "SELL")) return null;
  const entry = numOf(t.entry) ?? price, sl = numOf(t.sl), tp1 = numOf(t.tp1), buy = t.type === "BUY";
  if (sl == null || tp1 == null || (buy ? !(sl < entry && tp1 > entry) : !(sl > entry && tp1 < entry))) return null;
  const tp2 = numOf(t.tp2);
  return { type: t.type, entry, sl, tp1, tp2: tp2 != null && (buy ? tp2 > tp1 : tp2 < tp1) ? tp2 : null };
}
function cleanRec(b, wall) {
  b = b || {};
  const price = numOf(b.price);
  if (price == null || price < 100) throw new AppError(400, "bad_request", "client", "Harga analisa tidak valid.");
  const near = x => { const n = numOf(x); return n != null && Math.abs(n - price) < price * 0.2 ? n : null; };
  const arr = (a, k = 3) => (Array.isArray(a) ? a : []).map(near).filter(x => x != null).slice(0, k);
  const style = ["scalp", "intra", "swing"].includes(b.style) ? b.style : "intra", sig = cleanTrade(b.sig, price), wait = !!b.wait && !sig;
  const tb = near(b.trg && b.trg.buy), ts = near(b.trg && b.trg.sell);
  return {
    id: wall.toString(36) + Math.random().toString(36).slice(2, 6), ts: wall, tf: strOf(b.tf, 8), tfLabel: strOf(b.tfLabel, 12), style,
    sens: ["kons", "seimbang", "agresif"].includes(b.sens) ? b.sens : "seimbang", depth: ["std", "high", "max"].includes(b.depth) ? b.depth : null,
    model: strOf(b.model, 60), pv: strOf(b.pv, 12), price, atr: numOf(b.atr), bias: ["naik", "turun", "netral"].includes(b.bias) ? b.bias : "netral",
    conf: ["rendah", "sedang", "tinggi"].includes(b.conf) ? b.conf : null, sig, wait, waitWhy: strOf(b.waitWhy, 160), trg: tb != null || ts != null ? { buy: tb, sell: ts } : null,
    inv: near(b.inv), sup: arr(b.sup), res: arr(b.res), tn: arr(b.tn, 2), tt: arr(b.tt, 2), hor: HOR[style], ss: strOf(b.ss, 3) || "",
    ne: Number.isFinite(+b.ne) ? Math.round(+b.ne) : null, base: cleanTrade(b.base, price),
    text: strOf(b.text, 6000) || "", ctx: strOf(b.ctx, 7000) || "", meta: strOf(b.meta, 400) || "",
    align: (Array.isArray(b.align) ? b.align : []).slice(0, 8).map(x => ({ nm: strOf(x && x.nm, 10), b: strOf(x && x.b, 10) })),
    status: sig || wait ? "pending" : "na", done: !(sig || wait) && !(cleanTrade(b.base, price)), ev: {}, bv: null,
  };
}
async function listSigs(env) {
  const out = []; let cursor;
  for (let i = 0; i < 3; i++) {
    const l = await env.CHATS.list({ prefix: "sig:", limit: 1000, cursor });
    for (const k of l.keys) if (k.metadata) out.push({ key: k.name, ...k.metadata });
    if (l.list_complete !== false) break;
    cursor = l.cursor;
  }
  return out.sort((a, b) => b.ts - a.ts);
}

// ---------- pengaturan ----------
const CFG0 = { chatId: null, spread: 0.35, newsMin: 30, sum: "daily", n: { sig: true, res: true, alert: true, news: true, wait: true }, quiet: { on: true, from: "23:00", to: "06:00" } };
async function getCfg(env) {
  const c = (env.CHATS && (await env.CHATS.get("cfg", "json"))) || {};
  return { ...CFG0, ...c, n: { ...CFG0.n, ...(c.n || {}) }, quiet: { ...CFG0.quiet, ...(c.quiet || {}) } };
}
const putCfg = (env, c) => env.CHATS.put("cfg", JSON.stringify(c));
const hm2min = s => { const m = /^(\d\d):(\d\d)$/.exec(s || ""); return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : null; };
function inQuiet(cfg, wall) {
  if (!cfg.quiet.on) return false;
  const f = hm2min(cfg.quiet.from), t = hm2min(cfg.quiet.to);
  if (f == null || t == null) return false;
  const d = new Date(wall), m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return f < t ? m >= f && m < t : m >= f || m < t;
}
function cleanCfg(cur, b) {
  const c = { ...cur, n: { ...cur.n }, quiet: { ...cur.quiet } };
  b = b || {};
  if (b.spread !== undefined) { const x = numOf(b.spread); if (x == null || x < 0 || x > 5) throw new AppError(400, "bad_request", "client", "Spread harus angka 0 sampai 5 (USD)."); c.spread = x; }
  if (b.newsMin !== undefined) { if (![10, 15, 30, 60].includes(+b.newsMin)) throw new AppError(400, "bad_request", "client", "Pengingat news: 10, 15, 30, atau 60 menit."); c.newsMin = +b.newsMin; }
  if (b.sum !== undefined) { if (!["off", "daily", "weekly"].includes(b.sum)) throw new AppError(400, "bad_request", "client", "Ringkasan: off, daily, atau weekly."); c.sum = b.sum; }
  if (b.n) for (const k of Object.keys(CFG0.n)) if (typeof b.n[k] === "boolean") c.n[k] = b.n[k];
  if (b.quiet) {
    if (typeof b.quiet.on === "boolean") c.quiet.on = b.quiet.on;
    for (const k of ["from", "to"]) if (b.quiet[k] !== undefined) { if (hm2min(b.quiet[k]) == null) throw new AppError(400, "bad_request", "client", "Jam tenang harus berformat HH:MM."); c.quiet[k] = b.quiet[k]; }
  }
  return c;
}

// ---------- Telegram ----------
async function tgApi(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => null);
  log(j && j.ok ? "info" : "warn", "-", "telegram", { method, status: r.status, ok: !!(j && j.ok), err: j && !j.ok ? String(j.description || "").slice(0, 120) : undefined });
  return j;
}
async function tgSend(env, chatId, text) {
  try { const j = await tgApi(env, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }); return !!(j && j.ok); }
  catch (e) { log("error", "-", "telegram_fail", { msg: String((e && e.message) || e) }); return false; }
}
// kind: sig | res | alert | news | wait. critical = tetap dikirim di jam tenang.
async function notify(env, cfg, kind, text, critical) {
  if (!env.TELEGRAM_BOT_TOKEN || !cfg.chatId || cfg.n[kind] === false) return false;
  if (!critical && inQuiet(cfg, wibNow())) return false;
  return tgSend(env, cfg.chatId, text);
}
const webhookSecret = env => sign("tg-webhook", env.SESSION_SECRET);
function msgResult(rec) {
  const S = rec.sig, R = (rec.ev && rec.ev.r) || {}, I = (rec.ev && rec.ev.i) || {};
  const head = { win: "✅ TP tercapai", loss: "❌ SL kena", expired: "⌛ Kedaluwarsa", skip: "⏭ Tidak dieksekusi (harga sudah dekat atau melewati SL saat entry)", nodata: "❔ Data tidak cukup" }[R.s] || "ℹ️ " + R.s;
  return `${head} — <b>${S.type}</b> XAU/USD\nEntry ${fmt(S.entry)} · SL ${fmt(S.sl)} · TP1 ${fmt(S.tp1)}\nHasil realistis: <b>${rTxt(R)}</b> (teoritis ${rTxt(I)})\n${STYLE_NM[rec.style] || rec.style} · keyakinan ${H(rec.conf || "-")} · ${wibStr(rec.ts)}`;
}
function msgNew(rec) {
  if (rec.sig) { const S = rec.sig; return `📌 Sinyal baru: <b>${S.type}</b> XAU/USD\nEntry ${fmt(S.entry)} · SL ${fmt(S.sl)} · TP1 ${fmt(S.tp1)}${S.tp2 != null ? " · TP2 " + fmt(S.tp2) : ""}\n${STYLE_NM[rec.style]} · keyakinan ${H(rec.conf || "-")} · berlaku ${rec.hor} jam`; }
  const T = rec.trg || {};
  return `⏸ <b>WAIT</b> XAU/USD${rec.waitWhy ? "\n" + H(rec.waitWhy) : ""}${T.buy != null ? "\nBUY jika di atas " + fmt(T.buy) : ""}${T.sell != null ? "\nSELL jika di bawah " + fmt(T.sell) : ""}`;
}
function summarize(items, since) {
  const L = items.filter(x => x.ts >= since), sg = L.filter(x => x.g === "B" || x.g === "S"), w = sg.filter(x => x.s === "win").length, l = sg.filter(x => x.s === "loss").length;
  const R = sg.filter(x => x.s === "win" || x.s === "loss").reduce((a, x) => a + (x.r || 0), 0), Ri = sg.filter(x => x.si === "win" || x.si === "loss").reduce((a, x) => a + (x.ri || 0), 0);
  const wt = L.filter(x => x.g === "W"), wo = wt.filter(x => x.s === "wok").length, wn = wo + wt.filter(x => x.s === "wmiss").length;
  return { n: L.length, sg: sg.length, w, l, ex: sg.filter(x => x.s === "expired").length, sk: sg.filter(x => x.s === "skip").length, pend: sg.filter(x => x.s === "pending").length, R, Ri, wo, wn };
}
function msgSummary(title, s) {
  return `📊 <b>${title}</b>\nSinyal BUY/SELL: ${s.sg} (${s.w} menang, ${s.l} kalah${s.l + s.w ? ", " + Math.round((s.w / (s.w + s.l)) * 100) + "%" : ""}${s.ex ? ", " + s.ex + " kedaluwarsa" : ""}${s.sk ? ", " + s.sk + " tidak dieksekusi" : ""}${s.pend ? ", " + s.pend + " menunggu" : ""})\nTotal R realistis: <b>${(s.R >= 0 ? "+" : "−") + Math.abs(s.R).toFixed(1)}R</b> (teoritis ${(s.Ri >= 0 ? "+" : "−") + Math.abs(s.Ri).toFixed(1)}R)${s.wn ? "\nWAIT tepat: " + s.wo + " dari " + s.wn : ""}`;
}

// ---------- alert harga (disimpan di server, dicek Cron) ----------
const getAlerts = async env => (await env.CHATS.get("alerts", "json")) || [];
const putAlerts = (env, a) => env.CHATS.put("alerts", JSON.stringify(a));

// ---------- mesin evaluasi (dipakai Cron dan halaman) ----------
let lastPageEval = 0;
async function evalAll(env, rid, opt = {}) {
  const out = { changes: [], fired: [], fetched: [] };
  if (!env.CHATS || !env.TWELVEDATA_KEY) return out;
  const now = Date.now(), wall = now + 7 * 36e5, open = marketOpen(now), cfg = await getCfg(env), S = {};
  const getS = async tf => { if (!(tf in S)) { try { S[tf] = await tdSeries(env, rid, "XAU/USD", tf); out.fetched.push(tf); } catch (e) { S[tf] = null; log("warn", rid, "eval_series_fail", { tf, msg: String((e && e.message) || e).slice(0, 120) }); } } return S[tf]; };
  const items = await listSigs(env), pend = items.filter(x => !x.d).slice(0, 25);
  for (const it of pend) {
    if (!open && wall < it.ts + it.hor * 36e5) continue; // pasar tutup dan jangka belum habis: tidak ada candle baru
    const rec = await env.CHATS.get(it.key, "json");
    if (!rec) continue;
    const wasDone = fin(rec.ev && rec.ev.r), ch = await evalRecord(rec, getS, cfg.spread, wall);
    if (!ch) continue;
    await putRec(env, rec);
    out.changes.push({ id: rec.id, s: rec.status, done: rec.done });
    if (!wasDone && fin(rec.ev.r)) {
      if (rec.sig) await notify(env, cfg, "res", msgResult(rec), true);
      else if (rec.wait && rec.ev.r.s === "wmiss") {
        const T = rec.trg || {};
        await notify(env, cfg, "wait", `⚠ WAIT terlewat — harga menembus pemicu${T.buy != null ? " BUY di atas " + fmt(T.buy) : ""}${T.sell != null ? " / SELL di bawah " + fmt(T.sell) : ""} (${wibStr(rec.ts)})`, false);
      }
    }
  }
  const alerts = open ? await getAlerts(env) : [];
  if (alerts.length) {
    const j = await getS("5min");
    if (j) {
      const v = j.values, step = candleStep(v), keep = [];
      for (const a of alerts) {
        let hit = false;
        for (const c of v) { const t = P(c.t); if (t > a.ts) hit = a.dir === "up" ? c.h >= a.p : c.l <= a.p; else if (t + step > a.ts) hit = a.dir === "up" ? c.c >= a.p : c.c <= a.p; if (hit) break; }
        if (hit) { out.fired.push(a); await notify(env, cfg, "alert", `🔔 Alert harga XAU/USD: ${a.dir === "up" ? "naik ke ≥" : "turun ke ≤"} <b>${fmt(a.p)}</b> (harga ${fmt(v[v.length - 1].c)})`, true); }
        else keep.push(a);
      }
      if (out.fired.length) await putAlerts(env, keep);
    }
  }
  return out;
}
// Pengingat news dan ringkasan, hanya dari Cron. Keadaan disimpan di KV "state" dan hanya ditulis bila berubah.
async function cronExtras(env, rid) {
  const cfg = await getCfg(env);
  if (!cfg.chatId || !env.TELEGRAM_BOT_TOKEN) return;
  const now = Date.now(), wall = now + 7 * 36e5, st = (await env.CHATS.get("state", "json")) || { news: {}, sumD: "", sumW: "" };
  let dirty = false;
  for (const [d, t, z, n] of NEWS_EV) {
    const ms = zUtc(d, t, ZONES[z]), key = d + "|" + n;
    if (st.news[key] || ms <= now || ms - now > cfg.newsMin * 60e3) continue;
    st.news[key] = now; dirty = true;
    await notify(env, cfg, "news", `⏰ ${Math.max(1, Math.round((ms - now) / 6e4))} menit lagi: <b>${H(n)}</b> (${p2(new Date(ms + 7 * 36e5).getUTCHours())}:${p2(new Date(ms + 7 * 36e5).getUTCMinutes())} WIB). Volatilitas bisa melonjak.`, false);
  }
  for (const k of Object.keys(st.news)) if (now - st.news[k] > 7 * 864e5) { delete st.news[k]; dirty = true; }
  const d = new Date(wall), day = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`, hr = d.getUTCHours();
  if (cfg.sum !== "off" && hr >= 7 && hr < 22) {
    const weekly = cfg.sum === "weekly", due = weekly ? d.getUTCDay() === 1 && st.sumW !== day : st.sumD !== day;
    if (due) {
      const items = await listSigs(env), s = summarize(items, wall - (weekly ? 7 : 1) * 864e5);
      if (weekly) st.sumW = day; else st.sumD = day;
      dirty = true;
      if (s.n) await notify(env, cfg, "news", msgSummary(weekly ? "Ringkasan 7 hari terakhir" : "Ringkasan 24 jam terakhir", s), false);
    }
  }
  if (dirty) await env.CHATS.put("state", JSON.stringify(st));
}
async function cronRun(env) {
  const rid = "cron-" + crypto.randomUUID().slice(0, 4);
  try {
    if (!env.CHATS) return;
    const r = await evalAll(env, rid, { cron: true });
    await cronExtras(env, rid);
    log("info", rid, "cron", { changes: r.changes.length, fired: r.fired.length, fetched: r.fetched.join(",") });
  } catch (e) { log("error", rid, "cron_fail", { msg: String((e && e.message) || e), stack: String((e && e.stack) || "").slice(0, 400) }); }
}

// ---------- API: sinyal ----------
async function signalsApi(request, env, rid) {
  await requireAuth(request, env, rid, true);
  if (!env.CHATS) throw new AppError(500, "kv_missing", "config", "KV 'CHATS' belum terpasang.", CFG_HINT);
  const cfg = await getCfg(env);
  if (request.method === "GET") {
    const id = new URL(request.url).searchParams.get("id");
    if (id) { const rec = await env.CHATS.get("sig:" + id, "json"); if (!rec) throw new AppError(404, "not_found", "client", "Sinyal tidak ditemukan."); return json({ ok: true, rec }); }
    return json({ ok: true, items: (await listSigs(env)).map(({ key, ...m }) => m), cfg: { spread: cfg.spread }, now: wibNow() });
  }
  const b = await request.json().catch(() => ({}));
  if (b.action === "create") {
    const rec = cleanRec(b.rec, wibNow());
    await putRec(env, rec);
    const items = await listSigs(env);
    if (items.length > SIG_MAX) for (const x of items.slice(SIG_MAX)) await env.CHATS.delete(x.key);
    if (rec.sig || rec.wait) await notify(env, cfg, "sig", msgNew(rec), true);
    return json({ ok: true, id: rec.id, meta: metaOf(rec) });
  }
  if (b.action === "import") {
    const list = (Array.isArray(b.records) ? b.records : []).slice(0, 100);
    let n = 0;
    for (const r0 of list) {
      try {
        const rec = cleanRec({ ...r0, ...(r0.sig ? {} : {}) }, numOf(r0.ts) || wibNow());
        rec.ts = numOf(r0.ts) || rec.ts; rec.id = "i" + rec.id; rec.imp = true;
        const old = ({ win: "win", loss: "loss", expired: "expired", wok: "wok", wmiss: "wmiss", nodata: "nodata", hit: "win", miss: "loss" })[r0.status];
        if (r0.done && old) { rec.ev = { i: { s: old, r: numOf(r0.r) }, r: { s: old, r: numOf(r0.r) } }; rec.status = old; rec.done = true; }
        if (await env.CHATS.get("sig:" + rec.id)) continue;
        await putRec(env, rec); n++;
      } catch { /* lewati rekaman yang tidak valid */ }
    }
    return json({ ok: true, imported: n });
  }
  if (b.action === "delete") { const id = String(b.id || ""); if (id) await env.CHATS.delete("sig:" + id); return json({ ok: true }); }
  if (b.action === "clear") { for (const x of await listSigs(env)) await env.CHATS.delete(x.key); return json({ ok: true }); }
  if (b.action === "eval") {
    if (Date.now() - lastPageEval < 15000) return json({ ok: true, throttled: true, changes: [], fired: [] });
    lastPageEval = Date.now();
    const r = await evalAll(env, rid, {});
    return json({ ok: true, changes: r.changes, fired: r.fired.map(a => ({ p: a.p, dir: a.dir })) });
  }
  throw new AppError(400, "bad_request", "client", "Aksi tidak dikenal.", "Gunakan create, import, delete, clear, atau eval.");
}
// ---------- API: alert harga ----------
async function alertsApi(request, env, rid) {
  await requireAuth(request, env, rid, true);
  if (!env.CHATS) throw new AppError(500, "kv_missing", "config", "KV 'CHATS' belum terpasang.", CFG_HINT);
  let list = await getAlerts(env);
  if (request.method === "GET") return json({ ok: true, alerts: list });
  const b = await request.json().catch(() => ({}));
  if (b.action === "add") {
    const p = numOf(b.p), px = numOf(b.px);
    if (p == null || p <= 0 || px == null) throw new AppError(400, "bad_request", "client", "Level atau harga acuan tidak valid.");
    if (Math.abs(p - px) < 0.01) throw new AppError(400, "bad_request", "client", "Level sama dengan harga sekarang.");
    if (list.length >= 5) throw new AppError(400, "limit", "client", "Maksimal 5 alert aktif.");
    list.push({ id: Math.random().toString(36).slice(2, 8), p, dir: p > px ? "up" : "down", ts: wibNow() });
  } else if (b.action === "remove") list = list.filter(a => a.id !== b.id);
  else if (b.action === "clear") list = [];
  else throw new AppError(400, "bad_request", "client", "Aksi tidak dikenal.");
  await putAlerts(env, list);
  return json({ ok: true, alerts: list });
}
// ---------- API: pengaturan notifikasi + penyambungan Telegram ----------
async function notifyApi(request, env, rid) {
  await requireAuth(request, env, rid, true);
  if (!env.CHATS) throw new AppError(500, "kv_missing", "config", "KV 'CHATS' belum terpasang.", CFG_HINT);
  const b = await request.json().catch(() => ({})), cfg = await getCfg(env), tokenSet = !!env.TELEGRAM_BOT_TOKEN;
  const view = c => ({ tokenSet, linked: !!c.chatId, spread: c.spread, newsMin: c.newsMin, sum: c.sum, n: c.n, quiet: c.quiet });
  if (b.action === "status") return json({ ok: true, ...view(cfg) });
  if (b.action === "save") { const c = cleanCfg(cfg, b.cfg); await putCfg(env, c); return json({ ok: true, ...view(c) }); }
  if (!tokenSet) throw new AppError(400, "telegram_token_missing", "config", "Secret TELEGRAM_BOT_TOKEN belum diisi.", "Buat bot di @BotFather, isi tokennya sebagai Secret TELEGRAM_BOT_TOKEN, lalu Deploy.");
  if (b.action === "pair") {
    const me = await tgApi(env, "getMe");
    if (!me || !me.ok) throw new AppError(502, "telegram_rejected", "upstream", "Telegram menolak token bot.", "Cek TELEGRAM_BOT_TOKEN di @BotFather.");
    const hook = await tgApi(env, "setWebhook", { url: new URL(request.url).origin + "/api/telegram", secret_token: await webhookSecret(env), allowed_updates: ["message"] });
    if (!hook || !hook.ok) throw new AppError(502, "telegram_webhook", "upstream", "Gagal mendaftarkan webhook Telegram: " + String((hook && hook.description) || "tidak ada jawaban"), "Pastikan Worker bisa diakses lewat HTTPS publik.");
    const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
    await env.CHATS.put("tg:pair", JSON.stringify({ code, exp: Date.now() + 10 * 60e3 }), { expirationTtl: 660 });
    return json({ ok: true, code, bot: me.result.username, ttlMin: 10 });
  }
  if (b.action === "test") {
    if (!cfg.chatId) throw new AppError(400, "telegram_not_linked", "client", "Telegram belum terhubung.", "Tekan Hubungkan Telegram dulu.");
    const ok = await tgSend(env, cfg.chatId, "✅ Tes notifikasi didinska.ai berhasil.");
    if (!ok) throw new AppError(502, "telegram_send_failed", "upstream", "Telegram gagal mengirim pesan.", "Coba hubungkan ulang.");
    return json({ ok: true });
  }
  if (b.action === "unlink") { cfg.chatId = null; await putCfg(env, cfg); return json({ ok: true, ...view(cfg) }); }
  throw new AppError(400, "bad_request", "client", "Aksi tidak dikenal.");
}
// ---------- Webhook Telegram ----------
async function telegramHook(request, env, rid) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.CHATS || !env.SESSION_SECRET) throw new AppError(404, "not_found", "worker", "Tidak aktif.");
  if (!safeEq(request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "", await webhookSecret(env))) throw new AppError(401, "bad_secret", "auth", "Rahasia webhook salah.");
  const u = await request.json().catch(() => null), msg = u && u.message;
  if (!msg || typeof msg.text !== "string" || !msg.chat) return json({ ok: true });
  const chatId = msg.chat.id, text = msg.text.trim(), cfg = await getCfg(env), reply = t => tgSend(env, chatId, t);
  try {
    const m = /^\/start(?:@\w+)?\s+(\d{6})$/.exec(text);
    if (m) {
      const pr = await env.CHATS.get("tg:pair", "json");
      if (pr && pr.exp > Date.now() && safeEq(String(pr.code), m[1])) {
        cfg.chatId = chatId; await putCfg(env, cfg); await env.CHATS.delete("tg:pair");
        await reply("✅ Terhubung. Notifikasi didinska.ai akan masuk ke chat ini.\nKetik /help untuk daftar perintah.");
      } else log("warn", rid, "tg_pair_bad", {});
      return json({ ok: true });
    }
    if (!cfg.chatId || chatId !== cfg.chatId) { log("warn", rid, "tg_unknown_chat", {}); return json({ ok: true }); }
    await tgCommand(env, cfg, text, reply, rid);
  } catch (e) { log("error", rid, "tg_cmd_fail", { msg: String((e && e.message) || e) }); await reply("Terjadi kesalahan saat memproses perintah.").catch(() => {}); }
  return json({ ok: true });
}
async function tgCommand(env, cfg, text, reply, rid) {
  const [cmd0, ...rest] = text.split(/\s+/), cmd = cmd0.toLowerCase().replace(/@\w+$/, ""), arg = rest.join(" ");
  const wall = wibNow();
  if (cmd === "/help" || cmd === "/start") return reply("Perintah:\n/status — harga, pasar, sinyal menunggu\n/sinyal — sinyal yang masih berjalan\n/akurasi — ringkasan hasil\n/alert 4150 — pasang alert harga\n/alerts — daftar alert\n/hapusalert 1 — hapus alert (atau all)\n/keys — status API key\n/resetkey — hapus penanda key habis");
  if (cmd === "/status") {
    let px = "-";
    try { const j = await tdSeries(env, rid, "XAU/USD", "5min"); const c = j.values[j.values.length - 1]; px = `${fmt(c.c)} (candle ${c.t.slice(5, 16)} WIB)`; } catch { px = "tidak bisa diambil"; }
    const items = await listSigs(env), pend = items.filter(x => x.g !== "-" && !(x.si && x.si !== "pending" && x.d)).filter(x => x.s === "pending").length;
    const nx = NEWS_EV.map(([d, t, z, n]) => ({ ms: zUtc(d, t, ZONES[z]), n })).filter(e => e.ms > Date.now()).sort((a, b) => a.ms - b.ms)[0];
    return reply(`<b>XAU/USD</b> ${px}\nPasar: ${marketOpen() ? "buka" : "tutup"}\nSinyal menunggu: ${pend}\nAlert aktif: ${(await getAlerts(env)).length}${nx ? `\nNews berikutnya: ${H(nx.n)} (${wibStr(nx.ms + 7 * 36e5)})` : ""}`);
  }
  if (cmd === "/sinyal") {
    const items = (await listSigs(env)).filter(x => x.s === "pending" && (x.g === "B" || x.g === "S")).slice(0, 5);
    if (!items.length) return reply("Tidak ada sinyal BUY/SELL yang sedang berjalan.");
    const lines = [];
    for (const it of items) { const r = await env.CHATS.get(it.key, "json"); if (r && r.sig) lines.push(`<b>${r.sig.type}</b> ${fmt(r.sig.entry)} · SL ${fmt(r.sig.sl)} · TP1 ${fmt(r.sig.tp1)} · ${wibStr(r.ts)}`); }
    return reply(lines.join("\n") || "Tidak ada sinyal berjalan.");
  }
  if (cmd === "/akurasi") { const s = summarize(await listSigs(env), 0); return reply(s.n ? msgSummary("Akurasi semua sinyal", s) : "Belum ada sinyal tersimpan."); }
  if (cmd === "/keys") { const k = await keyStatus(env); return reply(`🔑 API key: <b>${k.total}</b> total\nAktif: ${k.alive} · saldo habis: ${k.saldo} · ditolak: ${k.ditolak} · istirahat (rate limit): ${k.cooling}\nKey yang saldonya habis dicoba lagi otomatis setelah 6 jam. Ketik /resetkey kalau sudah top up.`); }
  if (cmd === "/resetkey") { await saveDead(env, {}); keyMem.cool.clear(); return reply("Penanda key habis dihapus. Semua key dicoba lagi."); }
  if (cmd === "/alerts") { const a = await getAlerts(env); return reply(a.length ? a.map((x, i) => `${i + 1}. ${x.dir === "up" ? "naik ≥" : "turun ≤"} ${fmt(x.p)}`).join("\n") : "Belum ada alert aktif."); }
  if (cmd === "/hapusalert") {
    let a = await getAlerts(env);
    if (arg.toLowerCase() === "all") a = []; else { const i = parseInt(arg, 10) - 1; if (!(i >= 0 && i < a.length)) return reply("Pakai: /hapusalert 1 (nomor dari /alerts) atau /hapusalert all"); a.splice(i, 1); }
    await putAlerts(env, a); return reply("Alert dihapus.");
  }
  if (cmd === "/alert") {
    const p = numOf(arg); if (p == null || p <= 0) return reply("Pakai: /alert 4150");
    const a = await getAlerts(env); if (a.length >= 5) return reply("Maksimal 5 alert aktif.");
    const j = await tdSeries(env, rid, "XAU/USD", "5min"), px = j.values[j.values.length - 1].c;
    if (Math.abs(p - px) < 0.01) return reply("Level sama dengan harga sekarang.");
    a.push({ id: Math.random().toString(36).slice(2, 8), p, dir: p > px ? "up" : "down", ts: wall }); await putAlerts(env, a);
    return reply(`Alert dipasang: ${p > px ? "naik ke ≥" : "turun ke ≤"} ${fmt(p)} (harga ${fmt(px)})`);
  }
  return reply("Perintah tidak dikenal. Ketik /help.");
}

export default {
  // Cron (lihat wrangler.jsonc): menilai sinyal, memeriksa alert, dan mengirim notifikasi Telegram walau web tertutup.
  async scheduled(event, env, ctx) { ctx.waitUntil(cronRun(env)); },
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
      else if (p === "/api/signals" && (m === "GET" || m === "POST")) res = await signalsApi(request, env, rid);
      else if (p === "/api/alerts" && (m === "GET" || m === "POST")) res = await alertsApi(request, env, rid);
      else if (p === "/api/notify" && m === "POST") res = await notifyApi(request, env, rid);
      else if (p === "/api/telegram" && m === "POST") res = await telegramHook(request, env, rid);
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

// Hanya untuk uji otomatis (tidak aktif di produksi).
if (globalThis.__TEST__) globalThis.__W = { apiKeys, keyStatus, keyMem, judgeTrade, judgeWait, evalRecord, cleanRec, metaOf, summarize, marketOpen, zUtc, inQuiet, cleanCfg, cronRun, evalAll, tgCommand, NEWS_EV, P, listSigs, getCfg };
