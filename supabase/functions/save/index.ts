// POST { url, html?, tags? }  ->  saves the page for the signed-in user and returns the item.
// `url` may be raw shared text that contains a link. `html` is optional page
// source captured by the browser extension (used for pages behind a login).
// `tags` are added to the item; when none of them is a topic tag, topics are
// chosen automatically.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { buildItem, normalizeUrl } from "./extract.ts";
import { suggestTopics, TOPICS } from "./tagger.ts";

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
  let givenTags: string[] = [];
  try {
    const body = await req.json();
    url = normalizeUrl(body.url ?? body.text ?? "");
    html = typeof body.html === "string" && body.html.length > 0 ? body.html : undefined;
    if (Array.isArray(body.tags)) {
      givenTags = body.tags
        .filter((t: unknown): t is string => typeof t === "string")
        .map((t: string) => t.trim().toLowerCase().slice(0, 40))
        .filter(Boolean)
        .slice(0, 10);
    }
  } catch (err) {
    return json({ error: (err as Error).message || "Bad request" }, 400);
  }

  let fields;
  try {
    fields = await buildItem(url, html);
  } catch (err) {
    return json({ error: (err as Error).message }, 400);
  }

  const row: Record<string, unknown> = { ...fields, url, user_id: auth.user.id, deleted_at: null, is_archived: false };

  // Tags: keep what the item already has, add any that were passed in, and
  // choose topics unless the item has some already.
  if (fields.status !== "failed") {
    const { data: existing } = await supabase.from("items").select("tags").eq("url", url).maybeSingle();
    const current: string[] = existing?.tags ?? [];
    const hasTopic = [...current, ...givenTags].some((t) => TOPICS.includes(t));
    const added = hasTopic ? givenTags : [...givenTags, ...(await suggestTopics(fields))];
    const merged = [...new Set([...current, ...added])];
    if (merged.length !== current.length) row.tags = merged;
  }

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
