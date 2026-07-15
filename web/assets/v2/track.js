/*
 * track.js — first-party, cookieless UI click tracker for Nadelio.
 *
 * Standalone vanilla JS. No external request, no third-party library, no cookie,
 * no localStorage. It only reports meaningful clicks (buttons, links, elements
 * flagged with data-ev or role=button) to the same-origin /api/track endpoint.
 * Page views are logged server-side, so this file never sends a page view.
 *
 * Wiring is done elsewhere (an HTML <script> tag added by another process); this
 * file only defines the behavior.
 */
(function () {
  "use strict";

  function send(label) {
    if (!label) return;
    var payload = JSON.stringify({ label: label, path: location.pathname });
    // Preferred path: sendBeacon survives page unload and never blocks the UI.
    try {
      if (navigator && typeof navigator.sendBeacon === "function") {
        var blob = new Blob([payload], { type: "application/json" });
        navigator.sendBeacon("/api/track", blob);
        return;
      }
    } catch (e) {
      // fall through to fetch
    }
    // Fallback for browsers without sendBeacon: fetch with keepalive so the
    // request can still complete if the page is navigating away.
    try {
      if (typeof fetch === "function") {
        fetch("/api/track", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          keepalive: true
        });
      }
    } catch (e2) {
      // best effort only: never throw from a click handler
    }
  }

  function onClick(ev) {
    var target = ev && ev.target;
    if (!target || typeof target.closest !== "function") return;
    var el = target.closest("button, a, [role=button], [data-ev]");
    if (!el) return;
    var label =
      (el.dataset && el.dataset.ev) ||
      el.getAttribute("aria-label") ||
      el.textContent ||
      "";
    label = String(label).replace(/\s+/g, " ").trim().slice(0, 80);
    if (label) send(label);
  }

  function init() {
    // Capture phase so a click is caught even if a child handler stops it.
    document.addEventListener("click", onClick, true);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
