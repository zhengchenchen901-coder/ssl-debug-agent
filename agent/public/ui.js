(() => {
  "use strict";
  // Appearance is the only value persisted here; credentials stay in their existing scopes.
  let appearance = "system";
  try { appearance = localStorage.getItem("remote-debug-appearance") || "system"; } catch (_) {}
  function applyAppearance() {
    document.documentElement.style.colorScheme = ["light", "dark"].includes(appearance) ? appearance : "light dark";
    const button = document.getElementById("appearanceButton");
    if (button) button.setAttribute("aria-label", `切换明暗外观（当前${appearance === "system" ? "跟随系统" : appearance === "dark" ? "深色" : "浅色"}）`);
  }
  applyAppearance();
  document.getElementById("appearanceButton")?.addEventListener("click", () => {
    const dark = appearance === "dark" || appearance === "system" && matchMedia("(prefers-color-scheme: dark)").matches;
    appearance = dark ? "light" : "dark";
    try { localStorage.setItem("remote-debug-appearance", appearance); } catch (_) {}
    applyAppearance();
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== "remote-debug-appearance") return;
    appearance = event.newValue || "system";
    applyAppearance();
  });

  // Keep keyboard focus inside the existing authentication/configuration dialogs.
  let activeDialog = null, returnFocus = null;
  const dialogs = [...document.querySelectorAll('.overlay [role="dialog"]')];
  function syncDialog() {
    const next = dialogs.find(dialog => !dialog.closest("[hidden]") && !dialog.closest(".embedded-settings"));
    if (next === activeDialog) return;
    if (next) {
      if (!activeDialog) returnFocus = document.activeElement;
      activeDialog = next;
      document.querySelector(".app-shell")?.setAttribute("inert", "");
      (next.querySelector("input:not(:disabled), textarea:not(:disabled)") || next.querySelector("button"))?.focus();
    } else {
      activeDialog = null;
      document.querySelector(".app-shell")?.removeAttribute("inert");
      if (returnFocus?.isConnected) returnFocus.focus();
      returnFocus = null;
    }
  }
  for (const dialog of dialogs) new MutationObserver(syncDialog).observe(dialog.closest(".overlay"), { attributes: true, attributeFilter: ["hidden", "class"] });
  document.addEventListener("keydown", (event) => {
    if (!activeDialog || event.key !== "Tab") return;
    const controls = [...activeDialog.querySelectorAll("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]")].filter(node => node.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
})();
