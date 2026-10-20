/* global window, document, localStorage */
// Theme before first paint (§10.4): stored choice, else the OS preference; never throws.
// A separate file (not inline) so the site's Content-Security-Policy (script-src 'self') allows it.
(function () {
  var choice = "system";
  try {
    choice = localStorage.getItem("satya.theme") || "system";
  } catch {
    // storage blocked (private mode): fall back to the OS preference
  }
  var dark =
    choice === "dark" ||
    (choice === "system" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
})();
