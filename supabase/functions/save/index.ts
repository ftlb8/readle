// POST { url, html? }  ->  saves the page for the signed-in user and returns the item.
// `url` may be raw shared text that contains a link. `html` is optional page
// source captured by the browser extension (used for pages behind a login).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { buildItem, normalizeUrl } from "./extract.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  const authorization = req.headers.get("Authorization") ?? "";
  const apiKey = Deno.env.get("SUPABASE_ANON_KEY") ?? req.headers.get("apikey") ?? "";
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, apiKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  });

  const { data: auth } = await supabase.auth.getUser(authorization.replace(/^Bearer\s+/i, ""));
  if (!auth?.user) return json({ error: "Sign in first" }, 401);

  let url: string;
  let html: string | undefined;
  try {
    const body = await req.json();
    url = normalizeUrl(body.url ?? body.text ?? "");
    html = typeof body.html === "string" && body.html.length > 0 ? body.html : undefined;
  } catch (err) {
    return json({ error: (err as Error).message || "Bad request" }, 400);
  }

  let fields;
  try {
    fields = await buildItem(url, html);
  } catch (err) {
    return json({ error: (err as Error).message }, 400);
  }

  const row = { ...fields, url, user_id: auth.user.id, deleted_at: null, is_archived: false };

  // A failed fetch must not wipe out a copy that was saved successfully before.
  const { data, error } = await supabase
    .from("items")
    .upsert(row, { onConflict: "user_id,url", ignoreDuplicates: fields.status === "failed" })
    .select()
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);

  if (data) return json({ item: data });

  const existing = await supabase.from("items").select().eq("url", url).maybeSingle();
  if (existing.error || !existing.data) return json({ error: "Could not save" }, 500);
  return json({ item: existing.data });
});
