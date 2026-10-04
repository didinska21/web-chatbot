import { makeToken, safeEq } from "../../lib/auth.js";

const json = (o, status = 200, h = {}) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", ...h } });

export async function onRequestPost({ request, env }) {
  const { pin } = await request.json().catch(() => ({}));
  await new Promise(r => setTimeout(r, 600)); // perlambat tebak-tebakan PIN
  if (!env.PIN || !safeEq(String(pin || ""), env.PIN)) return json({ ok: false }, 401);
  const t = await makeToken(env.SESSION_SECRET);
  return json({ ok: true }, 200, {
    "Set-Cookie": `sess=${t}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`,
  });
}
