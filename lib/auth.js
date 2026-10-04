const enc = new TextEncoder();

async function sign(msg, secret) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export function safeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function makeToken(secret) {
  const exp = Date.now() + 7 * 864e5; // berlaku 7 hari
  return exp + "." + (await sign(String(exp), secret));
}

export async function isLoggedIn(request, secret) {
  const m = /(?:^|; )sess=([^;]+)/.exec(request.headers.get("Cookie") || "");
  if (!m || !secret) return false;
  const [exp, sig] = m[1].split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEq(sig, await sign(exp, secret));
}
