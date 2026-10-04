import { isLoggedIn } from "../../lib/auth.js";

export async function onRequestGet({ request, env }) {
  const ok = await isLoggedIn(request, env.SESSION_SECRET);
  return new Response(null, { status: ok ? 204 : 401 });
}
