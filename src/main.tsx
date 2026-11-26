import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { markUpdateReady } from "./store";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Keeps the app available offline. Skipped during development so that code
// changes always show up immediately.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js"));
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "update-ready") markUpdateReady();
  });
}
