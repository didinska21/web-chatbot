import { isLoggedIn } from "../../lib/auth.js";

export async function onRequestPost({ request, env }) {
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
