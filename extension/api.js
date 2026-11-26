// Everything the extension sends over the network is in this file.
// It talks to one place only: the Readler Supabase project.
const SUPABASE_URL = "https://kgnpncskdmzwqmjrrupx.supabase.co";
// Public by design: identifies the project, grants nothing without a sign-in.
const SUPABASE_KEY = "sb_publishable_TR1a-HqOvBOusa_4F8Kuyg_dyE7FG5-";
export const APP_URL = "https://readler.app/";

const SESSION = "session";

export class NotSignedIn extends Error {
  constructor() {
    super("Sign in to Readler first");
  }
}

async function post(path, body, token) {
  const response = await fetch(SUPABASE_URL + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_KEY,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    // some answers have no body
  }
  return { ok: response.ok, status: response.status, data };
}

function remember(data, email) {
  const session = {
    email: data.user?.email ?? email,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
  };
  return chrome.storage.local.set({ [SESSION]: session }).then(() => session);
}

export async function getSession() {
  return (await chrome.storage.local.get(SESSION))[SESSION] ?? null;
}

/** Signs in with the Readler email and password. The password is sent once and never stored. */
export async function signIn(email, password) {
  const { ok, data } = await post("/auth/v1/token?grant_type=password", { email, password });
  if (!ok) throw new Error(data?.msg ?? data?.error_description ?? "Could not sign in");
  return remember(data, email);
}

export async function signOut() {
  const session = await getSession();
  await chrome.storage.local.remove(SESSION);
  if (session) post("/auth/v1/logout?scope=local", {}, session.access_token).catch(() => {});
}

/** Returns a valid access token, renewing it when it is about to expire. */
async function accessToken() {
  const session = await getSession();
  if (!session) throw new NotSignedIn();
  if (session.expires_at - 60 > Date.now() / 1000) return session.access_token;

  const { ok, status, data } = await post("/auth/v1/token?grant_type=refresh_token", {
    refresh_token: session.refresh_token,
  });
  if (!ok) {
    // A refused renewal means the sign-in is no longer valid; other failures may be temporary.
    if (status === 400 || status === 401) {
      await chrome.storage.local.remove(SESSION);
      throw new NotSignedIn();
    }
    throw new Error("Could not reach Readler");
  }
  return (await remember(data, session.email)).access_token;
}

/**
 * Saves a page. `html` is the page as currently shown in the tab; when given,
 * Readler extracts the article from it instead of fetching the address itself,
 * which is what makes pages behind a login save in full.
 */
export async function save({ url, html }) {
  const token = await accessToken();
  const { ok, status, data } = await post("/functions/v1/save", html ? { url, html } : { url }, token);
  if (status === 401) {
    await chrome.storage.local.remove(SESSION);
    throw new NotSignedIn();
  }
  if (!ok || !data?.item) throw new Error(data?.error ?? "Could not save this page");
  return data.item;
}
