/**
 * Applies the side panel theme before first paint.
 *
 * Loaded as a plain (parser-blocking) script in <head> so the system-derived
 * theme is on <html> before any content renders; the stored explicit choice
 * (`heart_theme` in chrome.storage.local) lands in the same tick's microtask
 * queue in practice, so there is no flash of the wrong theme. Kept as a
 * separate file because the extension CSP (script-src 'self') forbids inline
 * scripts.
 */
(() => {
  const apply = (theme) => {
    if (theme === "light" || theme === "dark") {
      document.documentElement.dataset.theme = theme;
    }
  };

  try {
    apply(window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  } catch {
    apply("light");
  }

  try {
    chrome.storage.local.get("heart_theme", (stored) => {
      void (chrome.runtime && chrome.runtime.lastError);
      apply(stored && stored.heart_theme);
    });
  } catch {}
})();
