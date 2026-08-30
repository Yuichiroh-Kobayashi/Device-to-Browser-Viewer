/**
 * Presentation-only theme authority for Issue #9.
 *
 * The controller owns three states -- "system", "light", "dark" -- for the
 * lifetime of one application construction. It never reads or writes
 * localStorage, sessionStorage, cookies, URL state or server state, and it
 * holds no reference to WebSocketSource, SessionAdapter or StreamModel: a
 * theme change is a presentation event and can never mutate transport,
 * parser, stream identity or measurement state.
 */

export const THEME_STATES = Object.freeze(["system", "light", "dark"]);
export const THEME_MEDIA_QUERY = "(prefers-color-scheme: dark)";

export function effectiveTheme(state, systemPrefersDark) {
  if (state === "light" || state === "dark") return state;
  if (state !== "system") throw new TypeError("theme state must be system, light, or dark");
  return systemPrefersDark === true ? "dark" : "light";
}

/** One activation always selects the theme opposite to what is currently shown. */
export function nextThemeState(state, systemPrefersDark) {
  return effectiveTheme(state, systemPrefersDark) === "dark" ? "light" : "dark";
}

/** The control offers the theme the learner would move to, never the current one. */
export function themeControlLabel(effective) {
  if (effective !== "light" && effective !== "dark") throw new TypeError("effective theme must be light or dark");
  return effective === "dark" ? "ライト表示 / Light mode" : "ダーク表示 / Dark mode";
}

/**
 * The button carries the icon and the label as separate child nodes so a
 * theme change can relabel the control by writing only the label node's
 * textContent (see app.js syncThemeControl). Replacing the whole button's
 * textContent, as earlier revisions did, would destroy the icon on every
 * toggle. The icon is decorative and carries no information of its own, so
 * it is aria-hidden.
 */
export function themeControlMarkup(label) {
  return `<button type="button" class="theme-toggle" data-theme-toggle><span class="theme-toggle-icon" aria-hidden="true"></span><span data-theme-toggle-label>${label}</span></button>`;
}

/** Resolves the browser/OS colour-scheme authority, or null where matchMedia is absent. */
export function createThemeMediaQuery(view = globalThis) {
  const matchMedia = view?.matchMedia;
  if (typeof matchMedia !== "function") return null;
  return matchMedia.call(view, THEME_MEDIA_QUERY);
}

function observeMedia(media, listener) {
  if (typeof media?.addEventListener === "function") {
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }
  if (typeof media?.addListener === "function") {
    media.addListener(listener);
    return () => media.removeListener(listener);
  }
  return () => {};
}

export function createThemeController({ media = null, root = null } = {}) {
  let state = "system";
  let disposed = false;
  const listeners = new Set();
  const systemPrefersDark = () => media?.matches === true;
  const resolve = () => effectiveTheme(state, systemPrefersDark());
  const apply = () => {
    if (!root?.setAttribute) return;
    root.setAttribute("data-theme", state);
    root.setAttribute("data-effective-theme", resolve());
  };
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const onSystemChange = () => {
    if (disposed || state !== "system") return;
    apply();
    notify();
  };
  const detach = observeMedia(media, onSystemChange);
  apply();
  return Object.freeze({
    get state() { return state; },
    get effective() { return resolve(); },
    get label() { return themeControlLabel(resolve()); },
    get systemPrefersDark() { return systemPrefersDark(); },
    toggle() {
      if (disposed) throw new Error("theme controller is disposed");
      state = nextThemeState(state, systemPrefersDark());
      apply();
      notify();
      return state;
    },
    subscribe(listener) {
      if (typeof listener !== "function") throw new TypeError("theme listener must be a function");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      detach();
      listeners.clear();
    },
  });
}
