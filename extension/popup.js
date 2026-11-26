// Opening the popup saves the current tab. If you are not signed in yet,
// it asks for your Readler email and password first.
import { APP_URL, NotSignedIn, getSession, save, signIn, signOut } from "./api.js";

const $ = (id) => document.getElementById(id);
const MAX_HTML = 4_500_000;

function show(section) {
  $("login").hidden = section !== "login";
  $("status").hidden = section !== "status";
}

function fail(text) {
  $("error").textContent = text;
  $("error").hidden = !text;
}

/**
 * Reads the page as it is currently displayed in the tab. This runs only on
 * the tab you clicked the button on, and only at that moment.
 */
async function capture(tab) {
  const host = new URL(tab.url).hostname;
  // Videos are saved by address; their pages are large and not needed.
  if (/(^|\.)(youtube\.com|youtu\.be|vimeo\.com)$/.test(host)) return undefined;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const copy = document.documentElement.cloneNode(true);
        copy.querySelectorAll('script:not([type="application/ld+json"]), style').forEach((n) => n.remove());
        return "<!doctype html>" + copy.outerHTML;
      },
    });
    return result && result.length < MAX_HTML ? result : undefined;
  } catch {
    // Some pages (PDFs, the Chrome Web Store) cannot be read; save by address instead.
    return undefined;
  }
}

function describe(item) {
  if (item.kind === "video") return "Saved video";
  if (item.kind === "link") return "Saved as a link only";
  const minutes = item.word_count ? Math.max(1, Math.round(item.word_count / 230)) : null;
  return minutes ? `Saved · ${minutes} min read` : "Saved";
}

async function saveCurrentTab() {
  fail("");
  show("status");
  $("open").href = APP_URL;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https?:/i.test(tab.url)) {
    $("message").textContent = "This page cannot be saved";
    $("detail").textContent = "Readler saves web pages that start with http or https.";
    return;
  }

  $("message").textContent = "Saving…";
  $("detail").textContent = tab.title ?? tab.url;
  try {
    const item = await save({ url: tab.url, html: await capture(tab) });
    $("message").textContent = describe(item);
    $("detail").textContent =
      item.kind === "link" ? "Readler could not find an article on this page." : (item.title ?? tab.url);
  } catch (err) {
    if (err instanceof NotSignedIn) return show("login");
    $("message").textContent = "Not saved";
    fail(err.message);
  }
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  fail("");
  $("login-button").disabled = true;
  try {
    await signIn($("email").value.trim(), $("password").value);
    $("password").value = "";
    await saveCurrentTab();
  } catch (err) {
    fail(err.message);
  } finally {
    $("login-button").disabled = false;
  }
});

$("signout").addEventListener("click", async () => {
  await signOut();
  show("login");
});

if (await getSession()) saveCurrentTab();
else show("login");
