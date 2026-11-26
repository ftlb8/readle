// Adds "Save link to Readler" to the right-click menu on links.
// The result shows briefly as a mark on the Readler toolbar button.
import { save } from "./api.js";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "save-link", title: "Save link to Readler", contexts: ["link"] });
});

function badge(text, color) {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
}

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== "save-link" || !info.linkUrl) return;
  badge("…", "#6f6a62");
  try {
    await save({ url: info.linkUrl });
    badge("✓", "#2e7d4f");
  } catch {
    // Most likely not signed in: clicking the toolbar button shows the sign-in form.
    badge("!", "#a3261b");
  }
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 4000);
});
