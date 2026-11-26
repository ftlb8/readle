// Turns a saved article into speech, one part at a time.
//
//   POST { item_id }              -> { parts, chars, minutes }  how the article will be split
//   POST { item_id, part }        -> the audio for that part (counted against the monthly allowance)
//   POST { sample: true, voice }  -> a short sample in that voice (admin only)
//
// Nothing is stored: the audio goes straight back to the listener's device.
// Needs OPENAI_API_KEY in the function's secrets.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { parseHTML } from "npm:linkedom@0.18.5";

const MODEL = "gpt-4o-mini-tts";
const VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"];
const PART_CHARS = 3200; // comfortably inside the model's limit per request
const STYLE =
  "Read this aloud as the narrator of a long-form magazine article: calm, clear and natural, at an unhurried pace, " +
  "without theatrics. Read it in the language it is written in.";
const SAMPLE =
  "Readler will read your saved articles in this voice: long essays, features and analysis, at whatever pace you like. " +
  "E também em português, quando o artigo for escrito em português.";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** The article as paragraphs fit for reading aloud: no captions, tables, code or footnote marks. */
function paragraphs(html: string | null, fallback: string | null): string[] {
  const whole = squash(fallback ?? "");
  let blocks: string[] = [];
  if (html) {
    const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body></html>`);
    const root = document.getElementById("r")!;
    root.querySelectorAll("figure, figcaption, table, pre, code, sup, aside, nav, footer, script, style, iframe, button, form")
      // deno-lint-ignore no-explicit-any
      .forEach((el: any) => el.remove());
    const selector = "p, h1, h2, h3, h4, h5, h6, li, blockquote";
    // deno-lint-ignore no-explicit-any
    blocks = [...root.querySelectorAll(selector)].filter((el: any) => !el.querySelector(selector))
      // deno-lint-ignore no-explicit-any
      .map((el: any) => squash(el.textContent ?? "")).filter(Boolean);
  }
  // Some pages keep their text outside ordinary paragraphs; fall back to the plain text then.
  if (blocks.join(" ").length < whole.length * 0.6) blocks = whole ? [whole] : [];
  return blocks.map((b) => squash(b.replace(/\[\d+\]/g, "").replace(/https?:\/\/\S+/g, ""))).filter(Boolean);
}

/** Packs paragraphs into parts short enough for one request, breaking long ones at sentence ends. */
function pack(blocks: string[]): string[] {
  const pieces = blocks.flatMap((block) =>
    block.length <= PART_CHARS ? [block] : block.match(/[^.!?…]+[.!?…]+["'”’)\]]*\s*|[^.!?…]+$/g) ?? [block]
  ).flatMap((piece) => piece.length <= PART_CHARS ? [piece] : piece.match(new RegExp(`.{1,${PART_CHARS}}(\\s|$)`, "g")) ?? [piece]);

  const parts: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (current && current.length + piece.length + 2 > PART_CHARS) {
      parts.push(current);
      current = "";
    }
    current += (current ? "\n\n" : "") + piece.trim();
  }
  if (current) parts.push(current);
  return parts;
}

async function speak(text: string, voice: string): Promise<Response> {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) return json({ error: "Listening is not set up yet" }, 503);
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, voice, input: text, instructions: STYLE, response_format: "mp3" }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) {
    let message = `The speech service answered ${response.status}`;
    try {
      message = (await response.json()).error?.message ?? message;
    } catch { /* keep the generic message */ }
    console.error("Speech failed:", response.status, message);
    return json({ error: message }, 502);
  }
  // Sent as a plain byte stream so the app receives it untouched.
  return new Response(response.body, { headers: { ...cors, "Content-Type": "application/octet-stream" } });
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

  let body: { item_id?: string; part?: number; sample?: boolean; voice?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Bad request" }, 400);
  }

  try {
    if (body.sample) {
      const { data: admin } = await supabase.rpc("is_admin");
      if (admin !== true) return json({ error: "Only the admin can try voices" }, 403);
      if (!VOICES.includes(body.voice ?? "")) return json({ error: "Unknown voice" }, 400);
      return await speak(SAMPLE, body.voice!);
    }

    if (!body.item_id) return json({ error: "Which article?" }, 400);
    const { data: item, error } = await supabase
      .from("items")
      .select("title, author, site_name, kind, content_html, text_content")
      .eq("id", body.item_id)
      .maybeSingle();
    if (error || !item) return json({ error: "Article not found" }, 404);
    if (item.kind !== "article") return json({ error: "Only articles can be read aloud" }, 400);

    const intro = [item.title, item.author ? `By ${item.author}` : null, item.site_name ? `From ${item.site_name}` : null]
      .filter(Boolean).map((s) => String(s).replace(/[.\s]+$/, "") + ".").join(" ");
    const parts = pack([intro, ...paragraphs(item.content_html, item.text_content)]);
    const chars = parts.reduce((n, p) => n + p.length, 0);

    if (body.part == null) {
      // About 900 characters a minute at a natural reading pace.
      return json({ parts: parts.length, chars, minutes: Math.max(1, Math.round(chars / 900)) });
    }

    const text = parts[body.part];
    if (!text) return json({ error: "No such part" }, 400);

    const { data: charge, error: chargeError } = await supabase.rpc("speech_charge", { p_chars: text.length });
    if (chargeError) return json({ error: chargeError.message }, 500);
    if (!charge.ok) {
      return json({ error: "You have used this month's listening allowance. It resets on the 1st.", ...charge }, 429);
    }

    const { data: voice } = await supabase.rpc("speech_voice");
    return await speak(text, VOICES.includes(voice) ? voice : "alloy");
  } catch (err) {
    console.error("speak failed:", (err as Error).message);
    return json({ error: "Could not prepare the audio" }, 500);
  }
});
